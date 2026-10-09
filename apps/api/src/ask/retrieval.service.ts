import { Inject, Injectable } from '@nestjs/common';
import type { Sensitivity } from '@sotto/ai';
import { assertModelId, forWorkspace, toVectorLiteral } from '@sotto/db';
import { atLeast } from '../auth/roles.js';
import { type Viewer, visibleTo } from '../collections/collections.service.js';
import { PrismaService } from '../core.module.js';
import { AiService } from './ai.service.js';
import { keywordQuery } from './keywords.js';
import { type AskScope, kindsOf } from './scope.js';

/** Reciprocal Rank Fusion's constant: the usual 60, so neither list dominates the other. */
const RRF_K = 60;
/** How many candidates each half (keyword, vector) contributes before fusing. */
const CANDIDATES = 40;
/**
 * Cosine similarity a passage needs to count as relevant on meaning alone (no shared words).
 * Below it a passage only shows up because something has to be nearest. Tuned for
 * nomic-embed-text by the eval set; mock (hash) embeddings never count on their own.
 */
export const MIN_SIMILARITY = 0.5;
const SENSITIVITIES: Sensitivity[] = ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

export type FileKind = 'DOCUMENT' | 'AUDIO' | 'NOTE';

export interface Passage {
  chunkId: string;
  fileId: string;
  title: string;
  kind: FileKind;
  collectionId: string | null;
  sensitivity: Sensitivity;
  text: string;
  page: number | null;
  startMs: number | null;
  endMs: number | null;
  /** The fused RRF score (higher is better). */
  score: number;
  /** 1-based rank in each list, or null when that half didn't find it. */
  keywordRank: number | null;
  vectorRank: number | null;
  /** Cosine similarity to the question, when semantic search ran. */
  similarity: number | null;
}

export interface Retrieval {
  passages: Passage[];
  /** Relevant sources the route wasn't allowed to read: counted, never read. */
  hidden: { restricted: number; confidential: number };
  /** "keyword" when semantic search couldn't run (nothing indexed, model mismatch, server down). */
  mode: 'hybrid' | 'keyword';
}

export interface RetrieveInput {
  viewer: Viewer;
  question: string;
  scope: AskScope;
  /** Sensitivities that may be returned (Ask: what the answering model may read). */
  allowed?: Sensitivity[];
  limit?: number;
  /** At most this many passages from one file, so an answer draws on several sources. */
  perFile?: number;
  signal?: AbortSignal;
}

interface Row {
  chunk_id: string;
  file_id: string;
  sensitivity: Sensitivity;
  score: number;
  kr: number | null;
  vr: number | null;
  similarity: number | null;
  title?: string;
  kind?: FileKind;
  collection_id?: string | null;
  text?: string;
  page?: number | null;
  start_ms?: number | null;
  end_ms?: number | null;
}

/**
 * Hybrid retrieval (BRIEF §5): Postgres full-text search and pgvector, fused by Reciprocal Rank
 * Fusion, in one statement. Workspace, readiness, trash, the viewer's access, the scope and the
 * allowed sensitivities are all part of that statement's WHERE (CLAUDE.md: permissions inside
 * SQL, never applied afterwards), so a passage the viewer can't open is never even read.
 */
