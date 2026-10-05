import { createHash } from 'node:crypto';
import { type ChatProvider, type EmbeddingProvider, canSend } from '@sotto/ai';
import {
  type FileEvent,
  type FileUploaded,
  PagesDocument,
  Queues,
  type TranscribeCompleted,
  type TranscribeProgress,
  type TranscribeRequested,
  TranscriptDocument,
} from '@sotto/contracts';
import {
  type File,
  type FileStatus,
  type PrismaClient,
  type TenantClient,
  ensureEmbeddingIndex,
  forWorkspace,
  tenantTransaction,
  writeEmbeddings,
} from '@sotto/db';
import { Derived, ObjectMissingError, type Storage } from '@sotto/storage';
import { type ChunkDraft, type Line, chunkPages, chunkTranscript } from './chunk.js';
import { ExtractError, extract } from './extract.js';
import { basicInsights, modelInsights } from './insights.js';

/**
 * The ingestion pipeline, one handler per message. Handlers know nothing about RabbitMQ: they
 * take a message and their dependencies, so tests drive them directly and the transport
 * (main.ts) owns acks, retries and the dead-letter queue.
 *
 *   file.uploaded          DOCUMENT → INDEXING → extract → pages.json → chunk → embed → READY
 *                          AUDIO    → TRANSCRIBING, and asks the transcriber
 *   transcribe.progress    updates the status ring
 *   transcribe.completed   → INDEXING → transcript rows → chunk → embed → notes → READY
 */

export interface Deps {
  prisma: PrismaClient;
  storage: Storage;
  publish: (
    queue: typeof Queues.transcribeRequested,
    message: TranscribeRequested,
  ) => Promise<void>;
  emit: (workspaceId: string, event: Omit<FileEvent, 'type' | 'at'>) => Promise<void>;
  embeddings: EmbeddingProvider;
  chat: { provider: ChatProvider; model: string } | null;
  /** Documents larger than this aren't read into memory (a 2 GB "PDF" is a mistake or an attack). */
  maxDocumentBytes: number;
  /** Vector storage; defaults to pgvector through @sotto/db (tests may record instead). */
  vectors?: Vectors;
}

export interface Vectors {
  ensureIndex(model: string, dims: number): Promise<void>;
  write(
    workspaceId: string,
    model: string,
    dims: number,
    rows: { chunkId: string; vector: number[] }[],
  ): Promise<void>;
}

export function pgVectors(prisma: PrismaClient): Vectors {
  return {
    ensureIndex: (model, dims) => ensureEmbeddingIndex(prisma, model, dims),
    write: async (workspaceId, model, dims, rows) => {
      await writeEmbeddings(prisma, workspaceId, model, dims, rows);
    },
  };
}

/**
 * A failure that retrying won't fix: the file is marked FAILED with this code at once. Anything
 * else is treated as transient (a provider or storage blip) and retried by the transport.
 */
export class PermanentFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentFailure';
  }
}

/** The code shown for a failure once retries run out. */
export function failureCode(error: unknown): string {
  if (error instanceof PermanentFailure) return error.code;
  if (error instanceof Error && error.name === 'ProviderHttpError') return 'embedding_unavailable';
  if (error instanceof TypeError && /fetch/i.test(error.message)) return 'embedding_unavailable';
  return 'processing_failed';
}

const EMBED_BATCH = 64;
const indexed = new WeakMap<Vectors, Set<string>>();

type Scoped = TenantClient;

async function setStatus(
  deps: Deps,
  db: Scoped,
  file: File,
  status: FileStatus,
  extra: { progress?: number | null; error?: string | null } & Partial<
    Pick<File, 'pageCount' | 'durationMs' | 'checksum'>
  > = {},
): Promise<File> {
  const updated = await db.file.update({
    where: { id: file.id },
    data: {
      status,
      statusAt: new Date(),
      progress: extra.progress ?? null,
      error: extra.error ?? null,
      ...(extra.pageCount !== undefined ? { pageCount: extra.pageCount } : {}),
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
      ...(extra.checksum !== undefined ? { checksum: extra.checksum } : {}),
    },
  });
  await deps.emit(file.workspaceId, {
    fileId: updated.id,
    collectionId: updated.collectionId,
    ownerId: updated.ownerId,
    deleted: Boolean(updated.deletedAt),
    status: updated.status,
    progress: updated.progress,
    error: updated.error,
    change: 'status',
  });
  return updated;
}

