import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicChatProvider, toAnthropicMessages } from '../src/adapters/anthropic.js';
import {
  byokChatProvider,
  checkEndpointUrl,
  isPrivateAddress,
  listModels,
  testConnection,
} from '../src/catalog.js';
import { aiEnv, managedChatFrom } from '../src/settings.js';
import type { ChatChunk } from '../src/types.js';

/** A stand-in for Anthropic and an OpenAI-style server, on localhost. */
let server: Server;
let base = '';
const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: unknown }> = [];

function sse(events: unknown[]): string {
  return events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const key = req.headers['x-api-key'] ?? req.headers.authorization;
      if (key === 'bad' || key === 'Bearer bad') {
        res.writeHead(401).end('{"error":"secret details"}');
        return;
      }
      if (req.url?.startsWith('/v1/models')) {
        res.end(JSON.stringify({ data: [{ id: 'claude-a' }, { id: 'claude-b' }] }));
        return;
      }
      if (req.url === '/oai/models') {
        res.end(
          JSON.stringify({
            data: [{ id: 'gpt-x' }, { id: 'text-embedding-3-small' }, { id: 'models/gemini-y' }],
          }),
        );
        return;
      }
      if (req.url === '/empty/models') {
        res.end(JSON.stringify({ data: [{ id: 'whisper-1' }] }));
        return;
      }
      if (req.url === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 1 } } },
            { type: 'content_block_start', index: 0 },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo [1]' } },
            { type: 'message_delta', usage: { output_tokens: 7 } },
            { type: 'message_stop' },
          ]),
        );
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function collect(stream: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

describe('Anthropic adapter', () => {
  it('moves the system prompt out and joins same-side turns', () => {
    expect(
      toAnthropicMessages([
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ]),
    ).toEqual({
      system: 'rules',
      messages: [
        { role: 'user', content: 'a\n\nb' },
        { role: 'assistant', content: 'c' },
      ],
    });
  });

  it('streams text and usage, with the key in x-api-key', async () => {
    const chat = new AnthropicChatProvider({ apiKey: 'sk-ant-good', baseUrl: base });
    expect(chat.dataLocation).toBe('THIRD_PARTY');
    const chunks = await collect(
      chat.stream({ model: 'claude-a', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(chunks).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo [1]' },
      { type: 'done', usage: { inputTokens: 42, outputTokens: 7 } },
    ]);
    const req = seen.at(-1)!;
    expect(req.headers['x-api-key']).toBe('sk-ant-good');
    expect(req.headers['anthropic-version']).toBeTruthy();
    expect(req.body).toMatchObject({ model: 'claude-a', stream: true, max_tokens: 2048 });
  });

  it('reports an HTTP failure by status only', async () => {
    const chat = new AnthropicChatProvider({ apiKey: 'bad', baseUrl: base });
    const error = await collect(
      chat.stream({ model: 'm', messages: [{ role: 'user', content: 'x' }] }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401 });
    expect(String(error)).not.toContain('secret details');
  });
});

describe('BYOK catalog', () => {
  it('builds a THIRD_PARTY chat for every provider', () => {
    for (const id of ['anthropic', 'openai', 'google']) {
      expect(byokChatProvider(id, { apiKey: 'k' }).dataLocation).toBe('THIRD_PARTY');
    }
    expect(
      byokChatProvider('openai-compatible', { baseUrl: 'https://llm.example.com/v1' }).dataLocation,
    ).toBe('THIRD_PARTY');
    expect(() => byokChatProvider('openai-compatible', {})).toThrow('base_url_required');
    expect(() => byokChatProvider('mystery', { apiKey: 'k' })).toThrow('unknown_provider');
  });

  it('lists chat models and drops embedding and audio ones', async () => {
    await expect(
      listModels('openai-compatible', { apiKey: 'k', baseUrl: `${base}/oai` }),
    ).resolves.toEqual(['gpt-x', 'gemini-y']);
  });

  it('tests a connection without throwing, with a code for each failure', async () => {
    // Anthropic's fixed URL can't be redirected, so exercise it through the stand-in by hand.
    await expect(
      testConnection('openai-compatible', { apiKey: 'k', baseUrl: `${base}/oai` }),
    ).resolves.toEqual({ ok: true, models: ['gpt-x', 'gemini-y'] });
    await expect(
      testConnection('openai-compatible', { apiKey: 'bad', baseUrl: `${base}/oai` }),
    ).resolves.toEqual({ ok: false, code: 'invalid_key' });
    await expect(
      testConnection('openai-compatible', { baseUrl: `${base}/empty` }),
    ).resolves.toEqual({ ok: false, code: 'no_models' });
    await expect(
      testConnection('openai-compatible', { baseUrl: `${base}/missing` }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });
    await expect(
      testConnection('openai-compatible', { baseUrl: 'http://127.0.0.1:1' }),
    ).resolves.toEqual({ ok: false, code: 'unreachable' });
  });
});

describe('endpoint safety', () => {
  it('knows private addresses, including cloud metadata', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it('allows public HTTPS hosts and refuses everything else', async () => {
    const resolve = (ips: string[]) => () => Promise.resolve(ips);
    await expect(
      checkEndpointUrl('https://llm.example.com/v1/', { resolve: resolve(['93.184.216.34']) }),
    ).resolves.toBe('https://llm.example.com/v1');
    await expect(checkEndpointUrl('http://llm.example.com/v1')).rejects.toMatchObject({
      code: 'https_required',
    });
    await expect(
      checkEndpointUrl('https://sneaky.example.com', {
        resolve: resolve(['93.184.216.34', '169.254.169.254']),
      }),
    ).rejects.toMatchObject({ code: 'private_address' });
    await expect(checkEndpointUrl('https://10.0.0.5/v1')).rejects.toMatchObject({
      code: 'private_address',
    });
    await expect(checkEndpointUrl('https://user:pw@example.com')).rejects.toMatchObject({
      code: 'bad_url',
    });
    await expect(checkEndpointUrl('not a url')).rejects.toMatchObject({ code: 'bad_url' });
    await expect(
      checkEndpointUrl('http://127.0.0.1:8000/v1', { allowPrivate: true }),
    ).resolves.toBe('http://127.0.0.1:8000/v1');
  });
});

describe('Managed settings', () => {
  it('reads one provider and its models, or nothing', () => {
    expect(managedChatFrom(aiEnv.parse({}))).toBeNull();
    const managed = managedChatFrom(
      aiEnv.parse({
        AI_MANAGED_CHAT: 'anthropic:claude-a, anthropic:claude-b',
        AI_MANAGED_KEY: 'k',
      }),
    );
    expect(managed?.models).toEqual(['claude-a', 'claude-b']);
    expect(managed?.provider.dataLocation).toBe('THIRD_PARTY');
    expect(() =>
      managedChatFrom(
        aiEnv.parse({ AI_MANAGED_CHAT: 'anthropic:a,openai:b', AI_MANAGED_KEY: 'k' }),
      ),
    ).toThrow();
    expect(() => managedChatFrom(aiEnv.parse({ AI_MANAGED_CHAT: 'anthropic:a' }))).toThrow(
      'AI_MANAGED_KEY',
    );
  });
});
