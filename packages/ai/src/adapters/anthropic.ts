/**
 * Anthropic's Messages API (Claude), over plain fetch like every adapter here: no SDK, so nothing
 * vendor-specific leaks out of this package. It differs from the OpenAI shape in three ways that
 * matter: the system prompt is a separate field, turns must alternate user/assistant, and the
 * stream is typed events (`content_block_delta`, `message_delta`) with usage split across them.
 *
 * Always THIRD_PARTY: the passages in the prompt go to Anthropic under the key owner's terms.
 */
import type { ChatChunk, ChatMessage, ChatProvider, ChatRequest, DataLocation } from '../types.js';
import { ProviderHttpError } from './openai-compatible.js';

export const ANTHROPIC_VERSION = '2023-06-01';
/** Anthropic requires max_tokens; answers in Ask set their own, this is only the fallback. */
const DEFAULT_MAX_TOKENS = 2048;

export interface AnthropicConfig {
  apiKey: string;
  /** Defaults to https://api.anthropic.com; tests point it at a stand-in. */
  baseUrl?: string;
  label?: string;
  timeoutMs?: number;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/**
 * System messages become the `system` field; consecutive turns from the same side are joined,
 * because the API rejects two user turns in a row; a conversation must start with the user.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = turns.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(continue)' });
  return { system: system || undefined, messages: turns };
}

/** Reads Anthropic's typed SSE stream: yields each event's parsed `data`. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const part of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      try {
        yield JSON.parse(line.slice(5).trim());
      } catch {
        // a partial or keep-alive line
      }
    }
  }
}

/** A stream that started fine and then failed (overloaded, …); reported by type, never body. */
export class ProviderStreamError extends Error {
  constructor(
    readonly provider: string,
    readonly type: string,
  ) {
    super(`${provider} stream failed: ${type}`);
    this.name = 'ProviderStreamError';
  }
}

export class AnthropicChatProvider implements ChatProvider {
  readonly capability = 'chat' as const;
  readonly id = 'anthropic';
  readonly label: string;
  readonly dataLocation: DataLocation = 'THIRD_PARTY';

  constructor(private readonly config: AnthropicConfig) {
    this.label = config.label ?? 'Claude';
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const { system, messages } = toAnthropicMessages(request.messages);
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 300_000);
    const res = await fetch(
      `${trimSlash(this.config.baseUrl ?? 'https://api.anthropic.com')}/v1/messages`,
      {
        method: 'POST',
        headers: anthropicHeaders(this.config.apiKey),
        body: JSON.stringify({
          model: request.model,
          max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
          ...(system ? { system } : {}),
          messages,
          stream: true,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      },
    );
    if (!res.ok || !res.body) throw new ProviderHttpError(res.status, this.id);
    const usage = { inputTokens: 0, outputTokens: 0 };
    for await (const event of readEvents(res.body)) {
      const e = event as {
        type?: string;
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        delta?: { type?: string; text?: string };
        usage?: { output_tokens?: number; input_tokens?: number };
        error?: { type?: string };
      };
      switch (e.type) {
        case 'message_start':
          usage.inputTokens = e.message?.usage?.input_tokens ?? 0;
          usage.outputTokens = e.message?.usage?.output_tokens ?? 0;
          break;
        case 'content_block_delta':
          if (e.delta?.type === 'text_delta' && e.delta.text)
            yield { type: 'text', text: e.delta.text };
          break;
        case 'message_delta':
          // Cumulative output tokens for the whole message.
          if (e.usage?.output_tokens !== undefined) usage.outputTokens = e.usage.output_tokens;
          if (e.usage?.input_tokens) usage.inputTokens = e.usage.input_tokens;
          break;
        case 'error':
          throw new ProviderStreamError(this.id, e.error?.type ?? 'error');
        default:
          break;
      }
    }
    yield { type: 'done', usage };
  }
}
