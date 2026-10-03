import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Queues } from '@sotto/contracts';
import { type Prisma, tenantTransaction } from '@sotto/db';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { accessAtLeast } from '../auth/roles.js';
import { CollectionsModule } from '../collections/collections.controller.js';
import { CollectionsService } from '../collections/collections.service.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth } from '../common/request.js';
import { QueueService, StorageService } from '../infra.module.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { canDeleteForever, canRelabel } from './access.js';
import { FilesService, toSensitivity } from './files.service.js';
import {
  DownloadLink,
  DownloadQuery,
  FilePage,
  FileSchema,
  ListFilesQuery,
  UpdateFile,
  type FileOut,
} from './schemas.js';
import { UploadsController, viewerOf } from './uploads.controller.js';

const DOWNLOAD_SECONDS = 900;

@ApiTags('files')
@ApiErrors()
@Controller('files')
export class FilesController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Files you can see: filter, search titles, page with the cursor.' })
  @ApiOkResponse({ standardSchema: FilePage })
  list(
    @Ctx() auth: RequestAuth,
    @Query({ schema: ListFilesQuery }) query: z.infer<typeof ListFilesQuery>,
  ): Promise<z.infer<typeof FilePage>> {
    return this.files.list(viewerOf(auth), query);
  }

  @Get(':id')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'One file, including from the trash.' })
  @ApiOkResponse({ standardSchema: FileSchema })
  async get(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<FileOut> {
    const { file, access } = await this.files.open(viewerOf(auth), id, { trashed: 'include' });
    return this.files.present(file, access);
  }

  @Patch(':id')
  @RequireRole('member')
  @ApiOperation({ summary: 'Rename, move, tag, pin or relabel a file (needs Edit).' })
  @ApiOkResponse({ standardSchema: FileSchema })
  async update(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateFile }) body: z.infer<typeof UpdateFile>,
  ): Promise<FileOut> {
    const viewer = viewerOf(auth);
    const { file } = await this.files.require(
      viewer,
      id,
      'EDIT',
      'You can view this file but not change it.',
    );

    const data: Prisma.FileUpdateInput = {};
    const moving = body.collectionId !== undefined && body.collectionId !== file.collectionId;
    if (moving) {
      if (body.collectionId) {
        await this.collections.require(
          viewer,
          body.collectionId,
          'EDIT',
          'You can’t add files to that collection.',
        );
        data.collection = { connect: { id: body.collectionId } };
      } else {
        data.collection = { disconnect: true };
      }
    }
    const sensitivity = body.sensitivity ? toSensitivity(body.sensitivity) : file.sensitivity;
    if (!canRelabel(viewer, file.sensitivity, sensitivity)) {
      throw new ApiException(
        403,
        'ADMIN_REQUIRED',
        'Only admins and owners can lower a file from Restricted.',
      );
    }
    if (body.title !== undefined) data.title = body.title;
    if (body.tags !== undefined) data.tags = [...new Set(body.tags)];
    if (body.pinned !== undefined) data.pinned = body.pinned;
    if (sensitivity !== file.sensitivity) data.sensitivity = sensitivity;

    const db = this.files.db(viewer.workspaceId);
    const updated = await tenantTransaction(db, async (tx) => {
      const row = await tx.file.update({ where: { id }, data });
      // Chunks carry the file's collection and label so search filters stay inside SQL.
      if (moving || sensitivity !== file.sensitivity) {
        await tx.chunk.updateMany({
          where: { fileId: id },
          data: { collectionId: row.collectionId, sensitivity: row.sensitivity },
        });
      }
      return row;
    });

    const target = { type: 'file' as const, id };
    if (body.title !== undefined && body.title !== file.title) {
      await this.audit.record(viewer.workspaceId, auth, {
        action: 'file.renamed',
        target,
        meta: { from: file.title, to: updated.title },
      });
    }
    if (moving) {
      const to = updated.collectionId
        ? (await this.collections.open(viewer, updated.collectionId)).name
        : null;
      await this.audit.record(viewer.workspaceId, auth, {
        action: 'file.moved',
        target,
        meta: { name: updated.title, from: file.collection?.name ?? null, to },
      });
    }
    if (sensitivity !== file.sensitivity) {
      await this.audit.record(viewer.workspaceId, auth, {
        action: 'file.relabelled',
        target,
        meta: {
          name: updated.title,
          from: file.sensitivity.toLowerCase(),
          to: sensitivity.toLowerCase(),
        },
      });
    }
    await this.files.emit(updated, 'updated');
    const { file: after, access } = await this.files.open(viewer, id);
    return this.files.present(after, access);
  }

  @Delete(':id')
  @RequireRole('member')
  @HttpCode(204)
  @ApiOperation({ summary: 'Move a file to the trash (restorable for 30 days).' })
  @ApiNoContentResponse()
  async trash(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const { file } = await this.files.require(
      viewer,
      id,
      'EDIT',
      'You can view this file but not delete it.',
    );
    const updated = await this.files
      .db(viewer.workspaceId)
      .file.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.files.emit(updated, 'removed');
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'file.trashed',
      target: { type: 'file', id },
      meta: { name: file.title },
    });
  }

  @Post(':id/restore')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bring a file back from the trash.' })
  @ApiOkResponse({ standardSchema: FileSchema })
  async restore(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<FileOut> {
    const viewer = viewerOf(auth);
    const { file } = await this.files.require(
      viewer,
      id,
      'EDIT',
      'You can view this file but not restore it.',
      { trashed: 'include' },
    );
    if (!file.deletedAt) {
      const { access } = await this.files.open(viewer, id);
      return this.files.present(file, access);
    }
    const updated = await this.files
      .db(viewer.workspaceId)
      .file.update({ where: { id }, data: { deletedAt: null } });
    await this.files.emit(updated, 'updated');
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'file.restored',
      target: { type: 'file', id },
      meta: { name: file.title },
    });
    const { file: after, access } = await this.files.open(viewer, id);
    return this.files.present(after, access);
  }

  @Delete(':id/permanent')
  @RequireRole('member')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a file for good: the original, transcript, chunks and embeddings.',
  })
  @ApiNoContentResponse()
  async destroy(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const { file, access } = await this.files.open(viewer, id, { trashed: 'include' });
    if (!canDeleteForever(viewer, file, access)) {
      throw new ApiException(
        403,
        'ACCESS_REQUIRED',
        'Only the person who added this file, or someone who manages its collection, can delete it for good.',
      );
    }
    if (file.uploadId) await this.storage.abortMultipart(file.storageKey, file.uploadId);
    // Storage first: if it fails, the row stays and the delete can be tried again; the
    // database cascade removes the transcript, insights, chunks, vectors and positions.
    await this.storage.deletePrefix(this.storage.keys.file(viewer.workspaceId, id));
    await this.files.db(viewer.workspaceId).file.delete({ where: { id } });
    await this.files.emit({ ...file, deletedAt: file.deletedAt ?? new Date() }, 'removed');
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'file.deleted',
      target: { type: 'file', id },
      meta: { name: file.title },
    });
  }

  @Post(':id/retry')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({ summary: 'Process a failed file again from the start.' })
  @ApiOkResponse({ standardSchema: FileSchema })
  async retry(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<FileOut> {
    const viewer = viewerOf(auth);
    const { file } = await this.files.require(
      viewer,
      id,
      'EDIT',
      'You can view this file but not retry it.',
    );
    if (file.status !== 'FAILED') {
      throw new ApiException(
        409,
        'NOT_FAILED',
        'This file hasn’t failed, so there’s nothing to retry.',
      );
    }
    const updated = await this.files.db(viewer.workspaceId).file.update({
      where: { id },
      data: { status: 'UPLOADED', statusAt: new Date(), error: null, progress: null },
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
    const { file: after, access } = await this.files.open(viewer, id);
    return this.files.present(after, access);
  }

  @Get(':id/download')
  @RequireRole('viewer')
  @ApiOperation({
    summary: 'A short-lived link to the original. `inline=true` opens it in place (the player).',
  })
  @ApiOkResponse({ standardSchema: DownloadLink })
  async download(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Query({ schema: DownloadQuery }) query: z.infer<typeof DownloadQuery>,
  ): Promise<z.infer<typeof DownloadLink>> {
    const viewer = viewerOf(auth);
    const { file, access } = await this.files.open(viewer, id);
    if (!accessAtLeast(access, 'VIEW') || file.status === 'UPLOADING') {
      throw new ApiException(409, 'NOT_READY', 'This file is still uploading.');
    }
    const inline = query.inline === 'true';
    const extension = /\.[a-z0-9]+$/.exec(file.storageKey)?.[0] ?? '';
    const url = await this.storage.presignGet(file.storageKey, {
      filename: `${file.title}${extension}`,
      inline,
      contentType: file.mime,
      expiresIn: DOWNLOAD_SECONDS,
    });
    // Playing a recording isn't an export; saving a copy is (BRIEF §4: the audit log has exports).
    if (!inline) {
      await this.audit.record(viewer.workspaceId, auth, {
        action: 'file.downloaded',
        target: { type: 'file', id },
        meta: { name: file.title },
      });
    }
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() };
  }
}

@Module({
  imports: [CollectionsModule],
  controllers: [UploadsController, FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
