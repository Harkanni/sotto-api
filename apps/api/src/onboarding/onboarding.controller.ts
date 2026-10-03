import { Controller, HttpCode, Inject, Module, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { tenantTransaction } from '@sotto/db';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { CollectionsModule } from '../collections/collections.controller.js';
import { CollectionsService } from '../collections/collections.service.js';
import { ApiErrors } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { readWorkspaceMeta, writeWorkspaceMeta } from '../workspaces/metadata.js';

/**
 * The fictional sample workspace's collections (PLAN → API: "POST /onboarding/sample-content
 * (fictional files)"). Phase 3 creates the collections as real rows, so roles and grants apply
 * to them; their documents, meetings and chats are the web app's labelled sample layer until
 * Phase 4 turns them into real files. Keys match the web's sample data.
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
  constructor(
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('sample-content')
  @RequireRole('owner')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Fill the workspace with fictional sample content (owners). Loading it twice changes nothing.',
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

    if (result.created) {
      await this.audit.record(workspace.id, auth, {
        action: 'onboarding.sample_loaded',
        target: { type: 'workspace', id: workspace.id },
        meta: { collections: SAMPLE_COLLECTIONS.length },
      });
    }
    return result.sample;
  }
}

@Module({ imports: [CollectionsModule], controllers: [OnboardingController] })
export class OnboardingModule {}
