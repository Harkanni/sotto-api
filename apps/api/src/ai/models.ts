import type { AiRoute } from '@sotto/db';

/**
 * A model reference names one chat model and the mode it runs in, so a stored choice (a
 * workspace default, a disabled model, the model that answered) is never ambiguous:
 *
 *   private:<provider>:<model>     the platform's in-cluster models   private:ollama:llama3.2:3b
 *   managed:<provider>:<model>     Sotto's own provider account       managed:anthropic:claude-x
 *   byok:<config id>:<model>       a workspace's own key              byok:cm1abc…:gpt-x
 *
 * Model ids may contain colons (Ollama tags), so everything after the second colon is the model.
 */
export interface ModelRef {
  mode: AiRoute;
  /** The adapter id for private/managed; the AiProviderConfig id for byok. */
  source: string;
  model: string;
}

const MODES: Record<string, AiRoute> = { private: 'PRIVATE', managed: 'MANAGED', byok: 'BYOK' };

export function parseRef(ref: string): ModelRef | null {
  const [mode, source, ...rest] = ref.split(':');
  const route = mode ? MODES[mode] : undefined;
  const model = rest.join(':');
  if (!route || !source || !model) return null;
  return { mode: route, source, model };
}

export function formatRef(ref: ModelRef): string {
  return `${ref.mode.toLowerCase()}:${ref.source}:${ref.model}`;
}

/** Sentences the settings screen shows for each mode (BRIEF §3, plain language). */
export const MODE_LABEL: Record<AiRoute, string> = {
  PRIVATE: 'Private',
  BYOK: 'Your API key',
  MANAGED: 'Managed',
};
