import { Inject, Injectable, Logger } from '@nestjs/common';
import { type LiveSession, type Prisma, type Sensitivity, forWorkspace } from '@sotto/db';
import {
  AiSettingsService,
  type ResolvedChat,
  sensitivitiesFor,
} from '../ai/ai-settings.service.js';
import { UsageService } from '../billing/usage.service.js';
import { PrismaService } from '../core.module.js';
import { LiveHub } from './live.hub.js';
import { type LiveNotes, liveTranscriptText, writeLiveNotes } from './notes.js';

/** The first notes once this much of the call is transcribed; then every few minutes. */
export const FIRST_NOTES_AFTER_MS = 60_000;
export const NOTES_EVERY_MS = 2 * 60_000;
/** A model that takes longer than this is given up on until the next round. */
const NOTES_TIMEOUT_MS = 90_000;

/**
 * Why notes aren't being written. The web says each in words; codes keep content out of the
 * database's error fields and the logs.
 */
export type NotesError =
  | 'no_model'
  | 'model_unavailable'
  | 'restricted_private_only'
  | 'confidential_not_allowed'
  | 'quota'
  | 'unreadable'
  | 'failed';

/** What's stored in `LiveSession.notes`: the notes, which line they reach, and who wrote them. */
export interface StoredNotes extends LiveNotes {
  /** The last chunk the notes have read, so a quiet stretch doesn't rewrite them. */
  upTo: number;
  by: { routeLabel: string; isMock: boolean; private: boolean };
}

/**
 * Running notes for a live call, with the workspace's default chat model chosen exactly as Ask
 * chooses it, under the same privacy rules (BRIEF §3, ADR 0020): a Restricted meeting is only
 * read by a model in the cluster, Confidential only by modes the admins allowed, and a model
 * that can't be used means no notes and a reason, never a quiet switch to another model.
 */
