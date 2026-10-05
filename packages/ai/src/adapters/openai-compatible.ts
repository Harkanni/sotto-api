/**
 * Adapters for any server that speaks the OpenAI HTTP API: Ollama (`/v1`), vLLM, Hugging Face
 * TEI, LM Studio, and hosted APIs. One adapter family is what makes "move from Ollama to vLLM or a
 * bigger model" a settings change (PLAN → Swappable AI providers). No SDK: plain fetch, so
 * nothing vendor-specific leaks out of this package.
 *
 * Where data goes is declared by whoever configures the endpoint (`dataLocation`), never guessed
 * from a URL: an in-cluster Ollama is IN_CLUSTER; a hosted API is THIRD_PARTY.
 */
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  DataLocation,
  EmbedOptions,
  EmbeddingProvider,
} from '../types.js';

export interface EndpointConfig {
  /** Base URL including the version prefix, e.g. "http://ollama:11434/v1". */
  baseUrl: string;
  apiKey?: string;
  dataLocation: DataLocation;
  /** Shown in admin settings and on the data-route badge. */
  label?: string;
  /** Per-request timeout; transcripts of long meetings take a while to summarise. */
  timeoutMs?: number;
}

/** A provider call that failed, by HTTP status; never includes request or response bodies. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly provider: string,
  ) {
    super(`${provider} answered ${status}`);
    this.name = 'ProviderHttpError';
  }
}

function headers(config: EndpointConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Some embedding models are trained with task prefixes and retrieve noticeably better with
 * them (nomic-embed-text: "search_document: …" / "search_query: …").
 */
const PREFIXES: Record<string, { document: string; query: string }> = {
  'nomic-embed-text': { document: 'search_document: ', query: 'search_query: ' },
  'nomic-embed-text-v1.5': { document: 'search_document: ', query: 'search_query: ' },
};

/** Known sizes, so an index can be created before the first call; others are learned from it. */
const DIMENSIONS: Record<string, number> = {
  'nomic-embed-text': 768,
  'nomic-embed-text-v1.5': 768,
  'mxbai-embed-large': 1024,
  'bge-m3': 1024,
  'all-minilm': 384,
  'snowflake-arctic-embed': 1024,
};

function baseModel(model: string): string {
  return model.split(':')[0]!.split('/').at(-1)!;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly capability = 'embedding' as const;
  readonly label: string;
  readonly dataLocation: DataLocation;
  private learned: number | null = null;

  constructor(
    readonly id: string,
    readonly model: string,
    private readonly config: EndpointConfig,
    /** Texts per request; servers have limits, and smaller batches fail less expensively. */
    private readonly batchSize = 32,
  ) {
    this.label = config.label ?? `${model} (${id})`;
    this.dataLocation = config.dataLocation;
  }

  get dimensions(): number {
    return this.learned ?? DIMENSIONS[baseModel(this.model)] ?? 0;
  }

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    const prefix = PREFIXES[baseModel(this.model)]?.[options.purpose ?? 'document'] ?? '';
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize).map((t) => prefix + t);
      const res = await fetch(`${trimSlash(this.config.baseUrl)}/embeddings`, {
        method: 'POST',
        headers: headers(this.config),
        body: JSON.stringify({ model: this.model, input: batch }),
        signal: withTimeout(options.signal, this.config.timeoutMs ?? 120_000),
      });
      if (!res.ok) throw new ProviderHttpError(res.status, this.id);
      const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
      const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== batch.length) throw new Error(`${this.id} returned the wrong count`);
      for (const row of rows) out.push(row.embedding);
    }
    if (out[0]) this.learned = out[0].length;
    return out;
  }
}

/** Reads an OpenAI-style server-sent event stream into text chunks. */
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
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // a keep-alive or partial line: skip it
      }
    }
  }
}

export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly capability = 'chat' as const;
  readonly label: string;
  readonly dataLocation: DataLocation;

  constructor(
    readonly id: string,
    private readonly config: EndpointConfig,
  ) {
    this.label = config.label ?? id;
    this.dataLocation = config.dataLocation;
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await fetch(`${trimSlash(this.config.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: headers(this.config),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: withTimeout(request.signal, this.config.timeoutMs ?? 300_000),
    });
    if (!res.ok || !res.body) throw new ProviderHttpError(res.status, this.id);
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const event of readEvents(res.body)) {
      const e = event as {
        choices?: { delta?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = e.choices?.[0]?.delta?.content;
      if (text) yield { type: 'text', text };
      if (e.usage) {
        usage = {
          inputTokens: e.usage.prompt_tokens ?? 0,
          outputTokens: e.usage.completion_tokens ?? 0,
        };
      }
    }
    yield { type: 'done', usage };
  }
}
