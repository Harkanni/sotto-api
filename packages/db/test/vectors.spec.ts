import { describe, expect, it } from 'vitest';
import {
  ensureEmbeddingIndex,
  hnswIndexSql,
  indexNameFor,
  toVectorLiteral,
  writeEmbeddings,
  type RawExecutor,
} from '../src/vectors.js';

/** Records the statements instead of running them (the SQL itself runs in integration tests). */
function recorder() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db: RawExecutor = {
    async $executeRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      return Array.isArray(values[0]) ? values[0].length : 1;
    },
  };
  return { db, calls };
}

describe('vectors', () => {
  it('formats vectors the way pgvector reads them', () => {
    expect(toVectorLiteral([0.25, -1, 3])).toBe('[0.25,-1,3]');
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(/non-finite/);
  });

  it('gives each model a short, stable, distinct index name', () => {
    const a = indexNameFor('ollama:nomic-embed-text');
    expect(a).toBe(indexNameFor('ollama:nomic-embed-text'));
    expect(a).not.toBe(indexNameFor('ollama:nomic-embed-text-v2'));
    expect(a).toMatch(/^chunk_embeddings_hnsw_[a-z0-9_]+$/);
    expect(indexNameFor('x'.repeat(128)).length).toBeLessThanOrEqual(63);
  });

  it('builds a partial HNSW index cast to the model’s dimension', () => {
    const sql = hnswIndexSql('ollama:nomic-embed-text', 768);
    expect(sql).toContain('USING hnsw (("embedding"::vector(768)) vector_cosine_ops)');
    expect(sql).toContain(`WHERE "model" = 'ollama:nomic-embed-text'`);
  });

  it('refuses model ids and sizes that could break the SQL', () => {
    expect(() => hnswIndexSql("x'; DROP TABLE files; --", 3)).toThrow(/Unsafe/);
    expect(() => hnswIndexSql('ok', 0)).toThrow(/out of range/);
    expect(() => hnswIndexSql('ok', 1.5)).toThrow(/out of range/);
  });

  it('creates the index, then registers the model', async () => {
    const { db, calls } = recorder();
    await ensureEmbeddingIndex(db, 'fake-hash', 8);
    expect(calls[0]!.sql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(calls[1]!.sql).toContain('INSERT INTO "embedding_indexes"');
    expect(calls[1]!.values).toEqual(['fake-hash', 8]);
  });

  it('writes a batch in one statement, stamped with the workspace', async () => {
    const { db, calls } = recorder();
    const n = await writeEmbeddings(db, 'w1', 'fake-hash', 2, [
      { chunkId: 'c1', vector: [1, 0] },
      { chunkId: 'c2', vector: [0, 1] },
    ]);
    expect(n).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual([['c1', 'c2'], 'fake-hash', 'w1', 2, ['[1,0]', '[0,1]']]);
    expect(calls[0]!.sql).toContain('ON CONFLICT ("chunk_id", "model") DO UPDATE');
  });

  it('skips empty batches and refuses vectors of the wrong size', async () => {
    const { db, calls } = recorder();
    expect(await writeEmbeddings(db, 'w1', 'fake-hash', 2, [])).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(
      writeEmbeddings(db, 'w1', 'fake-hash', 2, [{ chunkId: 'c1', vector: [1, 0, 0] }]),
    ).rejects.toThrow(/expected 2/);
  });
});
