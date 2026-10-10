import type { ChatMessage, ChatProvider, ChatRequest, DataLocation } from '@sotto/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiSettingsService } from '../../src/ai/ai-settings.service.js';
import { FOLLOW_UPS } from '../../src/ask/answer.js';
import { withDatabase } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';

/**
 * A model for tests: records every prompt and answers with a script, a few characters at a time
 * like a real stream. `cite` answers by naming sources by title; it learns their numbers from
 * the prompt, as a real model must.
 */
class ScriptedChat implements ChatProvider {
  readonly id = 'scripted';
  readonly label = 'Scripted model';
  readonly capability = 'chat' as const;
  prompts: ChatMessage[][] = [];
  reply: (prompt: ChatMessage[]) => string | Error = () => 'No script.';
  delayMs = 0;

  constructor(readonly dataLocation: DataLocation) {}

  async *stream(request: ChatRequest) {
    this.prompts.push(request.messages);
    const reply = this.reply(request.messages);
    if (reply instanceof Error) throw reply;
    for (const piece of reply.match(/[\s\S]{1,4}/g) ?? []) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (request.signal?.aborted)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield { type: 'text' as const, text: piece };
    }
    yield { type: 'done' as const, usage: { inputTokens: 120, outputTokens: 30 } };
  }
}

/** The titles of the sources in a prompt, in their numbered order. */
function sourcesIn(prompt: ChatMessage[]): string[] {
  return [...prompt.at(-1)!.content.matchAll(/<source n="\d+" title="([^"]+)"/g)].map((m) => m[1]!);
}

/** "[n]" for each title, by its number in the prompt. */
function cite(prompt: ChatMessage[], ...titles: string[]): string {
  const sources = sourcesIn(prompt);
  return titles.map((t) => `[${sources.indexOf(t) + 1}]`).join('');
}

interface Event {
  type: string;
  [key: string]: unknown;
}
interface AnswerOut {
  id: string;
  status: string;
  content: string;
  model: string | null;
  route: { kind: string | null; label: string } | null;
  passagesOnly: boolean;
  notFound: boolean;
  followUps: string[];
  hidden: { restricted: number; confidential: number };
  error: { code: string; message: string } | null;
  citations: {
    n: number;
    available: boolean;
    title: string | null;
    quote: string | null;
    fileId: string | null;
    kind: string | null;
    page: number | null;
    startMs: number | null;
  }[];
}

function parseEvents(text: string): Event[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => JSON.parse(block.split('\ndata: ')[1]!) as Event);
}

