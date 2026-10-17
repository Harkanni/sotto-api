import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_TOLERANCE_MS,
  signBotToken,
  signWebhook,
  verifyBotToken,
  verifyWebhook,
} from '../src/notetaker/signing.js';
import {
  GoogleCalendar,
  MicrosoftCalendar,
  SampleCalendar,
  meetingLink,
} from '../src/notetaker/calendars.js';

const SECRET = 'a-test-secret-that-is-long-enough-1234';
const NOW = Date.parse('2026-10-17T09:00:00Z');

describe('bot tokens', () => {
  it('name one assignment until they expire', () => {
    const token = signBotToken(SECRET, 'ba_123', new Date(NOW + 60_000));
    expect(verifyBotToken(SECRET, token, NOW)).toEqual({ assignmentId: 'ba_123' });
    expect(verifyBotToken(SECRET, token, NOW + 60_000)).toBeNull();
  });

  it('refuse a forged, altered or foreign token', () => {
    const token = signBotToken(SECRET, 'ba_123', new Date(NOW + 60_000));
    const [, expires, signature] = token.split('.');
    expect(verifyBotToken(SECRET, `ba_999.${expires}.${signature}`, NOW)).toBeNull();
    expect(verifyBotToken(SECRET, `ba_123.${Number(expires) + 3600}.${signature}`, NOW)).toBeNull();
    expect(verifyBotToken('another-secret-entirely-1234567890', token, NOW)).toBeNull();
    expect(verifyBotToken(SECRET, 'not a token', NOW)).toBeNull();
    expect(verifyBotToken(SECRET, '', NOW)).toBeNull();
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ assignmentId: 'ba_123', event: 'in_call' });
  const ts = Math.floor(NOW / 1000);

  it('accept the exact body, signed within five minutes', () => {
    const signature = signWebhook(SECRET, ts, body);
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature }, body, NOW)).toBe(true);
    expect(
      verifyWebhook(
        SECRET,
        { timestamp: String(ts), signature },
        body,
        NOW + WEBHOOK_TOLERANCE_MS - 1_000,
      ),
    ).toBe(true);
  });

  it('refuse a changed body, an old or future timestamp, or a missing signature', () => {
    const signature = signWebhook(SECRET, ts, body);
    const tampered = body.replace('in_call', 'left');
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature }, tampered, NOW)).toBe(false);
    expect(
      verifyWebhook(
        SECRET,
        { timestamp: String(ts), signature },
        body,
        NOW + WEBHOOK_TOLERANCE_MS + 1_000,
      ),
    ).toBe(false);
    expect(
      verifyWebhook(SECRET, { timestamp: String(ts), signature }, body, NOW - 10 * 60_000),
    ).toBe(false);
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature: undefined }, body, NOW)).toBe(
      false,
    );
    expect(verifyWebhook(SECRET, { timestamp: 'soon', signature }, body, NOW)).toBe(false);
  });

  it('never accepts a bot token as a webhook signature, or the reverse', () => {
    const token = signBotToken(SECRET, 'ba_123', new Date(NOW + 60_000));
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature: token }, body, NOW)).toBe(
      false,
    );
    const signature = signWebhook(SECRET, ts, 'ba_123.1792234800');
    expect(verifyBotToken(SECRET, `ba_123.1792234800.${signature}`, NOW)).toBeNull();
  });
});

// ── Calendars ───────────────────────────────────────────────────────────────────────────────

/** A stub fetch: answers by URL prefix, records what was asked. */
function stubFetch(answers: Array<[string, number, unknown]>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = answers.find(([prefix]) => url.startsWith(prefix));
    if (!answer) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer[2]), {
      status: answer[1],
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { doFetch, calls };
}

const idToken = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

