import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleCalendar } from '../../src/notetaker/calendars.js';
import { BotsService } from '../../src/notetaker/bots.service.js';
import { CalendarService, parseEventKey } from '../../src/notetaker/calendar.service.js';
import { NotetakerBots } from '../../src/notetaker/bot-registry.js';
import type { StandInBot } from '../../src/notetaker/bots.js';
import { signBotToken, signWebhook } from '../../src/notetaker/signing.js';
import { LiveService } from '../../src/live/live.service.js';
import { APP_URL, withoutStorage } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';
import { StandInTranscriber } from './stand-in-transcriber.js';

const SECRET = 'a-meeting-bot-secret-for-the-tests-0123456789';
const ENV = {
  MEETING_BOT: 'sample',
  MEETING_BOT_SECRET: SECRET,
  AI_KEYS_MASTER: randomBytes(32).toString('base64'),
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
};

/** Google, answered here: one call with a Meet link starting in an hour, one without a link. */
function stubGoogle() {
  const asked: string[] = [];
  const hour = 3600_000;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = String(init?.body ?? '');
      if (body.includes('code=bad')) return json({ error: 'invalid_grant' }, 400);
      return json({
        access_token: 'access',
        refresh_token: 'google-refresh-token',
        id_token: `x.${Buffer.from(JSON.stringify({ email: 'tunde@kestrel.example' })).toString('base64url')}.y`,
        scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly',
      });
    }
    if (url.startsWith('https://oauth2.googleapis.com/revoke')) return json({});
    if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
      const now = Date.now();
      return json({
        items: [
          {
            id: 'g-board',
            summary: 'Board prep',
            start: { dateTime: new Date(now + hour).toISOString() },
            end: { dateTime: new Date(now + 2 * hour).toISOString() },
            hangoutLink: 'https://meet.google.com/brd-prep-now',
          },
          {
            id: 'g-lunch',
            summary: 'Lunch',
            start: { dateTime: new Date(now + 3 * hour).toISOString() },
            end: { dateTime: new Date(now + 4 * hour).toISOString() },
          },
        ],
      });
    }
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  return { doFetch, asked };
}

