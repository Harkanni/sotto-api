import { Controller, HttpCode, Inject, Logger, Module, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Queues, TranscriptDocument } from '@sotto/contracts';
import { tenantTransaction } from '@sotto/db';
import { Derived } from '@sotto/storage';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { CollectionsModule } from '../collections/collections.controller.js';
import { CollectionsService } from '../collections/collections.service.js';
import { ApiErrors } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { newFileId } from '../files/uploads.controller.js';
import { QueueService, StorageService } from '../infra.module.js';
import {
  type WorkspaceMeta,
  readWorkspaceMeta,
  writeWorkspaceMeta,
} from '../workspaces/metadata.js';
import { SAMPLE_DOCS, SAMPLE_MEETINGS, sampleSegments } from './sample-files.js';

/**
 * The fictional sample workspace's collections (PLAN → API: "POST /onboarding/sample-content
 * (fictional files)"). The collections are real rows, so roles and grants apply to them; since
 * Phase 4 their memos and meetings are real files too (sample-files.ts), processed by the same
 * pipeline as uploads. Chats stay in the web's labelled sample layer until Phase 5.
 */
export const SAMPLE_COLLECTIONS = [
  { key: 'product', name: 'Product', restricted: false },
  { key: 'customers', name: 'Customers', restricted: false },
  { key: 'board', name: 'Board and finance', restricted: true },
  { key: 'handbook', name: 'Handbook', restricted: false },
] as const;

export const SampleContent = z
  .object({
    /** Sample key ("product", "board"…) → collection id. */
    collections: z.record(z.string(), z.string()),
    loadedAt: z.iso.datetime(),
  })
  .meta({ id: 'SampleContent' });

@ApiTags('onboarding')
@ApiErrors()
@Controller('onboarding')
export class OnboardingController {
  private readonly log = new Logger('onboarding');

  constructor(
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(QueueService) private readonly queue: QueueService,
  ) {}

