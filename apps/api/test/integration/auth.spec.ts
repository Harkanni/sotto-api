import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, Person, bootApp, withDatabase, type TestApp } from './harness.js';

describe.skipIf(withDatabase)('sign-in and the session', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await bootApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  it('refuses /me without a session', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/me').expect(401);
    expect(res.body.error).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(res.body.error.requestId).toMatch(/^req_/);
  });

  it('lists the sign-in methods this server offers', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/sign-in-methods').expect(200);
    // Mail is captured in tests (so links "send"), but SMTP_URL is unset and no OAuth apps exist.
    expect(res.body).toEqual({ magicLink: false, passkey: true, google: false, microsoft: false });
  });

  it('signs a new person up with a magic link, then sends them to onboarding', async () => {
    const ada = new Person(t, 'Ada@Kestrel.example');
    const verified = await ada.signIn();
    expect(verified.headers.location).toBe(`${APP_URL}/welcome`);
    expect(String(verified.headers['set-cookie'])).toMatch(/sotto\.session_token=.*HttpOnly/);

    const email = t.mailer.sent.at(-1)!;
    expect(email.subject).toBe('Sign in to Sotto');
    expect(email.html).toContain('Sign in');

    const me = await ada.get('/api/v1/me').expect(200);
    expect(me.body).toMatchObject({
      user: { email: 'ada@kestrel.example', name: '', handedness: 'right' },
      workspace: null,
    });
    expect(me.body.csrfToken).toEqual(expect.any(String));
  });

  it('sends a returning person to the page they asked for', async () => {
    const ada = new Person(t, 'ada@kestrel.example');
    const verified = await ada.signIn();
    expect(verified.headers.location).toBe(`${APP_URL}/home`);
  });

  it('uses each magic link once', async () => {
    const tunde = new Person(t, 'tunde@kestrel.example');
    await tunde.signIn();
    const reused = await request(t.app.getHttpServer())
      .get(t.mailer.lastLink('tunde@kestrel.example'))
      .expect(302);
    expect(reused.headers.location).not.toBe(`${APP_URL}/home`);
    expect(reused.headers['set-cookie']).toBeUndefined();
  });

  it('needs the CSRF token on writes', async () => {
    const sofia = new Person(t, 'sofia@kestrel.example');
    await sofia.signIn();

    const missing = await sofia.agent
      .patch('/api/v1/me')
      .set('sec-fetch-site', 'same-origin')
      .send({ name: 'Sofia Marin' })
      .expect(403);
    expect(missing.body.error.code).toBe('CSRF_TOKEN_INVALID');

    const other = new Person(t, 'priya@kestrel.example');
    await other.signIn();
    await sofia.agent
      .patch('/api/v1/me')
      .set('sec-fetch-site', 'same-origin')
      .set('x-csrf-token', other.csrf)
      .send({ name: 'Sofia Marin' })
      .expect(403);

    const ok = await sofia.patch('/api/v1/me', { name: 'Sofia Marin', handedness: 'left' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ name: 'Sofia Marin', handedness: 'left' });
  });

  it('refuses writes sent from another site, token or not', async () => {
    const jonas = new Person(t, 'jonas@kestrel.example');
    await jonas.signIn();
    await jonas.agent
      .patch('/api/v1/me')
      .set('sec-fetch-site', 'cross-site')
      .set('origin', 'https://evil.example')
      .set('x-csrf-token', jonas.csrf)
      .send({ name: 'Mallory' })
      .expect(403);
  });

  it('validates input and says what to fix', async () => {
    const kwame = new Person(t, 'kwame@kestrel.example');
    await kwame.signIn();
    const res = await kwame.patch('/api/v1/me', { name: '   ' }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(res.body.error.message).toContain('Enter your name.');
  });

  it('signs out', async () => {
    const amaka = new Person(t, 'amaka@kestrel.example');
    await amaka.signIn();
    await amaka.agent.post('/api/auth/sign-out').set('origin', APP_URL).send({}).expect(200);
    await amaka.get('/api/v1/me').expect(401);
  });
});
