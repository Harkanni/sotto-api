import { randomBytes } from 'node:crypto';
import { OpenAICompatibleChatProvider } from '@sotto/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiSettingsService } from '../../src/ai/ai-settings.service.js';
import { withDatabase } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';
import { StandInLlm } from './stand-in-llm.js';

/**
 * Phase 6's "done when": switching models is a setting, and Restricted never reaches outside AI.
 *
 * Two stand-in providers record every byte they receive: `inside` is the platform's Private
 * model (in the cluster), `outside` is the workspace's own key (BYOK, a third party). Tunde can
 * open the restricted Board collection, so only the route can keep its text from a model.
 */
describe.skipIf(withDatabase)('Ask routes and the privacy rules', () => {
  const k = new Kestrel('ask-routes.example');
  const inside = new StandInLlm();
  const outside = new StandInLlm();
  const RESTRICTED = ['Runway is 21 months', '40,000'];
  const CONFIDENTIAL = 'price Business per seat';
  let byokLarge = '';
  let byokSmall = '';
  const PRIVATE = 'private:inside:inside-model';

  interface Answer {
    status: string;
    model: string | null;
    route: { kind: string | null; label: string } | null;
    hidden: { restricted: number; confidential: number };
    error: { code: string } | null;
    citations: { title: string | null }[];
  }

  async function chat(who: Who, scope = {}) {
    return (await k.people[who].post('/api/v1/conversations', { scope }).expect(201)).body
      .id as string;
  }

  async function stream(req: ReturnType<(typeof k.people)['ada']['post']>, status = 200) {
    const res = await req
      .buffer(true)
      .parse((r, done) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => done(null, data));
      })
      .expect(status);
    if (status !== 200) return { res, answer: null, events: [] as { type: string }[] };
    const events = (res.body as string)
      .split('\n\n')
      .filter((b) => b.startsWith('event:'))
      .map((b) => JSON.parse(b.split('\ndata: ')[1]!) as { type: string; answer?: Answer });
    const end = events.find((e) => e.type === 'done' || e.type === 'error');
    const answer = (end?.answer ??
      (end?.type === 'error' ? { error: end } : null)) as Answer | null;
    return { res, answer, events };
  }

  const ask = (who: Who, id: string, content: string, model?: string, status = 200) =>
    stream(
      k.people[who].post(`/api/v1/conversations/${id}/messages`, {
        content,
        ...(model ? { model } : {}),
      }),
      status,
    );

  const neverOutside = () => {
    for (const text of RESTRICTED) expect(outside.sentText()).not.toContain(text);
  };

  beforeAll(async () => {
    await Promise.all([inside.start(), outside.start()]);
    Object.assign(process.env, {
      AI_KEYS_MASTER: randomBytes(32).toString('base64'),
      AI_BYOK_ALLOW_PRIVATE_URLS: 'true',
      AI_ASK_CHAT: '',
      AI_MANAGED_CHAT: '',
      ASK_RATE_PER_MINUTE: '1000',
    });
    await k.start();
    await k.seedLibrary();
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
    byokLarge = `byok:${key.body.id}:stand-in-large`;
    byokSmall = `byok:${key.body.id}:stand-in-small`;
    await k.people.ada
      .put('/api/v1/ai/policy', {
        allowedModes: ['PRIVATE', 'BYOK'],
        defaultMode: 'BYOK',
        defaultModel: byokLarge,
      })
      .expect(200);
  });

  afterAll(async () => {
    await k.stop();
    await Promise.all([inside.stop(), outside.stop()]);
  });

  it('answers with the default model and keeps Restricted and Confidential out of it', async () => {
    const id = await chat('tunde');
    const { answer } = await ask(
      'tunde',
      id,
      'What is our runway and budget, the pricing, and the roadmap on citations?',
    );
    expect(answer).toMatchObject({
      status: 'done',
      model: byokLarge,
      route: { kind: 'byok', label: 'Your server · your API key' },
      hidden: { restricted: 1, confidential: 1 },
    });
    expect(outside.chatCalls()).toBe(1);
    expect(inside.chatCalls()).toBe(0);
    neverOutside();
    expect(outside.sentText()).not.toContain(CONFIDENTIAL);
    // The question itself is sent: it's what the person asked this model.
    expect(outside.sentText()).toContain('runway');
  });

  it('never sends Restricted outside, even when the chat is scoped to it', async () => {
    const board = await chat('tunde', { collectionId: k.collections.board });
    const before = outside.chatCalls();
    const { answer } = await ask('tunde', board, 'runway budget burn months');
    // Everything relevant is hidden, so nothing is sent at all: it says it found nothing.
    expect(answer).toMatchObject({ status: 'done', hidden: { restricted: 1 } });
    expect(outside.chatCalls()).toBe(before);
    const mention = await chat('tunde', { fileIds: [k.files.board!] });
    await ask('tunde', mention, 'What does this say about money?');
    neverOutside();
  });

  it('switches model per question, and Private reads everything Tunde can open', async () => {
    const id = await chat('tunde');
    const { answer } = await ask('tunde', id, 'runway budget burn', PRIVATE);
    expect(answer).toMatchObject({
      status: 'done',
      model: PRIVATE,
      route: { kind: 'private', label: 'Private · Inside model' },
      hidden: { restricted: 0, confidential: 0 },
    });
    expect(inside.sentText()).toContain(RESTRICTED[0]);
    neverOutside();
  });

  it('answers again with another model, and the rules follow the new route', async () => {
    const id = await chat('tunde');
    const first = await ask('tunde', id, 'runway budget burn and citations', PRIVATE);
    const answerId = (
      first.events.find((e) => e.type === 'start') as unknown as {
        answer: { id: string };
      }
    ).answer.id;
    const before = outside.chatCalls();
    const again = await stream(
      k.people.tunde.post(`/api/v1/messages/${answerId}/regenerate`, { model: byokSmall }),
    );
    expect(again.answer).toMatchObject({
      model: byokSmall,
      route: { kind: 'byok' },
      hidden: { restricted: 1 },
    });
    expect(outside.chatCalls()).toBe(before + 1);
    neverOutside();
  });

  it('lets Confidential reach BYOK only once an admin allows it; Restricted still never', async () => {
    await k.people.ada.put('/api/v1/ai/policy', { confidentialModes: ['BYOK'] }).expect(200);
    const id = await chat('tunde');
    const { answer } = await ask(
      'tunde',
      id,
      'What did we decide about pricing, runway and budget?',
    );
    expect(answer).toMatchObject({ hidden: { restricted: 1, confidential: 0 } });
    expect(outside.sentText()).toContain(CONFIDENTIAL);
    neverOutside();
    await k.people.ada.put('/api/v1/ai/policy', { confidentialModes: [] }).expect(200);
  });

  it('refuses a model the workspace no longer allows, before anything is sent', async () => {
    await k.people.ada
      .put('/api/v1/ai/policy', {
        allowedModes: ['PRIVATE'],
        defaultMode: 'PRIVATE',
        defaultModel: null,
      })
      .expect(200);
    const before = outside.chatCalls();
    const id = await chat('priya');
    const refused = await ask('priya', id, 'pricing', byokLarge, 409);
    expect(JSON.parse(refused.res.body as string).error.code).toBe('MODEL_UNAVAILABLE');
    const madeUp = await ask('priya', id, 'pricing', 'byok:made-up:x', 409);
    expect(JSON.parse(madeUp.res.body as string).error.code).toBe('MODEL_UNAVAILABLE');
    // With no model picked, the default (Private) answers.
    const { answer } = await ask('priya', id, 'What is the security setup?');
    expect(answer).toMatchObject({ model: PRIVATE, route: { kind: 'private' } });
    expect(outside.chatCalls()).toBe(before);
  });

  it('fails plainly when the key is refused, and never falls back to another model', async () => {
    await k.people.ada
      .put('/api/v1/ai/policy', {
        allowedModes: ['PRIVATE', 'BYOK'],
        defaultMode: 'BYOK',
        defaultModel: byokLarge,
      })
      .expect(200);
    outside.failStatus = 401;
    const before = inside.chatCalls();
    try {
      const id = await chat('kofi');
      const { answer } = await ask('kofi', id, 'What is the security setup?');
      expect(answer?.error).toMatchObject({ code: 'key_rejected' });
      expect(inside.chatCalls()).toBe(before);
    } finally {
      outside.failStatus = null;
    }
  });

  it('never let a Restricted passage reach the outside model, across every test above', () => {
    expect(outside.chatCalls()).toBeGreaterThanOrEqual(4);
    neverOutside();
  });
});