async function until(check: () => Promise<boolean> | boolean, ms = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Phase 7, M6: calendars and the notetaker. Tunde and Kofi are members, Priya a viewer. */
describe.skipIf(withoutStorage)('the notetaker (calendars, bots, webhook)', () => {
  const k = new Kestrel('notetaker.example');
  const transcriber = new StandInTranscriber();
  const google = stubGoogle();
  let bots: BotsService;
  let live: LiveService;

  beforeAll(async () => {
    await transcriber.start();
    Object.assign(process.env, ENV, { TRANSCRIBER_URL: transcriber.url });
    await k.start();
    k.t.app
      .get(CalendarService)
      .useProvider(
        new GoogleCalendar({ id: 'google-client', secret: 'google-secret' }, google.doFetch),
      );
    bots = k.t.app.get(BotsService);
    live = k.t.app.get(LiveService);
  });

  afterAll(async () => {
    await k.stop();
    await transcriber.stop();
    for (const name of Object.keys(ENV)) delete process.env[name];
  });

  const auditActions = async () =>
    (
      await k.db.auditLog.findMany({
        where: { workspaceId: k.workspaceId },
        orderBy: { at: 'asc' },
        select: { action: true },
      })
    ).map((a) => a.action);

  const events = async (who: Who) =>
    (await k.people[who].get('/api/v1/calendar/events').expect(200)).body as {
      items: Array<{
        id: string;
        title: string;
        provider: string;
        startsAt: string;
        platform: string | null;
        unavailable: string | null;
        bot: {
          status: string;
          error: string | null;
          joinAt: string;
          liveSessionId: string | null;
        } | null;
      }>;
      problems: unknown[];
    };

  it('is for members: viewers are refused, admins can manage the notetaker', async () => {
    await k.people.priya.get('/api/v1/calendar').expect(403);
    await k.people.priya.post('/api/v1/calendar/connect/sample').expect(403);
    const status = (await k.people.tunde.get('/api/v1/calendar').expect(200)).body;
    expect(status).toMatchObject({
      providers: [
        { id: 'google', label: 'Google Calendar', available: true, isMock: false },
        { id: 'microsoft', available: false },
        { id: 'sample', label: 'Sample calendar', available: true, isMock: true },
      ],
      connections: [],
      notetaker: {
        name: 'Sotto Notetaker',
        enabled: true,
        available: true,
        isMock: true,
        platforms: ['meet', 'zoom', 'teams'],
      },
      canManageNotetaker: false,
    });
    expect((await k.people.ada.get('/api/v1/calendar').expect(200)).body.canManageNotetaker).toBe(
      true,
    );
    // A calendar this server doesn't offer, or doesn't know.
    const microsoft = await k.people.tunde.post('/api/v1/calendar/connect/microsoft').expect(404);
    expect(microsoft.body.error.code).toBe('CALENDAR_UNAVAILABLE');
    await k.people.tunde.post('/api/v1/calendar/connect/outlook').expect(400);
  });

  it('connects the sample calendar at once and lists its calls, labelled', async () => {
    const res = await k.people.tunde.post('/api/v1/calendar/connect/sample').expect(200);
    expect(res.body).toMatchObject({
      url: null,
      connection: { provider: 'sample', label: 'Sample calendar', autoJoin: false, isMock: true },
    });
    const list = await events('tunde');
    expect(list.problems).toEqual([]);
    expect(list.items.every((e) => e.provider === 'sample')).toBe(true);
    expect(list.items.some((e) => e.title === 'Quick sync')).toBe(true);
    const focus = list.items.find((e) => e.title === 'Focus time' && e.unavailable !== 'ended');
    expect(focus?.unavailable).toBe('no_link');
    // Kofi has no calendar of his own: Tunde's calls aren't his.
    expect((await events('kofi')).items).toEqual([]);
    expect(await auditActions()).toContain('calendar.connected');
  });

  it('connects Google through a single-use state bound to the person who started it', async () => {
    const start = await k.people.tunde.post('/api/v1/calendar/connect/google').expect(200);
    const url = new URL(start.body.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/v1/calendar/callback/google`);
    const state = url.searchParams.get('state')!;

    // Someone else coming back with it: refused, and the state is spent.
    const stolen = await k.people.kofi
      .get(`/api/v1/calendar/callback/google?code=good&state=${state}`)
      .expect(303);
    expect(stolen.headers.location).toBe(`${APP_URL}/meetings/calendar?calendar_error=expired`);
    const late = await k.people.tunde
      .get(`/api/v1/calendar/callback/google?code=good&state=${state}`)
      .expect(303);
    expect(late.headers.location).toContain('calendar_error=expired');

    // Said no on Google's page; a code Google won't take.
    const declined = new URL(
      (await k.people.tunde.post('/api/v1/calendar/connect/google').expect(200)).body.url,
    ).searchParams.get('state');
    expect(
      (
        await k.people.tunde
          .get(`/api/v1/calendar/callback/google?error=access_denied&state=${declined}`)
          .expect(303)
      ).headers.location,
    ).toContain('calendar_error=declined');
    const bad = new URL(
      (await k.people.tunde.post('/api/v1/calendar/connect/google').expect(200)).body.url,
    ).searchParams.get('state');
    expect(
      (
        await k.people.tunde
          .get(`/api/v1/calendar/callback/google?code=bad&state=${bad}`)
          .expect(303)
      ).headers.location,
    ).toContain('calendar_error=token_revoked');

    // The real thing.
    const fresh = new URL(
      (await k.people.tunde.post('/api/v1/calendar/connect/google').expect(200)).body.url,
    ).searchParams.get('state');
    const done = await k.people.tunde
      .get(`/api/v1/calendar/callback/google?code=good&state=${fresh}`)
      .expect(303);
    expect(done.headers.location).toBe(`${APP_URL}/meetings/calendar?connected=google`);

    // The refresh token is sealed, never stored as it came.
    const row = await k.db.calendarConnection.findFirstOrThrow({ where: { provider: 'google' } });
    expect(row.accountEmail).toBe('tunde@kestrel.example');
    expect(Buffer.from(row.encryptedRefreshToken!).toString('utf8')).not.toContain(
      'google-refresh-token',
    );
    const list = await events('tunde');
    const board = list.items.find((e) => e.title === 'Board prep')!;
    expect(board).toMatchObject({
      provider: 'google',
      platform: 'meet',
      unavailable: null,
      bot: null,
    });
    expect(list.items.find((e) => e.title === 'Lunch')?.unavailable).toBe('no_link');
  });

  it('sends the notetaker to one call or keeps it out; only your own calls, with a link', async () => {
    const board = (await events('tunde')).items.find((e) => e.title === 'Board prep')!;
    const sent = await k.people.tunde
      .put(`/api/v1/calendar/events/${board.id}/bot`, { send: true })
      .expect(200);
    expect(sent.body.bot).toMatchObject({ status: 'scheduled', error: null, liveSessionId: null });
    expect(Date.parse(sent.body.bot.joinAt)).toBe(Date.parse(board.startsAt) - 60_000);

    // Kofi can't reach Tunde's call; Priya can't send bots at all.
    await k.people.kofi.put(`/api/v1/calendar/events/${board.id}/bot`, { send: true }).expect(404);
    await k.people.priya.put(`/api/v1/calendar/events/${board.id}/bot`, { send: true }).expect(403);
    await k.people.tunde
      .put('/api/v1/calendar/events/not-an-event/bot', { send: true })
      .expect(404);
    const lunch = (await events('tunde')).items.find((e) => e.title === 'Lunch')!;
    const noLink = await k.people.tunde
      .put(`/api/v1/calendar/events/${lunch.id}/bot`, { send: true })
      .expect(409);
    expect(noLink.body.error.code).toBe('NO_MEETING_LINK');

    const skipped = await k.people.tunde
      .put(`/api/v1/calendar/events/${board.id}/bot`, { send: false })
      .expect(200);
    expect(skipped.body.bot.status).toBe('skipped');
    const actions = await auditActions();
    expect(actions).toContain('bot.sent');
    expect(actions).toContain('bot.skipped');
    expect(parseEventKey(board.id)?.eventId).toBe('g-board');
  });

  it('auto-joins every upcoming call with a link, but not one skipped by hand', async () => {
    const status = await k.people.tunde
      .patch('/api/v1/calendar/settings', { autoJoin: true })
      .expect(200);
    expect(status.body.connections.every((c: { autoJoin: boolean }) => c.autoJoin)).toBe(true);
    const list = (await events('tunde')).items;
    expect(list.find((e) => e.title === 'Board prep')?.bot?.status).toBe('skipped');
    const upcoming = list.filter(
      (e) => e.platform && Date.parse(e.startsAt) > Date.now() && e.title !== 'Board prep',
    );
    expect(upcoming.length).toBeGreaterThan(0);
    expect(upcoming.every((e) => e.bot?.status === 'scheduled')).toBe(true);
    expect(await auditActions()).toContain('calendar.auto_join_changed');
    await k.people.tunde.patch('/api/v1/calendar/settings', { autoJoin: false }).expect(200);
  });

  it('runs the stand-in bot through the real path: let in, recorded live, saved when it leaves', async () => {
    const quick = (await events('tunde')).items.find(
      (e) => e.title === 'Quick sync' && e.unavailable === null && e.bot?.status !== 'done',
    )!;
    await k.people.tunde.put(`/api/v1/calendar/events/${quick.id}/bot`, { send: true }).expect(200);
    const parsed = parseEventKey(quick.id)!;
    const assignment = () =>
      k.db.botAssignment.findUniqueOrThrow({
        where: {
          connectionId_eventId: { connectionId: parsed.connectionId, eventId: parsed.eventId },
        },
      });
    // Due at the call's start (a minute early): the scheduler launches it once.
    await bots.tick(new Date(Date.parse(quick.startsAt)));
    await until(async () => (await assignment()).status === 'IN_CALL');
    const inCall = await assignment();
    expect(inCall.providerRef).toMatch(/^sample:/);
    const session = (
      await k.people.tunde.get(`/api/v1/live-sessions/${inCall.liveSessionId}`).expect(200)
    ).body;
    expect(session).toMatchObject({
      source: 'bot',
      inputs: ['call'],
      canControl: true,
      file: { source: 'bot', status: 'uploading', title: 'Quick sync' },
    });
    // A capture is its sender's until it's saved, bot or not.
    await k.people.kofi.get(`/api/v1/live-sessions/${inCall.liveSessionId}`).expect(404);

    // The stand-in leaves after its short test run; the meeting is saved like a Listen capture.
    await until(async () => (await assignment()).status === 'DONE', 10_000);
    await until(() => (k.t.app.get(NotetakerBots).provider as StandInBot).running === 0);
    const file = await k.db.file.findFirstOrThrow({
      where: { liveSession: { id: inCall.liveSessionId! } },
    });
    expect(file).toMatchObject({ source: 'BOT', status: 'UPLOADED', title: 'Quick sync' });
    expect(file.durationMs).toBeGreaterThan(0);
    await live.settled(inCall.liveSessionId!);
    expect(transcriber.transcribed).toBeGreaterThan(0);
    expect(k.t.queue.sent.some((m) => m.message.fileId === file.id)).toBe(true);
    expect((await events('tunde')).items.find((e) => e.id === quick.id)?.bot).toMatchObject({
      status: 'done',
      liveSessionId: inCall.liveSessionId,
    });
  });

  describe('a real bot: the signed webhook and its own token on the Listen chunk API', () => {
    let assignmentId = '';
    const server = () => request(k.t.app.getHttpServer());
    const report = (body: object, opts: { secret?: string; at?: number } = {}) => {
      const raw = JSON.stringify(body);
      const ts = Math.floor((opts.at ?? Date.now()) / 1000);
      return server()
        .post('/api/v1/webhooks/meeting-bot')
        .set('content-type', 'application/json')
        .set('x-sotto-timestamp', String(ts))
        .set('x-sotto-signature', signWebhook(opts.secret ?? SECRET, ts, raw))
        .send(raw);
    };
    const audio = (sessionId: string, seq: number, token: string) =>
      server()
        .post(`/api/v1/live-sessions/${sessionId}/audio?seq=${seq}`)
        .set('authorization', `Bot ${token}`)
        .set('content-type', 'application/octet-stream')
        .send(Buffer.alloc(4_000 * 32));

    beforeAll(async () => {
      const connection = await k.db.calendarConnection.findFirstOrThrow({
        where: { provider: 'google' },
      });
      assignmentId = (
        await k.db.botAssignment.create({
          data: {
            workspaceId: k.workspaceId,
            connectionId: connection.id,
            eventId: 'g-real-bot',
            title: 'Partner review',
            meetingUrl: 'https://meet.google.com/prt-revw-now',
            platform: 'MEET',
            status: 'JOINING',
            providerRef: 'meet:test-run',
            joinAt: new Date(),
            endsAt: new Date(Date.now() + 3600_000),
          },
        })
      ).id;
    });

    it('refuses reports that aren’t signed with the secret, or are stale', async () => {
      const body = { assignmentId, event: 'in_call' };
      await server()
        .post('/api/v1/webhooks/meeting-bot')
        .set('content-type', 'application/json')
        .send(JSON.stringify(body))
        .expect(401);
      await report(body, { secret: 'another-secret-entirely-0123456789abcdef' }).expect(401);
      await report(body, { at: Date.now() - 10 * 60_000 }).expect(401);
      expect(
        (await k.db.botAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status,
      ).toBe('JOINING');
    });

    it('starts a live meeting when the bot is let in, and takes its audio by token alone', async () => {
      const res = await report({ assignmentId, event: 'in_call' }).expect(200);
      const sessionId = res.body.liveSessionId as string;
      expect(sessionId).toBeTruthy();
      // Saying so twice changes nothing.
      expect(
        (await report({ assignmentId, event: 'in_call' }).expect(200)).body.liveSessionId,
      ).toBe(sessionId);
      const token = signBotToken(SECRET, assignmentId, new Date(Date.now() + 3600_000));
      // No cookie, no CSRF token: the bot's own token, for this session only.
      expect((await audio(sessionId, 0, token).expect(200)).body).toMatchObject({
        accepted: true,
        nextSeq: 1,
      });
      await audio(sessionId, 1, token).expect(200);

      const other = (
        await live.startForBot({ workspaceId: k.workspaceId, userId: k.ids.tunde, title: 'Other' })
      ).id;
      expect((await audio(other, 0, token).expect(401)).body.error.code).toBe('BOT_TOKEN_INVALID');
      await audio(
        sessionId,
        2,
        signBotToken(SECRET, 'ba_someone_else', new Date(Date.now() + 3600_000)),
      ).expect(401);
      await audio(
        sessionId,
        2,
        signBotToken(SECRET, assignmentId, new Date(Date.now() - 1_000)),
      ).expect(401);
      await audio(sessionId, 2, 'not-a-token').expect(401);
      // The token opens nothing else.
      await server().get('/api/v1/calendar').set('authorization', `Bot ${token}`).expect(401);
      await live.endBySystem(k.workspaceId, other);

      // Gone from the call: the meeting is saved and the token stops working.
      await report({ assignmentId, event: 'left', reason: 'meeting_ended' }).expect(200);
      const done = await k.db.botAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(done).toMatchObject({ status: 'DONE', liveSessionId: sessionId });
      const session = await k.db.liveSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.status).toBe('ENDED');
      await audio(sessionId, 2, token).expect(401);
    });

    it('records why a bot never got in', async () => {
      const connection = await k.db.calendarConnection.findFirstOrThrow({
        where: { provider: 'google' },
      });
      const waiting = await k.db.botAssignment.create({
        data: {
          workspaceId: k.workspaceId,
          connectionId: connection.id,
          eventId: 'g-not-admitted',
          title: 'Locked meeting',
          meetingUrl: 'https://meet.google.com/lck-meet-ing',
          platform: 'MEET',
          status: 'JOINING',
          joinAt: new Date(),
        },
      });
      await report({ assignmentId: waiting.id, event: 'left', reason: 'not_admitted' }).expect(200);
      expect(
        await k.db.botAssignment.findUniqueOrThrow({ where: { id: waiting.id } }),
      ).toMatchObject({
        status: 'FAILED',
        error: 'not_admitted',
        liveSessionId: null,
      });
    });
  });

  it('lets admins turn the notetaker off: calls not started are skipped, bots in calls leave', async () => {
    const connection = await k.db.calendarConnection.findFirstOrThrow({
      where: { provider: 'google' },
    });
    const scheduled = await k.db.botAssignment.create({
      data: {
        workspaceId: k.workspaceId,
        connectionId: connection.id,
        eventId: 'g-later',
        title: 'Later',
        meetingUrl: 'https://meet.google.com/ltr-meet-ing',
        platform: 'MEET',
        status: 'SCHEDULED',
        joinAt: new Date(Date.now() + 3600_000),
      },
    });
    const inCall = await k.db.botAssignment.create({
      data: {
        workspaceId: k.workspaceId,
        connectionId: connection.id,
        eventId: 'g-now',
        title: 'Now',
        meetingUrl: 'https://meet.google.com/now-meet-ing',
        platform: 'MEET',
        status: 'JOINING',
        joinAt: new Date(),
      },
    });
    const live1 = (await bots.report({ assignmentId: inCall.id, event: 'in_call' })).liveSessionId!;
    await live.chunk(k.viewer('tunde'), live1, 0, Buffer.alloc(4_000 * 32));

    await k.people.tunde.patch('/api/v1/workspace', { meetingBots: false }).expect(403);
    const off = await k.people.ada.patch('/api/v1/workspace', { meetingBots: false }).expect(200);
    expect(off.body).toMatchObject({ meetingBots: false, name: 'Kestrel' });
    expect(
      await k.db.botAssignment.findUniqueOrThrow({ where: { id: scheduled.id } }),
    ).toMatchObject({
      status: 'SKIPPED',
      error: 'bots_off',
    });
    expect(await k.db.botAssignment.findUniqueOrThrow({ where: { id: inCall.id } })).toMatchObject({
      status: 'DONE',
      error: 'bots_off',
    });
    expect((await k.db.liveSession.findUniqueOrThrow({ where: { id: live1 } })).status).toBe(
      'ENDED',
    );

    const board = (await events('tunde')).items.find((e) => e.title === 'Board prep')!;
    expect(board.unavailable).toBe('bots_off');
    const refused = await k.people.tunde
      .put(`/api/v1/calendar/events/${board.id}/bot`, { send: true })
      .expect(403);
    expect(refused.body.error.code).toBe('NOTETAKER_OFF');
    expect((await k.people.tunde.get('/api/v1/calendar').expect(200)).body.notetaker.enabled).toBe(
      false,
    );
    expect(await auditActions()).toContain('workspace.bots_changed');

    await k.people.ada.patch('/api/v1/workspace', { meetingBots: true }).expect(200);
    // Renaming still works on its own, and an empty change is refused.
    await k.people.ada.patch('/api/v1/workspace', { name: 'Kestrel' }).expect(200);
    await k.people.ada.patch('/api/v1/workspace', {}).expect(400);
  });

  it('disconnects your own calendar only; its calls go with it', async () => {
    const google = (await k.people.tunde.get('/api/v1/calendar').expect(200)).body.connections.find(
      (c: { provider: string }) => c.provider === 'google',
    );
    await k.people.kofi.delete(`/api/v1/calendar/connections/${google.id}`).expect(404);
    await k.people.tunde.delete(`/api/v1/calendar/connections/${google.id}`).expect(204);
    expect(google.label).toBe('Google Calendar');
    const list = await events('tunde');
    expect(list.items.every((e) => e.provider !== 'google')).toBe(true);
    expect(await k.db.botAssignment.count({ where: { connectionId: google.id } })).toBe(0);
    expect(stubGoogleRevoked()).toBe(true);
    expect(await auditActions()).toContain('calendar.disconnected');
  });

  /** Disconnecting told Google to forget the token. */
  function stubGoogleRevoked(): boolean {
    return google.asked.some((a) => a.startsWith('POST https://oauth2.googleapis.com/revoke'));
  }
});
