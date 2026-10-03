import { Body, Controller, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PagesDocument, PeaksDocument } from '@sotto/contracts';
import { Derived, ObjectMissingError } from '@sotto/storage';
import { z } from 'zod';
import { RequireRole } from '../auth/auth.guard.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth } from '../common/request.js';
import { StorageService } from '../infra.module.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { fileAccess, fileVisibleTo } from './access.js';
import { FilesService } from './files.service.js';
import { FileSchema } from './schemas.js';
import { viewerOf } from './uploads.controller.js';

export const DocumentContent = z
  .object({
    /** True for PDFs: `page` is the real page number. Other formats are one flowing text. */
    paged: z.boolean(),
    pages: z.array(z.object({ page: z.number(), text: z.string() })),
  })
  .meta({ id: 'DocumentContent' });

export const TranscriptQuery = z
  .object({ q: z.string().trim().min(1).max(200).optional() })
  .meta({ id: 'TranscriptQuery' });

export const TranscriptSchema = z
  .object({
    language: z.string(),
    /** e.g. "faster-whisper:base"; "sample" for sample meetings. */
    engine: z.string(),
    /** Made by the labelled mock engine: placeholder lines, not what was said. */
    isMock: z.boolean(),
    segments: z.array(
      z.object({
        idx: z.number(),
        startMs: z.number(),
        endMs: z.number(),
        speaker: z.string().nullable(),
        text: z.string(),
      }),
    ),
    /** With `q`: the lines that match, in order (search within the transcript). */
    matches: z.array(z.number()).nullable(),
  })
  .meta({ id: 'Transcript' });

export const InsightsSchema = z
  .object({
    summary: z.string(),
    decisions: z.array(z.string()),
    actionItems: z.array(
      z.object({
        text: z.string(),
        owner: z.string().nullable(),
        due: z.string().nullable(),
        atMs: z.number().nullable(),
      }),
    ),
    openQuestions: z.array(z.string()),
    chapters: z.array(z.object({ title: z.string(), startMs: z.number() })),
    /** Which model wrote them; "basic-notes" when no model is configured, "sample" for samples. */
    model: z.string(),
    /** True for basic notes: rule-based, not written by an AI model. */
    isMock: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'MeetingInsights' });

export const PeaksSchema = z
  .object({ durationMs: z.number(), peaks: z.array(z.number()) })
  .meta({ id: 'Peaks' });

export const PositionBody = z
  .object({
    positionMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3_600_000),
  })
  .meta({ id: 'PlaybackPosition' });

export const ContinueListening = z
  .array(z.object({ file: FileSchema, positionMs: z.number(), updatedAt: z.iso.datetime() }))
  .meta({ id: 'ContinueListening' });

const asList = (value: unknown) => (Array.isArray(value) ? value : []);