/** Marks a file failed (called by the transport when retries run out, too). */
export async function markFailed(
  deps: Deps,
  workspaceId: string,
  fileId: string,
  code: string,
): Promise<void> {
  const db = forWorkspace(deps.prisma, workspaceId);
  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file || file.status === 'READY') return;
  await setStatus(deps, db, file, 'FAILED', { error: code.slice(0, 200) });
}

async function readAll(storage: Storage, key: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of await storage.getStream(key)) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** sha256 of a stored object, streamed, so a long recording never sits in memory. */
async function checksumOf(storage: Storage, key: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const part of await storage.getStream(key)) hash.update(part as Buffer);
  return hash.digest('hex');
}

/** Replaces a file's passages and their vectors (re-running a job is harmless). */
async function index(deps: Deps, db: Scoped, file: File, drafts: ChunkDraft[]): Promise<void> {
  const chunks = await tenantTransaction(db, async (tx) => {
    await tx.chunk.deleteMany({ where: { fileId: file.id } });
    if (!drafts.length) return [];
    return tx.chunk.createManyAndReturn({
      data: drafts.map((d, idx) => ({
        workspaceId: file.workspaceId,
        fileId: file.id,
        collectionId: file.collectionId,
        sensitivity: file.sensitivity,
        idx,
        text: d.text,
        tokenCount: d.tokenCount,
        page: d.page,
        startMs: d.startMs,
        endMs: d.endMs,
      })),
      select: { id: true, idx: true, text: true },
    });
  });

  // Embeddings always run in-house (BRIEF §3); a third-party embedder is a configuration error.
  if (deps.embeddings.dataLocation !== 'IN_CLUSTER') {
    throw new PermanentFailure('embedding_not_private');
  }
  const ordered = [...chunks].sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < ordered.length; i += EMBED_BATCH) {
    const batch = ordered.slice(i, i + EMBED_BATCH);
    const vectors = await deps.embeddings.embed(
      batch.map((c) => c.text),
      { purpose: 'document' },
    );
    const dims = vectors[0]?.length ?? deps.embeddings.dimensions;
    const model = `${deps.embeddings.id}:${deps.embeddings.model}`;
    const store = (deps.vectors ??= pgVectors(deps.prisma));
    const seen = indexed.get(store) ?? new Set<string>();
    if (!seen.has(model)) {
      await store.ensureIndex(model, dims);
      seen.add(model);
      indexed.set(store, seen);
    }
    await store.write(
      file.workspaceId,
      model,
      dims,
      batch.map((c, j) => ({ chunkId: c.id, vector: vectors[j]! })),
    );
  }
}

/** Loads a file the pipeline should still work on: present, not trashed, in the given state. */
async function load(db: Scoped, fileId: string, states: FileStatus[]): Promise<File | null> {
  const file = await db.file.findUnique({ where: { id: fileId } });
  if (!file || file.deletedAt || !states.includes(file.status)) return null;
  return file;
}

export async function onFileUploaded(deps: Deps, msg: FileUploaded): Promise<void> {
  const db = forWorkspace(deps.prisma, msg.workspaceId);
  // Only from UPLOADED: a duplicate delivery of a job already under way is skipped.
  let file = await load(db, msg.fileId, ['UPLOADED']);
  if (!file) return;

  if (file.kind === 'AUDIO') {
    const checksum = await checksumOf(deps.storage, file.storageKey).catch((error: unknown) => {
      if (error instanceof ObjectMissingError) throw new PermanentFailure('storage_missing');
      throw error;
    });
    await setStatus(deps, db, file, 'TRANSCRIBING', { progress: 0, checksum });
    await deps.publish(Queues.transcribeRequested, {
      v: 1,
      fileId: file.id,
      workspaceId: file.workspaceId,
      storageKey: file.storageKey,
      outputPrefix: deps.storage.keys.file(file.workspaceId, file.id),
      sensitivity: file.sensitivity,
    });
    return;
  }

  file = await setStatus(deps, db, file, 'INDEXING');
  if (Number(file.sizeBytes) > deps.maxDocumentBytes) throw new PermanentFailure('too_large');
  let bytes: Buffer;
  try {
    bytes = await readAll(deps.storage, file.storageKey);
  } catch (error) {
    if (error instanceof ObjectMissingError) throw new PermanentFailure('storage_missing');
    throw error;
  }
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let extracted;
  try {
    extracted = await extract(new Uint8Array(bytes), file.mime);
  } catch (error) {
    if (error instanceof ExtractError) throw new PermanentFailure(error.code);
    throw new PermanentFailure('unreadable');
  }
  await deps.storage.putJson(
    deps.storage.keys.derived(file.workspaceId, file.id, Derived.pages),
    PagesDocument.parse({ pages: extracted.pages }),
  );
  await index(deps, db, file, chunkPages(extracted.pages, { paged: extracted.paged }));
  await setStatus(deps, db, file, 'READY', {
    pageCount: extracted.paged ? extracted.pages.length : null,
    checksum,
  });
}

