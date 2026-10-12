import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Queues } from '@sotto/contracts';
import { type LiveSession, forWorkspace, tenantTransaction } from '@sotto/db';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { UsageService } from '../billing/usage.service.js';
import { CollectionsService, type Viewer } from '../collections/collections.service.js';
import { ApiException } from '../common/errors.js';
import type { RequestAuth } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { fileVisibleTo } from '../files/access.js';
import { FilesService, toSensitivity } from '../files/files.service.js';
import { newFileId } from '../files/uploads.controller.js';
import { QueueService, StorageService } from '../infra.module.js';
import {
  AHEAD_ALLOWANCE_MS,
  IDLE_END_MS,
  MAX_CHUNK_BYTES,
  MAX_SESSION_MS,
  msOf,
  toWav,
  wavHeader,
} from './audio.js';
import { type LiveEvent, LiveHub } from './live.hub.js';
import type { LiveSegmentSchema, LiveSessionSchema, StartLive } from './schemas.js';
import { LiveNotesService, type StoredNotes, presentNotes } from './notes.service.js';
import { LiveTranscriber, TranscriberError } from './transcriber.js';

type SessionOut = z.infer<typeof LiveSessionSchema>;
type SegmentOut = z.infer<typeof LiveSegmentSchema>;
type Who = Pick<RequestAuth, 'ip'> & { user: { id: string } };

const OPEN = ['CONNECTING', 'LIVE'] as const;
const SWEEP_EVERY_MS = 60_000;
/** On End, how long to wait for chunks still being transcribed before saving the meeting. */
const END_DRAIN_MS = 20_000;

const lower = <T extends string>(value: T) => value.toLowerCase() as Lowercase<T>;

/** "Live meeting, 12 Oct 09:30" in UTC: the browser sends its own title with local time. */
function defaultTitle(now: Date): string {
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `Live meeting, ${date} ${time}`;
}

export function segmentId(seq: number, idx: number): string {
  return `${seq}.${idx}`;
}

/** Parses a browser's Last-Event-ID ("12.3") into the point to resume after. */
export function resumeAfter(lastEventId: string | undefined): { seq: number; idx: number } | null {
  const match = /^(\d{1,6})\.(\d{1,4})$/.exec(lastEventId ?? '');
  return match ? { seq: Number(match[1]), idx: Number(match[2]) } : null;
}

/**
 * Listen mode and, later, the notetaker bot: a call captured live.
 *
 * - **Start** creates the meeting's File (source LIVE, status UPLOADING) and the session, so the
 *   call shows in Meetings while it happens.
 * - **Chunks** arrive numbered from 0 as raw 16 kHz PCM16 (see audio.ts). Each is stored under
 *   the file, counted in order (a resend is a no-op, a gap is refused), then transcribed in the
 *   background, one at a time per session, and pushed to every viewer as `segment` events.
 * - **End** (or ten silent minutes) joins the chunks into `original.wav` and hands the file to the
 *   normal pipeline, which writes the full-quality transcript, peaks and insights.
 */
