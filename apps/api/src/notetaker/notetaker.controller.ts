import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { Public, RequireRole } from '../auth/auth.guard.js';
import { ApiErrors } from '../common/errors.js';
import { type ApiRequest, Ctx, type RequestAuth } from '../common/request.js';
import { viewerOf } from '../files/uploads.controller.js';
import { LiveModule } from '../live/live.controller.js';
import { NotetakerBots } from './bot-registry.js';
import { BotsService } from './bots.service.js';
import { CalendarService } from './calendar.service.js';
import { NOTETAKER_SWITCH } from './switch.js';
import {
  CalendarEventList,
  CalendarEventSchema,
  CalendarEventsQuery,
  CalendarProviderId,
  CalendarSettings,
  CalendarStatus,
  CallbackQuery,
  ConnectResult,
  SendBot,
} from './schemas.js';

const ConnectionId = z.string().min(1).max(64);
const EventId = z.string().min(1).max(2048);

/**
 * Calendars and the notetaker (ADR 0035). Members and above: viewers can't record meetings, so
 * they can't send a bot to record one either.
 */
@ApiTags('calendar')
@ApiErrors()
@Controller()
export class NotetakerController {
  constructor(
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(BotsService) private readonly bots: BotsService,
  ) {}

  @Get('calendar')
  @RequireRole('member')
  @ApiOperation({
    summary:
      'Your connected calendars, the calendars this server offers, and the notetaker: whether ' +
      'the admins allow it and whether this server can send one.',
  })
  @ApiOkResponse({ standardSchema: CalendarStatus })
  status(@Ctx() auth: RequestAuth) {
    return this.calendar.status(viewerOf(auth));
  }

  @Post('calendar/connect/:provider')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Connect a calendar. Google and Microsoft answer with the page where you grant read-only ' +
      'access (open it in the browser); the sample calendar connects at once.',
  })
  @ApiOkResponse({ standardSchema: ConnectResult })
  connect(
    @Ctx() auth: RequestAuth,
    @Param('provider', { schema: CalendarProviderId }) provider: string,
  ) {
    return this.calendar.connect(viewerOf(auth), auth, provider);
  }

  @Get('calendar/callback/:provider')
  @RequireRole('member')
  @ApiOperation({
    summary:
      'Where Google or Microsoft send the browser back after the consent page. Redirects to the ' +
      'calendar screen with `connected=<provider>` or `calendar_error=<code>`.',
  })
  async callback(
    @Ctx() auth: RequestAuth,
    @Param('provider', { schema: CalendarProviderId }) provider: string,
    @Query({ schema: CallbackQuery }) query: z.infer<typeof CallbackQuery>,
    @Res() res: ServerResponse,
  ) {
    const location = await this.calendar.callback(viewerOf(auth), auth, provider, query);
    res.statusCode = 303;
    res.setHeader('location', location);
    res.setHeader('cache-control', 'no-store');
    res.end();
  }

  @Delete('calendar/connections/:id')
  @RequireRole('member')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Disconnect a calendar: Sotto forgets its access (and tells Google), and any notetaker on ' +
      'its way or in a call for it leaves. Meetings already recorded stay.',
  })
  @ApiNoContentResponse()
  async disconnect(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: ConnectionId }) id: string,
  ): Promise<void> {
    await this.calendar.disconnect(viewerOf(auth), auth, id);
  }

  @Get('calendar/events')
  @RequireRole('member')
  @ApiOperation({
    summary:
      'Your upcoming calls (and ones under way) from every connected calendar, soonest first, ' +
      'each with whether the notetaker can go and what it is doing.',
  })
  @ApiOkResponse({ standardSchema: CalendarEventList })
  events(
    @Ctx() auth: RequestAuth,
    @Query({ schema: CalendarEventsQuery }) query: z.infer<typeof CalendarEventsQuery>,
  ) {
    return this.calendar.events(viewerOf(auth), query.days);
  }

  @Put('calendar/events/:id/bot')
  @RequireRole('member')
  @ApiOperation({
    summary:
      'Send the notetaker to one call, or keep it out (taking it back if it is on its way or ' +
      'in the call: what it recorded so far is saved).',
  })
  @ApiOkResponse({ standardSchema: CalendarEventSchema })
  send(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: EventId }) id: string,
    @Body({ schema: SendBot }) body: z.infer<typeof SendBot>,
  ) {
    return this.calendar.send(viewerOf(auth), auth, id, body.send);
  }

  @Patch('calendar/settings')
  @RequireRole('member')
  @ApiOperation({
    summary:
      'Auto-join: send the notetaker to every call with a link on one calendar, or on all of ' +
      'yours. Calls you skip one by one stay skipped.',
  })
  @ApiOkResponse({ standardSchema: CalendarStatus })
  settings(
    @Ctx() auth: RequestAuth,
    @Body({ schema: CalendarSettings }) body: z.infer<typeof CalendarSettings>,
  ) {
    return this.calendar.settings(viewerOf(auth), auth, body);
  }

  /** A bot's reports: no session; the signature over the exact body is the proof (ADR 0035). */
  @Post('webhooks/meeting-bot')
  @Public()
  @ApiExcludeEndpoint()
  async webhook(@Req() req: ApiRequest & { rawBody?: Buffer }, @Res() res: ServerResponse) {
    const answer = await this.bots.webhook(req.rawBody, req.headers);
    res.statusCode = answer ? 200 : 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(answer ?? { error: { code: 'BAD_SIGNATURE', message: 'Not signed.' } }));
  }
}

/** Global so the workspace settings route can reach the switch by its token alone. */
@Global()
@Module({
  imports: [LiveModule],
  controllers: [NotetakerController],
  providers: [
    NotetakerBots,
    CalendarService,
    BotsService,
    { provide: NOTETAKER_SWITCH, useExisting: BotsService },
  ],
  exports: [BotsService, NOTETAKER_SWITCH],
})
export class NotetakerModule {}
