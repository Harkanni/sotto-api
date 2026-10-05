import { FakeEmbeddingProvider } from '@sotto/ai';
import { PagesDocument, type FileEvent } from '@sotto/contracts';
import { createPrismaClient, type PrismaClient } from '@sotto/db';
import { Derived, Storage, storageEnv } from '@sotto/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Deps,
  PermanentFailure,
  type Vectors,
  markFailed,
  onFileUploaded,
  onTranscribeCompleted,
  onTranscribeProgress,
  pgVectors,
  purgeTrash,
} from '../src/pipeline.js';
import { TEST_DATABASE_URL, TEST_S3_ENDPOINT, createTestDatabase, makePdf } from './helpers.js';

/** The pipeline against real Postgres and S3; vectors in real pgvector when it's installed. */
describe.skipIf(!TEST_DATABASE_URL || !TEST_S3_ENDPOINT)('ingestion pipeline', () => {
  let prisma: PrismaClient;
  let drop: () => Promise<void>;
  let pgvector = false;
  const storage = new Storage(
    storageEnv.parse({
      S3_ENDPOINT: TEST_S3_ENDPOINT,
      S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'sotto-test',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
    }),
  );
  const published: { queue: string; message: Record<string, unknown> }[] = [];
  const events: Omit<FileEvent, 'type' | 'at'>[] = [];
  const recorded: { model: string; dims: number; chunkIds: string[] }[] = [];
  let deps: Deps;
  const ws = 'wspipeline';

  const statuses = (fileId: string) =>
    events.filter((e) => e.fileId === fileId).map((e) => e.status);

  async function newFile(
    id: string,
    kind: 'DOCUMENT' | 'AUDIO',
    mime: string,
    body: Buffer,
    extra: Record<string, unknown> = {},
  ) {
    const key = storage.keys.original(ws, id, kind === 'AUDIO' ? 'a.webm' : 'a.bin');
    await storage.putBytes(key, body, mime);
    return prisma.file.create({
      data: {
        id,
        workspaceId: ws,
        kind,
        title: id,
        status: 'UPLOADED',
        storageKey: key,
        mime,
        sizeBytes: BigInt(body.length),
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    await fetch(`${TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET ?? 'sotto-test'}`, {
      method: 'PUT',
    }).catch(() => undefined);
    const db = await createTestDatabase();
    drop = db.drop;
    pgvector = db.pgvector;
    prisma = createPrismaClient(db.url);
    await prisma.workspace.create({ data: { id: ws, name: 'Pipeline', slug: 'pipeline' } });
    const recorder: Vectors = {
      ensureIndex: async () => undefined,
      write: async (_w, model, dims, rows) => {
        recorded.push({ model, dims, chunkIds: rows.map((r) => r.chunkId) });
      },
    };
    deps = {
      prisma,
      storage,
      embeddings: new FakeEmbeddingProvider(8, 'fake-hash'),
      chat: null,
      maxDocumentBytes: 10 * 1024 * 1024,
      vectors: pgvector ? pgVectors(prisma) : recorder,
      publish: async (queue, message) => {
        published.push({ queue, message });
      },
      emit: async (_w, event) => {
        events.push(event);
      },
    };
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await drop?.();
  });

  it('reads a PDF page by page, indexes it and marks it ready', async () => {
    const pdf = makePdf([
      'Roadmap: answers in under two seconds.',
      'Pricing: keep three tiers.',
      'Hiring: two engineers.',
    ]);
    await newFile('pdf1', 'DOCUMENT', 'application/pdf', pdf);
    await onFileUploaded(deps, {
      v: 1,
      fileId: 'pdf1',
      workspaceId: ws,
      kind: 'DOCUMENT',
      storageKey: 'x',
      mime: 'application/pdf',
    });

    const file = await prisma.file.findUniqueOrThrow({ where: { id: 'pdf1' } });
    expect(file).toMatchObject({ status: 'READY', pageCount: 3, error: null });
    expect(file.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(statuses('pdf1')).toEqual(['INDEXING', 'READY']);

    const chunks = await prisma.chunk.findMany({
      where: { fileId: 'pdf1' },
      orderBy: { idx: 'asc' },
    });
    expect(chunks.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(chunks[1]!.text).toBe('Pricing: keep three tiers.');

    const pages = await storage.getJson(
      storage.keys.derived(ws, 'pdf1', Derived.pages),
      PagesDocument,
    );
    expect(pages.pages.map((p) => p.page)).toEqual([1, 2, 3]);

    if (pgvector) {
      const rows = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM chunk_embeddings WHERE workspace_id = ${ws}`;
      expect(Number(rows[0]!.n)).toBe(3);
    } else {
      expect(recorded.at(-1)).toMatchObject({ model: 'fake:fake-hash', dims: 8 });
      expect(recorded.at(-1)!.chunkIds).toHaveLength(3);
    }
  });

  it('re-processing replaces passages instead of adding to them', async () => {
    await prisma.file.update({ where: { id: 'pdf1' }, data: { status: 'UPLOADED' } });
    await onFileUploaded(deps, {
      v: 1,
      fileId: 'pdf1',
      workspaceId: ws,
      kind: 'DOCUMENT',
      storageKey: 'x',
      mime: 'application/pdf',
    });
    expect(await prisma.chunk.count({ where: { fileId: 'pdf1' } })).toBe(3);
  });

  it('fails unreadable documents for good, with a code', async () => {
    await newFile('bad1', 'DOCUMENT', 'application/pdf', Buffer.from('not a pdf'));
    const error = await onFileUploaded(deps, {
      v: 1,
      fileId: 'bad1',
      workspaceId: ws,
      kind: 'DOCUMENT',
      storageKey: 'x',
      mime: 'application/pdf',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentFailure);
    await markFailed(deps, ws, 'bad1', (error as PermanentFailure).code);
    expect(await prisma.file.findUniqueOrThrow({ where: { id: 'bad1' } })).toMatchObject({
      status: 'FAILED',
      error: 'unreadable',
    });
  });

  it('skips trashed files and duplicate deliveries', async () => {
    await newFile('gone1', 'DOCUMENT', 'text/plain', Buffer.from('hello'), {
      deletedAt: new Date(),
    });
    await onFileUploaded(deps, {
      v: 1,
      fileId: 'gone1',
      workspaceId: ws,
      kind: 'DOCUMENT',
      storageKey: 'x',
      mime: 'text/plain',
    });
    expect((await prisma.file.findUniqueOrThrow({ where: { id: 'gone1' } })).status).toBe(
      'UPLOADED',
    );
    const before = events.length;
    await onFileUploaded(deps, {
      v: 1,
      fileId: 'pdf1',
      workspaceId: ws,
      kind: 'DOCUMENT',
      storageKey: 'x',
      mime: 'application/pdf',
    });
    expect(events.length).toBe(before); // pdf1 is READY: nothing happens
  });

  it('hands a recording to the transcriber, then indexes the transcript and writes notes', async () => {
    await newFile('rec1', 'AUDIO', 'audio/webm', Buffer.from('fake audio'), {
      sensitivity: 'RESTRICTED',
    });
    await onFileUploaded(deps, {
      v: 1,
      fileId: 'rec1',
      workspaceId: ws,
      kind: 'AUDIO',
      storageKey: 'x',
      mime: 'audio/webm',
    });
    expect(published.at(-1)).toMatchObject({
      queue: 'transcribe.requested',
      message: { fileId: 'rec1', outputPrefix: `files/${ws}/rec1/`, sensitivity: 'RESTRICTED' },
    });
    expect((await prisma.file.findUniqueOrThrow({ where: { id: 'rec1' } })).status).toBe(
      'TRANSCRIBING',
    );

    await onTranscribeProgress(deps, { v: 1, fileId: 'rec1', workspaceId: ws, progress: 0.5 });
    await onTranscribeProgress(deps, { v: 1, fileId: 'rec1', workspaceId: ws, progress: 0.4 });
    expect((await prisma.file.findUniqueOrThrow({ where: { id: 'rec1' } })).progress).toBe(0.5);

    // 30 minutes of lines, one every 10 seconds.
    const segments = Array.from({ length: 180 }, (_, i) => ({
      startMs: i * 10_000,
      endMs: i * 10_000 + 9_000,
      text: i === 30 ? 'We decided to ship on Friday.' : `Discussion point ${i} about the roadmap.`,
      speaker: null,
    }));
    const transcriptKey = storage.keys.derived(ws, 'rec1', Derived.transcript);
    await storage.putJson(transcriptKey, {
      engine: 'faster-whisper',
      model: 'base',
      language: 'en',
      durationMs: 1_800_000,
      segments,
    });
    await onTranscribeCompleted(deps, {
      v: 1,
      status: 'ok',
      fileId: 'rec1',
      workspaceId: ws,
      transcriptKey,
      engine: 'faster-whisper',
      model: 'base',
      durationMs: 1_800_000,
    });

    const file = await prisma.file.findUniqueOrThrow({
      where: { id: 'rec1' },
      include: {
        transcript: { include: { segments: { orderBy: { idx: 'asc' } } } },
        insights: true,
      },
    });
    expect(file).toMatchObject({ status: 'READY', durationMs: 1_800_000 });
    expect(file.transcript!.segments).toHaveLength(180);
    expect(file.transcript!.segments[30]).toMatchObject({
      startMs: 300_000,
      text: 'We decided to ship on Friday.',
    });
    expect(file.insights).toMatchObject({ isMock: true, model: 'basic-notes', route: 'PRIVATE' });
    expect(file.insights!.decisions).toEqual(['We decided to ship on Friday.']);

    const chunks = await prisma.chunk.findMany({
      where: { fileId: 'rec1' },
      orderBy: { idx: 'asc' },
    });
    expect(chunks[0]!.startMs).toBe(0);
    expect(chunks.at(-1)!.endMs).toBe(179 * 10_000 + 9_000);
    expect(chunks.every((c) => c.sensitivity === 'RESTRICTED' && c.page === null)).toBe(true);
    expect(statuses('rec1')).toEqual(['TRANSCRIBING', 'TRANSCRIBING', 'INDEXING', 'READY']);
  });

  it('keeps the notes a sample meeting arrives with', async () => {
    await newFile('sample1', 'AUDIO', 'audio/webm', Buffer.from(''), {
      source: 'SAMPLE',
      status: 'TRANSCRIBING',
      insights: {
        create: {
          workspaceId: ws,
          summary: 'Written by hand',
          decisions: [],
          actionItems: [],
          openQuestions: [],
          chapters: [],
          model: 'sample',
          route: 'PRIVATE',
        },
      },
    });
    const transcriptKey = storage.keys.derived(ws, 'sample1', Derived.transcript);
    await storage.putJson(transcriptKey, {
      engine: 'sample',
      model: 'none',
      language: 'en',
      durationMs: 20_000,
      segments: [{ startMs: 0, endMs: 18_000, text: 'Welcome to the sample.', speaker: 'Amaka' }],
    });
    await onTranscribeCompleted(deps, {
      v: 1,
      status: 'ok',
      fileId: 'sample1',
      workspaceId: ws,
      transcriptKey,
      engine: 'sample',
      model: 'none',
      durationMs: 20_000,
    });
    const file = await prisma.file.findUniqueOrThrow({
      where: { id: 'sample1' },
      include: { insights: true, transcript: { include: { segments: true } } },
    });
    expect(file.status).toBe('READY');
    expect(file.insights!.summary).toBe('Written by hand');
    expect(file.transcript!.segments[0]).toMatchObject({ speaker: 'Amaka', startMs: 0 });
    expect(await prisma.chunk.count({ where: { fileId: 'sample1' } })).toBe(1);
  });

  it('records a transcription failure', async () => {
    await newFile('rec2', 'AUDIO', 'audio/webm', Buffer.from('x'));
    await onFileUploaded(deps, {
      v: 1,
      fileId: 'rec2',
      workspaceId: ws,
      kind: 'AUDIO',
      storageKey: 'x',
      mime: 'audio/webm',
    });
    await onTranscribeCompleted(deps, {
      v: 1,
      status: 'failed',
      fileId: 'rec2',
      workspaceId: ws,
      engine: 'faster-whisper',
      error: 'audio_unreadable',
    });
    expect(await prisma.file.findUniqueOrThrow({ where: { id: 'rec2' } })).toMatchObject({
      status: 'FAILED',
      error: 'audio_unreadable',
    });
  });

  it('empties the trash after 30 days, storage included', async () => {
    const old = new Date(Date.now() - 31 * 86_400_000);
    await newFile('old1', 'DOCUMENT', 'text/plain', Buffer.from('old'), { deletedAt: old });
    await newFile('new1', 'DOCUMENT', 'text/plain', Buffer.from('new'), { deletedAt: new Date() });
    expect(await purgeTrash(deps)).toBe(1);
    expect(await prisma.file.findUnique({ where: { id: 'old1' } })).toBeNull();
    expect(await prisma.file.findUnique({ where: { id: 'new1' } })).not.toBeNull();
    await expect(storage.head(storage.keys.original(ws, 'old1', 'a.bin'))).rejects.toThrow();
  });
});