/** Meetings and document content: transcript, notes, waveform, where you stopped, the text. */
@ApiTags('meetings')
@ApiErrors()
@Controller()
export class MeetingsController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  @Get('files/:id/content')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'A document’s text, page by page (once it’s Ready).' })
  @ApiOkResponse({ standardSchema: DocumentContent })
  async content(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof DocumentContent>> {
    const { file } = await this.files.open(viewerOf(auth), id);
    if (file.kind === 'AUDIO') {
      throw new ApiException(409, 'NOT_A_DOCUMENT', 'This is a recording; open its transcript.');
    }
    if (file.status !== 'READY') {
      throw new ApiException(409, 'NOT_READY', 'Sotto is still reading this document.');
    }
    try {
      const doc = await this.storage.getJson(
        this.storage.keys.derived(file.workspaceId, id, Derived.pages),
        PagesDocument,
      );
      return { paged: file.pageCount !== null, pages: doc.pages };
    } catch (error) {
      if (error instanceof ObjectMissingError) {
        throw new ApiException(409, 'NOT_READY', 'This document needs processing again. Retry it.');
      }
      throw error;
    }
  }

  @Get('files/:id/transcript')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'A recording’s transcript; `q` marks the lines that match.' })
  @ApiOkResponse({ standardSchema: TranscriptSchema })
  async transcript(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Query({ schema: TranscriptQuery }) query: z.infer<typeof TranscriptQuery>,
  ): Promise<z.infer<typeof TranscriptSchema>> {
    const viewer = viewerOf(auth);
    await this.files.open(viewer, id);
    const db = this.files.db(viewer.workspaceId);
    const transcript = await db.transcript.findUnique({
      where: { fileId: id },
      include: { segments: { orderBy: { idx: 'asc' } } },
    });
    if (!transcript) {
      throw new ApiException(404, 'NO_TRANSCRIPT', 'This recording hasn’t been transcribed yet.');
    }
    let matches: number[] | null = null;
    if (query.q) {
      // ILIKE through the trigram index; Prisma escapes % and _ so they match themselves.
      const rows = await db.transcriptSegment.findMany({
        where: { transcriptId: transcript.id, text: { contains: query.q, mode: 'insensitive' } },
        select: { idx: true },
        orderBy: { idx: 'asc' },
      });
      matches = rows.map((r) => r.idx);
    }
    return {
      language: transcript.language,
      engine:
        transcript.engine === 'sample' ? 'sample' : `${transcript.engine}:${transcript.model}`,
      isMock: transcript.isMock,
      segments: transcript.segments.map((s) => ({
        idx: s.idx,
        startMs: s.startMs,
        endMs: s.endMs,
        speaker: s.speaker,
        text: s.text,
      })),
      matches,
    };
  }

  @Get('files/:id/insights')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'A meeting’s notes: summary, decisions, action items, chapters.' })
  @ApiOkResponse({ standardSchema: InsightsSchema })
  async insights(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof InsightsSchema>> {
    const viewer = viewerOf(auth);
    await this.files.open(viewer, id);
    const row = await this.files.db(viewer.workspaceId).meetingInsights.findUnique({
      where: { fileId: id },
    });
    if (!row) throw new ApiException(404, 'NO_NOTES', 'Notes appear when processing finishes.');
    return {
      summary: row.summary,
      decisions: asList(row.decisions) as string[],
      actionItems: (asList(row.actionItems) as Record<string, unknown>[]).map((a) => ({
        text: String(a.text ?? ''),
        owner: typeof a.owner === 'string' ? a.owner : null,
        due: typeof a.due === 'string' ? a.due : null,
        atMs: typeof a.atMs === 'number' ? a.atMs : null,
      })),
      openQuestions: asList(row.openQuestions) as string[],
      chapters: asList(row.chapters) as { title: string; startMs: number }[],
      model: row.model,
      isMock: row.isMock,
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Get('files/:id/peaks')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Waveform peaks for the player (0–1 per slice of the recording).' })
  @ApiOkResponse({ standardSchema: PeaksSchema })
  async peaks(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof PeaksSchema>> {
    const { file } = await this.files.open(viewerOf(auth), id);
    try {
      return await this.storage.getJson(
        this.storage.keys.derived(file.workspaceId, id, Derived.peaks),
        PeaksDocument,
      );
    } catch (error) {
      if (error instanceof ObjectMissingError) {
        throw new ApiException(404, 'NO_WAVEFORM', 'This recording has no waveform yet.');
      }
      throw error;
    }
  }

  @Put('files/:id/position')
  @RequireRole('viewer')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remember where you stopped listening (Continue listening).' })
  @ApiNoContentResponse()
  async position(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: PositionBody }) body: z.infer<typeof PositionBody>,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const { file } = await this.files.open(viewer, id);
    if (file.kind !== 'AUDIO') return;
    await this.files.db(viewer.workspaceId).playbackPosition.upsert({
      where: { userId_fileId: { userId: viewer.userId, fileId: id } },
      create: {
        userId: viewer.userId,
        fileId: id,
        workspaceId: viewer.workspaceId,
        positionMs: body.positionMs,
      },
      update: { positionMs: body.positionMs },
    });
  }

  @Get('continue-listening')
  @RequireRole('viewer')
  @ApiOperation({
    summary: 'Recordings you started and didn’t finish, most recent first (up to 10).',
  })
  @ApiOkResponse({ standardSchema: ContinueListening })
  async continueListening(@Ctx() auth: RequestAuth): Promise<z.infer<typeof ContinueListening>> {
    const viewer = viewerOf(auth);
    const rows = await this.files.db(viewer.workspaceId).playbackPosition.findMany({
      where: {
        userId: viewer.userId,
        positionMs: { gte: 5_000 },
        file: { AND: [fileVisibleTo(viewer), { deletedAt: null, status: 'READY' }] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 20,
      include: { file: { include: this.files.include(viewer) } },
    });
    return rows
      .filter((r) => !r.file.durationMs || r.positionMs < r.file.durationMs - 10_000)
      .flatMap((r) => {
        const access = fileAccess(viewer, r.file);
        return access
          ? [
              {
                file: this.files.present(r.file, access),
                positionMs: r.positionMs,
                updatedAt: r.updatedAt.toISOString(),
              },
            ]
          : [];
      })
      .slice(0, 10);
  }
}