@Injectable()
export class LiveNotesService {
  private readonly log = new Logger('live-notes');
  private readonly writing = new Map<string, Promise<void>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiSettingsService) private readonly settings: AiSettingsService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(LiveHub) private readonly hub: LiveHub,
  ) {}

  private db(workspaceId: string) {
    return forWorkspace(this.prisma.client, workspaceId);
  }

  /** The chat that may write this meeting's notes, or why none may. */
  async choose(
    workspaceId: string,
    sensitivity: Sensitivity,
  ): Promise<{ chat: ResolvedChat } | { error: NotesError }> {
    const policy = await this.settings.policy(workspaceId);
    const { defaultRef } = await this.settings.usableModels(workspaceId);
    if (!defaultRef) return { error: 'no_model' };
    let chat: ResolvedChat;
    try {
      chat = await this.settings.resolve(workspaceId, defaultRef);
    } catch {
      return { error: 'model_unavailable' };
    }
    if (!sensitivitiesFor(chat, policy).includes(sensitivity)) {
      return {
        error:
          sensitivity === 'RESTRICTED' ? 'restricted_private_only' : 'confidential_not_allowed',
      };
    }
    try {
      await this.usage.checkAsk(workspaceId, chat.route);
    } catch {
      return { error: 'quota' };
    }
    return { chat };
  }

  /** Whether it's time for new notes: enough said, enough time since the last, new lines. */
  due(session: LiveSession, lastSeq: number | null, now = Date.now()): boolean {
    if (lastSeq === null) return false;
    const stored = session.notes as StoredNotes | null;
    if (stored && stored.upTo >= lastSeq) return false;
    if (!session.notesAt) return session.durationMs >= FIRST_NOTES_AFTER_MS;
    return now - session.notesAt.getTime() >= NOTES_EVERY_MS;
  }

  /** Writes notes if they're due (or `force`d). One at a time per session; never throws. */
  refresh(workspaceId: string, sessionId: string, options: { force?: boolean } = {}): void {
    if (this.writing.has(sessionId)) return;
    const run = this.write(workspaceId, sessionId, options.force ?? false)
      .catch((error: unknown) => {
        this.log.warn(`live notes not written (${error instanceof Error ? error.name : 'error'})`);
      })
      .finally(() => this.writing.delete(sessionId));
    this.writing.set(sessionId, run);
  }

  /** Resolves when notes being written for a session are done (tests, End). */
  async settled(sessionId: string): Promise<void> {
    await this.writing.get(sessionId);
  }

  private async write(workspaceId: string, sessionId: string, force: boolean): Promise<void> {
    const db = this.db(workspaceId);
    const session = await db.liveSession.findFirst({
      where: { id: sessionId },
      include: { file: { select: { sensitivity: true, deletedAt: true } } },
    });
    if (!session || session.file.deletedAt) return;
    const lines = await db.liveSegment.findMany({
      where: { sessionId },
      orderBy: [{ seq: 'asc' }, { idx: 'asc' }],
      select: { seq: true, startMs: true, text: true, speaker: true },
    });
    const lastSeq = lines.at(-1)?.seq ?? null;
    const stored = session.notes as StoredNotes | null;
    if (
      force ? lastSeq === null || (stored && stored.upTo >= lastSeq) : !this.due(session, lastSeq)
    ) {
      return;
    }

    const choice = await this.choose(workspaceId, session.file.sensitivity);
    if ('error' in choice) {
      await this.setError(session, choice.error);
      return;
    }
    const { chat } = choice;
    const signal = AbortSignal.timeout(NOTES_TIMEOUT_MS);
    let result: Awaited<ReturnType<typeof writeLiveNotes>>;
    try {
      result = await writeLiveNotes(
        chat.provider,
        chat.model,
        liveTranscriptText(lines),
        stored ? { summary: stored.summary, points: stored.points, actions: stored.actions } : null,
        signal,
      );
    } catch {
      await this.setError(session, 'failed');
      return;
    }
    await this.usage.record(workspaceId, [
      {
        kind: 'AI_INPUT_TOKENS',
        quantity: result.inputTokens,
        route: chat.route,
        model: chat.ref,
        userId: session.startedById,
      },
      {
        kind: 'AI_OUTPUT_TOKENS',
        quantity: result.outputTokens,
        route: chat.route,
        model: chat.ref,
        userId: session.startedById,
      },
    ]);
    if (!result.notes) {
      await this.setError(session, 'unreadable');
      return;
    }
    const notes: StoredNotes = {
      ...result.notes,
      upTo: lastSeq!,
      by: {
        routeLabel: chat.routeLabel,
        isMock: chat.isMock,
        private: chat.dataLocation === 'IN_CLUSTER',
      },
    };
    const notesAt = new Date();
    await db.liveSession.update({
      where: { id: sessionId },
      data: {
        notes: notes as unknown as Prisma.InputJsonValue,
        notesAt,
        notesModel: chat.ref,
        notesError: null,
      },
    });
    await this.hub.publish(sessionId, {
      type: 'notes',
      data: { notes: presentNotes(notes), notesAt: notesAt.toISOString(), notesError: null },
    });
  }

  private async setError(session: LiveSession, error: NotesError): Promise<void> {
    if (session.notesError === error) return;
    await this.db(session.workspaceId).liveSession.update({
      where: { id: session.id },
      data: { notesError: error },
    });
    await this.hub.publish(session.id, {
      type: 'notes',
      data: {
        notes: presentNotes(session.notes as StoredNotes | null),
        notesAt: session.notesAt?.toISOString() ?? null,
        notesError: error,
      },
    });
  }
}

/** The notes as the api shows them (without the bookkeeping). */
export function presentNotes(stored: StoredNotes | null) {
  if (!stored) return null;
  return {
    summary: stored.summary,
    points: stored.points,
    actions: stored.actions,
    routeLabel: stored.by.routeLabel,
    isMock: stored.by.isMock,
    private: stored.by.private,
  };
}
