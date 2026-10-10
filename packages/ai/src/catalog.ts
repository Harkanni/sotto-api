/**
 * The chat providers a workspace can bring its own key for (BYOK, BRIEF §3), and how to reach
 * them. No model names are hard-coded: a key's models are read from the provider when it is
 * tested, and admins pick from that list, so a new model is available the day it ships.
 *
 * Every BYOK provider is THIRD_PARTY, including a self-described "OpenAI-compatible" server:
 * it runs outside Sotto's cluster, so Restricted content never reaches it (policy.ts).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AnthropicChatProvider, anthropicHeaders } from './adapters/anthropic.js';
import { OpenAICompatibleChatProvider, ProviderHttpError } from './adapters/openai-compatible.js';
import type { ChatProvider, DataLocation } from './types.js';

export type ByokProviderId = 'anthropic' | 'openai' | 'google' | 'openai-compatible';

export interface ByokProviderInfo {
  id: ByokProviderId;
  /** Shown in settings: "Anthropic (Claude)". */
  label: string;
  /** Shown on the data-route badge: "Claude · your API key". */
  badge: string;
  /** Fixed endpoint; null when the admin supplies one. */
  baseUrl: string | null;
  /** What a key looks like, as a placeholder (never a real prefix check: formats change). */
  keyHint: string;
  /** Some self-hosted servers take no key. */
  keyRequired: boolean;
  dataLocation: DataLocation;
}

export const BYOK_PROVIDERS: readonly ByokProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    badge: 'Claude',
    baseUrl: 'https://api.anthropic.com',
    keyHint: 'sk-ant-…',
    keyRequired: true,
    dataLocation: 'THIRD_PARTY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    badge: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    keyRequired: true,
    dataLocation: 'THIRD_PARTY',
  },
  {
    // Gemini through Google's OpenAI-compatible endpoint, so one adapter serves both.
    id: 'google',
    label: 'Google (Gemini)',
    badge: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyHint: 'AIza…',
    keyRequired: true,
    dataLocation: 'THIRD_PARTY',
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible server',
    badge: 'Your server',
    baseUrl: null,
    keyHint: 'Optional',
    keyRequired: false,
    dataLocation: 'THIRD_PARTY',
  },
];

export function byokProvider(id: string): ByokProviderInfo | undefined {
  return BYOK_PROVIDERS.find((p) => p.id === id);
}

export interface ByokCredentials {
  apiKey?: string | undefined;
  /** Required for openai-compatible, ignored otherwise. */
  baseUrl?: string | null | undefined;
}

function endpointOf(info: ByokProviderInfo, creds: ByokCredentials): string {
  const url = info.baseUrl ?? creds.baseUrl;
  if (!url) throw new EndpointError('base_url_required');
  return url.replace(/\/+$/, '');
}

/** The chat provider for a workspace key. The caller decrypts the key just before this. */
export function byokChatProvider(id: string, creds: ByokCredentials, label?: string): ChatProvider {
  const info = byokProvider(id);
  if (!info) throw new EndpointError('unknown_provider');
  const baseUrl = endpointOf(info, creds);
  const badge = label ?? info.badge;
  if (info.id === 'anthropic') {
    return new AnthropicChatProvider({ apiKey: creds.apiKey ?? '', baseUrl, label: badge });
  }
  return new OpenAICompatibleChatProvider(info.id, {
    baseUrl,
    dataLocation: 'THIRD_PARTY',
    label: badge,
    ...(creds.apiKey ? { apiKey: creds.apiKey } : {}),
  });
}

// ── Endpoint safety ───────────────────────────────────────────────────

export type EndpointErrorCode =
  'unknown_provider' | 'base_url_required' | 'bad_url' | 'https_required' | 'private_address';

export class EndpointError extends Error {
  constructor(readonly code: EndpointErrorCode) {
    super(code);
    this.name = 'EndpointError';
  }
}

