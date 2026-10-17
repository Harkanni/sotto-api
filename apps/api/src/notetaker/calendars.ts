import type { MeetPlatform } from '@sotto/db';

/**
 * Calendars the notetaker reads (ADR 0035). Google and Microsoft through the same OAuth apps as
 * sign-in, asking for read-only calendar access and offline access; `sample` is a labelled
 * stand-in calendar of made-up calls, until those apps exist. Calendars aren't AI, so they live
 * here rather than in packages/ai. `fetch` is injected, so tests stub the providers' HTTP.
 */

export type CalendarProviderId = 'google' | 'microsoft' | 'sample';

export interface CalendarEvent {
  /** The calendar's own id for the event. */
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** The call's link, when the event has one Sotto recognises. */
  meetingUrl: string | null;
  platform: MeetPlatform | null;
}

export interface CalendarGrant {
  refreshToken: string;
  accountEmail: string | null;
  scopes: string[];
}

export type CalendarErrorCode =
  /** The person (or their admin) took Sotto's access away; connect again. */
  | 'token_revoked'
  /** The provider didn't answer; try again later. */
  | 'unreachable'
  /** The provider refused the request (a bad code, a missing scope). */
  | 'refused';

export class CalendarError extends Error {
  constructor(
    readonly code: CalendarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

export interface CalendarProvider {
  readonly id: CalendarProviderId;
  /** "Google Calendar", "Outlook calendar", "Sample calendar". */
  readonly label: string;
  readonly isMock: boolean;
  /** Connecting sends the person to the provider's consent page first. */
  readonly needsConsent: boolean;
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  /** Trades the consent page's code for lasting access. */
  exchange(input: { code: string; redirectUri: string }): Promise<CalendarGrant>;
  /**
   * Timed events overlapping [from, to), soonest first (all-day and cancelled ones left out).
   * Microsoft replaces its refresh token as it's used: the new one comes back to be stored.
   */
  events(input: {
    refreshToken: string;
    from: Date;
    to: Date;
  }): Promise<{ events: CalendarEvent[]; refreshToken?: string }>;
  /** Tells the provider Sotto no longer needs access (best effort). */
  revoke(refreshToken: string): Promise<void>;
}

// ── Meeting links ───────────────────────────────────────────────────────────────────────────

const LINKS: ReadonlyArray<[MeetPlatform, RegExp]> = [
  ['MEET', /https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}\b/i],
  ['ZOOM', /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w)\/[\w/?=&.%-]+/i],
  ['TEAMS', /https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"'<>)]+/i],
];

/**
 * The first call link in `texts`, in order (the conference link first, then the location, then
 * the description), with the platform it belongs to.
 */
export function meetingLink(
  texts: ReadonlyArray<string | null | undefined>,
): { url: string; platform: MeetPlatform } | null {
  for (const text of texts) {
    if (!text) continue;
    for (const [platform, pattern] of LINKS) {
      const match = pattern.exec(text);
      if (match) return { url: match[0], platform };
    }
  }
  return null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────

type Fetch = typeof fetch;

/** Reads a JSON answer, turning the provider's refusals into CalendarErrors (never content). */
async function json<T>(
  doFetch: Fetch,
  url: string,
  init: RequestInit,
  provider: string,
): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new CalendarError('unreachable', `${provider} didn’t answer. Try again in a minute.`);
  }
  if (response.ok) return (await response.json()) as T;
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const error =
    typeof body?.error === 'string'
      ? body.error
      : ((body?.error as { code?: string } | undefined)?.code ?? '');
  if (error === 'invalid_grant' || response.status === 401) {
    throw new CalendarError(
      'token_revoked',
      `${provider} no longer lets Sotto read this calendar. Connect it again.`,
    );
  }
  if (response.status >= 500 || response.status === 429) {
    throw new CalendarError('unreachable', `${provider} didn’t answer. Try again in a minute.`);
  }
  throw new CalendarError('refused', `${provider} refused the request.`);
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams(fields).toString(),
});

