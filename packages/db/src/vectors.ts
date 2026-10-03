/**
 * Raw SQL for vectors, which Prisma can't express. Every embedding model gets its own partial
 * HNSW index, cast to that model's dimension, so models of different sizes live side by side in
 * one table and a re-index can run beside the live one (PLAN → Swappable AI providers).
 */

/** Model ids reach SQL as literals and index names, so they're held to a safe alphabet. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function assertModelId(model: string): void {
  if (!MODEL_ID.test(model)) throw new Error(`Unsafe embedding model id: ${JSON.stringify(model)}`);
}

/** pgvector's text format: "[0.1,0.2,…]". Rejects NaN and infinities, which pgvector refuses. */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const v of vector) {
    if (!Number.isFinite(v)) throw new Error('Embedding contains a non-finite number');
  }
  return `[${vector.join(',')}]`;
}

/** A stable, short, SQL-safe index name for a model (Postgres caps identifiers at 63 bytes). */
export function indexNameFor(model: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < model.length; i++) {
    hash ^= model.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 30);
  return `chunk_embeddings_hnsw_${slug}_${hash.toString(16).padStart(8, '0')}`;
}

/** The statements that create one model's index. Exported for tests. */
export function hnswIndexSql(model: string, dims: number): string {
  assertModelId(model);
  if (!Number.isInteger(dims) || dims < 1 || dims > 16_000) {
    throw new Error(`Embedding dimension out of range: ${dims}`);
  }
  // HNSW over a cast expression; the WHERE makes it partial, so each model's search only walks
  // its own vectors. Queries must repeat the same cast and predicate to use it.
  return (
    `CREATE INDEX IF NOT EXISTS "${indexNameFor(model)}" ON "chunk_embeddings" ` +
    `USING hnsw (("embedding"::vector(${dims})) vector_cosine_ops) ` +
    `WHERE "model" = '${model.replace(/'/g, "''")}'`
  );
}

/** The slice of a Prisma client these helpers use, so they work in and out of transactions. */
export interface RawExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Makes sure a model has its index and registry row. The first model ever used starts serving
 * at once, since there's nothing to switch from; later ones wait for a re-index (Phase 6).
 */
export async function ensureEmbeddingIndex(
  db: RawExecutor,
  model: string,
  dims: number,
): Promise<void> {
  await db.$executeRawUnsafe(hnswIndexSql(model, dims));
  await db.$executeRawUnsafe(
    `INSERT INTO "embedding_indexes" ("model", "dims", "status", "serving", "updated_at")
     VALUES ($1, $2, 'READY', NOT EXISTS (SELECT 1 FROM "embedding_indexes" WHERE "serving"), now())
     ON CONFLICT ("model") DO NOTHING`,
    model,
    dims,
  );
}

export interface EmbeddingRow {
  chunkId: string;
  vector: readonly number[];
}

/**
 * Writes one model's vectors for a batch of chunks in a single statement (re-running replaces
 * them, so a retried job is harmless). `workspaceId` is stamped on every row: raw SQL isn't
 * covered by the tenant client, so the caller passes the file's workspace explicitly.
 */
export async function writeEmbeddings(
  db: RawExecutor,
  workspaceId: string,
  model: string,
  dims: number,
  rows: readonly EmbeddingRow[],
): Promise<number> {
  assertModelId(model);
  if (!rows.length) return 0;
  for (const row of rows) {
    if (row.vector.length !== dims) {
      throw new Error(`Embedding has ${row.vector.length} dimensions, expected ${dims}`);
    }
  }
  return db.$executeRawUnsafe(
    `INSERT INTO "chunk_embeddings" ("chunk_id", "model", "workspace_id", "dims", "embedding")
     SELECT c, $2, $3, $4, v::vector
     FROM unnest($1::text[], $5::text[]) AS t(c, v)
     ON CONFLICT ("chunk_id", "model") DO UPDATE
       SET "embedding" = EXCLUDED."embedding", "dims" = EXCLUDED."dims"`,
    rows.map((r) => r.chunkId),
    model,
    workspaceId,
    dims,
    rows.map((r) => toVectorLiteral(r.vector)),
  );
}
