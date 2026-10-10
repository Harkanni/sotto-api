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
  Put,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BYOK_PROVIDERS } from '@sotto/ai';
import { type AiProviderConfig, type AiRoute, indexCoverage } from '@sotto/db';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { AiSettingsService, type CatalogEntry, type Policy } from './ai-settings.service.js';
import { MODE_LABEL, parseRef } from './models.js';

// ── Schemas ──────────────────────────────────────────────────────────

export const AiModeSchema = z.enum(['PRIVATE', 'BYOK', 'MANAGED']).meta({ id: 'AiMode' });

const ModelRef = z.string().min(3).max(300);

export const AiPolicySchema = z
  .object({
    allowedModes: z.array(AiModeSchema),
    defaultMode: AiModeSchema,
    /** A model reference from the catalog; null = the default mode's first model. */
    defaultModel: ModelRef.nullable(),
    /** Modes besides Private that may read Confidential sources. Restricted: Private only. */
    confidentialModes: z.array(AiModeSchema),
    disabledModels: z.array(ModelRef),
  })
  .meta({ id: 'AiPolicy' });

const Availability = z.object({
  available: z.boolean(),
  /** Why not: no_model (Private), no_master_key (BYOK), not_configured (Managed). */
  reason: z.string().optional(),
});

export const AiSettingsSchema = z
  .object({
    policy: AiPolicySchema,
    modes: z.array(z.object({ mode: AiModeSchema, label: z.string(), availability: Availability })),
    /** The model Ask uses when nobody picks one, or null (Ask answers with passages). */
    effectiveDefault: ModelRef.nullable(),
  })
  .meta({ id: 'AiSettings' });

export const UpdateAiPolicy = AiPolicySchema.partial()
  .refine((b) => Object.keys(b).length > 0, 'Change something first.')
  .meta({ id: 'UpdateAiPolicy' });

export const CatalogEntrySchema = z
  .object({
    ref: ModelRef,
    mode: AiModeSchema,
    model: z.string(),
    providerLabel: z.string(),
    keyLabel: z.string().nullable(),
    routeLabel: z.string(),
    dataLocation: z.enum(['IN_CLUSTER', 'THIRD_PARTY']),
    isMock: z.boolean(),
    enabled: z.boolean(),
    allowed: z.boolean(),
    /** What this model may read: Confidential only where the policy says, Restricted never outside. */
    readsConfidential: z.boolean(),
    readsRestricted: z.boolean(),
  })
  .meta({ id: 'AiCatalogEntry' });

export const AiModelsSchema = z
  .object({ models: z.array(CatalogEntrySchema), defaultRef: ModelRef.nullable() })
  .meta({ id: 'AiModels' });

export const ProviderIdSchema = z
  .enum(['anthropic', 'openai', 'google', 'openai-compatible'])
  .meta({ id: 'AiProviderId' });

export const AiProviderInfoSchema = z
  .object({
    id: ProviderIdSchema,
    label: z.string(),
    keyHint: z.string(),
    keyRequired: z.boolean(),
    needsBaseUrl: z.boolean(),
  })
  .meta({ id: 'AiProviderInfo' });

export const AiKeySchema = z
  .object({
    id: z.string(),
    provider: ProviderIdSchema,
    providerLabel: z.string(),
    label: z.string(),
    /** The last four characters; the key itself never leaves the api. */
    keyLast4: z.string().nullable(),
    baseUrl: z.string().nullable(),
    models: z.array(z.string()),
    verifiedAt: z.string().nullable(),
    /** The last failed Test connection, as a code. */
    lastError: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'AiKey' });

export const AiKeysSchema = z
  .object({
    keys: z.array(AiKeySchema),
    providers: z.array(AiProviderInfoSchema),
    /** False when the server has no master key: keys can't be saved. */
    canStoreKeys: z.boolean(),
  })
  .meta({ id: 'AiKeys' });

const KeyLabel = z
  .string()
  .trim()
  .min(1, 'Name the key.')
  .max(60, 'Keep the name under 60 characters.');
