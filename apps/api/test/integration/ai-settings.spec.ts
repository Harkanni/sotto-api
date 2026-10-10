import { randomBytes } from 'node:crypto';
import { keyVaultFrom } from '@sotto/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiSettingsService } from '../../src/ai/ai-settings.service.js';
import { Person, withDatabase } from './harness.js';
import { Kestrel } from './kestrel.js';
import { StandInLlm } from './stand-in-llm.js';

/**
 * AI settings (Phase 6, M3): the policy, the catalog and BYOK keys, per role. Kestrel's Ada is
 * the owner, Tunde a member, Priya a viewer. Keys point at a stand-in provider on localhost.
 */
describe.skipIf(withDatabase)('AI settings', () => {
  const k = new Kestrel('ai-settings.example');
  const llm = new StandInLlm();
  const SECRET = `sk-test-${randomBytes(12).toString('hex')}-WXYZ`;
  let keyId = '';
  const PRIVATE_REF = 'private:fake:mock-model';
  const ref = (model: string) => `byok:${keyId}:${model}`;
  const actions = async () =>
    (
      await k.db.auditLog.findMany({
        where: { workspaceId: k.workspaceId },
        orderBy: { at: 'asc' },
      })
    )
      .map((e) => e.action)
      .filter((a) => a.startsWith('ai.'));

  beforeAll(async () => {
    await llm.start();
    Object.assign(process.env, {
      AI_KEYS_MASTER: randomBytes(32).toString('base64'),
      AI_BYOK_ALLOW_PRIVATE_URLS: 'true',
      AI_ASK_CHAT: 'fake:mock-model',
      AI_MANAGED_CHAT: '',
    });
    await k.start();
  });

  afterAll(async () => {
    await k.db?.$disconnect();
    await k.t?.close();
    await llm.stop();
    for (const name of ['AI_KEYS_MASTER', 'AI_BYOK_ALLOW_PRIVATE_URLS', 'AI_ASK_CHAT']) {
      delete process.env[name];
    }
  });

  it('starts Private only, and says which modes this server offers', async () => {
    const res = await k.people.ada.get('/api/v1/ai/policy').expect(200);
    expect(res.body.policy).toEqual({
      allowedModes: ['PRIVATE'],
      defaultMode: 'PRIVATE',
      defaultModel: null,
      confidentialModes: [],
      disabledModels: [],
    });
    expect(res.body.modes).toEqual([
      { mode: 'PRIVATE', label: 'Private', availability: { available: true } },
      { mode: 'BYOK', label: 'Your API key', availability: { available: true } },
      {
        mode: 'MANAGED',
        label: 'Managed',
        availability: { available: false, reason: 'not_configured' },
      },
    ]);
    expect(res.body.effectiveDefault).toBe(PRIVATE_REF);
  });

  it('keeps the settings to admins, and shows everyone the models they can pick', async () => {
    for (const who of ['tunde', 'priya'] as const) {
      await k.people[who].get('/api/v1/ai/policy').expect(403);
      await k.people[who].get('/api/v1/ai/providers').expect(403);
      await k.people[who].get('/api/v1/ai/catalog').expect(403);
      await k.people[who]
        .put('/api/v1/ai/policy', { allowedModes: ['PRIVATE', 'BYOK'] })
        .expect(403);
      await k.people[who]
        .post('/api/v1/ai/providers', { provider: 'openai', label: 'x', apiKey: SECRET })
        .expect(403);
    }
    const models = await k.people.priya.get('/api/v1/ai/models').expect(200);
    expect(models.body).toEqual({
      defaultRef: PRIVATE_REF,
      models: [
        expect.objectContaining({
          ref: PRIVATE_REF,
          mode: 'PRIVATE',
          dataLocation: 'IN_CLUSTER',
          isMock: true,
          routeLabel: 'Mock chat · no model',
          readsConfidential: true,
          readsRestricted: true,
        }),
      ],
    });
  });

  it('refuses a key the provider rejects, and stores nothing', async () => {
    const res = await k.people.ada
      .post('/api/v1/ai/providers', {
        provider: 'openai-compatible',
        label: 'Team server',
        apiKey: 'bad-key-0000',
        baseUrl: llm.url,
      })
      .expect(422);
    expect(res.body.error).toMatchObject({ code: 'KEY_INVALID_KEY' });
    expect(res.body.error.message).toContain('didn’t accept this key');
    expect(await k.db.aiProviderConfig.count()).toBe(0);
  });

  it('refuses addresses that are not HTTP(S) and providers it does not know', async () => {
    await k.people.ada
      .post('/api/v1/ai/providers', {
        provider: 'openai-compatible',
        label: 'x',
        baseUrl: 'ftp://example.com',
      })
      .expect(400);
    await k.people.ada
      .post('/api/v1/ai/providers', { provider: 'mystery', label: 'x', apiKey: SECRET })
      .expect(400);
    await k.people.ada
      .post('/api/v1/ai/providers', { provider: 'openai-compatible', label: 'x' })
      .expect(400);
  });

  it('tests a working key, stores it encrypted and never shows it again', async () => {
    const res = await k.people.ada
      .post('/api/v1/ai/providers', {
        provider: 'openai-compatible',
        label: 'Team server',
        apiKey: SECRET,
        baseUrl: `${llm.url}/`,
      })
      .expect(201);
    keyId = res.body.id;
    expect(res.body).toMatchObject({
      provider: 'openai-compatible',
      providerLabel: 'OpenAI-compatible server',
      label: 'Team server',
      keyLast4: 'WXYZ',
      baseUrl: llm.url,
      models: ['stand-in-large', 'stand-in-small'],
      lastError: null,
    });
    expect(res.body.verifiedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(SECRET.slice(0, 20));

    const row = await k.db.aiProviderConfig.findUniqueOrThrow({ where: { id: keyId } });
    expect(row.keyWrapper).toMatch(/^local:/);
    for (const blob of [row.encryptedKey!, row.wrappedDek!]) {
      expect(Buffer.from(blob).toString('latin1')).not.toContain(SECRET.slice(0, 20));
    }
    // The stand-in saw the real key: the vault opened what it sealed.
    expect(llm.received.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);

    const list = await k.people.ada.get('/api/v1/ai/providers').expect(200);
    expect(list.body.canStoreKeys).toBe(true);
    expect(list.body.keys).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(SECRET.slice(0, 20));
    expect(list.body.providers.map((p: { id: string }) => p.id)).toEqual([
      'anthropic',
      'openai',
      'google',
      'openai-compatible',
    ]);
    const audit = await k.db.auditLog.findFirstOrThrow({ where: { action: 'ai.key_added' } });
    expect(JSON.stringify(audit.meta)).not.toContain(SECRET.slice(0, 20));
  });

  it("lists the key's models in the catalog, but nobody can pick them until BYOK is allowed", async () => {
    const catalog = await k.people.ada.get('/api/v1/ai/catalog').expect(200);
    expect(catalog.body.models.map((m: { ref: string }) => m.ref)).toEqual([
      PRIVATE_REF,
      ref('stand-in-large'),
      ref('stand-in-small'),
    ]);
    expect(catalog.body.models[1]).toMatchObject({
      mode: 'BYOK',
      routeLabel: 'Your server · your API key',
      keyLabel: 'Team server',
      dataLocation: 'THIRD_PARTY',
      allowed: false,
      enabled: true,
      readsConfidential: false,
      readsRestricted: false,
    });
    const models = await k.people.priya.get('/api/v1/ai/models').expect(200);
    expect(models.body.models).toHaveLength(1);
  });

  it('checks a new policy against what exists', async () => {
    const put = (body: object) => k.people.ada.put('/api/v1/ai/policy', body);
    expect((await put({ allowedModes: [] }).expect(400)).body.error.code).toBe('NO_MODE');
    expect((await put({ defaultMode: 'BYOK' }).expect(400)).body.error.code).toBe(
      'DEFAULT_NOT_ALLOWED',
    );
    expect((await put({ allowedModes: ['PRIVATE', 'MANAGED'] }).expect(409)).body.error.code).toBe(
      'MODE_UNAVAILABLE',
    );
    expect((await put({ confidentialModes: ['BYOK'] }).expect(400)).body.error.code).toBe(
      'CONFIDENTIAL_NOT_ALLOWED',
    );
    expect(
      (
        await put({
          allowedModes: ['PRIVATE', 'BYOK'],
          defaultMode: 'PRIVATE',
          defaultModel: ref('stand-in-large'),
        }).expect(400)
      ).body.error.code,
    ).toBe('DEFAULT_MODEL_MODE');
    expect((await put({ defaultModel: 'byok:nope:model' }).expect(404)).body.error.code).toBe(
      'MODEL_NOT_FOUND',
    );
    expect(await actions()).toEqual(['ai.key_added']);
  });

  it('makes a BYOK model the default once BYOK is allowed', async () => {
    const res = await k.people.ada
      .put('/api/v1/ai/policy', {
        allowedModes: ['PRIVATE', 'BYOK'],
        defaultMode: 'BYOK',
        defaultModel: ref('stand-in-small'),
        confidentialModes: ['BYOK'],
      })
      .expect(200);
    expect(res.body.policy).toMatchObject({
      allowedModes: ['PRIVATE', 'BYOK'],
      defaultMode: 'BYOK',
      confidentialModes: ['BYOK'],
    });
    expect(res.body.effectiveDefault).toBe(ref('stand-in-small'));
    const models = await k.people.priya.get('/api/v1/ai/models').expect(200);
    expect(models.body.defaultRef).toBe(ref('stand-in-small'));
    expect(models.body.models).toHaveLength(3);
    const byok = models.body.models.find((m: { mode: string }) => m.mode === 'BYOK');
    // Confidential now goes to BYOK; Restricted never does, whatever the policy says.
    expect(byok).toMatchObject({ readsConfidential: true, readsRestricted: false });
    expect(await actions()).toEqual(['ai.key_added', 'ai.policy_changed']);
  });

  it("won't turn off the default model, and turns others off and on", async () => {
    const path = (model: string) => `/api/v1/ai/catalog/${encodeURIComponent(ref(model))}`;
    expect(
      (await k.people.ada.put(path('stand-in-small'), { enabled: false }).expect(409)).body.error
        .code,
    ).toBe('MODEL_IS_DEFAULT');
    const off = await k.people.ada.put(path('stand-in-large'), { enabled: false }).expect(200);
    expect(off.body).toMatchObject({ enabled: false });
    const models = await k.people.priya.get('/api/v1/ai/models').expect(200);
    expect(models.body.models.map((m: { ref: string }) => m.ref)).not.toContain(
      ref('stand-in-large'),
    );
    await k.people.tunde.put(path('stand-in-large'), { enabled: true }).expect(403);
    await k.people.ada.put(path('stand-in-large'), { enabled: true }).expect(200);
    expect(await actions()).toEqual([
      'ai.key_added',
      'ai.policy_changed',
      'ai.model_toggled',
      'ai.model_toggled',
    ]);
  });

  it('renames a key, and keeps the old key when a replacement fails', async () => {
    await k.people.ada.patch(`/api/v1/ai/providers/${keyId}`, { label: 'Ops server' }).expect(200);
    const res = await k.people.ada
      .patch(`/api/v1/ai/providers/${keyId}`, { apiKey: 'bad-key-0000' })
      .expect(422);
    expect(res.body.error.code).toBe('KEY_INVALID_KEY');
    const retest = await k.people.ada.post(`/api/v1/ai/providers/${keyId}/test`).expect(200);
    expect(retest.body).toMatchObject({ label: 'Ops server', keyLast4: 'WXYZ', lastError: null });
    expect(llm.received.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("keeps one workspace's keys away from another", async () => {
    const other = new Person(k.t, 'someone@elsewhere.example');
    await other.signIn();
    await other.post('/api/v1/workspaces', { name: 'Elsewhere' }).expect(201);
    expect((await other.get('/api/v1/ai/providers').expect(200)).body.keys).toEqual([]);
    expect((await other.get('/api/v1/ai/catalog').expect(200)).body.models).toHaveLength(1);
    await other.patch(`/api/v1/ai/providers/${keyId}`, { label: 'Mine now' }).expect(404);
    await other.post(`/api/v1/ai/providers/${keyId}/test`).expect(404);
    await other.delete(`/api/v1/ai/providers/${keyId}`).expect(404);
    // A copied ciphertext doesn't open in another workspace either (the workspace is the AAD).
    const row = await k.db.aiProviderConfig.findUniqueOrThrow({ where: { id: keyId } });
    const vault = k.t.app.get(AiSettingsService).vault;
    await expect(
      vault.open(
        {
          encryptedKey: row.encryptedKey!,
          wrappedDek: row.wrappedDek!,
          keyWrapper: row.keyWrapper!,
        },
        'another-workspace',
      ),
    ).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('removes a key, its models and the default that named it', async () => {
    await k.people.tunde.delete(`/api/v1/ai/providers/${keyId}`).expect(403);
    await k.people.ada.delete(`/api/v1/ai/providers/${keyId}`).expect(204);
    const res = await k.people.ada.get('/api/v1/ai/policy').expect(200);
    expect(res.body.policy.defaultModel).toBeNull();
    // BYOK stays the default mode but has no models now, so Ask has no default to use.
    expect(res.body.effectiveDefault).toBeNull();
    expect(await k.db.aiProviderConfig.count()).toBe(0);
    expect((await actions()).at(-1)).toBe('ai.key_removed');
  });

  it('refuses to store keys when the server has no master key', async () => {
    const settings = k.t.app.get(AiSettingsService);
    const vault = settings.vault;
    (settings as { vault: typeof vault }).vault = keyVaultFrom({});
    try {
      const res = await k.people.ada
        .post('/api/v1/ai/providers', {
          provider: 'openai-compatible',
          label: 'Team server',
          apiKey: SECRET,
          baseUrl: llm.url,
        })
        .expect(409);
      expect(res.body.error.code).toBe('NO_MASTER_KEY');
      expect((await k.people.ada.get('/api/v1/ai/providers')).body.canStoreKeys).toBe(false);
    } finally {
      (settings as { vault: typeof vault }).vault = vault;
    }
  });

  it('shows admins the embedding indexes and how much of this workspace each covers', async () => {
    await k.people.tunde.get('/api/v1/ai/embeddings/indexes').expect(403);
    await k.people.priya.get('/api/v1/ai/embeddings/indexes').expect(403);
    await k.seed({ key: 'indexed', title: 'Indexed memo', texts: ['runway', 'hiring'] });
    const res = await k.people.ada.get('/api/v1/ai/embeddings/indexes').expect(200);
    expect(res.body.configured).toEqual(expect.any(String));
    expect(res.body.indexes).toEqual([
      { model: 'test:concepts', dims: 68, status: 'READY', serving: true, embedded: 2, total: 2 },
    ]);
  });
});
