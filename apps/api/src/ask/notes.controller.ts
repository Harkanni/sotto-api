import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Queues } from '@sotto/contracts';
import { type File, tenantTransaction } from '@sotto/db';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { CollectionsService } from '../collections/collections.service.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth } from '../common/request.js';
import { FilesService, toSensitivity } from '../files/files.service.js';
import { FileSchema, SensitivitySchema } from '../files/schemas.js';
import { newFileId, viewerOf } from '../files/uploads.controller.js';
import { QueueService, StorageService } from '../infra.module.js';
import { IdParam } from '../workspaces/workspaces.controller.js';

/** Long enough for meeting notes or a saved answer with its sources; short enough to index fast. */
const MAX_BODY = 100_000;

const NoteTitle = z.string().trim().min(1).max(200);
const NoteBody = z.string().max(MAX_BODY);

export const CreateNote = z
  .object({
    /** Defaults to the body's first line. */
    title: NoteTitle.optional(),
    /** Markdown. */
    body: NoteBody.refine((b) => b.trim().length > 0, 'Write something first.'),
    collectionId: z.string().min(1).max(64).nullish(),
    sensitivity: SensitivitySchema.optional(),
  })
  .meta({ id: 'CreateNote' });

export const UpdateNote = z
  .object({ title: NoteTitle.optional(), body: NoteBody.optional() })
  .refine((b) => b.title !== undefined || b.body !== undefined, 'Change the title or the text.')
  .meta({ id: 'UpdateNote' });

export const NoteSchema = z.object({ file: FileSchema, body: z.string() }).meta({ id: 'Note' });

/** "# Launch risks\n…" → "Launch risks"; a blank first line falls through to the next. */
export function titleOfNote(body: string): string {
  for (const line of body.split('\n')) {
    const text = line
      .replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)/, '')
      .replace(/[*_`[\]]/g, '')
      .trim();
    if (text) return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
  }
  return 'Untitled note';
}

/**
 * Notes (PLAN, Phase 5): written in Sotto, from New note or by saving an answer. A note is a file
 * of kind NOTE whose Markdown body is also its stored original, so the normal pipeline extracts,
 * chunks and embeds it, and it's searchable, citable and permissioned like any document. Routes
 * take the note's file id.
 */
@ApiTags('notes')
@ApiErrors()
@Controller('notes')
export class NotesController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post()
  @RequireRole('member')
  @HttpCode(201)
  @ApiOperation({ summary: 'Write a note. It is indexed like a document and can be cited.' })
  @ApiOkResponse({ standardSchema: NoteSchema })
  async create(
    @Ctx() auth: RequestAuth,
    @Body({ schema: CreateNote }) body: z.infer<typeof CreateNote>,
  ): Promise<z.infer<typeof NoteSchema>> {
    const viewer = viewerOf(auth);
    if (body.collectionId) {
      await this.collections.require(
        viewer,
        body.collectionId,
        'EDIT',
        'You can view this collection but not add notes to it.',
      );
    }
    const id = newFileId();
    const key = this.storage.keys.original(viewer.workspaceId, id, 'note.md');
    const bytes = Buffer.from(body.body, 'utf8');
    // Stored first: a row without its original would fail in the pipeline.
    await this.storage.putBytes(key, bytes, 'text/markdown; charset=utf-8');
    const created = await tenantTransaction(this.files.db(viewer.workspaceId), async (tx) => {
      const file = await tx.file.create({
        data: {
          id,
          workspaceId: viewer.workspaceId,
          collectionId: body.collectionId ?? null,
          ownerId: viewer.userId,
          kind: 'NOTE',
          source: 'WRITTEN',
          title: body.title ?? titleOfNote(body.body),
          status: 'UPLOADED',
          sensitivity: body.sensitivity ? toSensitivity(body.sensitivity) : 'INTERNAL',
          storageKey: key,
          mime: 'text/markdown',
          sizeBytes: BigInt(bytes.length),
        },
      });
      await tx.note.create({
        data: { workspaceId: viewer.workspaceId, fileId: id, body: body.body },
      });
      return file;
    });
    await this.index(created);
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'note.created',
      target: { type: 'file', id },
      meta: { name: created.title },
    });
    return this.read(viewer, id);
  }

  @Get(':id')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'A note’s text as written (Markdown), for reading and editing.' })
  @ApiOkResponse({ standardSchema: NoteSchema })
  async get(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    return this.read(viewerOf(auth), id);
  }

  @Patch(':id')
  @RequireRole('member')
  @ApiOperation({ summary: 'Edit a note’s title or text. The text is indexed again.' })
  @ApiOkResponse({ standardSchema: NoteSchema })
  async update(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateNote }) body: z.infer<typeof UpdateNote>,
  ): Promise<z.infer<typeof NoteSchema>> {
    const viewer = viewerOf(auth);
    const { file } = await this.files.require(
      viewer,
      id,
      'EDIT',
      'You can read this note but not change it.',
    );
    if (file.kind !== 'NOTE') {
      throw new ApiException(409, 'NOT_A_NOTE', 'Only notes written in Sotto can be edited here.');
    }
    const db = this.files.db(viewer.workspaceId);
    const textChanged = body.body !== undefined;
    if (textChanged) {
      if (!body.body!.trim()) throw new ApiException(400, 'EMPTY_NOTE', 'Write something first.');
      await this.storage.putBytes(
        file.storageKey,
        Buffer.from(body.body!, 'utf8'),
        'text/markdown; charset=utf-8',
      );
    }
    const updated = await tenantTransaction(db, async (tx) => {
      if (textChanged) await tx.note.update({ where: { fileId: id }, data: { body: body.body! } });
      return tx.file.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(textChanged
            ? {
                status: 'UPLOADED' as const,
                statusAt: new Date(),
                error: null,
                progress: null,
                sizeBytes: BigInt(Buffer.byteLength(body.body!, 'utf8')),
              }
            : {}),
        },
      });
    });
    if (textChanged) await this.index(updated);
    else await this.files.emit(updated, 'updated');
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'note.edited',
      target: { type: 'file', id },
      meta: { name: updated.title },
    });
    return this.read(viewer, id);
  }

  /** Queues the note for indexing and tells open screens it's processing. */
  private async index(file: File) {
    await this.queue.publish(Queues.fileUploaded, {
      v: 1,
      fileId: file.id,
      workspaceId: file.workspaceId,
      kind: file.kind,
      storageKey: file.storageKey,
      mime: file.mime,
    });
    await this.files.emit(file, 'status');
  }

  private async read(viewer: ReturnType<typeof viewerOf>, id: string) {
    const { file, access } = await this.files.open(viewer, id);
    const note = await this.files.db(viewer.workspaceId).note.findUnique({ where: { fileId: id } });
    if (!note)
      throw new ApiException(404, 'NOT_FOUND', 'This note doesn’t exist, or you can’t open it.');
    return { file: this.files.present(file, access), body: note.body };
  }
}
