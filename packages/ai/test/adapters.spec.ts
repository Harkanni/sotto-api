import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiConfigError,
  FakeEmbeddingProvider,
  OpenAICompatibleChatProvider,
  OpenAICompatibleEmbeddingProvider,
  ProviderHttpError,
  aiEnv,
  embeddingProviderFrom,
  privateChatFrom,
} from '../src/index.js';

/** A stand-in OpenAI-style server: embeddings and a streamed chat answer. */
let server: Server;
let base = '';
const seen: { path: string; body: Record<string, unknown>; auth?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ path: req.url!, body, auth: req.headers.authorization });
      if (body.model === 'broken') {
        res.writeHead(503).end('{"error":"down"}');
        return;
      }
      if (req.url === '/v1/embeddings') {
        const input = body.input as string[];
        res.writeHead(200, { 'content-type': 'application/json' });
        // Out of order on purpose: clients must sort by index.
        const data = input.map((text, index) => ({ index, embedding: [text.length, index, 1] }));
        res.end(JSON.stringify({ data: data.reverse() }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const word of ['{"summary":', ' "ok"}']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
      }
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('OpenAI-compatible embeddings', () => {
  it('batches, keeps order, learns the size and adds task prefixes', async () => {
    const p = new OpenAICompatibleEmbeddingProvider(
      'ollama',
      'nomic-embed-text',
      { baseUrl: base, dataLocation: 'IN_CLUSTER' },
      2,
    );
    expect(p.dimensions).toBe(768); // known before the first call
    const vectors = await p.embed(['a', 'bb', 'ccc']);
    // The stand-in embeds as [length with the 17-character prefix, index in batch, 1].
    expect(vectors).toEqual([
      [18, 0, 1],
      [19, 1, 1],
      [20, 0, 1],
    ]);
    expect(p.dimensions).toBe(3); // then learned from the answer
    const calls = seen.filter((s) => s.path === '/v1/embeddings');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.input).toEqual(['search_document: a', 'search_document: bb']);
    await p.embed(['q'], { purpose: 'query' });
    expect(seen.at(-1)!.body.input).toEqual(['search_query: q']);
  });

  it('reports failures by status, without bodies', async () => {
    const p = new OpenAICompatibleEmbeddingProvider('x', 'broken', {
      baseUrl: base,
      dataLocation: 'IN_CLUSTER',
    });
    await expect(p.embed(['a'])).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe('OpenAI-compatible chat', () => {
  it('streams text, then usage; sends the key and JSON mode', async () => {
    const p = new OpenAICompatibleChatProvider('vllm', {
      baseUrl: base,
      dataLocation: 'IN_CLUSTER',
      apiKey: 'k',
    });
    const parts: string[] = [];
    let usage;
    for await (const chunk of p.stream({
      model: 'llama',
      messages: [{ role: 'user', content: 'hi' }],
      json: true,
    })) {
      if (chunk.type === 'text') parts.push(chunk.text);
      else usage = chunk.usage;
    }
    expect(parts.join('')).toBe('{"summary": "ok"}');
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    const call = seen.at(-1)!;
    expect(call.auth).toBe('Bearer k');
    expect(call.body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('OpenAI-compatible chat options', () => {
  it('adds the server-specific fields from settings, never over its own', async () => {
    const chat = privateChatFrom(
      aiEnv.parse({
        AI_PRIVATE_CHAT: 'openai-compatible:qwen',
        AI_OPENAI_COMPATIBLE_URL: base,
        AI_OPENAI_COMPATIBLE_CHAT_EXTRA:
          '{"chat_template_kwargs":{"enable_thinking":false},"stream":false,"model":"x"}',
      }),
    )!;
    for await (const chunk of chat.provider.stream({
      model: chat.model,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void chunk;
    }
    const call = seen.at(-1)!;
    expect(call.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(call.body.stream).toBe(true);
    expect(call.body.model).toBe('qwen');
  });

  it('refuses extra fields that are not a JSON object', () => {
    expect(() => aiEnv.parse({ AI_OPENAI_COMPATIBLE_CHAT_EXTRA: '[1]' })).toThrow();
    expect(() => aiEnv.parse({ AI_OPENAI_COMPATIBLE_CHAT_EXTRA: 'not json' })).toThrow();
    expect(
      aiEnv.parse({ AI_OPENAI_COMPATIBLE_CHAT_EXTRA: '' }).AI_OPENAI_COMPATIBLE_CHAT_EXTRA,
    ).toBeUndefined();
  });
});

describe('settings', () => {
  it('builds providers from "provider:model" references', () => {
    const ollama = embeddingProviderFrom(aiEnv.parse({ OLLAMA_URL: 'http://ollama:11434/' }));
    expect(ollama).toMatchObject({
      id: 'ollama',
      model: 'nomic-embed-text',
      dataLocation: 'IN_CLUSTER',
    });
    expect(embeddingProviderFrom(aiEnv.parse({ AI_EMBEDDINGS: 'fake:fake' }))).toBeInstanceOf(
      FakeEmbeddingProvider,
    );
    const hosted = embeddingProviderFrom(
      aiEnv.parse({
        AI_EMBEDDINGS: 'openai-compatible:bge-m3',
        AI_OPENAI_COMPATIBLE_URL: 'https://example.test/v1',
        AI_OPENAI_COMPATIBLE_LOCATION: 'THIRD_PARTY',
      }),
    );
    expect(hosted.dataLocation).toBe('THIRD_PARTY');
  });

  it('has no chat model unless one is configured, and refuses unknown providers', () => {
    expect(privateChatFrom(aiEnv.parse({}))).toBeNull();
    expect(privateChatFrom(aiEnv.parse({ AI_PRIVATE_CHAT: 'ollama:llama3.2:3b' }))?.model).toBe(
      'llama3.2:3b',
    );
    expect(() => embeddingProviderFrom(aiEnv.parse({ AI_EMBEDDINGS: 'acme:x' }))).toThrow(
      AiConfigError,
    );
    expect(() =>
      embeddingProviderFrom(aiEnv.parse({ AI_EMBEDDINGS: 'openai-compatible:x' })),
    ).toThrow(/AI_OPENAI_COMPATIBLE_URL/);
  });
});