@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('live');
  /** Per session: the chain of transcriptions, so lines arrive in the order they were spoken. */
  private readonly chains = new Map<string, Promise<void>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(LiveTranscriber) private readonly transcriber: LiveTranscriber,
    @Inject(LiveHub) private readonly hub: LiveHub,
    @Inject(LiveNotesService) private readonly notes: LiveNotesService,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === 'test') return; // tests call sweep() themselves
    this.sweeper = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  private db(workspaceId: string) {
    return forWorkspace(this.prisma.client, workspaceId);
  }

  // ── Start ──────────────────────────────────────────────────────────────────────────────────

  async start(viewer: Viewer, by: Who, body: z.infer<typeof StartLive>): Promise<SessionOut> {
    if (body.collectionId) {
      await this.collections.require(
        viewer,
        body.collectionId,
        'EDIT',
        'You can view this collection but not add meetings to it.',
      );
    }
    // Recording minutes are what a live capture uses up; checked before anything starts.
    await this.usage.checkUpload(viewer.workspaceId, 'AUDIO', 0);
    const id = newFileId();
    const now = new Date();
    const { file, session } = await tenantTransaction(this.db(viewer.workspaceId), async (tx) => {
      const file = await tx.file.create({
        data: {
          id,
          workspaceId: viewer.workspaceId,
          collectionId: body.collectionId ?? null,
          ownerId: viewer.userId,
          kind: 'AUDIO',
          source: 'LIVE',
          title: body.title ?? defaultTitle(now),
          sensitivity: body.sensitivity ? toSensitivity(body.sensitivity) : 'INTERNAL',
          storageKey: this.storage.keys.original(viewer.workspaceId, id, 'live.wav'),
          mime: 'audio/wav',
          sizeBytes: 0n,
          durationMs: 0,
        },
      });
      const session = await tx.liveSession.create({
        data: {
          workspaceId: viewer.workspaceId,
          fileId: file.id,
          startedById: viewer.userId,
          source: 'LISTEN',
          inputs: body.inputs,
        },
      });
      return { file, session };
    });
    await this.files.emit(file, 'status');
    return this.present(viewer, session);
  }

  // ── Reading ────────────────────────────────────────────────────────────────────────────────

  /** The session if the viewer can open its meeting; 404 otherwise (as for files). */
  async open(viewer: Viewer, id: string): Promise<LiveSession> {
    const session = await this.db(viewer.workspaceId).liveSession.findFirst({ where: { id } });
    if (!session) {
      throw new ApiException(
        404,
        'NOT_FOUND',
        'This live meeting doesn’t exist, or you can’t open it.',
      );
    }
    try {
      await this.files.open(viewer, session.fileId);
    } catch {
      throw new ApiException(
        404,
        'NOT_FOUND',
        'This live meeting doesn’t exist, or you can’t open it.',
      );
    }
    return session;
  }

  async present(viewer: Viewer, session: LiveSession): Promise<SessionOut> {
    const [{ file, access }, starter, engine] = await Promise.all([
      this.files.open(viewer, session.fileId),
      session.startedById
        ? this.db(viewer.workspaceId).membership.findFirst({
            where: { userId: session.startedById },
            select: { user: { select: { id: true, name: true, email: true } } },
          })
        : null,
      this.transcriber.engine(),
    ]);
    return {
      id: session.id,
      source: lower(session.source),
      status: lower(session.status),
      inputs: session.inputs as SessionOut['inputs'],
      durationMs: session.durationMs,
      nextSeq: session.nextSeq,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      startedBy: starter
        ? {
            id: starter.user.id,
            name: starter.user.name || starter.user.email.split('@')[0]!,
          }
        : null,
      canControl: session.startedById === viewer.userId && OPEN.includes(session.status as never),
      transcriber: engine ? { engine: engine.active, isMock: engine.isMock } : null,
      notes: presentNotes(session.notes as StoredNotes | null),
      notesAt: session.notesAt?.toISOString() ?? null,
      notesError: session.notesError,
      error: session.error,
      file: this.files.present(file, access),
    };
  }

  /** Live meetings happening now that the viewer can open (Home and Meetings show them). */
  async active(viewer: Viewer): Promise<SessionOut[]> {
    const files = await this.db(viewer.workspaceId).file.findMany({
      where: {
        AND: [
          fileVisibleTo(viewer),
          { deletedAt: null },
          { liveSession: { status: { in: [...OPEN] } } },
        ],
      },
      select: { liveSession: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const out: SessionOut[] = [];
    for (const { liveSession } of files) {
      if (liveSession) out.push(await this.present(viewer, liveSession));
    }
    return out;
  }

  async segments(
    workspaceId: string,
    sessionId: string,
    after: { seq: number; idx: number } | null,
  ): Promise<SegmentOut[]> {
    const rows = await this.db(workspaceId).liveSegment.findMany({
      where: {
        sessionId,
        ...(after
          ? { OR: [{ seq: { gt: after.seq } }, { seq: after.seq, idx: { gt: after.idx } }] }
          : {}),
      },
      orderBy: [{ seq: 'asc' }, { idx: 'asc' }],
    });
    return rows.map((r) => ({
      id: segmentId(r.seq, r.idx),
      seq: r.seq,
      idx: r.idx,
      startMs: r.startMs,
      endMs: r.endMs,
      text: r.text,
      speaker: r.speaker,
    }));
  }

  /** The SSE stream: the session, the transcript since `lastEventId`, then everything live. */
  async stream(viewer: Viewer, id: string, lastEventId: string | undefined) {
    const session = await this.open(viewer, id);
    return this.hub.connect(session.id, async () => {
      const fresh = await this.db(viewer.workspaceId).liveSession.findFirstOrThrow({
        where: { id: session.id },
      });
      const segments = await this.segments(
        viewer.workspaceId,
        session.id,
        resumeAfter(lastEventId),
      );
      return [
        { type: 'session', data: await this.present(viewer, fresh) },
        ...segments.map((s): LiveEvent => ({ type: 'segment', data: s, id: s.id })),
      ];
    });
  }

  // ── Audio ──────────────────────────────────────────────────────────────────────────────────

  /** The starter's open session, or the reason they can't send to it. */
  private async controlled(viewer: Viewer, id: string): Promise<LiveSession> {
    const session = await this.open(viewer, id);
    if (session.startedById !== viewer.userId) {
      throw new ApiException(
        403,
        'NOT_YOURS',
        'Only the person who started listening can send audio or stop it.',
      );
    }
    if (!OPEN.includes(session.status as never)) {
      throw new ApiException(409, 'LIVE_ENDED', 'This live meeting has ended.');
    }
    return session;
  }

  async chunk(viewer: Viewer, id: string, seq: number, pcm: Buffer) {
    const session = await this.controlled(viewer, id);
    if (!pcm.length || pcm.length % 2 !== 0 || pcm.length > MAX_CHUNK_BYTES) {
      throw new ApiException(
        400,
        'BAD_AUDIO',
        'Each piece of audio must be up to 15 seconds of 16 kHz mono 16-bit PCM.',
      );
    }
    if (seq < session.nextSeq) {
      return { accepted: false, nextSeq: session.nextSeq, durationMs: session.durationMs };
    }
    if (seq > session.nextSeq) {
      throw new ApiException(
        409,
        'CHUNK_GAP',
        `Audio piece ${session.nextSeq} hasn’t arrived yet. Send it before piece ${seq}.`,
      );
    }
    const ms = msOf(pcm.length);
    if (session.durationMs + ms > MAX_SESSION_MS) {
      throw new ApiException(
        409,
        'LIVE_TOO_LONG',
        'Live meetings stop at 6 hours. Start a new one to carry on.',
      );
    }
    const elapsed = Date.now() - session.startedAt.getTime();
    if (session.durationMs + ms > elapsed + AHEAD_ALLOWANCE_MS) {
      throw new ApiException(429, 'TOO_FAST', 'Audio is arriving faster than it can be spoken.');
    }
    // Stored first: if counting it fails, a resend overwrites the same object.
    await this.storage.putBytes(
      this.storage.keys.liveChunk(session.workspaceId, session.fileId, seq),
      pcm,
      'application/octet-stream',
    );
    const now = new Date();
    const { count } = await this.db(session.workspaceId).liveSession.updateMany({
      where: { id: session.id, nextSeq: seq, status: { in: [...OPEN] } },
      data: {
        nextSeq: { increment: 1 },
        durationMs: { increment: ms },
        lastChunkAt: now,
        status: 'LIVE',
      },
    });
    if (count === 0) {
      // Another request counted this number first (a retry racing the original).
      const current = await this.db(session.workspaceId).liveSession.findFirstOrThrow({
        where: { id: session.id },
      });
      return { accepted: false, nextSeq: current.nextSeq, durationMs: current.durationMs };
    }
    const offsetMs = session.durationMs;
    if (session.status === 'CONNECTING') {
      const updated = await this.db(session.workspaceId).liveSession.findFirstOrThrow({
        where: { id: session.id },
      });
      await this.announce(viewer, updated);
      const file = await this.db(session.workspaceId).file.findFirstOrThrow({
        where: { id: session.fileId },
      });
      await this.files.emit(file, 'status');
    }
    this.enqueue(session, seq, offsetMs, pcm);
    return { accepted: true, nextSeq: seq + 1, durationMs: offsetMs + ms };
  }

  /** Tells everyone watching that the session changed (status, notes, a problem). */
  private async announce(viewer: Viewer, session: LiveSession): Promise<void> {
    await this.hub.publish(session.id, {
      type: 'session',
      data: await this.present(viewer, session),
    });
  }

  private enqueue(session: LiveSession, seq: number, offsetMs: number, pcm: Buffer): void {
    const previous = this.chains.get(session.id) ?? Promise.resolve();
    const next = previous
      .then(() => this.transcribe(session, seq, offsetMs, pcm))
      .catch((error: unknown) => {
        this.log.warn(
          `live chunk not transcribed (${error instanceof Error ? error.name : 'error'})`,
        );
      });
    this.chains.set(session.id, next);
    void next.finally(() => {
      if (this.chains.get(session.id) === next) this.chains.delete(session.id);
    });
  }

  /** Resolves once every chunk received so far has been transcribed (or failed). */
  async settled(sessionId: string): Promise<void> {
    await this.chains.get(sessionId);
  }

  private async transcribe(session: LiveSession, seq: number, offsetMs: number, pcm: Buffer) {
    const db = this.db(session.workspaceId);
    const file = await db.file.findFirst({
      where: { id: session.fileId },
      select: { sensitivity: true },
    });
    if (!file) return; // deleted meanwhile
    let error: string | null = null;
    try {
      const result = await this.transcriber.transcribe(toWav(pcm), {
        inClusterOnly: file.sensitivity === 'RESTRICTED',
      });
      const chunkMs = msOf(pcm.length);
      const rows = result.segments
        .filter((s) => s.text.trim())
        .map((s, idx) => {
          const startMs = offsetMs + Math.min(Math.max(0, s.startMs), chunkMs);
          const endMs = offsetMs + Math.min(Math.max(s.endMs, s.startMs, 0), chunkMs);
          return {
            workspaceId: session.workspaceId,
            sessionId: session.id,
            seq,
            idx,
            startMs,
            endMs: Math.max(endMs, startMs),
            text: s.text.trim(),
            speaker: s.speaker ?? null,
          };
        });
      if (rows.length) {
        await db.liveSegment.createMany({ data: rows, skipDuplicates: true });
        for (const row of rows) {
          const data: SegmentOut = {
            id: segmentId(row.seq, row.idx),
            seq: row.seq,
            idx: row.idx,
            startMs: row.startMs,
            endMs: row.endMs,
            text: row.text,
            speaker: row.speaker,
          };
          await this.hub.publish(session.id, { type: 'segment', data, id: data.id });
        }
        // Running notes, when they're due; written beside the transcription, never in its way.
        this.notes.refresh(session.workspaceId, session.id);
      }
    } catch (failure) {
      error = failure instanceof TranscriberError ? failure.code : 'transcriber_failed';
    }
    // Only a change is worth telling viewers about: a new problem, or one that cleared.
    const current = await db.liveSession.findFirst({ where: { id: session.id } });
    if (current && current.error !== error) {
      const updated = await db.liveSession.update({ where: { id: session.id }, data: { error } });
      await this.publishSystem(updated);
    }
  }

  /** A session event built for its starter's view (`canControl` differs per viewer; the web
   * re-reads it from GET /live-sessions/:id on a session event). */
  private async publishSystem(session: LiveSession): Promise<void> {
    if (!session.startedById) return;
    const membership = await this.db(session.workspaceId).membership.findFirst({
      where: { userId: session.startedById },
      select: { role: true },
    });
    if (!membership) return;
    await this.announce(
      { userId: session.startedById, role: membership.role, workspaceId: session.workspaceId },
      session,
    );
  }

  /** "Update notes" while listening: writes them now if anything new was said. */
  async refreshNotes(viewer: Viewer, id: string): Promise<SessionOut> {
    const session = await this.controlled(viewer, id);
    this.notes.refresh(session.workspaceId, session.id, { force: true });
    await this.notes.settled(session.id);
    const fresh = await this.db(session.workspaceId).liveSession.findFirstOrThrow({
      where: { id: session.id },
    });
    return this.present(viewer, fresh);
  }

  // ── End ────────────────────────────────────────────────────────────────────────────────────

  async end(viewer: Viewer, by: Who, id: string) {
    const session = await this.open(viewer, id);
    if (session.startedById !== viewer.userId) {
      throw new ApiException(
        403,
        'NOT_YOURS',
        'Only the person who started listening can stop it.',
      );
    }
    if (session.status === 'ENDED') {
      return { discarded: false, session: await this.present(viewer, session) };
    }
    if (session.status === 'FAILED') {
      throw new ApiException(409, 'LIVE_FAILED', 'This live meeting couldn’t be saved.');
    }
    return this.finish(session, by, viewer);
  }

  /**
   * Ends a session exactly once (whoever wins the status change does the work): no audio →
   * the empty meeting is removed; otherwise the chunks become `original.wav` and the pipeline
   * takes it from there.
   */
  private async finish(session: LiveSession, by: Who | null, viewer: Viewer | null) {
    const db = this.db(session.workspaceId);
    const endedAt = new Date();
    const { count } = await db.liveSession.updateMany({
      where: { id: session.id, status: { in: [...OPEN] } },
      data: { status: 'ENDED', endedAt },
    });
    if (count === 0) {
      const current = await db.liveSession.findFirst({ where: { id: session.id } });
      if (!current) return { discarded: true, session: null };
      return { discarded: false, session: viewer ? await this.present(viewer, current) : null };
    }

    const file = await db.file.findFirstOrThrow({ where: { id: session.fileId } });
    if (session.nextSeq === 0) {
      await this.storage.deletePrefix(this.storage.keys.file(session.workspaceId, file.id));
      await db.file.delete({ where: { id: file.id } });
      await this.files.emit({ ...file, deletedAt: endedAt }, 'removed');
      await this.hub.publish(session.id, {
        type: 'session',
        data: { id: session.id, status: 'ended', discarded: true },
      });
      return { discarded: true, session: null };
    }

    // Let the last lines land so everyone watching sees the whole call before it's saved.
    await Promise.race([
      this.settled(session.id),
      new Promise((resolve) => setTimeout(resolve, END_DRAIN_MS).unref()),
    ]);

    try {
      const dataBytes = await this.chunkBytes(session);
      const storage = this.storage;
      const pieces = async function* () {
        yield wavHeader(dataBytes);
        for (let seq = 0; seq < session.nextSeq; seq++) {
          yield await storage.getBytes(storage.keys.liveChunk(session.workspaceId, file.id, seq));
        }
      };
      const size = await this.storage.putFromPieces(file.storageKey, pieces(), 'audio/wav');
      const updated = await db.file.update({
        where: { id: file.id },
        data: {
          status: 'UPLOADED',
          statusAt: new Date(),
          sizeBytes: BigInt(size),
          durationMs: msOf(dataBytes),
        },
      });
      await this.queue.publish(Queues.fileUploaded, {
        v: 1,
        fileId: file.id,
        workspaceId: session.workspaceId,
        kind: updated.kind,
        storageKey: updated.storageKey,
        mime: updated.mime,
      });
      await this.files.emit(updated, 'status');
      const entry = {
        action: 'file.recorded' as const,
        target: { type: 'file' as const, id: file.id },
        meta: { name: updated.title, kind: 'audio', live: true },
      };
      if (by) await this.audit.record(session.workspaceId, by, entry);
      else await this.audit.recordSystem(session.workspaceId, entry);
      // The joined recording replaces the pieces.
      await this.storage
        .deletePrefix(`${this.storage.keys.file(session.workspaceId, file.id)}live/`)
        .catch(() => undefined);
    } catch (error) {
      this.log.warn(`live meeting not saved (${error instanceof Error ? error.name : 'error'})`);
      await db.liveSession.update({
        where: { id: session.id },
        data: { status: 'FAILED', error: 'save_failed' },
      });
      const failed = await db.file.update({
        where: { id: file.id },
        data: { status: 'FAILED', statusAt: new Date(), error: 'live_save_failed' },
      });
      await this.files.emit(failed, 'status');
      const current = await db.liveSession.findFirstOrThrow({ where: { id: session.id } });
      await this.publishSystem(current);
      throw new ApiException(
        502,
        'LIVE_SAVE_FAILED',
        'The meeting couldn’t be saved. The audio is kept; try again in a minute.',
      );
    }
    const current = await db.liveSession.findFirstOrThrow({ where: { id: session.id } });
    await this.publishSystem(current);
    return { discarded: false, session: viewer ? await this.present(viewer, current) : null };
  }

  /** Bytes of audio stored: the sum of the chunks' sizes (needed up front for the WAV header). */
  private async chunkBytes(session: LiveSession): Promise<number> {
    let total = 0;
    for (let seq = 0; seq < session.nextSeq; seq++) {
      const head = await this.storage.head(
        this.storage.keys.liveChunk(session.workspaceId, session.fileId, seq),
      );
      total += head.size;
    }
    return total;
  }

  // ── Idle captures ──────────────────────────────────────────────────────────────────────────

  /** Ends captures that stopped sending (closed tab, lost network) after ten quiet minutes. */
  async sweep(now = new Date()): Promise<number> {
    const quiet = new Date(now.getTime() - IDLE_END_MS);
    const stale = await this.prisma.client.liveSession.findMany({
      where: {
        status: { in: [...OPEN] },
        OR: [{ lastChunkAt: { lt: quiet } }, { lastChunkAt: null, startedAt: { lt: quiet } }],
      },
      take: 50,
    });
    let ended = 0;
    for (const session of stale) {
      try {
        await this.finish(session, null, null);
        ended++;
      } catch {
        // Recorded on the session; the next sweep doesn't retry a FAILED one.
      }
    }
    return ended;
  }
}