/** Loopback, private, link-local (cloud metadata lives at 169.254.169.254), CGNAT, ULA. */
export function isPrivateAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe8') ||
    v6.startsWith('fe9') ||
    v6.startsWith('fea') ||
    v6.startsWith('feb')
  );
}

/**
 * An admin-supplied base URL must not turn the api into a way to reach Sotto's own network
 * (server-side request forgery): HTTPS, and a host that resolves only to public addresses.
 * `allowPrivate` is for local development and tests (`AI_BYOK_ALLOW_PRIVATE_URLS`), where the
 * "outside" server really is on localhost.
 */
export async function checkEndpointUrl(
  raw: string,
  options: { allowPrivate?: boolean; resolve?: (host: string) => Promise<string[]> } = {},
): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new EndpointError('bad_url');
  }
  if (url.username || url.password || url.hash || url.search) throw new EndpointError('bad_url');
  if (options.allowPrivate) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new EndpointError('bad_url');
    return url.toString().replace(/\/+$/, '');
  }
  if (url.protocol !== 'https:') throw new EndpointError('https_required');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const resolve =
    options.resolve ??
    (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolve(host);
  } catch {
    throw new EndpointError('bad_url');
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new EndpointError('private_address');
  }
  return url.toString().replace(/\/+$/, '');
}

// ── Models and Test connection ────────────────────────────────────────

export type ConnectionErrorCode =
  | 'invalid_key'
  | 'no_access'
  | 'not_found'
  | 'rate_limited'
  | 'provider_error'
  | 'unreachable'
  | 'timeout'
  | 'no_models';

export type ConnectionResult =
  { ok: true; models: string[] } | { ok: false; code: ConnectionErrorCode };

export function connectionErrorFor(error: unknown): ConnectionErrorCode {
  if (error instanceof ProviderHttpError) {
    if (error.status === 401) return 'invalid_key';
    if (error.status === 403) return 'no_access';
    if (error.status === 404) return 'not_found';
    if (error.status === 429) return 'rate_limited';
    return 'provider_error';
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  return 'unreachable';
}

/** Model ids that aren't chat models, in OpenAI-style listings. */
const NOT_CHAT =
  /embed|whisper|tts|dall-e|image|moderation|transcribe|audio|realtime|search|davinci|babbage/i;

/**
 * The chat models a key can use, read from the provider (`GET /models`). Sorted newest-looking
 * first is the provider's business; we keep their order and drop obvious non-chat models.
 */
export async function listModels(
  id: string,
  creds: ByokCredentials,
  signal?: AbortSignal,
): Promise<string[]> {
  const info = byokProvider(id);
  if (!info) throw new EndpointError('unknown_provider');
  const base = endpointOf(info, creds);
  const timeout = AbortSignal.timeout(15_000);
  const anySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  if (info.id === 'anthropic') {
    const res = await fetch(`${base}/v1/models?limit=100`, {
      headers: anthropicHeaders(creds.apiKey ?? ''),
      signal: anySignal,
    });
    if (!res.ok) throw new ProviderHttpError(res.status, info.id);
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((m): m is string => !!m);
  }
  const res = await fetch(`${base}/models`, {
    headers: creds.apiKey ? { authorization: `Bearer ${creds.apiKey}` } : {},
    signal: anySignal,
  });
  if (!res.ok) throw new ProviderHttpError(res.status, info.id);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? [])
    .map((m) => m.id?.replace(/^models\//, ''))
    .filter((m): m is string => !!m && !NOT_CHAT.test(m));
}

/** Test connection: the key works and can list at least one chat model. Never throws. */
export async function testConnection(
  id: string,
  creds: ByokCredentials,
  signal?: AbortSignal,
): Promise<ConnectionResult> {
  try {
    const models = await listModels(id, creds, signal);
    return models.length ? { ok: true, models } : { ok: false, code: 'no_models' };
  } catch (error) {
    return { ok: false, code: connectionErrorFor(error) };
  }
}