/** The claims of an id token, which came straight from the provider over TLS. */
function claimsOf(idToken: string | undefined): Record<string, unknown> {
  const payload = idToken?.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

interface TokenAnswer {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

// ── Google ──────────────────────────────────────────────────────────────────────────────────

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  location?: string;
  description?: string;
}

export class GoogleCalendar implements CalendarProvider {
  readonly id = 'google' as const;
  readonly label = 'Google Calendar';
  readonly isMock = false;
  readonly needsConsent = true;

  constructor(
    private readonly client: { id: string; secret: string },
    private readonly doFetch: Fetch = fetch,
  ) {}

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.client.id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      // A refresh token, every time: the consent screen is shown again on purpose.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }) {
    const answer = await json<TokenAnswer>(
      this.doFetch,
      'https://oauth2.googleapis.com/token',
      form({
        code,
        client_id: this.client.id,
        client_secret: this.client.secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      'Google',
    );
    if (!answer.refresh_token) {
      throw new CalendarError('refused', 'Google didn’t grant lasting access. Connect again.');
    }
    const email = claimsOf(answer.id_token).email;
    return {
      refreshToken: answer.refresh_token,
      accountEmail: typeof email === 'string' ? email : null,
      scopes: (answer.scope ?? '').split(' ').filter(Boolean),
    };
  }

  private async accessToken(refreshToken: string): Promise<string> {
    const answer = await json<TokenAnswer>(
      this.doFetch,
      'https://oauth2.googleapis.com/token',
      form({
        refresh_token: refreshToken,
        client_id: this.client.id,
        client_secret: this.client.secret,
        grant_type: 'refresh_token',
      }),
      'Google',
    );
    return answer.access_token;
  }

  async events({ refreshToken, from, to }: { refreshToken: string; from: Date; to: Date }) {
    const token = await this.accessToken(refreshToken);
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
      fields:
        'items(id,status,summary,start,end,hangoutLink,conferenceData/entryPoints,location,description)',
    });
    const answer = await json<{ items?: GoogleEvent[] }>(
      this.doFetch,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      'Google',
    );
    const events: CalendarEvent[] = [];
    for (const item of answer.items ?? []) {
      // All-day events (a date, no time) and cancelled ones are never calls to join.
      if (item.status === 'cancelled' || !item.start?.dateTime || !item.end?.dateTime) continue;
      const video = item.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video');
      const link = meetingLink([item.hangoutLink, video?.uri, item.location, item.description]);
      events.push({
        id: item.id,
        title: item.summary?.trim() || '(No title)',
        startsAt: new Date(item.start.dateTime),
        endsAt: new Date(item.end.dateTime),
        meetingUrl: link?.url ?? null,
        platform: link?.platform ?? null,
      });
    }
    return { events };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.doFetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`,
      { method: 'POST', signal: AbortSignal.timeout(10_000) },
    ).catch(() => undefined);
  }
}

// ── Microsoft ───────────────────────────────────────────────────────────────────────────────

const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Calendars.Read',
];

interface GraphEvent {
  id: string;
  subject?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  onlineMeeting?: { joinUrl?: string } | null;
  onlineMeetingUrl?: string | null;
  location?: { displayName?: string };
  bodyPreview?: string;
}

/** Graph's times in the UTC the request asked for, written without a zone. */
const graphTime = (value: string) =>
  new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);

export class MicrosoftCalendar implements CalendarProvider {
  readonly id = 'microsoft' as const;
  readonly label = 'Outlook calendar';
  readonly isMock = false;
  readonly needsConsent = true;

  constructor(
    private readonly client: { id: string; secret: string; tenant: string },
    private readonly doFetch: Fetch = fetch,
  ) {}

  private get base(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.client.tenant)}/oauth2/v2.0`;
  }

  authorizeUrl({ state, redirectUri }: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.client.id,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: MICROSOFT_SCOPES.join(' '),
      prompt: 'select_account',
      state,
    });
    return `${this.base}/authorize?${params}`;
  }

  async exchange({ code, redirectUri }: { code: string; redirectUri: string }) {
    const answer = await json<TokenAnswer>(
      this.doFetch,
      `${this.base}/token`,
      form({
        client_id: this.client.id,
        client_secret: this.client.secret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: MICROSOFT_SCOPES.join(' '),
      }),
      'Microsoft',
    );
    if (!answer.refresh_token) {
      throw new CalendarError('refused', 'Microsoft didn’t grant lasting access. Connect again.');
    }
    const claims = claimsOf(answer.id_token);
    const email = claims.email ?? claims.preferred_username;
    return {
      refreshToken: answer.refresh_token,
      accountEmail: typeof email === 'string' ? email : null,
      scopes: (answer.scope ?? '').split(' ').filter(Boolean),
    };
  }

  async events({ refreshToken, from, to }: { refreshToken: string; from: Date; to: Date }) {
    const tokens = await json<TokenAnswer>(
      this.doFetch,
      `${this.base}/token`,
      form({
        client_id: this.client.id,
        client_secret: this.client.secret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: MICROSOFT_SCOPES.join(' '),
      }),
      'Microsoft',
    );
    const params = new URLSearchParams({
      startDateTime: from.toISOString(),
      endDateTime: to.toISOString(),
      $top: '50',
      $orderby: 'start/dateTime',
      $select:
        'id,subject,isCancelled,isAllDay,start,end,onlineMeeting,onlineMeetingUrl,location,bodyPreview',
    });
    const answer = await json<{ value?: GraphEvent[] }>(
      this.doFetch,
      `https://graph.microsoft.com/v1.0/me/calendarView?${params}`,
      {
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          accept: 'application/json',
          prefer: 'outlook.timezone="UTC"',
        },
      },
      'Microsoft',
    );
    const events: CalendarEvent[] = [];
    for (const item of answer.value ?? []) {
      if (item.isCancelled || item.isAllDay || !item.start?.dateTime || !item.end?.dateTime) {
        continue;
      }
      const link = meetingLink([
        item.onlineMeeting?.joinUrl,
        item.onlineMeetingUrl,
        item.location?.displayName,
        item.bodyPreview,
      ]);
      events.push({
        id: item.id,
        title: item.subject?.trim() || '(No title)',
        startsAt: graphTime(item.start.dateTime),
        endsAt: graphTime(item.end.dateTime),
        meetingUrl: link?.url ?? null,
        platform: link?.platform ?? null,
      });
    }
    return {
      events,
      ...(tokens.refresh_token && tokens.refresh_token !== refreshToken
        ? { refreshToken: tokens.refresh_token }
        : {}),
    };
  }

  async revoke(): Promise<void> {
    // Microsoft has no per-app revoke for a refresh token: people remove Sotto in their account's
    // app permissions. Forgetting the token here is what Disconnect does.
  }
}

