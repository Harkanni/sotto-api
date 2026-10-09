import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@sotto/db';
import { z } from 'zod';
import { RequireRole } from '../auth/auth.guard.js';
import { ApiErrors } from '../common/errors.js';
import { Ctx, type RequestAuth } from '../common/request.js';
import { fileAccess, fileVisibleTo } from '../files/access.js';
import { FilesService } from '../files/files.service.js';
import { FileSchema } from '../files/schemas.js';
import { viewerOf } from '../files/uploads.controller.js';
import { keywordsOf, lightStem } from './keywords.js';
import { RetrievalService } from './retrieval.service.js';
import { type AskScope, kindsOf } from './scope.js';
import { snippetOf } from './snippets.js';

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  /** One collection's files only. */
  collection: z.string().min(1).max(64).optional(),
  kind: z.enum(['documents', 'meetings']).optional(),
});

const SnippetSchema = z
  .object({
    text: z.string(),
    /** [start, end) character offsets in `text` of the words that matched. */
    highlights: z.array(z.tuple([z.number(), z.number()])),
  })
  .meta({ id: 'Snippet' });

const SourceFile = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['document', 'audio', 'note']),
});

export const SearchResults = z
  .object({
    /** "keyword" when semantic search couldn't run; results then need a shared word. */
    mode: z.enum(['hybrid', 'keyword']),
    /** Files whose title or content matched, best first. */
    files: z.array(z.object({ file: FileSchema, match: z.enum(['title', 'content']) })),
    /** Passages of documents and notes, with the page when the format has pages. */
    passages: z.array(
      z.object({
        /** 1-based place in the fused ranking, shared with `moments`, for interleaving them. */
        rank: z.number(),
        chunkId: z.string(),
        file: SourceFile,
        page: z.number().nullable(),
        snippet: SnippetSchema,
      }),
    ),
    /** Moments in meetings: where in the recording the words were said. */
    moments: z.array(
      z.object({
        rank: z.number(),
        chunkId: z.string(),
        file: SourceFile,
        startMs: z.number(),
        endMs: z.number(),
        snippet: SnippetSchema,
      }),
    ),
  })
  .meta({ id: 'SearchResults' });
type SearchResults = z.infer<typeof SearchResults>;

const MAX_FILES = 6;
const MAX_PASSAGES = 6;
const MAX_MOMENTS = 5;

/**
 * Search (BRIEF §4): the ⌘K palette and the phone's search field. Files by title and by
 * content, passages and meeting moments, from the same hybrid retrieval Ask uses, with the
 * viewer's access inside the SQL. Nothing here reaches a model, so every sensitivity is
 * searchable by whoever may open it.
 */
@ApiTags('search')
@ApiErrors()
@Controller('search')
export class SearchController {
  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Search files, passages and meeting moments (hybrid, ranked).' })
  @ApiOkResponse({ standardSchema: SearchResults })
  async search(
    @Ctx() auth: RequestAuth,
    @Query({ schema: SearchQuery }) query: z.infer<typeof SearchQuery>,
  ): Promise<SearchResults> {
    const viewer = viewerOf(auth);
    const scope: AskScope = { collectionId: query.collection ?? null, kind: query.kind };
    const [found, titleHits] = await Promise.all([
      this.retrieval.retrieve({ viewer, question: query.q, scope, limit: 16, perFile: 2 }),
      this.byTitle(viewer, query.q, scope),
    ]);
    // Titles that match best come first; among equals, a file whose content matched too.
    const contentRank = new Map<string, number>();
    found.passages.forEach((p, i) => {
      if (!contentRank.has(p.fileId)) contentRank.set(p.fileId, i);
    });
    const titled = titleHits
      .sort(
        (a, b) =>
          b.hits - a.hits ||
          (contentRank.get(a.id) ?? Infinity) - (contentRank.get(b.id) ?? Infinity) ||
          +b.updatedAt - +a.updatedAt,
      )
      .map((h) => h.id);

    const source = (p: { fileId: string; title: string; kind: string }) => ({
      id: p.fileId,
      title: p.title,
      kind: p.kind.toLowerCase() as 'document' | 'audio' | 'note',
    });
    const ranked = found.passages.map((p, i) => ({ ...p, rank: i + 1 }));
    const passages = ranked
      .filter((p) => p.kind !== 'AUDIO')
      .slice(0, MAX_PASSAGES)
      .map((p) => ({
        rank: p.rank,
        chunkId: p.chunkId,
        file: source(p),
        page: p.page,
        snippet: snippetOf(p.text, query.q),
      }));
    const moments = ranked
      .filter((p) => p.kind === 'AUDIO' && p.startMs !== null)
      .slice(0, MAX_MOMENTS)
      .map((p) => ({
        rank: p.rank,
        chunkId: p.chunkId,
        file: source(p),
        startMs: p.startMs!,
        endMs: p.endMs ?? p.startMs!,
        snippet: snippetOf(p.text, query.q),
      }));

    // Title matches first, then files found by what they say, each file once.
    const order = new Map<string, 'title' | 'content'>();
    for (const id of titled) if (!order.has(id)) order.set(id, 'title');
    for (const p of found.passages) if (!order.has(p.fileId)) order.set(p.fileId, 'content');
    const wanted = [...order].slice(0, MAX_FILES).map(([id, match]) => ({ id, match }));
    const rows = await this.files.db(viewer.workspaceId).file.findMany({
      where: { AND: [{ id: { in: wanted.map((w) => w.id) } }, fileVisibleTo(viewer)] },
      include: this.files.include(viewer),
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const files = wanted.flatMap(({ id, match }) => {
      const row = byId.get(id);
      const access = row ? fileAccess(viewer, row) : null;
      return row && access ? [{ file: this.files.present(row, access), match }] : [];
    });

    return { mode: found.mode, files, passages, moments };
  }

  /**
   * Files whose title has one of the question's words (any status but someone else's upload,
   * not trashed), with how many matched. Same visibility filter as the files list.
   */
  private async byTitle(
    viewer: ReturnType<typeof viewerOf>,
    question: string,
    scope: AskScope,
  ): Promise<{ id: string; hits: number; updatedAt: Date }[]> {
    const stems = [...new Set(keywordsOf(question).map(lightStem))].slice(0, 8);
    if (!stems.length) return [];
    const where: Prisma.FileWhereInput = {
      AND: [
        fileVisibleTo(viewer),
        { deletedAt: null, kind: { in: kindsOf(scope) } },
        scope.collectionId ? { collectionId: scope.collectionId } : {},
        { OR: stems.map((s) => ({ title: { contains: s, mode: 'insensitive' as const } })) },
      ],
    };
    const rows = await this.files.db(viewer.workspaceId).file.findMany({
      where,
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 40,
    });
    return rows.map((r) => {
      const lower = r.title.toLowerCase();
      return {
        id: r.id,
        hits: stems.filter((s) => lower.includes(s)).length,
        updatedAt: r.updatedAt,
      };
    });
  }
}
