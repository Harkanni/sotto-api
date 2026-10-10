import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProviderHttpError } from '@sotto/ai';
import {
  type Citation,
  type Conversation,
  type Message,
  type Prisma,
  forWorkspace,
  tenantTransaction,
} from '@sotto/db';
import { AuditService } from '../audit/audit.service.js';
import { redisRateLimitStore } from '../auth/rate-limit.js';
import type { Viewer } from '../collections/collections.service.js';
import { ApiException } from '../common/errors.js';
import type { RequestAuth } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService, RedisService } from '../core.module.js';
import { fileVisibleTo } from '../files/access.js';
import { AiService, type AskChat } from './ai.service.js';
import {
  CitationStream,
  FollowUpSplitter,
  buildPrompt,
  retrievalQuery,
  titleFromQuestion,
  type HistoryTurn,
} from './answer.js';
import { type Passage, RetrievalService } from './retrieval.service.js';
import type { AnswerEvent, CitationOut, MessageOut } from './schemas.js';
import { type AskScope, storedScope } from './scope.js';

/** How often a streaming answer is saved, so a reload mid-answer shows what's arrived. */
const SAVE_EVERY_MS = 1_500;
/** How often a running answer checks whether it was stopped (from any api instance). */
const STOP_CHECK_MS = 1_000;
/** An answer still "streaming" after this long was cut off by a restart: shown as failed. */
const STALE_MS = 3 * 60_000;
const MAX_OUTPUT_TOKENS = 1_024;
const CHAT_TIMEOUT_MS = 120_000;
/** Passages shown when no model is configured. */
const PASSAGES_ONLY = 5;
/** Kept with a citation: enough to find and highlight the passage at its source. */
const QUOTE_CHARS = 1_200;

export const ASK_ERRORS: Record<string, string> = {
  chat_unavailable:
    'The model that answers questions isn’t responding. Nothing was sent anywhere else. Try again in a moment.',
  chat_failed: 'The answer stopped part-way. Try again.',
  interrupted: 'This answer was interrupted. Ask again to get a full answer.',
};

type Send = (event: AnswerEvent) => void;

type MessageWithCitations = Message & {
  citations: (Citation & { file: { kind: 'DOCUMENT' | 'AUDIO' | 'NOTE' } | null })[];
};

/**
 * Ask (BRIEF §4–5). A question saves the question and an empty answer, retrieves with the
 * viewer's access and the answering model's sensitivity rule, then streams the model's answer
 * through the follow-up and citation filters, saving as it goes. The answer runs to the end even
 * if the browser goes away, so it's there when they come back; Stop ends it early.
 *
 * Chats are private to the person who started them: every lookup is by id and user.
 */
