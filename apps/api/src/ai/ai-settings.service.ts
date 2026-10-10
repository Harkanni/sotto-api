import { Inject, Injectable } from '@nestjs/common';
import {
  type ChatProvider,
  type ConnectionErrorCode,
  type DataLocation,
  EndpointError,
  type KeyVault,
  type SealedKey,
  type Sensitivity,
  askChatFrom,
  byokChatProvider,
  byokProvider,
  checkEndpointUrl,
  keyVaultFrom,
  managedChatFrom,
  testConnection,
} from '@sotto/ai';
import { type AiProviderConfig, type AiRoute, type Prisma, forWorkspace } from '@sotto/db';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { ApiException } from '../common/errors.js';
import { formatRef, parseRef } from './models.js';

/** The policy as the api uses it; a workspace with no row gets these defaults. */
export interface Policy {
  allowedModes: AiRoute[];
  defaultMode: AiRoute;
  defaultModel: string | null;
  confidentialModes: AiRoute[];
  disabledModels: string[];
}

export const DEFAULT_POLICY: Policy = {
  allowedModes: ['PRIVATE'],
  defaultMode: 'PRIVATE',
  defaultModel: null,
  confidentialModes: [],
  disabledModels: [],
};

/** One chat model a workspace could use. */
export interface CatalogEntry {
  ref: string;
  mode: AiRoute;
  /** The model id as the provider names it. */
  model: string;
  /** Who runs it: "Ollama (in your cluster)", "Claude", "Your server". */
  providerLabel: string;
  /** The key's own name, for BYOK. */
  keyLabel: string | null;
  /** What the data-route badge says when it answers. */
  routeLabel: string;
  dataLocation: DataLocation;
  isMock: boolean;
  /** Not turned off by an admin. */
  enabled: boolean;
  /** Its mode is allowed by the policy. */
  allowed: boolean;
}

/** A chat ready to answer, with everything the badge and the privacy rules need. */
export interface ResolvedChat {
  ref: string;
  provider: ChatProvider;
  model: string;
  route: AiRoute;
  routeLabel: string;
  dataLocation: DataLocation;
  isMock: boolean;
}

export type ModeAvailability = { available: true } | { available: false; reason: string };

export interface PlatformChat {
  provider: ChatProvider;
  model: string;
}

const MAX_KEYS = 10;
const MAX_MODELS_PER_KEY = 200;

/** People-facing sentences for a failed Test connection. */
export const CONNECTION_MESSAGE: Record<ConnectionErrorCode, string> = {
  invalid_key: 'The provider didn’t accept this key. Check it and paste it again.',
  no_access: 'This key can’t use the provider’s models. Check its permissions or billing.',
  not_found: 'Nothing answered at that address. Check that the URL ends in /v1.',
  rate_limited: 'The provider is limiting this key right now. Try again in a minute.',
  provider_error: 'The provider had a problem. Try again in a minute.',
  unreachable: 'Couldn’t reach the provider. Check the address and try again.',
  timeout: 'The provider took too long to answer. Try again.',
  no_models: 'The key works, but it can’t use any chat models.',
};

const ENDPOINT_MESSAGE: Record<string, string> = {
  base_url_required: 'Add the server’s address.',
  bad_url: 'That isn’t a valid address. Use something like https://llm.example.com/v1.',
  https_required:
    'Use an https:// address, so the key and your questions are encrypted on the way.',
  private_address:
    'That address points inside a private network. Use the server’s public https address.',
  unknown_provider: 'Choose a provider.',
};

/** Prisma's Bytes columns take a Uint8Array over a plain ArrayBuffer. */
function stored(sealed: SealedKey) {
  return {
    encryptedKey: new Uint8Array(sealed.encryptedKey),
    wrappedDek: new Uint8Array(sealed.wrappedDek),
    keyWrapper: sealed.keyWrapper,
    keyLast4: sealed.keyLast4,
  };
}

/**
 * The sensitivities a chat may read (BRIEF §3), applied inside the retrieval SQL: everything
 * in the cluster; outside it, Internal, plus Confidential only where the policy allows that
 * mode. Restricted never leaves the cluster, whatever the policy says.
 */
export function sensitivitiesFor(
  chat: { dataLocation: DataLocation; route: AiRoute } | null,
  policy: Policy,
): Sensitivity[] {
  if (!chat || chat.dataLocation === 'IN_CLUSTER')
    return ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
  return policy.confidentialModes.includes(chat.route)
    ? ['INTERNAL', 'CONFIDENTIAL']
    : ['INTERNAL'];
}

