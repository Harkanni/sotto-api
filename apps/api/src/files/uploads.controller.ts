import { randomBytes } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Queues } from '@sotto/contracts';
import { partCountFor, partSizeFor } from '@sotto/storage';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { UsageService } from '../billing/usage.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { CollectionsService, type Viewer } from '../collections/collections.service.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { QueueService, StorageService } from '../infra.module.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { ACCEPTED_EXTENSIONS, formatOf, titleFrom } from './formats.js';
import { FilesService, toSensitivity } from './files.service.js';
import {
  CompleteUpload,
  PartsRequest,
  PartsResponse,
  StartUpload,
  UploadSchema,
} from './schemas.js';

/**
 * File ids name storage keys, so they're made here, before the row exists: 20 random bytes in a
 * lowercase alphabet (like the cuid2 ids Prisma makes), unguessable and URL-safe.
 */
export function newFileId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(20)]
    .map((b, i) => (i === 0 ? alphabet[b % 26] : alphabet[b % 36]))
    .join('');
}

/** URLs handed out up front; a client asks for the rest as it goes (they expire in an hour). */
const FIRST_PARTS = 20;

export function viewerOf(auth: RequestAuth): Viewer {
  const workspace = workspaceOf(auth);
  return { userId: auth.user.id, role: workspace.role, workspaceId: workspace.id };
}

