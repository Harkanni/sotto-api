import { randomBytes } from 'node:crypto';
import { OpenAICompatibleChatProvider } from '@sotto/ai';
import type { Subscription } from '@sotto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiSettingsService } from '../../src/ai/ai-settings.service.js';
import { effectivePlan, periodOf } from '../../src/billing/usage.service.js';
import { withDatabase } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';
import { StandInLlm } from './stand-in-llm.js';

const DAY = 86_400_000;

describe('effectivePlan', () => {
  const sub = (s: Partial<Subscription>): Subscription => ({
    workspaceId: 'w',
    plan: 'PRO',
    status: 'ACTIVE',
    provider: 'test',
    customerRef: null,
    externalId: null,
    currentPeriodEnd: null,
    updatedAt: new Date(),
    ...s,
  });
  const now = new Date('2026-10-10T12:00:00Z');

  it('is Free with no subscription, the plan while it lasts, and Free after the grace days', () => {
    expect(effectivePlan(null, now)).toBe('FREE');
    expect(effectivePlan(sub({}), now)).toBe('PRO');
    const end = (days: number) => new Date(now.getTime() + days * DAY);
    expect(effectivePlan(sub({ currentPeriodEnd: end(-2) }), now)).toBe('PRO');
    expect(effectivePlan(sub({ currentPeriodEnd: end(-4) }), now)).toBe('FREE');
    expect(effectivePlan(sub({ status: 'CANCELLED', currentPeriodEnd: end(5) }), now)).toBe('PRO');
    expect(effectivePlan(sub({ status: 'CANCELLED', currentPeriodEnd: end(-1) }), now)).toBe(
      'FREE',
    );
  });

  it('counts calendar months in UTC', () => {
    const { start, end } = periodOf(new Date('2026-10-31T23:30:00Z'));
    expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

/**
 * Metering and quotas (Phase 6, M5). Kestrel starts on Free; the stand-ins answer every question
 * with 321 input and 12 output tokens.
 */
describe.skipIf(withDatabase)('usage and quotas', () => {
  const k = new Kestrel('usage.example');
  const inside = new StandInLlm();
  const outside = new StandInLlm();
  const GB = 1024 ** 3;

  async function ask(who: Who, content: string, model?: string, status = 200) {
    const id = (await k.people[who].post('/api/v1/conversations', { scope: {} }).expect(201)).body
      .id as string;
    const res = await k.people[who]
      .post(`/api/v1/conversations/${id}/messages`, { content, ...(model ? { model } : {}) })
      .buffer(true)
      .parse((r, done) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => done(null, data));
      })
      .expect(status);
    return status === 200
      ? null
      : (JSON.parse(res.body as string) as { error: { code: string; message: string } });
  }

  const report = async (range = '30d') =>
    (await k.people.ada.get(`/api/v1/usage?range=${range}`).expect(200)).body as {
      plan: { id: string; placeholderPrices: boolean };
      meters: { id: string; used: number; limit: number | null }[];
      byokTokens: number;
      daily: { date: string; privateTokens: number; managedTokens: number; byokTokens: number }[];
    };
  const meter = async (id: string) => (await report()).meters.find((m) => m.id === id)!;

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
      {
        provider: new OpenAICompatibleChatProvider('outside', {
          baseUrl: outside.url,
          dataLocation: 'THIRD_PARTY',
          label: 'Hosted',
        }),
        models: ['hosted-model'],
      },
    );
  });

  afterAll(async () => {
    await k.stop();
    await Promise.all([inside.stop(), outside.stop()]);
  });

  it('shows the owner this month against the Free plan; nobody else', async () => {
    for (const who of ['tunde', 'priya'] as const) {
      await k.people[who].get('/api/v1/usage').expect(403);
    }
    const r = await report('7d');
    expect(r.plan).toMatchObject({ id: 'FREE', placeholderPrices: true });
    expect(r.meters).toEqual([
      { id: 'privateTokens', used: 0, limit: 200_000 },
      { id: 'managedTokens', used: 0, limit: 0 },
      { id: 'transcriptionMinutes', used: 0, limit: 60 },
      { id: 'storageBytes', used: expect.any(Number), limit: GB },
    ]);
    expect(r.daily).toHaveLength(7);
    await k.people.ada.get('/api/v1/usage?range=1y').expect(400);
  });

  it('records the tokens of each answer, by route, without any content', async () => {
    expect(await ask('tunde', 'What does the roadmap say about citations?')).toBeNull();
    expect(await meter('privateTokens')).toMatchObject({ used: 333 });
    const today = (await report('7d')).daily.at(-1)!;
    expect(today).toMatchObject({ privateTokens: 333, managedTokens: 0 });
    const rows = await k.db.usageEvent.findMany({ where: { workspaceId: k.workspaceId } });
    expect(rows.map((r) => [r.kind, Number(r.quantity), r.route])).toEqual(
      expect.arrayContaining([
        ['AI_INPUT_TOKENS', 321, 'PRIVATE'],
        ['AI_OUTPUT_TOKENS', 12, 'PRIVATE'],
      ]),
    );
    expect(rows.every((r) => r.model === 'private:inside:inside-model')).toBe(true);
  });

  it('stops Private questions at the allowance, and says what to do', async () => {
    await k.db.usageEvent.create({
      data: {
        workspaceId: k.workspaceId,
        kind: 'AI_INPUT_TOKENS',
        quantity: 200_000n,
        route: 'PRIVATE',
      },
    });
    const calls = inside.chatCalls();
    const refused = await ask(
      'tunde',
      'What does the roadmap say about citations?',
      undefined,
      402,
    );
    expect(refused?.error.code).toBe('QUOTA_EXCEEDED');
    expect(refused?.error.message).toMatch(
      /private AI allowance on the Free plan\. Upgrade to Pro/,
    );
    expect(inside.chatCalls()).toBe(calls);
  });

  it('never limits a workspace’s own key, and shows its tokens apart', async () => {
    const key = await k.people.ada
      .post('/api/v1/ai/providers', {
        provider: 'openai-compatible',
        label: 'Ours',
        apiKey: `sk-${randomBytes(8).toString('hex')}`,
        baseUrl: outside.url,
      })
      .expect(201);
    await k.people.ada.put('/api/v1/ai/policy', { allowedModes: ['PRIVATE', 'BYOK'] }).expect(200);
    expect(
      await ask('tunde', 'roadmap citations', `byok:${key.body.id}:stand-in-large`),
    ).toBeNull();
    const r = await report();
    expect(r.byokTokens).toBe(333);
    expect(r.meters.find((m) => m.id === 'privateTokens')?.used).toBe(200_333);
  });

  it('keeps Managed for paid plans', async () => {
    const res = await k.people.ada
      .put('/api/v1/ai/policy', { allowedModes: ['PRIVATE', 'BYOK', 'MANAGED'] })
      .expect(402);
    expect(res.body.error).toMatchObject({ code: 'PLAN_REQUIRED' });
    const models = await k.people.priya.get('/api/v1/ai/models').expect(200);
    expect(models.body.models.some((m: { mode: string }) => m.mode === 'MANAGED')).toBe(false);

    await k.db.subscription.create({
      data: { workspaceId: k.workspaceId, plan: 'PRO', provider: 'test' },
    });
    await k.people.ada
      .put('/api/v1/ai/policy', { allowedModes: ['PRIVATE', 'BYOK', 'MANAGED'] })
      .expect(200);
    expect(await ask('tunde', 'roadmap citations', 'managed:outside:hosted-model')).toBeNull();
    const r = await report();
    expect(r.plan.id).toBe('PRO');
    expect(r.meters.find((m) => m.id === 'managedTokens')).toEqual({
      id: 'managedTokens',
      used: 333,
      limit: 2_000_000,
    });
    // Back on Free, the setting stays but Managed can't be used.
    await k.db.subscription.delete({ where: { workspaceId: k.workspaceId } });
    const refused = await ask('tunde', 'roadmap', 'managed:outside:hosted-model', 409);
    expect(refused?.error.code).toBe('MODEL_UNAVAILABLE');
  });

  it('refuses an upload that would pass the storage or transcription allowance', async () => {
    await k.seed({ key: 'huge', title: 'Huge archive', texts: ['big'] });
    await k.db.file.update({
      where: { id: k.files.huge! },
      data: { sizeBytes: BigInt(GB - 1_000) },
    });
    const full = await k.people.tunde
      .post('/api/v1/uploads', { filename: 'notes.pdf', sizeBytes: 5_000 })
      .expect(402);
    expect(full.body.error).toMatchObject({ code: 'STORAGE_FULL' });
    expect(full.body.error.message).toContain('Empty the trash');

    await k.db.file.update({ where: { id: k.files.huge! }, data: { sizeBytes: 100n } });
    await k.db.usageEvent.create({
      data: {
        workspaceId: k.workspaceId,
        kind: 'TRANSCRIPTION_SECONDS',
        quantity: 3_600n,
        route: 'PRIVATE',
        subjectId: 'some-file',
      },
    });
    const minutes = await k.people.tunde
      .post('/api/v1/uploads', { filename: 'standup.m4a', sizeBytes: 5_000 })
      .expect(402);
    expect(minutes.body.error.message).toContain('Documents still upload');
    // The same file can't be counted twice.
    await expect(
      k.db.usageEvent.create({
        data: {
          workspaceId: k.workspaceId,
          kind: 'TRANSCRIPTION_SECONDS',
          quantity: 3_600n,
          subjectId: 'some-file',
        },
      }),
    ).rejects.toThrow();
    expect(await meter('transcriptionMinutes')).toMatchObject({ used: 60, limit: 60 });
  });
});
