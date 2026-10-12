import { randomBytes } from 'node:crypto';
import { OpenAICompatibleChatProvider } from '@sotto/ai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiSettingsService } from '../../src/ai/ai-settings.service.js';
import { LiveService } from '../../src/live/live.service.js';
import { FIRST_NOTES_AFTER_MS, LiveNotesService } from '../../src/live/notes.service.js';
import { parseLiveNotes, liveTranscriptText } from '../../src/live/notes.js';
import { relevantStretches, stretches } from '../../src/live/passages.js';
import { withoutStorage } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';
import { StandInLlm } from './stand-in-llm.js';
import { StandInTranscriber } from './stand-in-transcriber.js';

describe('live notes parsing', () => {
  it('reads JSON wrapped in prose, drops blanks, and refuses an empty summary', () => {
    expect(
      parseLiveNotes(
        'Sure! {"summary":" Plans. ","points":["A"," "],"actions":[{"text":"Ship","owner":" Ada "},{"text":""}]}',
      ),
    ).toEqual({ summary: 'Plans.', points: ['A'], actions: [{ text: 'Ship', owner: 'Ada' }] });
    expect(parseLiveNotes('{"summary":"  "}')).toBeNull();
    expect(parseLiveNotes('no json')).toBeNull();
  });

  it('keeps the newest lines when the call outgrows one request', () => {
    const lines = Array.from({ length: 5 }, (_, i) => ({
      startMs: i * 61_000,
      text: `line ${i}`,
      speaker: null,
    }));
    expect(liveTranscriptText(lines, 40)).toBe('[3:03] line 3\n[4:04] line 4');
    expect(liveTranscriptText([{ startMs: 3_725_000, text: 'x', speaker: 'Tunde' }])).toBe(
      '[1:02:05] Tunde: x',
    );
  });
});

describe('live passages for Ask', () => {
  const line = (seq: number, startMs: number, text: string) => ({
    seq,
    idx: 0,
    startMs,
    endMs: startMs + 3_000,
    text,
    speaker: null,
  });
  const call = [
    line(0, 0, 'Welcome everyone.'),
    line(1, 20_000, 'The budget review is next week.'),
    line(2, 50_000, 'We ship the mobile app on Friday.'),
    line(3, 95_000, 'Lunch is at noon.'),
    line(4, 140_000, 'Any questions before we close?'),
  ];

  it('groups the call into stretches of about 45 seconds', () => {
    expect(stretches(call).map((s) => [s.key, s.startMs, s.endMs])).toEqual([
      ['0.0', 0, 23_000],
      ['2.0', 50_000, 53_000],
      ['3.0', 95_000, 98_000],
      ['4.0', 140_000, 143_000],
    ]);
  });

  it('offers the stretches that share words with the question, and always the latest', () => {
    const picked = relevantStretches(call, 'When do we ship the app?');
    expect(picked.map((s) => s.key)).toEqual(['2.0', '4.0']);
    expect(relevantStretches(call, 'what about the weather').map((s) => s.key)).toEqual(['4.0']);
    expect(relevantStretches([], 'anything')).toEqual([]);
  });
});

/**
 * Phase 7, M3: running notes follow Ask's privacy rules. `inside` is the platform's Private
 * model; `outside` is the workspace's own key (BYOK, a third party) and the default.
 */