// ── Sample (labelled stand-in) ──────────────────────────────────────────────────────────────

const SAMPLE_DAILY: ReadonlyArray<{
  key: string;
  title: string;
  /** Minutes after midnight UTC. */
  at: number;
  minutes: number;
  link: { url: string; platform: MeetPlatform } | null;
}> = [
  {
    key: 'design-review',
    title: 'Design review',
    at: 9 * 60 + 30,
    minutes: 30,
    link: { url: 'https://meet.google.com/smp-desg-rev', platform: 'MEET' },
  },
  {
    key: 'partner-check-in',
    title: 'Partner check-in',
    at: 13 * 60,
    minutes: 45,
    link: { url: 'https://kestrel.zoom.us/j/5550100200', platform: 'ZOOM' },
  },
  {
    key: 'product-sync',
    title: 'Weekly product sync',
    at: 15 * 60,
    minutes: 30,
    link: {
      url: 'https://teams.microsoft.com/l/meetup-join/19%3Asample-product-sync',
      platform: 'TEAMS',
    },
  },
  { key: 'focus', title: 'Focus time', at: 17 * 60, minutes: 60, link: null },
];
const QUICK_SYNC_LINK = { url: 'https://meet.google.com/smp-qick-snc', platform: 'MEET' as const };
const HALF_HOUR = 30 * 60_000;

/**
 * A made-up calendar (labelled "Sample" wherever it shows) so the notetaker can be tried before
 * Google or Microsoft is set up: the same four calls every day at fixed times (UTC), plus a
 * "Quick sync" every half hour, so there's always one about to start. Ids are stable per slot,
 * so sending the notetaker to one sticks. Its links lead nowhere real.
 */
export class SampleCalendar implements CalendarProvider {
  readonly id = 'sample' as const;
  readonly label = 'Sample calendar';
  readonly isMock = true;
  readonly needsConsent = false;

  constructor(private readonly now: () => number = Date.now) {}

  authorizeUrl(): string {
    throw new Error('The sample calendar connects without a consent page.');
  }

  async exchange(): Promise<CalendarGrant> {
    return { refreshToken: 'sample', accountEmail: null, scopes: [] };
  }

  async events({ from, to }: { refreshToken: string; from: Date; to: Date }) {
    const events: CalendarEvent[] = [];
    const day = 86_400_000;
    for (let midnight = Math.floor(from.getTime() / day) * day; midnight < to.getTime();) {
      for (const slot of SAMPLE_DAILY) {
        const startsAt = midnight + slot.at * 60_000;
        events.push({
          id: `sample-${slot.key}-${new Date(midnight).toISOString().slice(0, 10)}`,
          title: slot.title,
          startsAt: new Date(startsAt),
          endsAt: new Date(startsAt + slot.minutes * 60_000),
          meetingUrl: slot.link?.url ?? null,
          platform: slot.link?.platform ?? null,
        });
      }
      midnight += day;
    }
    // The quick syncs: the one under way (if any) and the next two, never the whole window.
    const first = Math.floor(this.now() / HALF_HOUR) * HALF_HOUR;
    for (let i = 0; i < 3; i++) {
      const startsAt = first + i * HALF_HOUR;
      events.push({
        id: `sample-quick-sync-${new Date(startsAt).toISOString()}`,
        title: 'Quick sync',
        startsAt: new Date(startsAt),
        endsAt: new Date(startsAt + 15 * 60_000),
        meetingUrl: QUICK_SYNC_LINK.url,
        platform: QUICK_SYNC_LINK.platform,
      });
    }
    return {
      events: events
        .filter((e) => e.endsAt.getTime() > from.getTime() && e.startsAt.getTime() < to.getTime())
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
    };
  }

  async revoke(): Promise<void> {}
}