const ApiKey = z.string().trim().min(8, 'That key looks too short.').max(500);

export const AddAiKey = z
  .object({
    provider: ProviderIdSchema,
    label: KeyLabel,
    apiKey: ApiKey.optional(),
    baseUrl: z.string().trim().max(500).optional(),
  })
  .meta({ id: 'AddAiKey' });

export const UpdateAiKey = z
  .object({ label: KeyLabel.optional(), apiKey: ApiKey.optional() })
  .refine((b) => b.label !== undefined || b.apiKey !== undefined, 'Change the name or the key.')
  .meta({ id: 'UpdateAiKey' });

export const ToggleModel = z.object({ enabled: z.boolean() }).meta({ id: 'ToggleAiModel' });

// ── Mapping ──────────────────────────────────────────────────────────

/** What a model may read under a policy (the same rule retrieval applies in SQL). */
export function reads(mode: AiRoute, policy: Policy) {
  return {
    readsConfidential: mode === 'PRIVATE' || policy.confidentialModes.includes(mode),
    readsRestricted: mode === 'PRIVATE',
  };
}

function entryOut(e: CatalogEntry, policy: Policy): z.infer<typeof CatalogEntrySchema> {
  return { ...e, ...reads(e.mode, policy) };
}

function keyOut(k: AiProviderConfig): z.infer<typeof AiKeySchema> {
  const info = BYOK_PROVIDERS.find((p) => p.id === k.provider);
  return {
    id: k.id,
    provider: k.provider as z.infer<typeof ProviderIdSchema>,
    providerLabel: info?.label ?? k.provider,
    label: k.label,
    keyLast4: k.keyLast4,
    baseUrl: k.baseUrl,
    models: k.models,
    verifiedAt: k.verifiedAt?.toISOString() ?? null,
    lastError: k.lastError,
    createdAt: k.createdAt.toISOString(),
  };
}

const ModelRefParam = z.string().min(3).max(300);