describe.skipIf(withDatabase)('ask', () => {
  const k = new Kestrel('ask.example');
  const chat = {
    inCluster: new ScriptedChat('IN_CLUSTER'),
    outside: new ScriptedChat('THIRD_PARTY'),
  };

  /**
   * Which model answers: an in-cluster one as the platform's Private model, an outside one as
   * the platform's Managed model with the workspace allowing Managed (the real Phase 6 path), or
   * none (passages only).
   */
  async function useChat(provider: ScriptedChat | null) {
    const settings = k.t.app.get(AiSettingsService);
    await k.db.workspaceAiPolicy.deleteMany({ where: { workspaceId: k.workspaceId } });
    if (!provider) return settings.usePlatformChats(null, null);
    if (provider.dataLocation === 'IN_CLUSTER') {
      return settings.usePlatformChats({ provider, model: 'scripted-1' }, null);
    }
    settings.usePlatformChats(null, { provider, models: ['scripted-1'] });
    // Managed AI is a Pro feature.
    await k.db.subscription.upsert({
      where: { workspaceId: k.workspaceId },
      create: { workspaceId: k.workspaceId, plan: 'PRO', provider: 'test' },
      update: {},
    });
    await k.db.workspaceAiPolicy.create({
      data: {
        workspaceId: k.workspaceId,
        allowedModes: ['PRIVATE', 'MANAGED'],
        defaultMode: 'MANAGED',
      },
    });
  }

  async function newChat(who: Who, scope = {}) {
    return (await k.people[who].post('/api/v1/conversations', { scope }).expect(201)).body
      .id as string;
  }

  /** Asks and reads the whole event stream. */
  async function ask(who: Who, conversationId: string, content: string, status = 200) {
    const res = await k.people[who]
      .post(`/api/v1/conversations/${conversationId}/messages`, { content })
      .buffer(true)
      .parse((r, done) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => done(null, data));
      })
      .expect(status);
    const events = status === 200 ? parseEvents(res.body as string) : [];
    const final = events.find((e) => e.type === 'done')?.answer as AnswerOut | undefined;
    return { res, events, final };
  }

  beforeAll(async () => {
    process.env.ASK_RATE_PER_MINUTE = '1000';
    await k.start();
    await k.seedLibrary();
  });
  afterAll(() => k.stop());

  it('streams an answer with renumbered citations and follow-ups, and saves it', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = (p) =>
      `Offline recording is a launch requirement ${cite(p, 'Weekly product sync')}. Business is priced per seat ${cite(p, 'Pricing review notes')}.\n${FOLLOW_UPS}\nWho owns offline recording?\nWhen is the beta?`;
    const id = await newChat('tunde');
    const { events, final } = await ask(
      'tunde',
      id,
      'What did we decide about offline recording and pricing?',
    );

    expect(events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1])).toEqual([
      'start',
      'token',
      'cite',
      'token',
      'cite',
      'token',
      'done',
    ]);
    const streamed = events
      .filter((e) => e.type === 'token')
      .map((e) => e.text)
      .join('');
    expect(streamed).toBe(
      'Offline recording is a launch requirement [1]. Business is priced per seat [2].',
    );
    expect(final).toMatchObject({
      status: 'done',
      content: streamed,
      model: 'private:scripted:scripted-1',
      route: { kind: 'private', label: 'Private · Scripted model' },
      notFound: false,
      followUps: ['Who owns offline recording?', 'When is the beta?'],
      hidden: { restricted: 0, confidential: 0 },
    });
    expect(final!.citations.map((c) => [c.n, c.title, c.kind])).toEqual([
      [1, 'Weekly product sync', 'audio'],
      [2, 'Pricing review notes', 'document'],
    ]);
    expect(final!.citations[0]).toMatchObject({ startMs: 0, page: null, available: true });
    expect(final!.citations[1]).toMatchObject({
      page: 1,
      quote: expect.stringContaining('per seat'),
    });

    const saved = await k.people.tunde.get(`/api/v1/conversations/${id}`).expect(200);
    expect(saved.body.title).toBe('What did we decide about offline recording and pricing');
    expect(saved.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(saved.body.messages[1]).toEqual(final);

    const audit = await k.db.auditLog.findFirstOrThrow({ where: { action: 'ask.asked' } });
    expect(audit).toMatchObject({ targetType: 'conversation', targetId: id });
    expect(JSON.stringify(audit.meta)).not.toMatch(/offline|pricing/i);
  });

  it('never lets a viewer’s answer draw on a collection they can’t open', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.prompts = [];
    chat.inCluster.reply = (p) =>
      `Here is what I found ${sourcesIn(p)
        .map((_, i) => `[${i + 1}]`)
        .join('')}.`;
    const question = 'What is our runway, burn and budget for the board?';
    for (const who of ['priya', 'kofi'] as const) {
      const { final } = await ask(who, await newChat(who), question);
      expect(final!.citations.map((c) => c.title)).not.toContain('Board update');
    }
    // The model was never even shown it.
    for (const prompt of chat.inCluster.prompts) {
      expect(JSON.stringify(prompt)).not.toMatch(/Runway is 21 months|Board update/);
    }
    // Tunde has a grant: the same question finds it.
    const { final } = await ask('tunde', await newChat('tunde'), question);
    expect(final!.citations.map((c) => c.title)).toContain('Board update');
  });

  it('keeps Restricted and Confidential from an outside model, and says how many', async () => {
    await useChat(chat.outside);
    chat.outside.prompts = [];
    chat.outside.reply = (p) =>
      sourcesIn(p).length ? `Found ${cite(p, sourcesIn(p)[0]!)}.` : 'Nothing.';
    const { final } = await ask(
      'ada',
      await newChat('ada'),
      'pricing runway burn offline recording',
    );
    expect(final).toMatchObject({
      route: { kind: 'managed', label: 'Managed · Scripted model' },
      hidden: { restricted: 1, confidential: 1 },
    });
    const prompt = JSON.stringify(chat.outside.prompts.at(-1));
    expect(prompt).not.toMatch(/Runway is 21 months|per seat/);
    expect(prompt).toContain('Offline recording');
  });

  it('answers with the matching passages, labelled, when no model is configured', async () => {
    await useChat(null);
    const { events, final } = await ask(
      'ada',
      await newChat('ada'),
      'offline recording field visits',
    );
    expect(events.some((e) => e.type === 'token')).toBe(false);
    expect(final).toMatchObject({
      model: 'none',
      passagesOnly: true,
      content: '',
      route: { kind: null, label: 'Passages only · no AI model' },
      notFound: false,
    });
    expect(final!.citations.map((c) => c.title)).toEqual([
      'Weekly product sync',
      'Weekly product sync',
    ]);
  });

  it('says so instead of guessing when nothing matches, without calling the model', async () => {
    await useChat(chat.inCluster);
    const before = chat.inCluster.prompts.length;
    const { final } = await ask('ada', await newChat('ada'), 'What is the office wifi password?');
    expect(final).toMatchObject({ notFound: true, citations: [], content: '' });
    expect(chat.inCluster.prompts.length).toBe(before);
  });

  it('marks an answer with no citations as not found', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = () => 'The sources don’t say who the CEO is.';
    const { final } = await ask('ada', await newChat('ada'), 'Who is the pricing CEO?');
    expect(final).toMatchObject({
      notFound: true,
      content: 'The sources don’t say who the CEO is.',
    });
  });

  it('answers within a scope, and refuses a scope the person can’t open', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = (p) =>
      `Scoped ${sourcesIn(p)
        .map((_, i) => `[${i + 1}]`)
        .join('')}.`;
    const id = await newChat('ada', { kind: 'meetings' });
    const { final } = await ask('ada', id, 'pricing offline recording');
    expect(new Set(final!.citations.map((c) => c.title))).toEqual(new Set(['Weekly product sync']));
    await k.people.priya
      .post('/api/v1/conversations', { scope: { fileIds: [k.files.board] } })
      .expect(404);
    await k.people.priya
      .post('/api/v1/conversations', { scope: { collectionId: k.collections.board } })
      .expect(404);
  });

  it('keeps chats private to the person who started them', async () => {
    await useChat(chat.inCluster);
    const id = await newChat('tunde');
    await ask('tunde', id, 'offline recording');
    await k.people.ada.get(`/api/v1/conversations/${id}`).expect(404);
    await ask('ada', id, 'offline recording', 404);
    const answerId = (
      await k.db.message.findFirstOrThrow({ where: { conversationId: id, role: 'ASSISTANT' } })
    ).id;
    await k.people.ada.post(`/api/v1/messages/${answerId}/feedback`, { value: 1 }).expect(404);
    await k.people.ada.delete(`/api/v1/conversations/${id}`).expect(404);
    const mine = await k.people.ada.get('/api/v1/conversations').expect(200);
    expect(mine.body.items.map((c: { id: string }) => c.id)).not.toContain(id);
  });

  it('lists and searches chats, newest first, with a preview', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = (p) => `Encrypted at rest ${cite(p, 'Security answers')}.`;
    const id = await newChat('kofi');
    await ask('kofi', id, 'Are files encrypted?');
    const list = await k.people.kofi.get('/api/v1/conversations').expect(200);
    expect(list.body.items[0]).toMatchObject({
      id,
      title: 'Are files encrypted',
      preview: 'Encrypted at rest.',
    });
    const found = await k.people.kofi.get('/api/v1/conversations?q=at%20rest').expect(200);
    expect(found.body.items.map((c: { id: string }) => c.id)).toEqual([id]);
    const none = await k.people.kofi.get('/api/v1/conversations?q=zebra').expect(200);
    expect(none.body.items).toEqual([]);
    // An empty chat (no question yet) isn't listed.
    await newChat('kofi');
    expect((await k.people.kofi.get('/api/v1/conversations').expect(200)).body.items).toHaveLength(
      list.body.items.length,
    );
  });

  it('regenerates an answer in place, takes feedback, deletes a chat', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = (p) => `First ${cite(p, 'Security answers')}.`;
    const id = await newChat('ada');
    const first = (await ask('ada', id, 'encrypted files TLS')).final!;
    chat.inCluster.reply = (p) => `Second ${cite(p, 'Security answers')}.`;
    const res = await k.people.ada
      .post(`/api/v1/messages/${first.id}/regenerate`)
      .buffer(true)
      .parse((r, done) => {
        let d = '';
        r.on('data', (c: Buffer) => (d += c.toString()));
        r.on('end', () => done(null, d));
      })
      .expect(200);
    const again = parseEvents(res.body as string).find((e) => e.type === 'done')!
      .answer as AnswerOut;
    expect(again).toMatchObject({ id: first.id, content: 'Second [1].' });
    // The prompt didn't include the answer being replaced.
    expect(JSON.stringify(chat.inCluster.prompts.at(-1))).not.toContain('First');
    const saved = (await k.people.ada.get(`/api/v1/conversations/${id}`).expect(200)).body;
    expect(saved.messages).toHaveLength(2);

    const rated = await k.people.ada
      .post(`/api/v1/messages/${first.id}/feedback`, { value: -1 })
      .expect(200);
    expect(rated.body).toEqual({ id: first.id, feedback: -1 });
    await k.people.ada.post(`/api/v1/messages/${first.id}/feedback`, { value: 2 }).expect(400);

    await k.people.ada.delete(`/api/v1/conversations/${id}`).expect(204);
    await k.people.ada.get(`/api/v1/conversations/${id}`).expect(404);
  });

  it('stops an answer part-way and keeps what arrived', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.delayMs = 15;
    chat.inCluster.reply = (p) => `${'Long answer '.repeat(80)}${cite(p, 'Security answers')}.`;
    try {
      const id = await newChat('ada');
      const asking = ask('ada', id, 'encrypted files TLS');
      let answerId = '';
      for (let i = 0; i < 100 && !answerId; i++) {
        await new Promise((r) => setTimeout(r, 30));
        const m = await k.db.message.findFirst({
          where: {
            conversationId: id,
            role: 'ASSISTANT',
            status: 'STREAMING',
            content: { not: '' },
          },
        });
        answerId = m?.id ?? '';
      }
      expect(answerId).not.toBe('');
      await ask('ada', id, 'another question', 409);
      await k.people.ada.post(`/api/v1/messages/${answerId}/stop`).expect(204);
      const { final } = await asking;
      expect(final!.status).toBe('stopped');
      expect(final!.content.length).toBeGreaterThan(0);
      expect(final!.content.length).toBeLessThan('Long answer '.length * 80);
    } finally {
      chat.inCluster.delayMs = 0;
    }
  });

  it('saves a failed answer with a reason, and never falls back to another model', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = () => Object.assign(new TypeError('fetch failed'));
    const outsideCalls = chat.outside.prompts.length;
    const id = await newChat('ada');
    const { events } = await ask('ada', id, 'encrypted files TLS');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'chat_unavailable' });
    expect(chat.outside.prompts.length).toBe(outsideCalls);
    const saved = (await k.people.ada.get(`/api/v1/conversations/${id}`).expect(200)).body;
    expect(saved.messages[1]).toMatchObject({
      status: 'failed',
      error: {
        code: 'chat_unavailable',
        message: expect.stringContaining('Nothing was sent anywhere else'),
      },
    });
  });

  it('hides a cited source once the person can no longer open it', async () => {
    await useChat(chat.inCluster);
    chat.inCluster.reply = (p) => `Seats ${cite(p, 'Pricing review notes')}.`;
    const id = await newChat('kofi');
    const { final } = await ask('kofi', id, 'pricing per seat');
    expect(final!.citations[0]).toMatchObject({ available: true, title: 'Pricing review notes' });
    await k.db.file.update({
      where: { id: k.files.pricing },
      data: { collectionId: k.collections.board },
    });
    try {
      const saved = (await k.people.kofi.get(`/api/v1/conversations/${id}`).expect(200)).body;
      expect(saved.messages[1].citations[0]).toEqual({
        n: 1,
        available: false,
        fileId: null,
        kind: null,
        title: null,
        page: null,
        startMs: null,
        endMs: null,
        quote: null,
      });
    } finally {
      await k.db.file.update({
        where: { id: k.files.pricing },
        data: { collectionId: k.collections.product },
      });
    }
  });

  it('refuses an empty question and anyone signed out', async () => {
    const id = await newChat('ada');
    await ask('ada', id, '   ', 400);
    const { default: request } = await import('supertest');
    await request(k.t.app.getHttpServer()).get('/api/v1/conversations').expect(401);
  });
});