export async function onTranscribeProgress(deps: Deps, msg: TranscribeProgress): Promise<void> {
  const db = forWorkspace(deps.prisma, msg.workspaceId);
  const file = await load(db, msg.fileId, ['TRANSCRIBING']);
  // Progress only moves forward; a late message after a retry doesn't wind the ring back.
  if (!file || (file.progress ?? 0) >= msg.progress) return;
  await setStatus(deps, db, file, 'TRANSCRIBING', { progress: msg.progress });
}

export async function onTranscribeCompleted(deps: Deps, msg: TranscribeCompleted): Promise<void> {
  const db = forWorkspace(deps.prisma, msg.workspaceId);
  let file = await load(db, msg.fileId, ['TRANSCRIBING']);
  if (!file) return;
  if (msg.status === 'failed') {
    await setStatus(deps, db, file, 'FAILED', { error: msg.error });
    return;
  }

  const doc = await deps.storage.getJson(msg.transcriptKey, TranscriptDocument);
  file = await setStatus(deps, db, file, 'INDEXING', { durationMs: doc.durationMs });
  const lines: Line[] = doc.segments
    .map((s) => ({
      startMs: s.startMs,
      endMs: Math.max(s.endMs, s.startMs),
      text: s.text.trim(),
      speaker: s.speaker ?? null,
    }))
    .filter((s) => s.text);

  const current = file;
  await tenantTransaction(db, async (tx) => {
    await tx.transcript.deleteMany({ where: { fileId: current.id } });
    const transcript = await tx.transcript.create({
      data: {
        workspaceId: current.workspaceId,
        fileId: current.id,
        language: doc.language,
        engine: doc.engine,
        model: doc.model,
        isMock: doc.isMock,
      },
    });
    // Batches keep each statement well under Postgres's parameter limit on long meetings.
    for (let i = 0; i < lines.length; i += 1_000) {
      await tx.transcriptSegment.createMany({
        data: lines.slice(i, i + 1_000).map((l, j) => ({
          workspaceId: current.workspaceId,
          transcriptId: transcript.id,
          idx: i + j,
          speaker: l.speaker,
          startMs: l.startMs,
          endMs: l.endMs,
          text: l.text,
        })),
      });
    }
  });

  await index(deps, db, file, chunkTranscript(lines));

  // Sample meetings arrive with their notes already written (onboarding); keep them.
  const existing =
    file.source === 'SAMPLE'
      ? await db.meetingInsights.findUnique({ where: { fileId: file.id }, select: { id: true } })
      : null;
  if (existing) {
    await setStatus(deps, db, file, 'READY', { durationMs: doc.durationMs });
    return;
  }

  // Notes: a private model may read any label; anything else may not read Restricted (BRIEF §3).
  const chat =
    deps.chat &&
    canSend(file.sensitivity, deps.chat.provider.dataLocation, {
      confidentialAllowsThirdParty: false,
    })
      ? deps.chat
      : null;
  const fromModel = chat
    ? await modelInsights(chat.provider, chat.model, lines, doc.durationMs).catch(() => null)
    : null;
  const notes = fromModel ?? basicInsights(lines, doc.durationMs);
  const isMock = !fromModel || Boolean(chat?.provider.isMock);
  const row = {
    summary: notes.summary,
    decisions: notes.decisions,
    actionItems: notes.actionItems,
    openQuestions: notes.openQuestions,
    chapters: notes.chapters,
    model: fromModel && chat ? `${chat.provider.id}:${chat.model}` : 'basic-notes',
    route: 'PRIVATE' as const,
    isMock,
  };
  await db.meetingInsights.upsert({
    where: { fileId: file.id },
    create: { workspaceId: file.workspaceId, fileId: file.id, ...row },
    update: row,
  });

  await setStatus(deps, db, file, 'READY', { durationMs: doc.durationMs });
}

/** Deletes files that have been in the trash for 30 days: storage first, then the row. */
export async function purgeTrash(deps: Deps, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  // System-wide by design: this is the one job that crosses workspaces, and it only deletes.
  const due = await deps.prisma.file.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, workspaceId: true },
    take: 200,
  });
  for (const file of due) {
    await deps.storage.deletePrefix(deps.storage.keys.file(file.workspaceId, file.id));
    await forWorkspace(deps.prisma, file.workspaceId).file.delete({ where: { id: file.id } });
  }
  return due.length;
}