export const EmbeddingIndexesSchema = z
  .object({
    /** The model new files are embedded with (AI_EMBEDDINGS). */
    configured: z.string(),
    indexes: z.array(
      z.object({
        model: z.string(),
        dims: z.number().int(),
        /** BUILDING until it covers every chunk; RETIRED once another index replaced it. */
        status: z.enum(['BUILDING', 'READY', 'RETIRED']),
        /** The one searches use. */
        serving: z.boolean(),
        /** This workspace's passages with a vector from this model, of all its passages. */
        embedded: z.number().int(),
        total: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'EmbeddingIndexes' });

/**
 * AI settings (BRIEF §3, PLAN → API "AI settings" and "AI providers"): where questions may go,
 * the workspace's own keys and which models people can pick. Admins and owners change them;
 * everyone can see which models they may pick (`GET /ai/models`).
 */
@ApiTags('ai')
@ApiErrors()
@Controller('ai')
export class AiController {
  constructor(
    @Inject(AiSettingsService) private readonly settings: AiSettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Which embedding index serves searches and how much of this workspace each covers. Read
   * only: a re-index runs across every workspace, so it is an operator command
   * (`node dist/reindex-cli.js` in the worker, ADR 0027), not a workspace setting.
   */
  @Get('embeddings/indexes')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Embedding indexes: which one serves, and how much each covers.' })
  @ApiOkResponse({ standardSchema: EmbeddingIndexesSchema })
  async indexes(@Ctx() auth: RequestAuth): Promise<z.infer<typeof EmbeddingIndexesSchema>> {
    const rows = await indexCoverage(this.prisma.client, workspaceOf(auth).id);
    return { configured: this.config.AI_EMBEDDINGS, indexes: rows };
  }

  private async settingsOut(workspaceId: string): Promise<z.infer<typeof AiSettingsSchema>> {
    const policy = await this.settings.policy(workspaceId);
    const availability = this.settings.availability();
    const usable = (await this.settings.catalog(workspaceId, policy)).filter(
      (e) => e.enabled && e.allowed,
    );
    return {
      policy,
      modes: (['PRIVATE', 'BYOK', 'MANAGED'] as const).map((mode) => ({
        mode,
        label: MODE_LABEL[mode],
        availability: availability[mode],
      })),
      effectiveDefault: this.settings.defaultRef(policy, usable),
    };
  }

  @Get('policy')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Where questions may be answered, and which modes this server offers.' })
  @ApiOkResponse({ standardSchema: AiSettingsSchema })
  async getPolicy(@Ctx() auth: RequestAuth): Promise<z.infer<typeof AiSettingsSchema>> {
    return this.settingsOut(workspaceOf(auth).id);
  }

  @Put('policy')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Change the AI policy: allowed modes, defaults, Confidential rule.' })
  @ApiOkResponse({ standardSchema: AiSettingsSchema })
  async putPolicy(
    @Ctx() auth: RequestAuth,
    @Body({ schema: UpdateAiPolicy }) body: z.infer<typeof UpdateAiPolicy>,
  ): Promise<z.infer<typeof AiSettingsSchema>> {
    const workspace = workspaceOf(auth);
    const before = await this.settings.policy(workspace.id);
    const next = await this.settings.validatePolicy(workspace.id, { ...before, ...body });
    await this.settings.savePolicy(workspace.id, auth.user.id, next);
    const changed = (Object.keys(next) as (keyof Policy)[]).filter(
      (k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]),
    );
    if (changed.length) {
      await this.audit.record(workspace.id, auth, {
        action: 'ai.policy_changed',
        target: { type: 'workspace', id: workspace.id },
        meta: {
          changed,
          allowedModes: next.allowedModes,
          defaultMode: next.defaultMode,
          confidentialModes: next.confidentialModes,
        },
      });
    }
    return this.settingsOut(workspace.id);
  }

  @Get('models')
  @ApiOperation({ summary: 'The models you can pick in Ask, and the default.' })
  @ApiOkResponse({ standardSchema: AiModelsSchema })
  async models(@Ctx() auth: RequestAuth): Promise<z.infer<typeof AiModelsSchema>> {
    const workspace = workspaceOf(auth);
    const policy = await this.settings.policy(workspace.id);
    const { models, defaultRef } = await this.settings.usableModels(workspace.id);
    return { models: models.map((m) => entryOut(m, policy)), defaultRef };
  }

  @Get('catalog')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Every model this workspace could use, on or off.' })
  @ApiOkResponse({ standardSchema: AiModelsSchema })
  async catalog(@Ctx() auth: RequestAuth): Promise<z.infer<typeof AiModelsSchema>> {
    const workspace = workspaceOf(auth);
    const policy = await this.settings.policy(workspace.id);
    const all = await this.settings.catalog(workspace.id, policy);
    return {
      models: all.map((m) => entryOut(m, policy)),
      defaultRef: this.settings.defaultRef(
        policy,
        all.filter((e) => e.enabled && e.allowed),
      ),
    };
  }

  @Put('catalog/:ref')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Turn a model on or off for this workspace.' })
  @ApiOkResponse({ standardSchema: CatalogEntrySchema })
  async toggle(
    @Ctx() auth: RequestAuth,
    @Param('ref', { schema: ModelRefParam }) ref: string,
    @Body({ schema: ToggleModel }) body: z.infer<typeof ToggleModel>,
  ): Promise<z.infer<typeof CatalogEntrySchema>> {
    const workspace = workspaceOf(auth);
    const policy = await this.settings.policy(workspace.id);
    const entry = (await this.settings.catalog(workspace.id, policy)).find((e) => e.ref === ref);
    if (!parseRef(ref) || !entry) {
      throw new ApiException(404, 'MODEL_NOT_FOUND', 'That model isn’t available any more.');
    }
    if (!body.enabled && policy.defaultModel === ref) {
      throw new ApiException(
        409,
        'MODEL_IS_DEFAULT',
        'This is the default model. Choose another default first.',
      );
    }
    if (entry.enabled !== body.enabled) {
      const disabledModels = body.enabled
        ? policy.disabledModels.filter((r) => r !== ref)
        : [...policy.disabledModels, ref];
      const next = { ...policy, disabledModels };
      await this.settings.savePolicy(workspace.id, auth.user.id, next);
      await this.audit.record(workspace.id, auth, {
        action: 'ai.model_toggled',
        target: { type: 'workspace', id: workspace.id },
        meta: { model: entry.model, provider: entry.providerLabel, enabled: body.enabled },
      });
      return entryOut({ ...entry, enabled: body.enabled }, next);
    }
    return entryOut(entry, policy);
  }

  @Get('providers')
  @RequireRole('admin')
  @ApiOperation({ summary: 'This workspace’s own API keys (never the keys themselves).' })
  @ApiOkResponse({ standardSchema: AiKeysSchema })
  async keys(@Ctx() auth: RequestAuth): Promise<z.infer<typeof AiKeysSchema>> {
    const keys = await this.settings.listKeys(workspaceOf(auth).id);
    return {
      keys: keys.map(keyOut),
      providers: BYOK_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        keyHint: p.keyHint,
        keyRequired: p.keyRequired,
        needsBaseUrl: p.baseUrl === null,
      })),
      canStoreKeys: this.settings.vault.available,
    };
  }

  @Post('providers')
  @RequireRole('admin')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Add an API key. It is tested first and stored encrypted only if it works.',
  })
  @ApiOkResponse({ standardSchema: AiKeySchema })
  async addKey(
    @Ctx() auth: RequestAuth,
    @Body({ schema: AddAiKey }) body: z.infer<typeof AddAiKey>,
  ): Promise<z.infer<typeof AiKeySchema>> {
    const workspace = workspaceOf(auth);
    const key = await this.settings.addKey(workspace.id, auth.user.id, body);
    await this.audit.record(workspace.id, auth, {
      action: 'ai.key_added',
      target: { type: 'workspace', id: workspace.id },
      meta: { name: key.label, provider: keyOut(key).providerLabel },
    });
    return keyOut(key);
  }

  @Patch('providers/:id')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Rename a key, or replace it with a new one (tested first).' })
  @ApiOkResponse({ standardSchema: AiKeySchema })
  async updateKey(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateAiKey }) body: z.infer<typeof UpdateAiKey>,
  ): Promise<z.infer<typeof AiKeySchema>> {
    const workspace = workspaceOf(auth);
    const before = await this.settings.findKey(workspace.id, id);
    const key = await this.settings.updateKey(workspace.id, id, body);
    if (body.apiKey) {
      await this.audit.record(workspace.id, auth, {
        action: 'ai.key_replaced',
        target: { type: 'workspace', id: workspace.id },
        meta: { name: key.label, provider: keyOut(key).providerLabel },
      });
    }
    if (body.label !== undefined && body.label !== before.label) {
      await this.audit.record(workspace.id, auth, {
        action: 'ai.key_renamed',
        target: { type: 'workspace', id: workspace.id },
        meta: { from: before.label, to: key.label },
      });
    }
    return keyOut(key);
  }

  @Post('providers/:id/test')
  @RequireRole('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Test a saved key again and refresh its models.' })
  @ApiOkResponse({ standardSchema: AiKeySchema })
  async testKey(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof AiKeySchema>> {
    return keyOut(await this.settings.retestKey(workspaceOf(auth).id, id));
  }

  @Delete('providers/:id')
  @RequireRole('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a key. Its models leave the catalog at once.' })
  async removeKey(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const workspace = workspaceOf(auth);
    const key = await this.settings.removeKey(workspace.id, auth.user.id, id);
    await this.audit.record(workspace.id, auth, {
      action: 'ai.key_removed',
      target: { type: 'workspace', id: workspace.id },
      meta: { name: key.label, provider: keyOut(key).providerLabel },
    });
  }
}

@Module({
  controllers: [AiController],
  providers: [AiSettingsService],
  exports: [AiSettingsService],
})
export class AiModule {}
