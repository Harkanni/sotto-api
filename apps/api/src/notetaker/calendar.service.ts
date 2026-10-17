import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type KeyVault, keyVaultFrom } from '@sotto/ai';
import {
  type BotAssignment,
  type CalendarConnection,
  type MeetPlatform,
  forWorkspace,
} from '@sotto/db';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { atLeast } from '../auth/roles.js';
import type { Viewer } from '../collections/collections.service.js';
import { ApiException } from '../common/errors.js';
import type { RequestAuth } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService, RedisService } from '../core.module.js';
import { NotetakerBots } from './bot-registry.js';
import {
  CalendarError,
  type CalendarEvent,
  type CalendarProvider,
  type CalendarProviderId,
  GoogleCalendar,
  MicrosoftCalendar,
  SampleCalendar,
} from './calendars.js';
import type {
  CalendarConnectionSchema,
  CalendarEventList,
  CalendarEventSchema,
  CalendarSettings,
  CalendarStatus,
  ConnectResult,
} from './schemas.js';

type Who = Pick<RequestAuth, 'ip'> & { user: { id: string } };
type ConnectionOut = z.infer<typeof CalendarConnectionSchema>;
type EventOut = z.infer<typeof CalendarEventSchema>;

const ORDER: readonly CalendarProviderId[] = ['google', 'microsoft', 'sample'];
const STATE_TTL_S = 600;
const EVENTS_TTL_S = 60;
/** The bot joins a minute early, so it's there when the host lets people in. */
const JOIN_EARLY_MS = 60_000;
/** How often auto-join looks ahead in each calendar, and how far. */
const SYNC_EVERY_MS = 5 * 60_000;
const SYNC_AHEAD_MS = 24 * 3600_000;
/** Calls already under way are still listed (and the notetaker can still be sent). */
const LOOK_BACK_MS = 2 * 3600_000;

const lower = <T extends string>(value: T) => value.toLowerCase() as Lowercase<T>;

/** An event's id for the routes: the calendar and its own event id, opaque to the client. */
export function eventKey(connectionId: string, eventId: string): string {
  return Buffer.from(`${connectionId}:${eventId}`, 'utf8').toString('base64url');
}

export function parseEventKey(key: string): { connectionId: string; eventId: string } | null {
  const raw = Buffer.from(key, 'base64url').toString('utf8');
  const at = raw.indexOf(':');
  if (at <= 0 || at === raw.length - 1) return null;
  return { connectionId: raw.slice(0, at), eventId: raw.slice(at + 1) };
}

/** Why the notetaker can't go to an event right now, in the order people would want to know. */
export function unavailableFor(
  event: Pick<CalendarEvent, 'endsAt' | 'meetingUrl' | 'platform'>,
  ctx: { now: Date; botsOn: boolean; botReady: boolean; supported: boolean },
): EventOut['unavailable'] {
  if (event.endsAt.getTime() <= ctx.now.getTime()) return 'ended';
  if (!event.meetingUrl || !event.platform) return 'no_link';
  if (!ctx.botsOn) return 'bots_off';
  if (!ctx.botReady) return 'no_bot';
  if (!ctx.supported) return 'platform';
  return null;
}

/**
 * Calendars and sending the notetaker (ADR 0035). Each person connects their own calendars in
 * the active workspace; events are read from the provider each time (cached a minute) and only
 * what a bot needs is kept, on its assignment. Refresh tokens are sealed with the BYOK vault.
 */
