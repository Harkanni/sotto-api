import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Prisma } from '@sotto/db';
import type { z } from 'zod';
import { RequireRole } from '../auth/auth.guard.js';
import type { Viewer } from '../collections/collections.service.js';
import { CollectionsService } from '../collections/collections.service.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { type ApiRequest, Ctx, type RequestAuth } from '../common/request.js';
import { decodeCursor, encodeCursor } from '../files/files.service.js';
import { FilesService } from '../files/files.service.js';
import { viewerOf } from '../files/uploads.controller.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { AskService } from './ask.service.js';
import {
  AnswerEvent,
  AskBody,
  ConversationPage,
  ConversationSchema,
  ConversationSummary,
  CreateConversation,
  FeedbackBody,
  ListConversationsQuery,
  MessageSchema,
  UpdateConversation,
} from './schemas.js';
import { type AskScope, storedScope } from './scope.js';

/** A comment line every 15 s keeps proxies from closing a slow answer's stream. */
const HEARTBEAT_MS = 15_000;

/**
 * Opens a Server-Sent Events response. Returns `send`, which becomes a no-op once the browser
 * goes away (the answer keeps running and is saved), and `close`.
 */
function openStream(req: ApiRequest, res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform: compressing proxies must pass events through as they come.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let open = true;
  const heartbeat = setInterval(() => open && res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  const stop = () => {
    open = false;
    clearInterval(heartbeat);
  };
  req.on('close', stop);
  return {
    send(event: AnswerEvent) {
      if (!open) return;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    close() {
      stop();
      if (!res.writableEnded) res.end();
    },
  };
}

function summary(
  c: { id: string; title: string; scope: unknown; createdAt: Date; updatedAt: Date },
  preview: string | null,
): z.infer<typeof ConversationSummary> {
  return {
    id: c.id,
    title: c.title || 'New chat',
    scope: storedScope(c.scope),
    preview: preview ? previewOf(preview) : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function previewOf(answer: string): string | null {
  // Plain words only: no citation markers, headings, bullets or bold.
  const text = answer
    .replace(/\s*\[\d+\]/g, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}

/**
 * Ask (PLAN, Phase 5): chats, and answers streamed with their sources. Viewers and up may ask;
 * every answer draws only on what the asker can open.
 */
@ApiTags('ask')
@ApiErrors()
@Controller()
export class ConversationsController {
  constructor(
    @Inject(AskService) private readonly ask: AskService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  /** A scope may only name a collection or files the viewer can open. */
  private async checkScope(viewer: Viewer, scope: AskScope): Promise<void> {
    if (scope.collectionId) await this.collections.open(viewer, scope.collectionId);
    for (const id of scope.fileIds ?? []) await this.files.open(viewer, id);
  }

  @Post('conversations')
  @RequireRole('viewer')
  @HttpCode(201)
  @ApiOperation({ summary: 'Start a chat with a scope (the whole workspace by default).' })
  @ApiOkResponse({ standardSchema: ConversationSchema })
  async create(
    @Ctx() auth: RequestAuth,
    @Body({ schema: CreateConversation }) body: z.infer<typeof CreateConversation>,
  ): Promise<z.infer<typeof ConversationSchema>> {
    const viewer = viewerOf(auth);
    await this.checkScope(viewer, body.scope);
    const created = await this.ask.db(viewer.workspaceId).conversation.create({
      data: {
        workspaceId: viewer.workspaceId,
        userId: viewer.userId,
        title: body.title ?? '',
        scope: body.scope as Prisma.InputJsonObject,
      },
    });
    return { ...summary(created, null), messages: [] };
  }

  @Get('conversations')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Your chats, most recent first; `q` searches titles and messages.' })
  @ApiOkResponse({ standardSchema: ConversationPage })
  async list(
    @Ctx() auth: RequestAuth,
    @Query({ schema: ListConversationsQuery }) query: z.infer<typeof ListConversationsQuery>,
  ): Promise<z.infer<typeof ConversationPage>> {
    const viewer = viewerOf(auth);
    const where: Prisma.ConversationWhereInput[] = [
      { userId: viewer.userId },
      // A chat appears once it has a question.
      { messages: { some: {} } },
    ];
    if (query.q) {
      where.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { messages: { some: { content: { contains: query.q, mode: 'insensitive' } } } },
        ],
      });
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      const at = new Date(cursor.k);
      where.push({ OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: cursor.id } }] });
    }
    const rows = await this.ask.db(viewer.workspaceId).conversation.findMany({
      where: { AND: where },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      include: {
        messages: {
          where: { role: 'ASSISTANT' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true },
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((c) => summary(c, c.messages[0]?.content ?? null)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ k: last.updatedAt.toISOString(), id: last.id })
          : null,
    };
  }

  @Get('conversations/:id')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'One of your chats, with every message and its sources.' })
  @ApiOkResponse({ standardSchema: ConversationSchema })
  async get(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof ConversationSchema>> {
    const viewer = viewerOf(auth);
    const conversation = await this.ask.conversation(viewer, id);
    const messages = await this.ask.db(viewer.workspaceId).message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      include: {
        citations: { orderBy: { n: 'asc' }, include: { file: { select: { kind: true } } } },
      },
    });
    const lastAnswer = messages.findLast((m) => m.role === 'ASSISTANT');
    return {
      ...summary(conversation, lastAnswer?.content ?? null),
      messages: await this.ask.presentAll(viewer, messages),
    };
  }

  @Patch('conversations/:id')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Rename a chat or change where its answers come from.' })
  @ApiOkResponse({ standardSchema: ConversationSummary })
  async update(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateConversation }) body: z.infer<typeof UpdateConversation>,
  ): Promise<z.infer<typeof ConversationSummary>> {
    const viewer = viewerOf(auth);
    await this.ask.conversation(viewer, id);
    if (body.scope) await this.checkScope(viewer, body.scope);
    const updated = await this.ask.db(viewer.workspaceId).conversation.update({
      where: { id },
      data: {
        ...(body.title ? { title: body.title } : {}),
        ...(body.scope ? { scope: body.scope as Prisma.InputJsonObject } : {}),
      },
    });
    return summary(updated, null);
  }

  @Delete('conversations/:id')
  @RequireRole('viewer')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete one of your chats and everything in it.' })
  @ApiNoContentResponse()
  async remove(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    const viewer = viewerOf(auth);
    await this.ask.conversation(viewer, id);
    await this.ask.db(viewer.workspaceId).conversation.delete({ where: { id } });
  }

  @Post('conversations/:id/messages')
  @RequireRole('viewer')
  @ApiOperation({
    summary:
      'Ask a question in a chat. The answer streams back as Server-Sent Events: `start`, ' +
      '`cite` (each source as first cited), `token`, then `done` or `error` (AnswerEvent).',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'text/event-stream', standardSchema: AnswerEvent })
  async askIn(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: AskBody }) body: z.infer<typeof AskBody>,
    @Req() req: ApiRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const conversation = await this.ask.conversation(viewer, id);
    const busy = await this.ask.db(viewer.workspaceId).message.findFirst({
      where: { conversationId: id, status: 'STREAMING' },
      select: { id: true },
    });
    if (busy) {
      throw new ApiException(409, 'ANSWER_IN_PROGRESS', 'Wait for the answer, or stop it first.');
    }
    await this.ask.checkRate(viewer);
    const stream = openStream(req, res);
    try {
      await this.ask.ask({ viewer, auth, conversation, question: body.content, send: stream.send });
    } finally {
      stream.close();
    }
  }

  @Post('messages/:id/regenerate')
  @RequireRole('viewer')
  @ApiOperation({ summary: 'Answer the question again, replacing this answer (streamed).' })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'text/event-stream', standardSchema: AnswerEvent })
  async regenerate(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Req() req: ApiRequest,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const message = await this.ask.answerOf(viewer, id);
    if (message.status === 'STREAMING') {
      throw new ApiException(409, 'ANSWER_IN_PROGRESS', 'Wait for the answer, or stop it first.');
    }
    await this.ask.checkRate(viewer);
    const stream = openStream(req, res);
    try {
      await this.ask.ask({
        viewer,
        auth,
        conversation: message.conversation,
        again: message,
        send: stream.send,
      });
    } finally {
      stream.close();
    }
  }

  @Post('messages/:id/stop')
  @RequireRole('viewer')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop an answer while it’s being written; what arrived is kept.' })
  @ApiNoContentResponse()
  async stop(@Ctx() auth: RequestAuth, @Param('id', { schema: IdParam }) id: string) {
    await this.ask.stop(viewerOf(auth), id);
  }

  @Post('messages/:id/feedback')
  @RequireRole('viewer')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rate an answer: 1 (helpful), -1 (not helpful) or 0 (clear).' })
  @ApiOkResponse({ standardSchema: MessageSchema.pick({ id: true, feedback: true }) })
  async feedback(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: FeedbackBody }) body: z.infer<typeof FeedbackBody>,
  ) {
    const viewer = viewerOf(auth);
    await this.ask.answerOf(viewer, id);
    const updated = await this.ask.db(viewer.workspaceId).message.update({
      where: { id },
      data: { feedback: body.value },
      select: { id: true, feedback: true },
    });
    return updated;
  }
}