describe('meetingLink', () => {
  it('finds Meet, Zoom and Teams links, the first text first', () => {
    expect(meetingLink(['Join https://meet.google.com/abc-defg-hij now'])).toEqual({
      url: 'https://meet.google.com/abc-defg-hij',
      platform: 'MEET',
    });
    expect(meetingLink([null, 'https://acme.zoom.us/j/12345?pwd=x1'])?.platform).toBe('ZOOM');
    expect(
      meetingLink(['Room 4', 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_x%40thread'])
        ?.platform,
    ).toBe('TEAMS');
    expect(
      meetingLink(['https://meet.google.com/aaa-bbbb-ccc', 'https://zoom.us/j/1'])?.platform,
    ).toBe('MEET');
    expect(meetingLink(['Lunch at the usual place', undefined])).toBeNull();
    expect(meetingLink(['https://evil.example/meet.google.com/abc-defg-hij'])).toBeNull();
  });
});

describe('GoogleCalendar', () => {
  const client = { id: 'cid', secret: 'shh' };

  it('asks for read-only calendar access and a refresh token', () => {
    const url = new URL(
      new GoogleCalendar(client).authorizeUrl({ state: 's1', redirectUri: 'https://app/cb' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toContain('calendar.events.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
  });

  it('trades the code for a refresh token and the account’s address', async () => {
    const { doFetch, calls } = stubFetch([
      [
        'https://oauth2.googleapis.com/token',
        200,
        {
          access_token: 'at',
          refresh_token: 'rt',
          id_token: idToken({ email: 'ada@kestrel.example' }),
          scope: 'openid email https://www.googleapis.com/auth/calendar.events.readonly',
        },
      ],
    ]);
    const grant = await new GoogleCalendar(client, doFetch).exchange({
      code: 'c0de',
      redirectUri: 'https://app/cb',
    });
    expect(grant).toEqual({
      refreshToken: 'rt',
      accountEmail: 'ada@kestrel.example',
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly'],
    });
    expect(String(calls[0]!.init!.body)).toContain('grant_type=authorization_code');
  });

  it('lists timed events with their call links, skipping all-day and cancelled ones', async () => {
    const { doFetch, calls } = stubFetch([
      ['https://oauth2.googleapis.com/token', 200, { access_token: 'at' }],
      [
        'https://www.googleapis.com/calendar/v3/',
        200,
        {
          items: [
            {
              id: 'e1',
              summary: 'Design review',
              start: { dateTime: '2026-10-17T10:00:00+01:00' },
              end: { dateTime: '2026-10-17T10:30:00+01:00' },
              hangoutLink: 'https://meet.google.com/abc-defg-hij',
            },
            {
              id: 'e2',
              summary: 'Holiday',
              start: { date: '2026-10-18' },
              end: { date: '2026-10-19' },
            },
            {
              id: 'e3',
              status: 'cancelled',
              start: { dateTime: '2026-10-17T12:00:00Z' },
              end: { dateTime: '2026-10-17T13:00:00Z' },
            },
            {
              id: 'e4',
              start: { dateTime: '2026-10-17T14:00:00Z' },
              end: { dateTime: '2026-10-17T15:00:00Z' },
              description: 'Dial in: https://acme.zoom.us/j/99?pwd=a',
            },
          ],
        },
      ],
    ]);
    const { events } = await new GoogleCalendar(client, doFetch).events({
      refreshToken: 'rt',
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-18T00:00:00Z'),
    });
    expect(events.map((e) => [e.id, e.title, e.platform, e.startsAt.toISOString()])).toEqual([
      ['e1', 'Design review', 'MEET', '2026-10-17T09:00:00.000Z'],
      ['e4', '(No title)', 'ZOOM', '2026-10-17T14:00:00.000Z'],
    ]);
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe('Bearer at');
  });

  it('says plainly when access was taken away or Google is down', async () => {
    const revoked = stubFetch([
      ['https://oauth2.googleapis.com/token', 400, { error: 'invalid_grant' }],
    ]);
    await expect(
      new GoogleCalendar(client, revoked.doFetch).events({
        refreshToken: 'rt',
        from: new Date(),
        to: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    const down = stubFetch([]);
    await expect(
      new GoogleCalendar(client, down.doFetch).exchange({ code: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: 'unreachable' });
  });
});

describe('MicrosoftCalendar', () => {
  const client = { id: 'cid', secret: 'shh', tenant: 'common' };

  it('lists events in UTC and hands back the replaced refresh token', async () => {
    const { doFetch, calls } = stubFetch([
      [
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        200,
        { access_token: 'at', refresh_token: 'rt2' },
      ],
      [
        'https://graph.microsoft.com/v1.0/me/calendarView',
        200,
        {
          value: [
            {
              id: 'm1',
              subject: 'Partner check-in',
              start: { dateTime: '2026-10-17T13:00:00.0000000' },
              end: { dateTime: '2026-10-17T13:45:00.0000000' },
              onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3Ax' },
            },
            {
              id: 'm2',
              isAllDay: true,
              start: { dateTime: '2026-10-18T00:00:00.0000000' },
              end: { dateTime: '2026-10-19T00:00:00.0000000' },
            },
          ],
        },
      ],
    ]);
    const result = await new MicrosoftCalendar(client, doFetch).events({
      refreshToken: 'rt1',
      from: new Date('2026-10-17T00:00:00Z'),
      to: new Date('2026-10-18T00:00:00Z'),
    });
    expect(result.refreshToken).toBe('rt2');
    expect(result.events).toEqual([
      {
        id: 'm1',
        title: 'Partner check-in',
        startsAt: new Date('2026-10-17T13:00:00Z'),
        endsAt: new Date('2026-10-17T13:45:00Z'),
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/19%3Ax',
        platform: 'TEAMS',
      },
    ]);
    expect((calls[1]!.init!.headers as Record<string, string>).prefer).toContain('UTC');
  });

  it('takes the address from the id token when exchanging the code', async () => {
    const { doFetch } = stubFetch([
      [
        'https://login.microsoftonline.com/',
        200,
        {
          access_token: 'at',
          refresh_token: 'rt',
          id_token: idToken({ preferred_username: 'ada@kestrel.example' }),
        },
      ],
    ]);
    const grant = await new MicrosoftCalendar(client, doFetch).exchange({
      code: 'c',
      redirectUri: 'https://app/cb',
    });
    expect(grant.accountEmail).toBe('ada@kestrel.example');
  });
});

describe('SampleCalendar', () => {
  const now = Date.parse('2026-10-17T09:10:00Z');
  const sample = new SampleCalendar(() => now);

  it('has the same calls at the same times, with stable ids, and a quick sync coming up', async () => {
    const window = { refreshToken: 'sample', from: new Date(now), to: new Date(now + 86_400_000) };
    const first = (await sample.events(window)).events;
    const again = (await sample.events(window)).events;
    expect(again.map((e) => e.id)).toEqual(first.map((e) => e.id));
    expect(first[0]).toMatchObject({ title: 'Quick sync', platform: 'MEET' });
    expect(first[0]!.startsAt.toISOString()).toBe('2026-10-17T09:00:00.000Z'); // under way
    expect(first.find((e) => e.title === 'Design review')?.startsAt.toISOString()).toBe(
      '2026-10-17T09:30:00.000Z',
    );
    expect(first.find((e) => e.title === 'Focus time')?.meetingUrl).toBeNull();
    expect(first.filter((e) => e.title === 'Quick sync')).toHaveLength(3);
    const starts = first.map((e) => e.startsAt.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
