import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  type MessageEvent,
  Module,
  Param,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { z } from 'zod';
import { RequireRole } from '../auth/auth.guard.js';
import { AiModule } from '../ai/ai.controller.js';
import { CollectionsModule } from '../collections/collections.controller.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { type ApiRequest, Ctx, type RequestAuth } from '../common/request.js';
import { FilesModule } from '../files/files.controller.js';
import { viewerOf } from '../files/uploads.controller.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { MAX_CHUNK_BYTES } from './audio.js';
import { LiveHub } from './live.hub.js';
import { LiveService } from './live.service.js';
import { LiveNotesService } from './notes.service.js';
import {
  ChunkQuery,
  ChunkResult,
  LiveSegmentSchema,
  LiveSessionList,
  LiveSessionSchema,
  StartLive,
} from './schemas.js';
import { LiveTranscriber } from './transcriber.js';

const AskChat = z.object({ conversationId: z.string() }).meta({ id: 'LiveAskChat' });

const EndResult = z
  .object({
    /** True when nothing had been captured: the empty meeting was removed, not saved. */
    discarded: z.boolean(),
    session: LiveSessionSchema.nullable(),
  })
  .meta({ id: 'EndLiveResult' });

/**
 * Reads a raw audio body. Express's JSON parser leaves `application/octet-stream` alone, so the
 * bytes are still on the request; anything over the limit is refused without buffering it.
 */
export async function readAudio(req: ApiRequest, limit: number): Promise<Buffer> {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim();
  if (type !== 'application/octet-stream') {
    throw new ApiException(415, 'BAD_AUDIO', 'Send audio as application/octet-stream.');
  }
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new ApiException(413, 'BAD_AUDIO', 'This piece of audio is longer than 15 seconds.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new ApiException(413, 'BAD_AUDIO', 'This piece of audio is longer than 15 seconds.');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

@ApiTags('live')
@ApiErrors()
@Controller('live-sessions')
export class LiveController {
  constructor(@Inject(LiveService) private readonly live: LiveService) {}

  @Post()
  @RequireRole('member')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Start listening to a call: creates the meeting (shown as live in Meetings) and the session that audio is sent to.',
  })
  @ApiOkResponse({ standardSchema: LiveSessionSchema })
  start(@Ctx() auth: RequestAuth, @Body({ schema: StartLive }) body: z.infer<typeof StartLive>) {
    return this.live.start(viewerOf(auth), auth, body);
  }

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Live meetings happening now that you can open.' })
  @ApiOkResponse({ standardSchema: LiveSessionList })
  async list(@Ctx() auth: RequestAuth) {
    return { items: await this.live.active(viewerOf(auth)) };
  }

  @Get(':id')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'One live session: status, inputs, notes and the meeting it becomes.' })
  @ApiOkResponse({ standardSchema: LiveSessionSchema })
  async get(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    const viewer = viewerOf(auth);
    return this.live.present(viewer, await this.live.open(viewer, id));
  }

  @Post(':id/audio')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Send the next piece of audio: up to 15 s of 16 kHz mono 16-bit PCM, numbered from 0 in `seq`. ' +
      'A piece that already arrived is accepted again without changes; a gap is refused (409 CHUNK_GAP).',
  })
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  @ApiOkResponse({ standardSchema: ChunkResult })
  async audio(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Query({ schema: ChunkQuery }) query: z.infer<typeof ChunkQuery>,
    @Req() req: ApiRequest,
  ) {
    const pcm = await readAudio(req, MAX_CHUNK_BYTES);
    return this.live.chunk(viewerOf(auth), id, query.seq, pcm);
  }

  @Sse(':id/events')
  @RequireRole('viewer')
  @ApiOperation({
    summary:
      'The live transcript and notes (Server-Sent Events): `session` first and on every change, ' +
      '`segment` per transcribed line (id `seq.idx`; reconnect with Last-Event-ID to resume), ' +
      '`notes` ({notes, notesAt, notesError}) when they change, `ping` every 25 s.',
  })
  @ApiOkResponse({ description: 'text/event-stream', standardSchema: LiveSegmentSchema })
  events(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Headers('last-event-id') lastEventId: string | undefined,
  ): Promise<Observable<MessageEvent>> {
    return this.live.stream(viewerOf(auth), id, lastEventId);
  }

  @Post(':id/ask')
  @RequireRole('viewer')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Ask during the call: opens a chat scoped to the transcript so far plus your library. ' +
      'Send questions to POST /conversations/:id/messages as usual.',
  })
  @ApiOkResponse({ standardSchema: AskChat })
  ask(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    return this.live.askChat(viewerOf(auth), id);
  }

  @Post(':id/notes')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Update the running notes now (they also refresh every few minutes), with the workspace’s default model under its privacy rules.',
  })
  @ApiOkResponse({ standardSchema: LiveSessionSchema })
  notes(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    return this.live.refreshNotes(viewerOf(auth), id);
  }

  @Post(':id/end')
  @RequireRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Stop listening: the audio becomes a meeting and goes through transcription and notes like any recording.',
  })
  @ApiOkResponse({ standardSchema: EndResult })
  end(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    return this.live.end(viewerOf(auth), auth, id);
  }
}

@Module({
  imports: [FilesModule, CollectionsModule, AiModule],
  controllers: [LiveController],
  providers: [LiveService, LiveHub, LiveTranscriber, LiveNotesService],
  exports: [LiveService],
})
export class LiveModule {}