  @Post('sample-content')
  @RequireRole('owner')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fill the workspace with fictional sample content (owners): collections, memos and ' +
      'meetings. Loading it twice changes nothing; a workspace that loaded only the ' +
      'collections earlier gets the files.',
  })
  @ApiOkResponse({ standardSchema: SampleContent })
  async load(@Ctx() auth: RequestAuth): Promise<z.infer<typeof SampleContent>> {
    const workspace = workspaceOf(auth);
    const db = this.collections.db(workspace.id);

    const result = await tenantTransaction(db, async (tx) => {
      const current = await tx.workspace.findFirstOrThrow({ select: { metadata: true } });
      const meta = readWorkspaceMeta(current.metadata);
      if (meta.sample) return { sample: meta.sample, created: false };

      const collections: Record<string, string> = {};
      for (const sample of SAMPLE_COLLECTIONS) {
        const row = await tx.collection.create({
          data: {
            workspaceId: workspace.id,
            name: sample.name,
            restricted: sample.restricted,
            permissions: {
              create: { workspaceId: workspace.id, userId: auth.user.id, access: 'MANAGE' },
            },
          },
          select: { id: true },
        });
        collections[sample.key] = row.id;
      }
      const sample = { loadedAt: new Date().toISOString(), collections };
      await tx.workspace.update({
        where: { id: workspace.id },
        data: { metadata: writeWorkspaceMeta({ ...meta, sample }) },
      });
      return { sample, created: true };
    });

    let sample: NonNullable<WorkspaceMeta['sample']> = result.sample;
    if (!sample.filesLoadedAt) {
      await this.addFiles(workspace.id, auth.user.id, sample.collections);
      sample = { ...sample, filesLoadedAt: new Date().toISOString() };
      const current = await db.workspace.findFirstOrThrow({ select: { metadata: true } });
      await db.workspace.update({
        where: { id: workspace.id },
        data: {
          metadata: writeWorkspaceMeta({ ...readWorkspaceMeta(current.metadata), sample }),
        },
      });
    }

    if (result.created) {
      await this.audit.record(workspace.id, auth, {
        action: 'onboarding.sample_loaded',
        target: { type: 'workspace', id: workspace.id },
        meta: { collections: SAMPLE_COLLECTIONS.length },
      });
    }
    return { collections: sample.collections, loadedAt: sample.loadedAt };
  }

  /**
   * Adds the sample memos and meetings as real files in the sample collections that still exist.
   * Memos go through the pipeline like uploads (extract, chunk, embed). Meetings have no audio:
   * their transcript is written where the transcriber would put it and the worker picks it up
   * from transcribe.completed, keeping the sample notes written here.
   */
  private async addFiles(
    workspaceId: string,
    ownerId: string,
    collections: Record<string, string>,
  ): Promise<void> {
    const db = this.collections.db(workspaceId);
    const existing = new Set(
      (await db.collection.findMany({ select: { id: true } })).map((c) => c.id),
    );
    const target = (key: string) => {
      const id = collections[key];
      return id && existing.has(id) ? id : null;
    };

    for (const doc of SAMPLE_DOCS) {
      const collectionId = target(doc.collection);
      if (!collectionId) continue;
      const id = newFileId();
      const body = Buffer.from(doc.body, 'utf8');
      const storageKey = this.storage.keys.original(workspaceId, id, `${doc.key}.md`);
      await this.storage.putBytes(storageKey, body, 'text/markdown');
      const file = await db.file.create({
        data: {
          id,
          workspaceId,
          collectionId,
          ownerId,
          kind: 'DOCUMENT',
          source: 'SAMPLE',
          title: doc.title,
          status: 'UPLOADED',
          sensitivity: doc.sensitivity,
          storageKey,
          mime: 'text/markdown',
          sizeBytes: BigInt(body.length),
          pinned: doc.pinned ?? false,
          tags: doc.tags ?? [],
        },
      });
      await this.queue.publish(Queues.fileUploaded, {
        v: 1,
        fileId: file.id,
        workspaceId,
        kind: 'DOCUMENT',
        storageKey,
        mime: file.mime,
      });
    }

    for (const meeting of SAMPLE_MEETINGS) {
      const collectionId = target(meeting.collection);
      if (!collectionId) continue;
      const id = newFileId();
      const segments = sampleSegments(meeting.lines);
      const durationMs = segments.at(-1)!.endMs + 2_000;
      const transcriptKey = this.storage.keys.derived(workspaceId, id, Derived.transcript);
      await this.storage.putJson(
        transcriptKey,
        TranscriptDocument.parse({
          engine: 'sample',
          model: 'none',
          language: 'en',
          durationMs,
          segments,
        }),
      );
      await db.file.create({
        data: {
          id,
          workspaceId,
          collectionId,
          ownerId,
          kind: 'AUDIO',
          source: 'SAMPLE',
          title: meeting.title,
          status: 'TRANSCRIBING',
          progress: 1,
          sensitivity: meeting.sensitivity,
          // No object here: sample meetings have no audio (download says so).
          storageKey: this.storage.keys.original(workspaceId, id, 'sample.webm'),
          mime: 'audio/webm',
          sizeBytes: 0n,
          durationMs,
          pinned: meeting.pinned ?? false,
          insights: {
            create: {
              workspaceId,
              ...meeting.notes,
              model: 'sample',
              route: 'PRIVATE',
              isMock: false,
            },
          },
        },
      });
      await this.queue.publish(Queues.transcribeCompleted, {
        v: 1,
        status: 'ok',
        fileId: id,
        workspaceId,
        transcriptKey,
        engine: 'sample',
        model: 'none',
        durationMs,
      });
    }
    this.log.log(`sample files queued for ${workspaceId}`);
  }
}

@Module({ imports: [CollectionsModule], controllers: [OnboardingController] })
export class OnboardingModule {}
