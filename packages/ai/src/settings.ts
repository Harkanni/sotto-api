import { z } from 'zod';
import { FakeChatProvider, FakeEmbeddingProvider } from './adapters/fake.js';
import {
  OpenAICompatibleChatProvider,
  OpenAICompatibleEmbeddingProvider,
} from './adapters/openai-compatible.js';
import { byokChatProvider, byokProvider } from './catalog.js';
import { parseModelRef } from './registry.js';
import type { ChatProvider, EmbeddingProvider } from './types.js';

const blankAsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optional = z.preprocess(blankAsUnset, z.string().trim().optional());

/**
 * Platform AI settings (PLAN: "platform defaults live in config"). Models are "provider:model"
 * references; workspace overrides arrive with the AI settings in Phase 6.
 *
 *   AI_EMBEDDINGS=ollama:nomic-embed-text        in-cluster Ollama (the default)
 *   AI_EMBEDDINGS=openai-compatible:bge-m3       any OpenAI-style server (TEI, vLLM…)
 *   AI_EMBEDDINGS=fake:fake-hash                 labelled mock, for tests and tiny servers
 *   AI_PRIVATE_CHAT=ollama:llama3.2:3b           meeting notes; unset → labelled basic notes
 *   AI_ASK_CHAT=openai-compatible:some-model     answers in Ask; unset → AI_PRIVATE_CHAT;
 *                                                neither → passages only, labelled
 */
export const aiEnv = z.object({
  AI_EMBEDDINGS: z.string().default('ollama:nomic-embed-text'),
  AI_PRIVATE_CHAT: optional,
  AI_ASK_CHAT: optional,
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  AI_OPENAI_COMPATIBLE_URL: optional,
  AI_OPENAI_COMPATIBLE_KEY: optional,
  /** Who runs that server: in your cluster, or a third party (then Restricted never goes). */
  AI_OPENAI_COMPATIBLE_LOCATION: z.enum(['IN_CLUSTER', 'THIRD_PARTY']).default('IN_CLUSTER'),
  /** Master key for workspace API keys (32 bytes, base64). Unset → BYOK keys can't be saved. */
  AI_KEYS_MASTER: optional,
  /** Older master keys, comma separated, kept only to open keys wrapped before a rotation. */
  AI_KEYS_MASTER_PREVIOUS: optional,
  /**
   * Managed mode (BRIEF §3: Sotto's own provider account, metered against the plan):
   * "provider:model" references for one BYOK-style provider, comma separated, e.g.
   * "anthropic:claude-sonnet-4-5,anthropic:claude-haiku-4-5". Unset → Managed is unavailable,
   * and the settings screen says so.
   */
  AI_MANAGED_CHAT: optional,
  AI_MANAGED_KEY: optional,
  /** Only for an openai-compatible Managed provider. */
  AI_MANAGED_BASE_URL: optional,
  /** Local development and tests only: let BYOK endpoints point at private addresses. */
  AI_BYOK_ALLOW_PRIVATE_URLS: z
    .preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean())
    .default(false),
});
export type AiSettings = z.infer<typeof aiEnv>;

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

function endpoint(provider: string, settings: AiSettings) {
  if (provider === 'ollama') {
    return {
      baseUrl: `${settings.OLLAMA_URL.replace(/\/+$/, '')}/v1`,
      dataLocation: 'IN_CLUSTER' as const,
      label: 'Ollama (in your cluster)',
    };
  }
  if (provider === 'openai-compatible') {
    if (!settings.AI_OPENAI_COMPATIBLE_URL) {
      throw new AiConfigError('openai-compatible needs AI_OPENAI_COMPATIBLE_URL');
    }
    return {
      baseUrl: settings.AI_OPENAI_COMPATIBLE_URL,
      dataLocation: settings.AI_OPENAI_COMPATIBLE_LOCATION,
      // The badge's words (BRIEF §3: "Private · Sotto-hosted model").
      label:
        settings.AI_OPENAI_COMPATIBLE_LOCATION === 'IN_CLUSTER'
          ? 'Sotto-hosted model'
          : 'Hosted model',
      ...(settings.AI_OPENAI_COMPATIBLE_KEY ? { apiKey: settings.AI_OPENAI_COMPATIBLE_KEY } : {}),
    };
  }
  throw new AiConfigError(
    `Unknown AI provider "${provider}" (use ollama, openai-compatible or fake)`,
  );
}

/** The embedding provider the settings name. Fails at startup on a bad setting, not mid-job. */
export function embeddingProviderFrom(settings: AiSettings): EmbeddingProvider {
  const { provider, model } = parseModelRef(settings.AI_EMBEDDINGS);
  if (provider === 'fake')
    return new FakeEmbeddingProvider(8, model === 'fake' ? 'fake-hash' : model);
  return new OpenAICompatibleEmbeddingProvider(provider, model, endpoint(provider, settings));
}

function chatFrom(ref: string, settings: AiSettings): { provider: ChatProvider; model: string } {
  const { provider, model } = parseModelRef(ref);
  if (provider === 'fake') return { provider: new FakeChatProvider(), model };
  const chat = new OpenAICompatibleChatProvider(provider, endpoint(provider, settings));
  return { provider: chat, model };
}

/** The private chat model for meeting notes, or null when none is configured. */
export function privateChatFrom(
  settings: AiSettings,
): { provider: ChatProvider; model: string } | null {
  return settings.AI_PRIVATE_CHAT ? chatFrom(settings.AI_PRIVATE_CHAT, settings) : null;
}

/**
 * The model that answers questions in Ask: AI_ASK_CHAT, else the private model, else null (Ask
 * then answers with the matching passages only, labelled). Workspace choices (Private, BYOK,
 * Managed) replace this platform default in Phase 6.
 */
export function askChatFrom(
  settings: AiSettings,
): { provider: ChatProvider; model: string } | null {
  const ref = settings.AI_ASK_CHAT ?? settings.AI_PRIVATE_CHAT;
  return ref ? chatFrom(ref, settings) : null;
}

/** Sotto's own account for Managed mode: one provider, the models it offers, or null. */
export function managedChatFrom(
  settings: AiSettings,
): { provider: ChatProvider; models: string[] } | null {
  if (!settings.AI_MANAGED_CHAT) return null;
  const refs = settings.AI_MANAGED_CHAT.split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map(parseModelRef);
  const ids = new Set(refs.map((r) => r.provider));
  const [id] = ids;
  if (!id || ids.size > 1) {
    throw new AiConfigError(
      'AI_MANAGED_CHAT must name one provider, e.g. "anthropic:model-a,anthropic:model-b"',
    );
  }
  const info = byokProvider(id);
  if (!info) throw new AiConfigError(`Unknown Managed provider "${id}"`);
  if (info.keyRequired && !settings.AI_MANAGED_KEY) {
    throw new AiConfigError('AI_MANAGED_CHAT needs AI_MANAGED_KEY');
  }
  return {
    provider: byokChatProvider(
      id,
      { apiKey: settings.AI_MANAGED_KEY, baseUrl: settings.AI_MANAGED_BASE_URL },
      // "Your server" is BYOK's word for a custom endpoint; Managed runs on Sotto's.
      info.id === 'openai-compatible' ? 'Sotto’s hosted model' : info.badge,
    ),
    models: refs.map((r) => r.model),
  };
}