@Injectable()
export class CalendarService {
  private readonly log = new Logger('calendar');
  private readonly providers = new Map<CalendarProviderId, CalendarProvider>();
  private readonly vault: KeyVault;
  private lastSync = new Map<string, number>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NotetakerBots) private readonly bots: NotetakerBots,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
  ) {
    if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
      this.useProvider(
        new GoogleCalendar({ id: config.GOOGLE_CLIENT_ID, secret: config.GOOGLE_CLIENT_SECRET }),
      );
    }
    if (config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET) {
      this.useProvider(
        new MicrosoftCalendar({
          id: config.MICROSOFT_CLIENT_ID,
          secret: config.MICROSOFT_CLIENT_SECRET,
          tenant: config.MICROSOFT_TENANT_ID,
        }),
      );
    }
    this.useProvider(new SampleCalendar());
    this.vault = keyVaultFrom(config);
  }

  /** Installs (or, in tests, replaces) a calendar provider. */
  useProvider(provider: CalendarProvider): void {
    this.providers.set(provider.id, provider);
  }

  private db(workspaceId: string) {
    return forWorkspace(this.prisma.client, workspaceId);
  }

  private redirectUri(provider: CalendarProviderId): string {
    return `${this.config.APP_URL.replace(/\/+$/, '')}/api/v1/calendar/callback/${provider}`;
  }

  /** Where the web app's calendar screen is, to come back to after the consent page. */
  private screen(query: Record<string, string>): string {
    return `${this.config.APP_URL.replace(/\/+$/, '')}/meetings/calendar?${new URLSearchParams(query)}`;
  }

  // ── Status ─────────────────────────────────────────────────────────────────────────────────

  private present(connection: CalendarConnection): ConnectionOut {
    const provider = this.providers.get(connection.provider as CalendarProviderId);
    return {
      id: connection.id,
      provider: connection.provider as CalendarProviderId,
      label: provider?.label ?? connection.provider,
      accountEmail: connection.accountEmail,
      autoJoin: connection.autoJoin,
      syncedAt: connection.syncedAt?.toISOString() ?? null,
      error: connection.lastError,
      isMock: provider?.isMock ?? false,
    };
  }

  private async botsOn(workspaceId: string): Promise<boolean> {
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { meetingBots: true },
    });
    return workspace?.meetingBots ?? false;
  }

  private mine(viewer: Viewer) {
    return this.db(viewer.workspaceId).calendarConnection.findMany({
      where: { userId: viewer.userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async status(viewer: Viewer): Promise<z.infer<typeof CalendarStatus>> {
    const [connections, enabled] = await Promise.all([
      this.mine(viewer),
      this.botsOn(viewer.workspaceId),
    ]);
    const bot = this.bots.provider;
    return {
      providers: ORDER.map((id) => {
        const provider = this.providers.get(id);
        const fallback = { google: 'Google Calendar', microsoft: 'Outlook calendar', sample: '' };
        return {
          id,
          label: provider?.label ?? fallback[id],
          available: Boolean(provider) && (id === 'sample' || this.vault.available),
          isMock: provider?.isMock ?? false,
        };
      }),
      connections: connections.map((c) => this.present(c)),
      notetaker: {
        name: this.bots.name,
        enabled,
        available: Boolean(bot),
        label: bot?.label ?? 'Not set up on this server',
        isMock: bot?.isMock ?? false,
        platforms: (bot?.platforms ?? []).map(lower),
      },
      canManageNotetaker: atLeast(viewer.role, 'admin'),
    };
  }

  // ── Connecting ─────────────────────────────────────────────────────────────────────────────

  private provider(id: string): CalendarProvider {
    const provider = this.providers.get(id as CalendarProviderId);
    if (!provider) {
      throw new ApiException(
        404,
        'CALENDAR_UNAVAILABLE',
        'That calendar isn’t set up on this server yet. An admin can add it.',
      );
    }
    return provider;
  }

  async connect(viewer: Viewer, by: Who, id: string): Promise<z.infer<typeof ConnectResult>> {
    const provider = this.provider(id);
    if (!provider.needsConsent) {
      const grant = await provider.exchange({ code: '', redirectUri: '' });
      const connection = await this.save(viewer, by, provider, grant);
      return { url: null, connection: this.present(connection) };
    }
    if (!this.vault.available) {
      throw new ApiException(
        409,
        'VAULT_UNAVAILABLE',
        'Calendars can’t be connected until this server has its key store set up.',
      );
    }
    const state = randomBytes(24).toString('base64url');
    await this.redis.client.set(
      `sotto:cal:state:${state}`,
      JSON.stringify({ userId: viewer.userId, workspaceId: viewer.workspaceId, provider: id }),
      'EX',
      STATE_TTL_S,
    );
    return {
      url: provider.authorizeUrl({ state, redirectUri: this.redirectUri(provider.id) }),
      connection: null,
    };
  }

  /**
   * The consent page sent the person back. The state must be one this person started here in
   * the last ten minutes, and works once. Returns where to send the browser next.
   */
  async callback(
    viewer: Viewer,
    by: Who,
    id: string,
    query: { code?: string | undefined; state?: string | undefined; error?: string | undefined },
  ): Promise<string> {
    const provider = this.providers.get(id as CalendarProviderId);
    const saved = query.state
      ? await this.redis.client.getdel(`sotto:cal:state:${query.state}`)
      : null;
    const state = saved
      ? (JSON.parse(saved) as { userId: string; workspaceId: string; provider: string })
      : null;
    if (
      !provider ||
      !state ||
      state.userId !== viewer.userId ||
      state.workspaceId !== viewer.workspaceId ||
      state.provider !== id
    ) {
      return this.screen({ calendar_error: 'expired' });
    }
    if (query.error || !query.code) {
      return this.screen({
        calendar_error: query.error === 'access_denied' ? 'declined' : 'refused',
      });
    }
    try {
      const grant = await provider.exchange({
        code: query.code,
        redirectUri: this.redirectUri(provider.id),
      });
      await this.save(viewer, by, provider, grant);
      return this.screen({ connected: provider.id });
    } catch (error) {
      const code = error instanceof CalendarError ? error.code : 'refused';
      this.log.warn(`calendar connect failed (${provider.id}: ${code})`);
      return this.screen({ calendar_error: code });
    }
  }

  private async save(
    viewer: Viewer,
    by: Who,
    provider: CalendarProvider,
    grant: { refreshToken: string; accountEmail: string | null; scopes: string[] },
  ): Promise<CalendarConnection> {
    const sealed = provider.needsConsent
      ? await this.vault.seal(grant.refreshToken, viewer.workspaceId)
      : null;
    const data = {
      accountEmail: grant.accountEmail,
      encryptedRefreshToken: sealed ? Buffer.from(sealed.encryptedKey) : null,
      wrappedDek: sealed ? Buffer.from(sealed.wrappedDek) : null,
      keyWrapper: sealed?.keyWrapper ?? null,
      scopes: grant.scopes,
      lastError: null,
    };
    const connection = await this.db(viewer.workspaceId).calendarConnection.upsert({
      where: {
        workspaceId_userId_provider: {
          workspaceId: viewer.workspaceId,
          userId: viewer.userId,
          provider: provider.id,
        },
      },
      create: {
        workspaceId: viewer.workspaceId,
        userId: viewer.userId,
        provider: provider.id,
        ...data,
      },
      update: data,
    });
    await this.audit.record(viewer.workspaceId, by, {
      action: 'calendar.connected',
      target: { type: 'calendar', id: connection.id },
      meta: { label: provider.label, ...(grant.accountEmail ? { email: grant.accountEmail } : {}) },
    });
    return connection;
  }

  private async own(viewer: Viewer, id: string): Promise<CalendarConnection> {
    const connection = await this.db(viewer.workspaceId).calendarConnection.findFirst({
      where: { id, userId: viewer.userId },
    });
    if (!connection) {
      throw new ApiException(404, 'NOT_FOUND', 'That calendar isn’t connected to your account.');
    }
    return connection;
  }

  async disconnect(viewer: Viewer, by: Who, id: string): Promise<void> {
    const connection = await this.own(viewer, id);
    const provider = this.providers.get(connection.provider as CalendarProviderId);
    // Bots on their way or in a call for this calendar leave; the meetings they recorded stay.
    const active = await this.db(viewer.workspaceId).botAssignment.findMany({
      where: { connectionId: id, status: { in: ['JOINING', 'IN_CALL'] } },
    });
    for (const assignment of active) await this.bots.leave(assignment.providerRef);
    if (provider?.needsConsent && connection.encryptedRefreshToken) {
      const token = await this.refreshToken(connection).catch(() => null);
      if (token) await provider.revoke(token);
    }
    await this.db(viewer.workspaceId).calendarConnection.delete({ where: { id } });
    await this.redis.client.del(`sotto:cal:events:${id}`).catch(() => 0);
    await this.audit.record(viewer.workspaceId, by, {
      action: 'calendar.disconnected',
      target: { type: 'calendar', id },
      meta: { label: provider?.label ?? connection.provider },
    });
  }

  async settings(
    viewer: Viewer,
    by: Who,
    body: z.infer<typeof CalendarSettings>,
  ): Promise<z.infer<typeof CalendarStatus>> {
    const targets = body.connectionId
      ? [await this.own(viewer, body.connectionId)]
      : await this.mine(viewer);
    for (const connection of targets) {
      if (connection.autoJoin === body.autoJoin) continue;
      await this.db(viewer.workspaceId).calendarConnection.update({
        where: { id: connection.id },
        data: { autoJoin: body.autoJoin },
      });
      this.lastSync.delete(connection.id);
      const provider = this.providers.get(connection.provider as CalendarProviderId);
      await this.audit.record(viewer.workspaceId, by, {
        action: 'calendar.auto_join_changed',
        target: { type: 'calendar', id: connection.id },
        meta: { label: provider?.label ?? connection.provider, autoJoin: body.autoJoin },
      });
    }
    if (body.autoJoin) this.bots.due();
    return this.status(viewer);
  }

  // ── Events ─────────────────────────────────────────────────────────────────────────────────

  private async refreshToken(connection: CalendarConnection): Promise<string> {
    if (connection.provider === 'sample') return 'sample';
    if (!connection.encryptedRefreshToken || !connection.wrappedDek || !connection.keyWrapper) {
      throw new CalendarError('token_revoked', 'Connect this calendar again.');
    }
    return this.vault.open(
      {
        encryptedKey: connection.encryptedRefreshToken,
        wrappedDek: connection.wrappedDek,
        keyWrapper: connection.keyWrapper,
      },
      connection.workspaceId,
    );
  }

  /**
   * One calendar's timed events in the listing window, from a one-minute cache or the provider.
   * A provider's problem is kept on the connection (as a code) and thrown to the caller.
   */
  async read(connection: CalendarConnection, days: number, now: Date): Promise<CalendarEvent[]> {
    const key = `sotto:cal:events:${connection.id}`;
    const cached = await this.redis.client.get(key).catch(() => null);
    if (cached) {
      const parsed = JSON.parse(cached) as { days: number; events: CalendarEvent[] };
      if (parsed.days >= days) {
        return parsed.events.map((e) => ({
          ...e,
          startsAt: new Date(e.startsAt),
          endsAt: new Date(e.endsAt),
        }));
      }
    }
    const provider = this.providers.get(connection.provider as CalendarProviderId);
    try {
      if (!provider) {
        throw new CalendarError('refused', 'That calendar isn’t set up on this server any more.');
      }
      const result = await provider.events({
        refreshToken: await this.refreshToken(connection),
        from: new Date(now.getTime() - LOOK_BACK_MS),
        to: new Date(now.getTime() + days * 86_400_000),
      });
      const data: { syncedAt: Date; lastError: null } & Partial<CalendarConnection> = {
        syncedAt: now,
        lastError: null,
      };
      if (result.refreshToken) {
        const sealed = await this.vault.seal(result.refreshToken, connection.workspaceId);
        data.encryptedRefreshToken = Buffer.from(sealed.encryptedKey);
        data.wrappedDek = Buffer.from(sealed.wrappedDek);
        data.keyWrapper = sealed.keyWrapper;
      }
      await this.db(connection.workspaceId).calendarConnection.update({
        where: { id: connection.id },
        data,
      });
      await this.redis.client
        .set(key, JSON.stringify({ days, events: result.events }), 'EX', EVENTS_TTL_S)
        .catch(() => undefined);
      return result.events;
    } catch (error) {
      const code = error instanceof CalendarError ? error.code : 'refused';
      await this.db(connection.workspaceId)
        .calendarConnection.update({ where: { id: connection.id }, data: { lastError: code } })
        .catch(() => undefined);
      throw error instanceof CalendarError
        ? error
        : new CalendarError('refused', 'This calendar couldn’t be read just now.');
    }
  }

  /**
   * Auto-join: future calls with a link the bot can join get the notetaker, unless someone said
   * no to that one (any existing assignment is left as it is).
   */
  private async autoJoin(connection: CalendarConnection, events: CalendarEvent[], now: Date) {
    if (!connection.autoJoin) return;
    const wanted = events.filter(
      (e) => e.startsAt.getTime() > now.getTime() && e.meetingUrl && this.bots.supports(e.platform),
    );
    if (!wanted.length) return;
    await this.db(connection.workspaceId).botAssignment.createMany({
      data: wanted.map((e) => this.assignmentData(connection, e)),
      skipDuplicates: true,
    });
  }

  private assignmentData(connection: CalendarConnection, event: CalendarEvent, now = new Date()) {
    return {
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      eventId: event.id,
      title: event.title.slice(0, 200),
      meetingUrl: event.meetingUrl!,
      platform: event.platform as MeetPlatform,
      joinAt: new Date(Math.max(now.getTime(), event.startsAt.getTime() - JOIN_EARLY_MS)),
      endsAt: event.endsAt,
    };
  }

  private toOut(
    connection: CalendarConnection,
    event: CalendarEvent,
    assignment: BotAssignment | undefined,
    ctx: { now: Date; botsOn: boolean },
  ): EventOut {
    return {
      id: eventKey(connection.id, event.id),
      connectionId: connection.id,
      provider: connection.provider as CalendarProviderId,
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      meetingUrl: event.meetingUrl,
      platform: event.platform ? lower(event.platform) : null,
      unavailable: unavailableFor(event, {
        now: ctx.now,
        botsOn: ctx.botsOn,
        botReady: Boolean(this.bots.provider),
        supported: this.bots.supports(event.platform),
      }),
      bot: assignment
        ? {
            status: lower(assignment.status),
            error: assignment.error,
            joinAt: assignment.joinAt.toISOString(),
            liveSessionId: assignment.liveSessionId,
          }
        : null,
    };
  }

  async events(
    viewer: Viewer,
    days: number,
    now = new Date(),
  ): Promise<z.infer<typeof CalendarEventList>> {
    const [connections, botsOn] = await Promise.all([
      this.mine(viewer),
      this.botsOn(viewer.workspaceId),
    ]);
    const problems: z.infer<typeof CalendarEventList>['problems'] = [];
    const listed: Array<{ connection: CalendarConnection; event: CalendarEvent }> = [];
    for (const connection of connections) {
      try {
        const events = await this.read(connection, days, now);
        if (botsOn) await this.autoJoin(connection, events, now);
        for (const event of events) listed.push({ connection, event });
      } catch (error) {
        problems.push({
          connectionId: connection.id,
          code: error instanceof CalendarError ? error.code : 'refused',
          message: error instanceof Error ? error.message : 'This calendar couldn’t be read.',
        });
      }
    }
    const assignments = listed.length
      ? await this.db(viewer.workspaceId).botAssignment.findMany({
          where: {
            OR: connections.map((c) => ({
              connectionId: c.id,
              eventId: {
                in: listed.filter((l) => l.connection.id === c.id).map((l) => l.event.id),
              },
            })),
          },
        })
      : [];
    const byEvent = new Map(assignments.map((a) => [`${a.connectionId}:${a.eventId}`, a]));
    const items = listed
      .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime())
      .map(({ connection, event }) =>
        this.toOut(connection, event, byEvent.get(`${connection.id}:${event.id}`), {
          now,
          botsOn,
        }),
      );
    return { items, problems };
  }

  /** Sends the notetaker to one call, or keeps it out (taking it back if it's on its way or in). */
  async send(viewer: Viewer, by: Who, key: string, send: boolean, now = new Date()) {
    const parsed = parseEventKey(key);
    const connection = parsed ? await this.own(viewer, parsed.connectionId) : null;
    if (!parsed || !connection) {
      throw new ApiException(404, 'NOT_FOUND', 'That call isn’t on your calendar.');
    }
    let events: CalendarEvent[];
    try {
      events = await this.read(connection, 7, now);
    } catch (error) {
      throw new ApiException(
        502,
        'CALENDAR_UNREACHABLE',
        error instanceof Error ? error.message : 'Your calendar couldn’t be read just now.',
      );
    }
    const event = events.find((e) => e.id === parsed.eventId);
    if (!event) {
      throw new ApiException(404, 'NOT_FOUND', 'That call isn’t on your calendar any more.');
    }
    const db = this.db(viewer.workspaceId);
    const where = { connectionId_eventId: { connectionId: connection.id, eventId: event.id } };
    const existing = await db.botAssignment.findUnique({ where });
    const botsOn = await this.botsOn(viewer.workspaceId);

    if (send) {
      const why = unavailableFor(event, {
        now,
        botsOn,
        botReady: Boolean(this.bots.provider),
        supported: this.bots.supports(event.platform),
      });
      if (why) throw refusal(why);
      if (existing?.status === 'DONE') {
        throw new ApiException(
          409,
          'ALREADY_RECORDED',
          'The notetaker already recorded this call.',
        );
      }
      const active = existing && ['JOINING', 'IN_CALL'].includes(existing.status);
      const assignment = active
        ? existing
        : await db.botAssignment.upsert({
            where,
            create: { ...this.assignmentData(connection, event, now), status: 'SCHEDULED' },
            update: {
              ...this.assignmentData(connection, event, now),
              status: 'SCHEDULED',
              error: null,
            },
          });
      if (!active) {
        await this.audit.record(viewer.workspaceId, by, {
          action: 'bot.sent',
          target: { type: 'calendar', id: connection.id },
          meta: { name: event.title },
        });
        if (assignment.joinAt.getTime() <= now.getTime()) this.bots.due();
      }
      return this.toOut(connection, event, assignment, { now, botsOn });
    }

    if (existing?.status === 'SKIPPED' || existing?.status === 'DONE') {
      return this.toOut(connection, event, existing, { now, botsOn });
    }
    // A call with no link never gets the notetaker: there's nothing to keep it out of.
    if (!existing && (!event.meetingUrl || !event.platform)) {
      return this.toOut(connection, event, undefined, { now, botsOn });
    }
    if (existing && ['JOINING', 'IN_CALL'].includes(existing.status)) {
      // It leaves; what it recorded so far is saved when it says it's gone.
      await this.bots.leave(existing.providerRef);
    }
    const assignment = await db.botAssignment.upsert({
      where,
      create: { ...this.assignmentData(connection, event, now), status: 'SKIPPED' },
      update: { status: 'SKIPPED', error: null },
    });
    await this.audit.record(viewer.workspaceId, by, {
      action: 'bot.skipped',
      target: { type: 'calendar', id: connection.id },
      meta: { name: event.title },
    });
    return this.toOut(connection, event, assignment, { now, botsOn });
  }

  /**
   * For the scheduler: calendars with auto-join, looked at every five minutes, get the notetaker
   * on their upcoming calls even when nobody opens the app.
   */
  async syncAutoJoin(now = new Date()): Promise<number> {
    const connections = await this.prisma.client.calendarConnection.findMany({
      where: { autoJoin: true, workspace: { meetingBots: true } },
      take: 200,
    });
    let synced = 0;
    for (const connection of connections) {
      if (now.getTime() - (this.lastSync.get(connection.id) ?? 0) < SYNC_EVERY_MS) continue;
      this.lastSync.set(connection.id, now.getTime());
      try {
        const events = await this.read(connection, SYNC_AHEAD_MS / 86_400_000, now);
        await this.autoJoin(connection, events, now);
        synced++;
      } catch {
        // Kept on the connection as a code; the calendar screen says what to do.
      }
    }
    return synced;
  }
}

/** Why the notetaker can't go, as the error the person sees. */
function refusal(why: NonNullable<EventOut['unavailable']>): ApiException {
  switch (why) {
    case 'ended':
      return new ApiException(409, 'EVENT_ENDED', 'That call has already ended.');
    case 'no_link':
      return new ApiException(
        409,
        'NO_MEETING_LINK',
        'That call has no Meet, Zoom or Teams link for the notetaker to join.',
      );
    case 'bots_off':
      return new ApiException(
        403,
        'NOTETAKER_OFF',
        'Your workspace’s admins turned the notetaker off.',
      );
    case 'no_bot':
      return new ApiException(
        409,
        'NOTETAKER_UNAVAILABLE',
        'The notetaker isn’t set up on this server yet.',
      );
    case 'platform':
      return new ApiException(
        409,
        'PLATFORM_UNSUPPORTED',
        'The notetaker can’t join calls on that service yet.',
      );
  }
}
