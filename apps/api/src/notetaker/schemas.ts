import { z } from 'zod';

/** Calendars and the notetaker bot (ADR 0035). */

export const CalendarProviderId = z
  .enum(['google', 'microsoft', 'sample'])
  .meta({ id: 'CalendarProviderId' });

export const MeetPlatformSchema = z.enum(['meet', 'zoom', 'teams']).meta({ id: 'MeetPlatform' });

export const CalendarProviderInfo = z
  .object({
    id: CalendarProviderId,
    /** "Google Calendar", "Outlook calendar", "Sample calendar". */
    label: z.string(),
    /** Set up on this server (Google and Microsoft need their OAuth apps). */
    available: z.boolean(),
    /** A labelled stand-in: the UI says so wherever it shows. */
    isMock: z.boolean(),
  })
  .meta({ id: 'CalendarProviderInfo' });

export const CalendarConnectionSchema = z
  .object({
    id: z.string(),
    provider: CalendarProviderId,
    label: z.string(),
    /** The calendar account's address, so people know which one is connected. */
    accountEmail: z.string().nullable(),
    /** The notetaker goes to every call with a link, unless skipped one by one. */
    autoJoin: z.boolean(),
    syncedAt: z.string().nullable(),
    /** The last problem reading it, as a code (`token_revoked`, `unreachable`, `refused`). */
    error: z.string().nullable(),
    isMock: z.boolean(),
  })
  .meta({ id: 'CalendarConnection' });

export const NotetakerInfo = z
  .object({
    /** The name everyone in the call sees. */
    name: z.string(),
    /** The workspace's admins allow the notetaker. */
    enabled: z.boolean(),
    /** This server can send one (`MEETING_BOT` is set). */
    available: z.boolean(),
    /** "Sotto's Meet bot", or the labelled stand-in. */
    label: z.string(),
    isMock: z.boolean(),
    /** Calls it can join. */
    platforms: z.array(MeetPlatformSchema),
  })
  .meta({ id: 'NotetakerInfo' });

export const CalendarStatus = z
  .object({
    providers: z.array(CalendarProviderInfo),
    connections: z.array(CalendarConnectionSchema),
    notetaker: NotetakerInfo,
    /** Admins and owners can turn the notetaker off for everyone. */
    canManageNotetaker: z.boolean(),
  })
  .meta({ id: 'CalendarStatus' });

export const BotStatusSchema = z
  .enum(['scheduled', 'joining', 'in_call', 'done', 'skipped', 'failed'])
  .meta({ id: 'BotStatus' });

export const BotStateSchema = z
  .object({
    status: BotStatusSchema,
    /**
     * Why it was skipped or failed, as a code: `bots_off`, `unavailable`, `missed`,
     * `not_admitted`, `removed`, `launch_failed`, `quota`, `error`.
     */
    error: z.string().nullable(),
    /** When it joins (a minute before the start). */
    joinAt: z.string(),
    /** The live meeting while it's in the call, and the meeting it became after. */
    liveSessionId: z.string().nullable(),
  })
  .meta({ id: 'BotState' });

export const CalendarEventSchema = z
  .object({
    /** Opaque: names the calendar and its event, for `PUT /calendar/events/:id/bot`. */
    id: z.string(),
    connectionId: z.string(),
    provider: CalendarProviderId,
    title: z.string(),
    startsAt: z.string(),
    endsAt: z.string(),
    meetingUrl: z.string().nullable(),
    platform: MeetPlatformSchema.nullable(),
    /** Why the notetaker can't be sent, or null when it can. */
    unavailable: z.enum(['no_link', 'platform', 'bots_off', 'no_bot', 'ended']).nullable(),
    bot: BotStateSchema.nullable(),
  })
  .meta({ id: 'CalendarEvent' });

export const CalendarEventList = z
  .object({
    items: z.array(CalendarEventSchema),
    /** Calendars that couldn't be read just now, and why (the others still list). */
    problems: z.array(
      z.object({ connectionId: z.string(), code: z.string(), message: z.string() }),
    ),
  })
  .meta({ id: 'CalendarEventList' });

export const CalendarEventsQuery = z
  .object({ days: z.coerce.number().int().min(1).max(14).default(7) })
  .meta({ id: 'CalendarEventsQuery' });

export const ConnectResult = z
  .object({
    /** Where to send the person to grant access (Google, Microsoft), or null. */
    url: z.string().nullable(),
    /** The calendar, when it connected straight away (the sample calendar). */
    connection: CalendarConnectionSchema.nullable(),
  })
  .meta({ id: 'CalendarConnectResult' });

export const CallbackQuery = z
  .object({
    code: z.string().max(4096).optional(),
    state: z.string().max(200).optional(),
    /** The provider's own refusal (`access_denied` when the person said no). */
    error: z.string().max(200).optional(),
  })
  .meta({ id: 'CalendarCallbackQuery' });

export const SendBot = z
  .object({
    /** True to send the notetaker, false to skip this call. */
    send: z.boolean(),
  })
  .meta({ id: 'SendBot' });

export const CalendarSettings = z
  .object({
    autoJoin: z.boolean(),
    /** One calendar, or all of yours when omitted. */
    connectionId: z.string().min(1).max(64).optional(),
  })
  .meta({ id: 'CalendarSettings' });

/** What a bot reports on the signed webhook (ADR 0035). Not part of the public client. */
export const BotReport = z.object({
  assignmentId: z.string().min(1).max(64),
  /** `waiting`: asking to be let in; `in_call`: let in, recording; `left`: gone; `failed`. */
  event: z.enum(['waiting', 'in_call', 'left', 'failed']),
  reason: z
    .enum(['meeting_ended', 'removed', 'not_admitted', 'stopped', 'meeting_not_found', 'error'])
    .optional(),
});
export type BotReport = z.infer<typeof BotReport>;