@Injectable()
export class RetrievalService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AiService) private readonly ai: AiService,
  ) {}

  async retrieve(input: RetrieveInput): Promise<Retrieval> {
    const allowed = input.allowed ?? SENSITIVITIES;
    const limit = input.limit ?? 8;
    const perFile = input.perFile ?? limit;
    const keywords = keywordQuery(input.question);
    const vector = await this.ai.queryVector(input.question, input.signal);
    // Mock (hash) vectors never count as relevant on their own, so that search is keyword-only.
    const mode = vector && !this.ai.embeddings.isMock ? 'hybrid' : 'keyword';
    if (!keywords && !vector) {
      return { passages: [], hidden: { restricted: 0, confidential: 0 }, mode };
    }
    const visible = await this.visibleCollections(input.viewer);

    const rows = await this.fused({
      ...input,
      sensitivities: allowed,
      keywords,
      vector,
      visible,
      // Over-fetch so the per-file cap and the relevance floor still leave `limit`.
      take: limit * 3,
      withText: true,
    });
    const passages = this.relevant(rows).filter(capPerFile(perFile)).slice(0, limit).map(toPassage);

    const excluded = SENSITIVITIES.filter((s) => !allowed.includes(s));
    const hidden = { restricted: 0, confidential: 0 };
    if (excluded.length) {
      // The same search over what the route may not read, for the count only: no text selected.
      const others = await this.fused({
        ...input,
        sensitivities: excluded,
        keywords,
        vector,
        visible,
        take: limit,
        withText: false,
      });
      const files = { RESTRICTED: new Set<string>(), CONFIDENTIAL: new Set<string>() };
      for (const row of this.relevant(others)) {
        if (row.sensitivity === 'RESTRICTED' || row.sensitivity === 'CONFIDENTIAL') {
          files[row.sensitivity].add(row.file_id);
        }
      }
      hidden.restricted = files.RESTRICTED.size;
      hidden.confidential = files.CONFIDENTIAL.size;
    }
    return { passages, hidden, mode };
  }

  /**
   * Collections the viewer may open, through the same `visibleTo` filter every other endpoint
   * uses (null: owners and admins see everything). The ids then become part of the SQL below.
   */
  async visibleCollections(viewer: Viewer): Promise<string[] | null> {
    if (atLeast(viewer.role, 'admin')) return null;
    const rows = await forWorkspace(this.prisma.client, viewer.workspaceId).collection.findMany({
      where: visibleTo(viewer),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Keeps passages that share a word with the question or are close enough in meaning. */
  private relevant(rows: Row[]): Row[] {
    const semantic = !this.ai.embeddings.isMock;
    return rows.filter(
      (r) => r.kr !== null || (semantic && r.similarity !== null && r.similarity >= MIN_SIMILARITY),
    );
  }

  private async fused(q: {
    viewer: Viewer;
    scope: AskScope;
    sensitivities: Sensitivity[];
    keywords: string | null;
    vector: { model: string; dims: number; vector: number[] } | null;
    visible: string[] | null;
    take: number;
    withText: boolean;
  }): Promise<Row[]> {
    const params: unknown[] = [];
    const p = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    const where = [
      `c."workspace_id" = ${p(q.viewer.workspaceId)}`,
      `f."workspace_id" = c."workspace_id"`,
      `f."deleted_at" IS NULL`,
      `f."status" = 'READY'`,
      `c."sensitivity" = ANY(${p(q.sensitivities)}::"sensitivity"[])`,
      `f."kind" = ANY(${p(kindsOf(q.scope))}::"file_kind"[])`,
    ];
    // Access (ADR 0016): open and granted collections, plus unfiled files (trash is excluded
    // above, so unfiled means visible to everyone). Owners and admins: no filter.
    if (q.visible) {
      where.push(`(f."collection_id" = ANY(${p(q.visible)}::text[]) OR f."collection_id" IS NULL)`);
    }
    if (q.scope.collectionId) where.push(`f."collection_id" = ${p(q.scope.collectionId)}`);
    if (q.scope.fileIds?.length) where.push(`f."id" = ANY(${p(q.scope.fileIds)}::text[])`);

    const take = p(CANDIDATES);
    const kw = q.keywords
      ? `SELECT c."id", row_number() OVER (
           ORDER BY ts_rank_cd(c."tsv", query, 32) DESC, ts_rank(c."tsv", query, 1) DESC, c."id") AS r
         FROM "chunks" c JOIN eligible e ON e."id" = c."id", to_tsquery('simple', ${p(q.keywords)}) query
         WHERE c."tsv" @@ query
         ORDER BY r LIMIT ${take}`
      : `SELECT NULL::text AS "id", NULL::bigint AS r WHERE false`;

    let vec = `SELECT NULL::text AS "id", NULL::bigint AS r, NULL::float8 AS similarity WHERE false`;
    if (q.vector) {
      assertModelId(q.vector.model);
      const dims = q.vector.dims;
      if (!Number.isInteger(dims) || dims < 1 || dims > 16_000) throw new Error('bad dimension');
      // The cast matches the model's HNSW index; exact distances within the eligible set keep
      // recall right for every workspace (a tenant filter after an approximate scan wouldn't).
      const distance = `ce."embedding"::vector(${dims}) <=> ${p(toVectorLiteral(q.vector.vector))}::vector(${dims})`;
      vec = `SELECT ce."chunk_id" AS "id", row_number() OVER (ORDER BY ${distance}, ce."chunk_id") AS r,
                    1 - (${distance}) AS similarity
             FROM "chunk_embeddings" ce JOIN eligible e ON e."id" = ce."chunk_id"
             WHERE ce."model" = ${p(q.vector.model)} AND ce."workspace_id" = ${p(q.viewer.workspaceId)}
             ORDER BY r LIMIT ${take}`;
    }

    const select = q.withText
      ? `, f."title", f."kind", f."collection_id", c."text", c."page", c."start_ms", c."end_ms"`
      : '';
    const sql = `
      WITH eligible AS MATERIALIZED (
        SELECT c."id" FROM "chunks" c JOIN "files" f ON f."id" = c."file_id"
        WHERE ${where.join('\n          AND ')}
      ),
      kw AS (${kw}),
      vec AS (${vec}),
      fused AS (
        SELECT "id", sum(1.0 / (${RRF_K} + r)) AS score, min(kr) AS kr, min(vr) AS vr,
               max(similarity) AS similarity
        FROM (
          SELECT "id", r, r AS kr, NULL::bigint AS vr, NULL::float8 AS similarity FROM kw
          UNION ALL
          SELECT "id", r, NULL::bigint, r, similarity FROM vec
        ) ranked
        GROUP BY "id"
      )
      SELECT c."id" AS chunk_id, c."file_id", c."sensitivity", fused.score::float8 AS score,
             fused.kr::int AS kr, fused.vr::int AS vr, fused.similarity${select}
      FROM fused
      JOIN "chunks" c ON c."id" = fused."id"
      JOIN "files" f ON f."id" = c."file_id"
      ORDER BY fused.score DESC, c."id"
      LIMIT ${p(q.take)}`;
    return this.prisma.client.$queryRawUnsafe<Row[]>(sql, ...params);
  }
}

function capPerFile(perFile: number) {
  const counts = new Map<string, number>();
  return (row: Row) => {
    const n = (counts.get(row.file_id) ?? 0) + 1;
    counts.set(row.file_id, n);
    return n <= perFile;
  };
}

function toPassage(row: Row): Passage {
  return {
    chunkId: row.chunk_id,
    fileId: row.file_id,
    title: row.title ?? '',
    kind: row.kind ?? 'DOCUMENT',
    collectionId: row.collection_id ?? null,
    sensitivity: row.sensitivity,
    text: row.text ?? '',
    page: row.page ?? null,
    startMs: row.start_ms ?? null,
    endMs: row.end_ms ?? null,
    score: Number(row.score),
    keywordRank: row.kr,
    vectorRank: row.vr,
    similarity: row.similarity === null ? null : Number(row.similarity),
  };
}