export function routeLabelFor(mode: AiRoute, providerLabel: string, isMock: boolean): string {
  if (isMock) return 'Mock chat · no model';
  if (mode === 'PRIVATE') return `Private · ${providerLabel}`;
  if (mode === 'BYOK') return `${providerLabel} · your API key`;
  return `Managed · ${providerLabel}`;
}

/**
 * Where a workspace's questions may go (BRIEF §3): its policy, the models it can pick from, and
 * its own keys. Private and Managed models come from the platform's settings; BYOK models come
 * from the workspace's keys, read from the provider when each key is tested.
 */
@Injectable()
export class AiSettingsService {
  readonly vault: KeyVault;
  private privateChat: PlatformChat | null = null;
  private managed: { provider: ChatProvider; models: string[] } | null = null;
  private readonly allowPrivateUrls: boolean;

  constructor(
    @Inject(APP_CONFIG) config: ApiConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {
    this.vault = keyVaultFrom(config);
    this.allowPrivateUrls = config.AI_BYOK_ALLOW_PRIVATE_URLS;
    const platform = askChatFrom(config);
    const managed = managedChatFrom(config);
    // Phase 5's platform chat may be a third party (AI_ASK_CHAT on a hosted API): that is
    // Sotto's own account, so it is Managed, never Private.
    if (platform && platform.provider.dataLocation === 'THIRD_PARTY') {
      this.usePlatformChats(
        null,
        managed ?? { provider: platform.provider, models: [platform.model] },
      );
    } else {
      this.usePlatformChats(platform, managed);
    }
  }

  /**
   * The platform's own models: Private (must run in the cluster) and Managed. Set from config
   * at startup; tests swap in scripted models the same way.
   */
  usePlatformChats(
    privateChat: PlatformChat | null,
    managed: { provider: ChatProvider; models: string[] } | null,
  ): void {
    if (privateChat && privateChat.provider.dataLocation !== 'IN_CLUSTER') {
      throw new Error('A Private model must run in the cluster');
    }
    this.privateChat = privateChat;
    this.managed = managed;
  }

  // ── Policy ──────────────────────────────────────────────────────────

  async policy(workspaceId: string): Promise<Policy> {
    const row = await forWorkspace(this.prisma.client, workspaceId).workspaceAiPolicy.findFirst();
    if (!row) return { ...DEFAULT_POLICY };
    return {
      allowedModes: row.allowedModes,
      defaultMode: row.defaultMode,
      defaultModel: row.defaultModel,
      confidentialModes: row.confidentialModes,
      disabledModels: row.disabledModels,
    };
  }

  availability(): Record<AiRoute, ModeAvailability> {
    return {
      PRIVATE: this.privateChat ? { available: true } : { available: false, reason: 'no_model' },
      BYOK: this.vault.available
        ? { available: true }
        : { available: false, reason: 'no_master_key' },
      MANAGED: this.managed ? { available: true } : { available: false, reason: 'not_configured' },
    };
  }

  /** Checks a new policy against the catalog; throws a people-facing error when it doesn't fit. */
  async validatePolicy(workspaceId: string, next: Policy): Promise<Policy> {
    const allowed = [...new Set(next.allowedModes)];
    if (allowed.length === 0) {
      throw new ApiException(400, 'NO_MODE', 'Allow at least one way to answer questions.');
    }
    if (!allowed.includes(next.defaultMode)) {
      throw new ApiException(400, 'DEFAULT_NOT_ALLOWED', 'The default mode must be one you allow.');
    }
    const availability = this.availability();
    const current = await this.policy(workspaceId);
    for (const mode of allowed) {
      const a = availability[mode];
      // Allowing a mode that can't work yet is refused, unless it was already allowed (so a
      // server losing its Managed key doesn't lock admins out of saving other changes).
      if (!a.available && mode !== 'PRIVATE' && !current.allowedModes.includes(mode)) {
        throw new ApiException(
          409,
          'MODE_UNAVAILABLE',
          mode === 'MANAGED'
            ? 'Managed AI isn’t set up on this server yet.'
            : 'This server can’t store API keys yet (it has no master key). Ask whoever runs it.',
        );
      }
    }
    const confidential = [...new Set(next.confidentialModes)].filter((m) => m !== 'PRIVATE');
    if (confidential.some((m) => !allowed.includes(m))) {
      throw new ApiException(
        400,
        'CONFIDENTIAL_NOT_ALLOWED',
        'Confidential files can only go to modes you allow.',
      );
    }
    const disabled = [...new Set(next.disabledModels)];
    let defaultModel = next.defaultModel;
    if (defaultModel) {
      const entry = (await this.catalog(workspaceId, { ...next, disabledModels: disabled })).find(
        (e) => e.ref === defaultModel,
      );
      if (!entry) {
        throw new ApiException(404, 'MODEL_NOT_FOUND', 'That model isn’t available any more.');
      }
      if (entry.mode !== next.defaultMode) {
        throw new ApiException(
          400,
          'DEFAULT_MODEL_MODE',
          'The default model must belong to the default mode.',
        );
      }
      if (!entry.enabled) {
        throw new ApiException(
          409,
          'MODEL_DISABLED',
          'Turn that model on before making it the default.',
        );
      }
    } else {
      defaultModel = null;
    }
    return {
      allowedModes: allowed,
      defaultMode: next.defaultMode,
      defaultModel,
      confidentialModes: confidential,
      disabledModels: disabled,
    };
  }

  async savePolicy(workspaceId: string, userId: string, policy: Policy): Promise<void> {
    const data = { ...policy, updatedById: userId };
    await forWorkspace(this.prisma.client, workspaceId).workspaceAiPolicy.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
    });
  }

  // ── Catalog ─────────────────────────────────────────────────────────

  /** Every chat model this workspace could use, with whether it's on and its mode allowed. */
  async catalog(workspaceId: string, policyOverride?: Policy): Promise<CatalogEntry[]> {
    const policy = policyOverride ?? (await this.policy(workspaceId));
    const disabled = new Set(policy.disabledModels);
    const allowed = new Set(policy.allowedModes);
    const entries: Omit<CatalogEntry, 'enabled' | 'allowed'>[] = [];

    if (this.privateChat) {
      const { provider, model } = this.privateChat;
      const isMock = provider.isMock === true;
      entries.push({
        ref: formatRef({ mode: 'PRIVATE', source: provider.id, model }),
        mode: 'PRIVATE',
        model,
        providerLabel: provider.label,
        keyLabel: null,
        routeLabel: routeLabelFor('PRIVATE', provider.label, isMock),
        dataLocation: 'IN_CLUSTER',
        isMock,
      });
    }
    if (this.managed) {
      for (const model of this.managed.models) {
        entries.push({
          ref: formatRef({ mode: 'MANAGED', source: this.managed.provider.id, model }),
          mode: 'MANAGED',
          model,
          providerLabel: this.managed.provider.label,
          keyLabel: null,
          routeLabel: routeLabelFor('MANAGED', this.managed.provider.label, false),
          dataLocation: 'THIRD_PARTY',
          isMock: false,
        });
      }
    }
    const keys = await forWorkspace(this.prisma.client, workspaceId).aiProviderConfig.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, provider: true, label: true, models: true },
    });
    for (const key of keys) {
      const info = byokProvider(key.provider);
      if (!info) continue;
      for (const model of key.models) {
        entries.push({
          ref: formatRef({ mode: 'BYOK', source: key.id, model }),
          mode: 'BYOK',
          model,
          providerLabel: info.badge,
          keyLabel: key.label,
          routeLabel: routeLabelFor('BYOK', info.badge, false),
          dataLocation: 'THIRD_PARTY',
          isMock: false,
        });
      }
    }
    return entries.map((e) => ({
      ...e,
      enabled: !disabled.has(e.ref),
      allowed: allowed.has(e.mode),
    }));
  }

  /** The models people may pick (Switch model): on, and in an allowed mode. */
  async usableModels(
    workspaceId: string,
  ): Promise<{ models: CatalogEntry[]; defaultRef: string | null }> {
    const policy = await this.policy(workspaceId);
    const models = (await this.catalog(workspaceId, policy)).filter((e) => e.enabled && e.allowed);
    return { models, defaultRef: this.defaultRef(policy, models) };
  }

  /** The policy's default model if it's usable, else the default mode's first usable model. */
  defaultRef(policy: Policy, usable: CatalogEntry[]): string | null {
    if (policy.defaultModel && usable.some((m) => m.ref === policy.defaultModel)) {
      return policy.defaultModel;
    }
    return usable.find((m) => m.mode === policy.defaultMode)?.ref ?? null;
  }

  // ── Resolving a chat (Ask) ──────────────────────────────────────────

  /**
   * The chat for a reference, with the key decrypted just for this call. Throws a people-facing
   * error if the model isn't usable by this workspace: never a quiet swap for another model.
   */
  async resolve(workspaceId: string, ref: string): Promise<ResolvedChat> {
    const parsed = parseRef(ref);
    const { models } = await this.usableModels(workspaceId);
    const entry = models.find((m) => m.ref === ref);
    if (!parsed || !entry) {
      throw new ApiException(
        409,
        'MODEL_UNAVAILABLE',
        'That model isn’t available in this workspace any more. Choose another.',
      );
    }
    const base = {
      ref,
      model: parsed.model,
      route: entry.mode,
      routeLabel: entry.routeLabel,
      dataLocation: entry.dataLocation,
      isMock: entry.isMock,
    };
    if (parsed.mode === 'PRIVATE' && this.privateChat) {
      return { ...base, provider: this.privateChat.provider };
    }
    if (parsed.mode === 'MANAGED' && this.managed) {
      return { ...base, provider: this.managed.provider };
    }
    const key = await forWorkspace(this.prisma.client, workspaceId).aiProviderConfig.findFirst({
      where: { id: parsed.source },
    });
    if (!key) {
      throw new ApiException(
        409,
        'MODEL_UNAVAILABLE',
        'That key was removed. Choose another model.',
      );
    }
    const apiKey = await this.openKey(workspaceId, key);
    return {
      ...base,
      provider: byokChatProvider(
        key.provider,
        { apiKey, baseUrl: key.baseUrl },
        entry.providerLabel,
      ),
    };
  }

  // ── Keys (BYOK) ─────────────────────────────────────────────────────

  async listKeys(workspaceId: string): Promise<AiProviderConfig[]> {
    return forWorkspace(this.prisma.client, workspaceId).aiProviderConfig.findMany({
      orderBy: { createdAt: 'asc' },
    });
  }

  async findKey(workspaceId: string, id: string): Promise<AiProviderConfig> {
    const key = await forWorkspace(this.prisma.client, workspaceId).aiProviderConfig.findFirst({
      where: { id },
    });
    if (!key) throw new ApiException(404, 'NOT_FOUND', 'This key was removed.');
    return key;
  }

  /** Checks a provider, address and key before anything is stored. Returns the clean URL. */
  async checkProvider(provider: string, apiKey: string | undefined, baseUrl: string | undefined) {
    const info = byokProvider(provider);
    if (!info) throw new ApiException(400, 'UNKNOWN_PROVIDER', ENDPOINT_MESSAGE.unknown_provider!);
    if (info.keyRequired && !apiKey) {
      throw new ApiException(400, 'KEY_REQUIRED', 'Paste the API key.');
    }
    if (!this.vault.available && apiKey) {
      throw new ApiException(
        409,
        'NO_MASTER_KEY',
        'This server can’t store API keys yet (it has no master key). Ask whoever runs it.',
      );
    }
    let url: string | null = null;
    if (!info.baseUrl) {
      if (!baseUrl)
        throw new ApiException(400, 'BASE_URL_REQUIRED', ENDPOINT_MESSAGE.base_url_required!);
      try {
        url = await checkEndpointUrl(baseUrl, { allowPrivate: this.allowPrivateUrls });
      } catch (error) {
        const code = error instanceof EndpointError ? error.code : 'bad_url';
        throw new ApiException(
          400,
          `URL_${code.toUpperCase()}`,
          ENDPOINT_MESSAGE[code] ?? ENDPOINT_MESSAGE.bad_url!,
        );
      }
    }
    return { info, baseUrl: url };
  }

  /** Test connection; a failure becomes a 422 with the reason in people's words. */
  async test(
    provider: string,
    apiKey: string | undefined,
    baseUrl: string | null,
  ): Promise<string[]> {
    const result = await testConnection(provider, { apiKey, baseUrl });
    if (!result.ok) {
      throw new ApiException(
        422,
        `KEY_${result.code.toUpperCase()}`,
        CONNECTION_MESSAGE[result.code],
      );
    }
    return result.models.slice(0, MAX_MODELS_PER_KEY);
  }

  async addKey(
    workspaceId: string,
    userId: string,
    input: {
      provider: string;
      label: string;
      apiKey?: string | undefined;
      baseUrl?: string | undefined;
    },
  ): Promise<AiProviderConfig> {
    const db = forWorkspace(this.prisma.client, workspaceId);
    if ((await db.aiProviderConfig.count()) >= MAX_KEYS) {
      throw new ApiException(
        409,
        'TOO_MANY_KEYS',
        `A workspace can keep up to ${MAX_KEYS} keys. Remove one first.`,
      );
    }
    const { baseUrl } = await this.checkProvider(input.provider, input.apiKey, input.baseUrl);
    const models = await this.test(input.provider, input.apiKey, baseUrl);
    const sealed = input.apiKey ? await this.vault.seal(input.apiKey, workspaceId) : null;
    return db.aiProviderConfig.create({
      data: {
        workspaceId,
        provider: input.provider,
        label: input.label,
        baseUrl,
        models,
        verifiedAt: new Date(),
        createdById: userId,
        ...(sealed ? stored(sealed) : {}),
      },
    });
  }

  /** Renames a key, or replaces it (tested first; the old one stays if the new one fails). */
  async updateKey(
    workspaceId: string,
    id: string,
    input: { label?: string | undefined; apiKey?: string | undefined },
  ): Promise<AiProviderConfig> {
    const key = await this.findKey(workspaceId, id);
    const data: Prisma.AiProviderConfigUpdateInput = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.apiKey) {
      await this.checkProvider(key.provider, input.apiKey, key.baseUrl ?? undefined);
      const models = await this.test(key.provider, input.apiKey, key.baseUrl);
      const sealed = await this.vault.seal(input.apiKey, workspaceId);
      Object.assign(data, stored(sealed), { models, verifiedAt: new Date(), lastError: null });
    }
    return forWorkspace(this.prisma.client, workspaceId).aiProviderConfig.update({
      where: { id },
      data,
    });
  }

  /** Tests a stored key again and refreshes its models; the result is saved either way. */
  async retestKey(workspaceId: string, id: string): Promise<AiProviderConfig> {
    const key = await this.findKey(workspaceId, id);
    const apiKey = key.encryptedKey ? await this.openKey(workspaceId, key) : undefined;
    const result = await testConnection(key.provider, { apiKey, baseUrl: key.baseUrl });
    const db = forWorkspace(this.prisma.client, workspaceId);
    if (!result.ok) {
      await db.aiProviderConfig.update({ where: { id }, data: { lastError: result.code } });
      throw new ApiException(
        422,
        `KEY_${result.code.toUpperCase()}`,
        CONNECTION_MESSAGE[result.code],
      );
    }
    return db.aiProviderConfig.update({
      where: { id },
      data: {
        models: result.models.slice(0, MAX_MODELS_PER_KEY),
        verifiedAt: new Date(),
        lastError: null,
      },
    });
  }

  /** Removes a key, and any policy choice that named its models. */
  async removeKey(workspaceId: string, userId: string, id: string): Promise<AiProviderConfig> {
    const key = await this.findKey(workspaceId, id);
    const prefix = `byok:${id}:`;
    const policy = await this.policy(workspaceId);
    const db = forWorkspace(this.prisma.client, workspaceId);
    await db.aiProviderConfig.delete({ where: { id } });
    const disabledModels = policy.disabledModels.filter((r) => !r.startsWith(prefix));
    const defaultModel = policy.defaultModel?.startsWith(prefix) ? null : policy.defaultModel;
    if (
      disabledModels.length !== policy.disabledModels.length ||
      defaultModel !== policy.defaultModel
    ) {
      await this.savePolicy(workspaceId, userId, { ...policy, disabledModels, defaultModel });
    }
    return key;
  }

  private async openKey(workspaceId: string, key: AiProviderConfig): Promise<string | undefined> {
    if (!key.encryptedKey || !key.wrappedDek || !key.keyWrapper) return undefined;
    try {
      return await this.vault.open(
        { encryptedKey: key.encryptedKey, wrappedDek: key.wrappedDek, keyWrapper: key.keyWrapper },
        workspaceId,
      );
    } catch {
      throw new ApiException(
        409,
        'KEY_UNREADABLE',
        'This key can’t be read on this server any more. Paste it again.',
      );
    }
  }
}