@Injectable()
export class AskService {
  private readonly log = new Logger('ask');
  private readonly running = new Map<string, AbortController>();
  private readonly limiter;
  private readonly rate: { window: number; max: number };

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RedisService) redis: RedisService,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.limiter = redisRateLimitStore(redis.client, 'rl:ask:');
    this.rate = { window: 60, max: config.ASK_RATE_PER_MINUTE };
  }

  db(workspaceId: string) {
    return forWorkspace(this.prisma.client, workspaceId);
  }

  /** The caller's own chat, or 404 (someone else's chat doesn't exist for them). */
  async conversation(viewer: Viewer, id: string): Promise<Conversation> {
    const found = await this.db(viewer.workspaceId).conversation.findFirst({
      where: { id, userId: viewer.userId },
    });
    if (!found) throw new ApiException(404, 'NOT_FOUND', 'This chat doesn’t exist.');
    return found;
  }

  /** An answer in one of the caller's chats, or 404. */
  async answerOf(viewer: Viewer, id: string) {
    const message = await this.db(viewer.workspaceId).message.findFirst({
      where: { id, role: 'ASSISTANT', conversation: { userId: viewer.userId } },
      include: { conversation: true },
    });
    if (!message) throw new ApiException(404, 'NOT_FOUND', 'This answer doesn’t exist.');
    return message;
  }

  async checkRate(viewer: Viewer): Promise<void> {
    const { allowed, retryAfter } = await this.limiter.consume(viewer.userId, this.rate);
    if (!allowed) {
      throw new ApiException(
        429,
        'TOO_MANY_QUESTIONS',
        `That’s a lot of questions in a minute. Try again in ${retryAfter ?? 60} seconds.`,
      );
    }
  }

  /**
   * Asks `question` in `conversation` (or answers it again, replacing `again`), streaming
   * events to `send` while the browser listens. Resolves when the answer is saved.
   */
  async ask(input: {
    viewer: Viewer;
    auth: RequestAuth;
    conversation: Conversation;
    question?: string;
    again?: Message;
    send: Send;
  }): Promise<void> {
    const { viewer, conversation, send } = input;
    const db = this.db(viewer.workspaceId);
    const chat = this.ai.chat;
    const scope = storedScope(conversation.scope);
    const earlier = await db.message.findMany({
      where: {
        conversationId: conversation.id,
        ...(input.again ? { createdAt: { lt: input.again.createdAt } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    const history = turns(earlier);
    let question: string;
    if (input.again) {
      const asked = earlier.findLast((m) => m.role === 'USER');
      if (!asked) throw new ApiException(409, 'NO_QUESTION', 'There’s no question to answer.');
      question = asked.content;
      history.pop();
    } else {
      question = input.question!;
    }

    const route = chat
      ? { model: chat.model, route: chat.route, routeLabel: chat.routeLabel, isMock: chat.isMock }
      : { model: 'none', route: null, routeLabel: 'Passages only · no AI model', isMock: false };
    const { asked, answer } = await tenantTransaction(db, async (tx) => {
      const asked = input.again
        ? null
        : await tx.message.create({
            data: {
              workspaceId: viewer.workspaceId,
              conversationId: conversation.id,
              role: 'USER',
              content: question,
            },
          });
      const fields = {
        ...route,
        content: '',
        status: 'STREAMING' as const,
        hiddenRestricted: 0,
        hiddenConfidential: 0,
        notFound: false,
        followUps: [],
        error: null,
        inputTokens: null,
        outputTokens: null,
        feedback: null,
      };
      let answer: Message;
      if (input.again) {
        await tx.citation.deleteMany({ where: { messageId: input.again.id } });
        answer = await tx.message.update({ where: { id: input.again.id }, data: fields });
      } else {
        answer = await tx.message.create({
          data: {
            ...fields,
            workspaceId: viewer.workspaceId,
            conversationId: conversation.id,
            role: 'ASSISTANT',
          },
        });
      }
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          updatedAt: new Date(),
          ...(conversation.title ? {} : { title: titleFromQuestion(question) }),
        },
      });
      return { asked, answer };
    });
    await this.audit.record(viewer.workspaceId, input.auth, {
      action: 'ask.asked',
      target: { type: 'conversation', id: conversation.id },
      meta: { route: route.routeLabel },
    });

    send({
      type: 'start',
      conversationId: conversation.id,
      question: asked ? this.present({ ...asked, citations: [] }) : null,
      answer: this.present({ ...answer, citations: [] }),
    });

    const controller = new AbortController();
    this.running.set(answer.id, controller);
    try {
      await this.answer({ viewer, chat, scope, question, history, answer, controller, send });
    } finally {
      this.running.delete(answer.id);
    }
  }

  /** Retrieval, then the model (or the passages alone), saving the result. */
  private async answer(run: {
    viewer: Viewer;
    chat: AskChat | null;
    scope: AskScope;
    question: string;
    history: HistoryTurn[];
    answer: Message;
    controller: AbortController;
    send: Send;
  }): Promise<void> {
    const { viewer, chat, answer, send, controller } = run;
    const db = this.db(viewer.workspaceId);
    const previous = run.history.at(-1)?.question ?? null;
    const found = await this.retrieval.retrieve({
      viewer,
      question: retrievalQuery(run.question, previous),
      scope: run.scope,
      allowed: this.ai.allowedFor(chat),
      limit: chat ? 8 : PASSAGES_ONLY,
      perFile: chat ? 3 : 2,
      signal: controller.signal,
    });
    const hidden = {
      hiddenRestricted: found.hidden.restricted,
      hiddenConfidential: found.hidden.confidential,
    };

    // No model, or nothing to answer from: no model call at all.
    if (!chat || !found.passages.length) {
      const cited = chat ? [] : found.passages.map((p, i) => [i + 1, p] as const);
      for (const [n, p] of cited) send({ type: 'cite', citation: citationOf(n, p) });
      const done = await this.finish(db, answer.id, {
        ...hidden,
        status: 'DONE',
        content: '',
        notFound: !found.passages.length,
        citations: cited.map(([n, p]) => citationRow(viewer.workspaceId, answer.id, n, p)),
      });
      send({ type: 'done', answer: done });
      return;
    }

    const passages = found.passages;
    const cites = new CitationStream(passages.length, (n, source) =>
      send({ type: 'cite', citation: citationOf(n, passages[source - 1]!) }),
    );
    const followUps = new FollowUpSplitter();
    let content = '';
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let savedAt = Date.now();
    let checkedAt = Date.now();
    const emit = (text: string) => {
      if (!text) return;
      content += text;
      send({ type: 'token', text });
    };

    try {
      const stream = chat.provider.stream({
        model: chat.model,
        messages: buildPrompt({ question: run.question, passages, history: run.history }),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
      });
      for await (const chunk of stream) {
        if (chunk.type === 'done') {
          usage = chunk.usage;
          continue;
        }
        emit(cites.push(followUps.push(chunk.text)));
        const now = Date.now();
        if (now - checkedAt > STOP_CHECK_MS) {
          checkedAt = now;
          const current = await db.message.findUnique({
            where: { id: answer.id },
            select: { status: true },
          });
          if (current?.status === 'STOPPED') controller.abort();
        }
        if (now - savedAt > SAVE_EVERY_MS) {
          savedAt = now;
          await db.message.update({
            where: { id: answer.id },
            data: { content: content.trimStart() },
          });
        }
      }
      const tail = followUps.end();
      // The saved answer is trimmed; the stream ends the same way.
      emit((cites.push(tail.text) + cites.end()).trimEnd());
      const done = await this.finish(db, answer.id, {
        ...hidden,
        status: 'DONE',
        content: content.trim(),
        notFound: cites.cited.length === 0,
        followUps: tail.followUps,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        citations: cites.cited.map(([n, source]) =>
          citationRow(viewer.workspaceId, answer.id, n, passages[source - 1]!),
        ),
      });
      send({ type: 'done', answer: done });
    } catch (error) {
      const stopped = controller.signal.aborted;
      emit(cites.end());
      const code = stopped ? null : errorCode(error);
      if (!stopped) this.log.warn(`answer failed (${code}: ${errorName(error)})`);
      const done = await this.finish(db, answer.id, {
        ...hidden,
        status: stopped ? 'STOPPED' : 'FAILED',
        content: content.trim(),
        error: code,
        citations: cites.cited.map(([n, source]) =>
          citationRow(viewer.workspaceId, answer.id, n, passages[source - 1]!),
        ),
      });
      if (stopped) send({ type: 'done', answer: done });
      else send({ type: 'error', code: code!, message: ASK_ERRORS[code!]! });
    }
  }

  /** Saves the answer's final state and its citations, and returns it as the API shows it. */
  private async finish(
    db: ReturnType<AskService['db']>,
    id: string,
    data: Omit<Prisma.MessageUncheckedUpdateInput, 'citations'> & {
      citations: Prisma.CitationCreateManyInput[];
    },
  ): Promise<MessageOut> {
    const { citations, ...fields } = data;
    const saved = await tenantTransaction(db, async (tx) => {
      await tx.citation.deleteMany({ where: { messageId: id } });
      if (citations.length) await tx.citation.createMany({ data: citations });
      return tx.message.update({
        where: { id },
        data: fields,
        include: {
          citations: { orderBy: { n: 'asc' }, include: { file: { select: { kind: true } } } },
        },
      });
    });
    // Just retrieved with the viewer's access, so every source is available.
    return this.present(saved);
  }

  /** Stops an answer that's still being written (on whichever api instance runs it). */
  async stop(viewer: Viewer, id: string): Promise<void> {
    const message = await this.answerOf(viewer, id);
    if (message.status !== 'STREAMING') return;
    await this.db(viewer.workspaceId).message.updateMany({
      where: { id, status: 'STREAMING' },
      data: { status: 'STOPPED' },
    });
    this.running.get(id)?.abort();
  }

  /**
   * Messages as the API shows them. Citations are checked against what the viewer can open
   * now: a file deleted, trashed or no longer theirs to see keeps its number but loses its
   * title and passage.
   */
  async presentAll(viewer: Viewer, messages: MessageWithCitations[]): Promise<MessageOut[]> {
    const fileIds = [
      ...new Set(messages.flatMap((m) => m.citations.map((c) => c.fileId)).filter(Boolean)),
    ] as string[];
    const visible = new Set(
      fileIds.length
        ? (
            await this.db(viewer.workspaceId).file.findMany({
              where: { AND: [{ id: { in: fileIds } }, { deletedAt: null }, fileVisibleTo(viewer)] },
              select: { id: true },
            })
          ).map((f) => f.id)
        : [],
    );
    return messages.map((m) => this.present(m, visible));
  }

  present(
    m: MessageWithCitations | (Message & { citations: [] }),
    visible?: Set<string>,
  ): MessageOut {
    const stale = m.status === 'STREAMING' && Date.now() - m.updatedAt.getTime() > STALE_MS;
    const status = stale ? 'FAILED' : m.status;
    const error = stale ? 'interrupted' : m.error;
    return {
      id: m.id,
      role: m.role === 'USER' ? 'user' : 'assistant',
      content: m.content,
      status: status.toLowerCase() as MessageOut['status'],
      model: m.model,
      route:
        m.role === 'ASSISTANT' && m.routeLabel
          ? {
              kind: m.route ? (m.route.toLowerCase() as 'private' | 'byok' | 'managed') : null,
              label: m.routeLabel,
            }
          : null,
      isMock: m.isMock,
      passagesOnly: m.role === 'ASSISTANT' && m.model === 'none',
      hidden: { restricted: m.hiddenRestricted, confidential: m.hiddenConfidential },
      notFound: m.notFound,
      followUps: m.followUps,
      error: error ? { code: error, message: ASK_ERRORS[error] ?? ASK_ERRORS.chat_failed! } : null,
      feedback: m.feedback,
      citations: (m.citations as MessageWithCitations['citations']).map((c) => {
        const available = c.fileId !== null && (!visible || visible.has(c.fileId));
        return {
          n: c.n,
          available,
          fileId: available ? c.fileId : null,
          kind: available && c.file ? (c.file.kind.toLowerCase() as CitationOut['kind']) : null,
          title: available ? c.title : null,
          page: available ? c.page : null,
          startMs: available ? c.startMs : null,
          endMs: available ? c.endMs : null,
          quote: available ? c.quote : null,
        };
      }),
      createdAt: m.createdAt.toISOString(),
    };
  }
}

/** Question-and-answer pairs from a chat's messages, oldest first. */
function turns(messages: { role: 'USER' | 'ASSISTANT'; content: string }[]): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const m of messages) {
    if (m.role === 'USER') out.push({ question: m.content, answer: '' });
    else if (out.length) out[out.length - 1]!.answer = m.content;
  }
  return out;
}

function citationOf(n: number, p: Passage): CitationOut {
  return {
    n,
    available: true,
    fileId: p.fileId,
    kind: p.kind.toLowerCase() as CitationOut['kind'],
    title: p.title,
    page: p.page,
    startMs: p.startMs,
    endMs: p.endMs,
    quote: p.text.slice(0, QUOTE_CHARS),
  };
}

function citationRow(
  workspaceId: string,
  messageId: string,
  n: number,
  p: Passage,
): Prisma.CitationCreateManyInput {
  return {
    workspaceId,
    messageId,
    n,
    chunkId: p.chunkId,
    fileId: p.fileId,
    title: p.title,
    page: p.page,
    startMs: p.startMs,
    endMs: p.endMs,
    quote: p.text.slice(0, QUOTE_CHARS),
  };
}

function errorCode(error: unknown): string {
  if (error instanceof ProviderHttpError) return 'chat_unavailable';
  if (error instanceof TypeError && /fetch/i.test(error.message)) return 'chat_unavailable';
  if (error instanceof Error && error.name === 'TimeoutError') return 'chat_unavailable';
  return 'chat_failed';
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}
