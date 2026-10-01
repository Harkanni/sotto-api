import type { AnyProvider, Capability, ProviderByCapability } from './types.js';

export class ProviderNotFoundError extends Error {
  constructor(capability: Capability, id: string, available: string[]) {
    super(
      `No ${capability} provider "${id}" is registered. Available: ${available.join(', ') || 'none'}.`,
    );
    this.name = 'ProviderNotFoundError';
  }
}

/**
 * Holds every installed adapter. Services ask for "the embedding provider called ollama" rather
 * than importing a vendor SDK, so switching is a config change.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AnyProvider>();

  register(provider: AnyProvider): this {
    const key = `${provider.capability}:${provider.id}`;
    if (this.providers.has(key)) throw new Error(`Provider already registered: ${key}`);
    this.providers.set(key, provider);
    return this;
  }

  get<C extends Capability>(capability: C, id: string): ProviderByCapability[C] {
    const provider = this.providers.get(`${capability}:${id}`);
    if (!provider) {
      throw new ProviderNotFoundError(
        capability,
        id,
        this.list(capability).map((p) => p.id),
      );
    }
    return provider as unknown as ProviderByCapability[C];
  }

  list<C extends Capability>(capability?: C): Array<ProviderByCapability[C]> {
    return [...this.providers.values()].filter(
      (p) => capability === undefined || p.capability === capability,
    ) as unknown as Array<ProviderByCapability[C]>;
  }
}

/**
 * Model references in config look like "provider:model", e.g. "ollama:nomic-embed-text" or
 * "openai-compatible:llama-3.3-70b". The model part may itself contain colons.
 */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const index = ref.indexOf(':');
  if (index <= 0 || index === ref.length - 1) {
    throw new Error(`Model reference must look like "provider:model", got "${ref}".`);
  }
  return { provider: ref.slice(0, index), model: ref.slice(index + 1) };
}