describe.skipIf(withoutStorage)('live notes and the privacy rules', () => {
  const k = new Kestrel('live-notes.example');
  const transcriber = new StandInTranscriber();
  const inside = new StandInLlm();
  const outside = new StandInLlm();
  const SECRET = 'Runway is 21 months';
  const NOTES = JSON.stringify({
    summary: 'The team planned the launch.',
    points: ['Launch on Friday'],
    actions: [{ text: 'Send the brief', owner: 'Ada' }],
  });
  const PRIVATE = 'private:inside:inside-model';
  let byok = '';
  let live: LiveService;
  let notes: LiveNotesService;
  const pcm = (ms: number) => Buffer.alloc(ms * 32);

  beforeAll(async () => {
    await Promise.all([transcriber.start(), inside.start(), outside.start()]);
    Object.assign(process.env, {
      TRANSCRIBER_URL: transcriber.url,
      AI_KEYS_MASTER: randomBytes(32).toString('base64'),
      AI_BYOK_ALLOW_PRIVATE_URLS: 'true',
      AI_ASK_CHAT: '',
      AI_MANAGED_CHAT: '',
    });
    await k.start();
    live = k.t.app.get(LiveService);
    notes = k.t.app.get(LiveNotesService);
    k.t.app.get(AiSettingsService).usePlatformChats(
      {
        provider: new OpenAICompatibleChatProvider('inside', {
          baseUrl: inside.url,
          dataLocation: 'IN_CLUSTER',
          label: 'Inside model',
        }),
        model: 'inside-model',
      },
      null,
    );
    const key = await k.people.ada
      .post('/api/v1/ai/providers', {
        provider: 'openai-compatible',
        label: 'Outside',
        apiKey: `sk-${randomBytes(10).toString('hex')}`,
        baseUrl: outside.url,
      })
      .expect(201);
    byok = `byok:${key.body.id}:stand-in-large`;
  });

  afterAll(async () => {
    await k.stop();
    await Promise.all([transcriber.stop(), inside.stop(), outside.stop()]);
  });

  beforeEach(async () => {
    inside.reply = NOTES;
    outside.reply = NOTES;
    await policy({ defaultMode: 'BYOK', defaultModel: byok });
  });

  const policy = (p: object) =>
    k.people.ada.put('/api/v1/ai/policy', { allowedModes: ['PRIVATE', 'BYOK'], ...p }).expect(200);

  /** Starts a capture and sends `ms` of audio in 4-second pieces, then waits for everything. */
  async function call(who: Who, ms: number, body: object = {}) {
    const res = await k.people[who]
      .post('/api/v1/live-sessions', { inputs: ['mic'], ...body })
      .expect(201);
    const id = res.body.id as string;
    await more(who, id, 0, ms);
    return { id, fileId: res.body.file.id as string };
  }

  async function more(who: Who, id: string, from: number, ms: number) {
    for (let seq = from; seq * 4_000 < from * 4_000 + ms; seq++) {
      await k.people[who]
        .post(`/api/v1/live-sessions/${id}/audio?seq=${seq}`)
        .set('content-type', 'application/octet-stream')
        .send(pcm(4_000))
        .expect(200);
    }
    await live.settled(id);
    await notes.settled(id);
  }

  const session = async (who: Who, id: string) =>
    (await k.people[who].get(`/api/v1/live-sessions/${id}`).expect(200)).body as {
      notes: { summary: string; routeLabel: string; private: boolean } | null;
      notesError: string | null;
    };

  it('writes the first notes after a minute, with the default model, and records the tokens', async () => {
    const calls = outside.chatCalls();
    const { id } = await call('tunde', FIRST_NOTES_AFTER_MS - 4_000);
    expect(outside.chatCalls()).toBe(calls);
    expect((await session('tunde', id)).notes).toBeNull();

    await more('tunde', id, 14, 4_000);
    expect(outside.chatCalls()).toBe(calls + 1);
    expect((await session('tunde', id)).notes).toEqual({
      summary: 'The team planned the launch.',
      points: ['Launch on Friday'],
      actions: [{ text: 'Send the brief', owner: 'Ada' }],
      routeLabel: 'Your server · your API key',
      isMock: false,
      private: false,
    });
    const usage = await k.db.usageEvent.findMany({
      where: { workspaceId: k.workspaceId, model: byok, userId: k.ids.tunde },
    });
    expect(usage.map((u) => u.kind).sort()).toEqual(['AI_INPUT_TOKENS', 'AI_OUTPUT_TOKENS']);

    // Not again until two minutes pass…
    await more('tunde', id, 15, 4_000);
    expect(outside.chatCalls()).toBe(calls + 1);
    // …unless the person listening asks, and only when something new was said.
    await k.people.tunde.post(`/api/v1/live-sessions/${id}/notes`).expect(200);
    expect(outside.chatCalls()).toBe(calls + 2);
    await k.people.tunde.post(`/api/v1/live-sessions/${id}/notes`).expect(200);
    expect(outside.chatCalls()).toBe(calls + 2);
    // Two minutes later, new lines bring new notes.
    await k.db.liveSession.update({
      where: { id },
      data: { notesAt: new Date(Date.now() - 3 * 60_000) },
    });
    await more('tunde', id, 16, 4_000);
    expect(outside.chatCalls()).toBe(calls + 3);
  });

  it('never sends a Restricted meeting to a model outside; says why instead', async () => {
    const calls = outside.chatCalls();
    transcriber.script.push(SECRET);
    const { id } = await call('ada', FIRST_NOTES_AFTER_MS, { sensitivity: 'restricted' });
    expect(outside.chatCalls()).toBe(calls);
    expect(outside.sentText()).not.toContain(SECRET);
    expect(await session('ada', id)).toMatchObject({
      notes: null,
      notesError: 'restricted_private_only',
    });
    // Asking for notes doesn't change the rule.
    await k.people.ada.post(`/api/v1/live-sessions/${id}/notes`).expect(200);
    expect(outside.chatCalls()).toBe(calls);

    // With a Private default, the cluster's model writes them.
    const insideCalls = inside.chatCalls();
    await policy({ defaultMode: 'PRIVATE', defaultModel: PRIVATE });
    await k.people.ada.post(`/api/v1/live-sessions/${id}/notes`).expect(200);
    expect(inside.chatCalls()).toBe(insideCalls + 1);
    expect(inside.sentText()).toContain(SECRET);
    expect(await session('ada', id)).toMatchObject({
      notes: { routeLabel: 'Private · Inside model', private: true },
      notesError: null,
    });
    expect(outside.sentText()).not.toContain(SECRET);
  });

  it('keeps Confidential from outside models unless admins allow that mode', async () => {
    const calls = outside.chatCalls();
    const { id } = await call('tunde', FIRST_NOTES_AFTER_MS, { sensitivity: 'confidential' });
    expect(outside.chatCalls()).toBe(calls);
    expect((await session('tunde', id)).notesError).toBe('confidential_not_allowed');

    await policy({ defaultMode: 'BYOK', defaultModel: byok, confidentialModes: ['BYOK'] });
    await k.people.tunde.post(`/api/v1/live-sessions/${id}/notes`).expect(200);
    expect(outside.chatCalls()).toBe(calls + 1);
    expect(await session('tunde', id)).toMatchObject({
      notesError: null,
      notes: { private: false },
    });
  });

  it('says so when the model’s answer can’t be read, and keeps listening', async () => {
    outside.reply = 'Here are your notes: none.';
    const { id } = await call('tunde', FIRST_NOTES_AFTER_MS);
    expect(await session('tunde', id)).toMatchObject({ notes: null, notesError: 'unreadable' });
    expect((await live.segments(k.workspaceId, id, null)).length).toBe(15);
  });

  /** Asks in a chat and returns the finished answer from the stream. */
  async function askIn(who: Who, conversationId: string, content: string) {
    const res = await k.people[who]
      .post(`/api/v1/conversations/${conversationId}/messages`, { content })
      .buffer(true)
      .parse((r, done) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => done(null, data));
      })
      .expect(200);
    const events = (res.body as string)
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => JSON.parse(b.split('\ndata: ')[1]!) as { type: string; answer?: unknown });
    return events.find((e) => e.type === 'done')!.answer as {
      status: string;
      hidden: { restricted: number; confidential: number };
      citations: { fileId: string | null; startMs: number | null; quote: string }[];
    };
  }

  it('answers mid-call from what was said so far, cited by moment', async () => {
    transcriber.script.push('Welcome to the launch sync.', 'We ship the mobile app on Friday.');
    const { id, fileId } = await call('tunde', 8_000);
    const { conversationId } = (
      await k.people.tunde.post(`/api/v1/live-sessions/${id}/ask`).expect(201)
    ).body as { conversationId: string };
    outside.reply = 'You ship on Friday [1].';
    const answer = await askIn('tunde', conversationId, 'When do we ship the mobile app?');
    expect(outside.sentText()).toContain('We ship the mobile app on Friday.');
    expect(answer.status).toBe('done');
    expect(answer.citations[0]).toMatchObject({ fileId, startMs: 200 });
    const stored = await k.db.citation.findFirstOrThrow({ where: { fileId } });
    expect(stored.chunkId).toBeNull();
  });

  it('keeps a Restricted call from an outside model when asking, too', async () => {
    transcriber.script.push(SECRET);
    const calls = outside.chatCalls();
    const { id } = await call('ada', 4_000, { sensitivity: 'restricted' });
    const { conversationId } = (
      await k.people.ada.post(`/api/v1/live-sessions/${id}/ask`).expect(201)
    ).body as { conversationId: string };
    const answer = await askIn('ada', conversationId, 'What is the runway?');
    expect(answer.hidden.restricted).toBeGreaterThanOrEqual(1);
    expect(outside.sentText()).not.toContain(SECRET);
    expect(outside.chatCalls()).toBe(calls); // nothing else to answer from
  });

  it('lets nobody else scope a chat to a call they can’t open', async () => {
    const { id } = await call('tunde', 4_000);
    await k.people.kofi.post(`/api/v1/live-sessions/${id}/ask`).expect(404);
    await k.people.kofi.post('/api/v1/conversations', { scope: { liveSessionId: id } }).expect(404);
  });

  it('refuses to update someone else’s notes', async () => {
    const { id } = await call('tunde', 4_000);
    await k.people.kofi.post(`/api/v1/live-sessions/${id}/notes`).expect(404);
    await k.people.priya.post(`/api/v1/live-sessions/${id}/notes`).expect(403);
  });
});
