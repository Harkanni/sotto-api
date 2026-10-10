import { FakeEmbeddingProvider } from '@sotto/ai';
import {
  createPrismaClient,
  ensureEmbeddingIndex,
  indexCoverage,
  writeEmbeddings,
  type PrismaClient,
} from '@sotto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReindexError, reindex } from '../src/reindex.js';
import { TEST_DATABASE_URL, createTestDatabase } from './helpers.js';

/**
 * Re-index (ADR 0027): a library indexed with an old model gets a new one beside it, chunk by
 * chunk across workspaces, and only then serves. Two workspaces, three chunks each.
 */
describe.skipIf(!TEST_DATABASE_URL)('re-index', () => {
  let db: { url: string; pgvector: boolean; drop: () => Promise<void> };
  let prisma: PrismaClient;
  const oldModel = new FakeEmbeddingProvider(8, 'old-hash');
  const newModel = new FakeEmbeddingProvider(16, 'new-hash');

  beforeAll(async () => {
    db = await createTestDatabase();
    prisma = createPrismaClient(db.url);
    for (const ws of ['ws_a', 'ws_b']) {
      await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      const file = await prisma.file.create({
        data: {
          id: `${ws}_file`,
          workspaceId: ws,
          kind: 'DOCUMENT',
          title: 'Memo',
          status: 'READY',
          storageKey: `files/${ws}/memo`,
          mime: 'text/plain',
          sizeBytes: 10n,
        },
      });
      const texts = ['runway and budget', 'hiring plan', 'security answers'];
      const chunks = [];
      for (const [idx, text] of texts.entries()) {
        chunks.push(
          await prisma.chunk.create({
            data: {
              workspaceId: ws,
              fileId: file.id,
              sensitivity: 'INTERNAL',
              idx,
              text,
              tokenCount: 3,
            },
          }),
        );
      }
      const vectors = await oldModel.embed(texts);
      await ensureEmbeddingIndex(prisma, 'fake:old-hash', 8);
      await writeEmbeddings(
        prisma,
        ws,
        'fake:old-hash',
        8,
        chunks.map((c, i) => ({ chunkId: c.id, vector: vectors[i]! })),
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.drop();
  });

  it('starts a later model as BUILDING beside the serving one', async () => {
    await ensureEmbeddingIndex(prisma, 'fake:new-hash', 16);
    const coverage = await indexCoverage(prisma);
    expect(coverage).toEqual([
      expect.objectContaining({
        model: 'fake:old-hash',
        serving: true,
        status: 'READY',
        embedded: 6,
        total: 6,
      }),
      expect.objectContaining({
        model: 'fake:new-hash',
        serving: false,
        status: 'BUILDING',
        embedded: 0,
      }),
    ]);
  });

  it("won't swap to an index that doesn't cover everything", async () => {
    const partial = await reindex(prisma, newModel, { batch: 2, limit: 2 });
    expect(partial).toMatchObject({ embedded: 2, covered: 2, total: 6, serving: false });
    await expect(reindex(prisma, newModel, { batch: 2, limit: 0, swap: true })).rejects.toEqual(
      new ReindexError('incomplete'),
    );
  });

  it('fills in the rest across workspaces, then serves it and retires the old one', async () => {
    const done = await reindex(prisma, newModel, { batch: 4, swap: true });
    expect(done).toMatchObject({ embedded: 4, covered: 6, total: 6, serving: true });
    const coverage = await indexCoverage(prisma);
    expect(coverage.map((c) => [c.model, c.serving, c.status])).toEqual([
      ['fake:new-hash', true, 'READY'],
      ['fake:old-hash', false, 'RETIRED'],
    ]);
    // Each workspace's vectors carry that workspace.
    const rows = await prisma.chunkEmbedding.groupBy({
      by: ['workspaceId'],
      where: { model: 'fake:new-hash' },
      _count: true,
    });
    expect(rows.map((r) => [r.workspaceId, r._count]).sort()).toEqual([
      ['ws_a', 3],
      ['ws_b', 3],
    ]);
    expect((await indexCoverage(prisma, 'ws_a')).find((c) => c.serving)).toMatchObject({
      embedded: 3,
      total: 3,
    });
  });

  it('is a no-op the second time', async () => {
    expect(await reindex(prisma, newModel, { swap: true })).toMatchObject({
      embedded: 0,
      serving: true,
    });
  });

  it('refuses an embedder outside the cluster', async () => {
    const outside = { ...newModel, dataLocation: 'THIRD_PARTY' as const, embed: newModel.embed };
    await expect(reindex(prisma, outside)).rejects.toEqual(new ReindexError('not_private'));
  });
});