function formatSize(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${Number(gib.toFixed(1))} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Direct-to-storage uploads (BRIEF §4): the api creates the file and an S3 multipart upload and
 * hands out presigned part URLs; the browser PUTs the bytes straight to storage, in parallel,
 * pausing and resuming at will; `complete` stitches them and queues processing. The api never
 * carries file bytes, so a 500 MB recording costs it a few small requests.
 */
@ApiTags('uploads')
@ApiErrors()
@Controller('uploads')
export class UploadsController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  @Post()
  @RequireRole('member')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start an upload: creates the file and returns presigned part URLs.' })
  @ApiOkResponse({ standardSchema: UploadSchema })
  async start(
    @Ctx() auth: RequestAuth,
    @Body({ schema: StartUpload }) body: z.infer<typeof StartUpload>,
  ): Promise<z.infer<typeof UploadSchema>> {
    const viewer = viewerOf(auth);
    const format = formatOf(body.filename, body.mime);
    if (!format) {
      throw new ApiException(
        415,
        'UNSUPPORTED_TYPE',
        `Sotto can’t read this kind of file. Upload PDF, Word, text, Markdown or audio (${ACCEPTED_EXTENSIONS.join(', ')}).`,
      );
    }
    if (body.sizeBytes > this.config.UPLOAD_MAX_BYTES) {
      throw new ApiException(
        413,
        'TOO_LARGE',
        `This file is larger than ${formatSize(this.config.UPLOAD_MAX_BYTES)}, the most Sotto takes.`,
      );
    }
    if (body.collectionId) {
      await this.collections.require(
        viewer,
        body.collectionId,
        'EDIT',
        'You can view this collection but not add files to it.',
      );
    }
    await this.usage.checkUpload(viewer.workspaceId, format.kind, body.sizeBytes);

    const id = newFileId();
    const key = this.storage.keys.original(viewer.workspaceId, id, body.filename);
    const partSize = partSizeFor(body.sizeBytes);
    const partCount = partCountFor(body.sizeBytes, partSize);
    const uploadId = await this.storage.createMultipart(key, format.mime);

    await this.files.db(viewer.workspaceId).file.create({
      data: {
        id,
        workspaceId: viewer.workspaceId,
        collectionId: body.collectionId ?? null,
        ownerId: viewer.userId,
        kind: format.kind,
        source: body.source === 'recording' ? 'RECORDING' : 'UPLOAD',
        title: body.title ?? titleFrom(body.filename),
        sensitivity: body.sensitivity ? toSensitivity(body.sensitivity) : 'INTERNAL',
        storageKey: key,
        mime: format.mime,
        sizeBytes: BigInt(body.sizeBytes),
        uploadId,
        partSize,
      },
    });
    const { file, access } = await this.files.open(viewer, id);
    const first = Array.from({ length: Math.min(FIRST_PARTS, partCount) }, (_, i) => i + 1);
    return {
      file: this.files.present(file, access),
      partSize,
      partCount,
      parts: await this.storage.presignParts(key, uploadId, first),
      uploadedParts: [],
    };
  }

  /** The uploader's own unfinished upload, or 404 (nobody else can touch it). */
  private async mine(viewer: Viewer, id: string) {
    const { file, access } = await this.files.open(viewer, id);
    if (file.status !== 'UPLOADING' || !file.uploadId || !file.partSize) {
      throw new ApiException(409, 'ALREADY_UPLOADED', 'This upload has already finished.');
    }
    if (file.ownerId !== viewer.userId) {
      throw new ApiException(404, 'NOT_FOUND', 'This upload doesn’t exist.');
    }
    return { file, access, uploadId: file.uploadId, partSize: file.partSize };
  }

  @Get(':id')
  @RequireRole('member')
  @ApiOperation({ summary: 'Resume an upload: what storage already holds, and fresh part URLs.' })
  @ApiOkResponse({ standardSchema: UploadSchema })
  async resume(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof UploadSchema>> {
    const viewer = viewerOf(auth);
    const { file, access, uploadId, partSize } = await this.mine(viewer, id);
    const partCount = partCountFor(Number(file.sizeBytes), partSize);
    const have = await this.storage.listParts(file.storageKey, uploadId);
    const done = new Set(have.map((p) => p.partNumber));
    const missing = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
    return {
      file: this.files.present(file, access),
      partSize,
      partCount,
      parts: await this.storage.presignParts(
        file.storageKey,
        uploadId,
        missing.slice(0, FIRST_PARTS),
      ),
      uploadedParts: have.map(({ partNumber, etag }) => ({ partNumber, etag })),
    };
  }

  @Post(':id/parts')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({ summary: 'More presigned part URLs (up to 100 at a time).' })
  @ApiOkResponse({ standardSchema: PartsResponse })
  async parts(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: PartsRequest }) body: z.infer<typeof PartsRequest>,
  ): Promise<z.infer<typeof PartsResponse>> {
    const viewer = viewerOf(auth);
    const { file, uploadId, partSize } = await this.mine(viewer, id);
    const partCount = partCountFor(Number(file.sizeBytes), partSize);
    if (body.partNumbers.some((n) => n > partCount)) {
      throw new ApiException(400, 'INVALID_PART', `This upload has ${partCount} parts.`);
    }
    return { parts: await this.storage.presignParts(file.storageKey, uploadId, body.partNumbers) };
  }

  @Post(':id/complete')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finish an upload: checks every part arrived, then queues processing.' })
  @ApiOkResponse({ standardSchema: UploadSchema.shape.file })
  async complete(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: CompleteUpload }) body: z.infer<typeof CompleteUpload>,
  ) {
    const viewer = viewerOf(auth);
    const { file, uploadId, partSize } = await this.mine(viewer, id);
    const partCount = partCountFor(Number(file.sizeBytes), partSize);
    const numbers = new Set(body.parts.map((p) => p.partNumber));
    if (numbers.size !== partCount || [...numbers].some((n) => n > partCount)) {
      throw new ApiException(
        400,
        'PARTS_MISSING',
        'Some of the file didn’t arrive. Resume the upload to send the rest.',
      );
    }
    try {
      await this.storage.completeMultipart(file.storageKey, uploadId, body.parts);
    } catch {
      throw new ApiException(
        409,
        'PARTS_MISSING',
        'Some of the file didn’t arrive. Resume the upload to send the rest.',
      );
    }
    const stored = await this.storage.head(file.storageKey);
    if (stored.size !== Number(file.sizeBytes)) {
      // Don't keep a file that isn't what the person picked.
      await this.storage.deletePrefix(this.storage.keys.file(viewer.workspaceId, id));
      await this.files.db(viewer.workspaceId).file.delete({ where: { id } });
      throw new ApiException(
        422,
        'SIZE_MISMATCH',
        'The file changed while it was uploading. Upload it again.',
      );
    }

    const updated = await this.files.db(viewer.workspaceId).file.update({
      where: { id },
      data: { status: 'UPLOADED', statusAt: new Date(), uploadId: null },
    });
    await this.queue.publish(Queues.fileUploaded, {
      v: 1,
      fileId: id,
      workspaceId: viewer.workspaceId,
      kind: updated.kind,
      storageKey: updated.storageKey,
      mime: updated.mime,
    });
    await this.files.emit(updated, 'status');
    await this.audit.record(viewer.workspaceId, auth, {
      action: updated.source === 'RECORDING' ? 'file.recorded' : 'file.uploaded',
      target: { type: 'file', id },
      meta: { name: updated.title, kind: updated.kind.toLowerCase() },
    });
    const { file: done, access } = await this.files.open(viewer, id);
    return this.files.present(done, access);
  }

  @Delete(':id')
  @RequireRole('member')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cancel an upload: storage drops the parts and the file is removed.' })
  @ApiNoContentResponse()
  async abort(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const { file, uploadId } = await this.mine(viewer, id);
    await this.storage.abortMultipart(file.storageKey, uploadId);
    await this.files.db(viewer.workspaceId).file.delete({ where: { id } });
  }
}
