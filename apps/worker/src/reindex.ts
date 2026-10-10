/**
 * Re-index (PLAN → Swappable AI providers: "embeddings switch with no downtime"; ADR 0027).
 * After AI_EMBEDDINGS changes, new files are embedded with the new model while searches keep
 * using the serving one. This job fills in the new model for every chunk that lacks it,
 * beside the live index, in small batches; with `swap` it then makes the new index serve and
 * retires the old one. Searches never see a half-built index.
 *
 * It runs across every workspace (the index is shared), so it is an operator command, not
 * something a workspace admin can start.
 */
import type { EmbeddingProvider } from '@sotto/ai';
import {
  type PrismaClient,
  ensureEmbeddingIndex,
  indexCoverage,
  setIndexStatus,
  swapServingIndex,
  writeEmbeddings,
} from '@sotto/db';

export interface ReindexOptions {
  /** Chunks embedded per call to the model. */
  batch?: number;
  /** Make the new index serve once it covers every chunk. */
  swap?: boolean;
  /** Stop after this many chunks (a dry run on a big library). */
  limit?: number;
  signal?: AbortSignal;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface ReindexResult {
  model: string;
  embedded: number;
  covered: number;
  total: number;
  serving: boolean;
}

export class ReindexError extends Error {
  constructor(readonly code: 'not_private' | 'incomplete') {
    super(code);
    this.name = 'ReindexError';
  }
}

export async function reindex(
  prisma: PrismaClient,
  embeddings: EmbeddingProvider,
  options: ReindexOptions = {},
): Promise<ReindexResult> {
  // Embeddings always run in-house (BRIEF §3): whole files never go to a third party.
  if (embeddings.dataLocation !== 'IN_CLUSTER') throw new ReindexError('not_private');
  const model = `${embeddings.id}:${embeddings.model}`;
  const batch = options.batch ?? 32;
  const log = options.log ?? (() => {});
  let after = '';
  let embedded = 0;
  let indexed = false;

  for (;;) {
    options.signal?.throwIfAborted();
    if (options.limit !== undefined && embedded >= options.limit) break;
    // Keyset by id: chunks added meanwhile are picked up, and nothing is read twice.
    const rows = await prisma.$queryRawUnsafe<{ id: string; workspace_id: string; text: string }[]>(
      `SELECT c."id", c."workspace_id", c."text"
         FROM "chunks" c
        WHERE c."id" > $2
          AND NOT EXISTS (SELECT 1 FROM "chunk_embeddings" e
                           WHERE e."chunk_id" = c."id" AND e."model" = $1)
        ORDER BY c."id"
        LIMIT $3`,
      model,
      after,
      batch,
    );
    if (!rows.length) break;
    after = rows.at(-1)!.id;
    const vectors = await embeddings.embed(
      rows.map((r) => r.text),
      { purpose: 'document', ...(options.signal ? { signal: options.signal } : {}) },
    );
    const dims = vectors[0]?.length ?? embeddings.dimensions;
    if (!indexed) {
      await ensureEmbeddingIndex(prisma, model, dims);
      indexed = true;
    }
    // One write per workspace: rows carry their own workspace (raw SQL isn't tenant-scoped).
    const byWorkspace = new Map<string, { chunkId: string; vector: number[] }[]>();
    rows.forEach((r, i) => {
      const list = byWorkspace.get(r.workspace_id) ?? [];
      list.push({ chunkId: r.id, vector: vectors[i]! });
      byWorkspace.set(r.workspace_id, list);
    });
    for (const [workspaceId, list] of byWorkspace) {
      await writeEmbeddings(prisma, workspaceId, model, dims, list);
    }
    embedded += rows.length;
    log('re-index batch', { model, embedded });
  }

  const coverage = (await indexCoverage(prisma)).find((c) => c.model === model);
  const covered = coverage?.embedded ?? 0;
  const total = coverage?.total ?? 0;
  const complete = coverage !== undefined && covered >= total;
  if (coverage && complete && !coverage.serving && coverage.status === 'BUILDING') {
    await setIndexStatus(prisma, model, 'READY');
  }
  let serving = coverage?.serving ?? false;
  if (options.swap && !serving) {
    if (!complete) throw new ReindexError('incomplete');
    await swapServingIndex(prisma, model);
    serving = true;
    log('re-index swapped', { model });
  }
  return { model, embedded, covered, total, serving };
}
