import {
  Controller,
  Inject,
  Injectable,
  Logger,
  type MessageEvent,
  Module,
  type OnModuleDestroy,
  Sse,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrowserFileEvent, FileEvent } from '@sotto/contracts';
import { type Role, forWorkspace } from '@sotto/db';
import { Redis } from 'ioredis';
import { Observable } from 'rxjs';
import { RequireRole } from '../auth/auth.guard.js';
import { atLeast } from '../auth/roles.js';
import { visibleTo } from '../collections/collections.service.js';
import { ApiErrors } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';

/** How long a viewer's list of visible collections is trusted before it's reloaded. */
const VISIBILITY_TTL_MS = 15_000;
/** Proxies close idle connections; a comment-sized event every 25 s keeps the stream open. */
const HEARTBEAT_MS = 25_000;

interface Subscriber {
  userId: string;
  role: Role;
  workspaceId: string;
  visible: Set<string>;
  loadedAt: number;
  loading: Promise<void> | null;
  push: (event: BrowserFileEvent) => void;
}

/**
 * Fans file events from Redis out to the browsers watching that workspace. One subscriber
 * connection per api process, opened when the first browser connects.
 *
 * Every event is filtered per viewer with the same rules as the files API (ADR 0016): someone
 * who can't open a file never hears of it, not even its id.
 */
@Injectable()
export class EventsHub implements OnModuleDestroy {
  private readonly log = new Logger('events');
  private redis: Redis | null = null;
  private readonly byWorkspace = new Map<string, Set<Subscriber>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private listen(): void {
    if (this.redis) return;
    const redis = new Redis(this.config.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    redis.on('error', (error: Error) => this.log.warn(`subscriber error (${error.name})`));
    void redis.psubscribe('sotto:events:*');
    redis.on('pmessage', (_pattern: string, channel: string, raw: string) => {
      const workspaceId = channel.slice('sotto:events:'.length);
      const subscribers = this.byWorkspace.get(workspaceId);
      if (!subscribers?.size) return;
      let event: FileEvent;
      try {
        event = FileEvent.parse(JSON.parse(raw));
      } catch {
        return; // not ours, or an older shape: the next refetch catches up
      }
      for (const subscriber of subscribers) void this.deliver(subscriber, event);
    });
    this.redis = redis;
  }

  /** Reloads the viewer's role and the collections they can see. */
  private refresh(subscriber: Subscriber): Promise<void> {
    subscriber.loading ??= (async () => {
      const db = forWorkspace(this.prisma.client, subscriber.workspaceId);
      const membership = await db.membership.findFirst({
        where: { userId: subscriber.userId },
        select: { role: true },
      });
      if (membership) subscriber.role = membership.role;
      const viewer = { userId: subscriber.userId, role: subscriber.role };
      const collections = await db.collection.findMany({
        where: visibleTo({ ...viewer, workspaceId: subscriber.workspaceId }),
        select: { id: true },
      });
      subscriber.visible = new Set(collections.map((c) => c.id));
      subscriber.loadedAt = Date.now();
    })().finally(() => {
      subscriber.loading = null;
    });
    return subscriber.loading;
  }

  private async canSee(subscriber: Subscriber, event: FileEvent): Promise<boolean> {
    if (Date.now() - subscriber.loadedAt > VISIBILITY_TTL_MS) await this.refresh(subscriber);
    if (atLeast(subscriber.role, 'admin')) return true;
    if (!event.collectionId) return !event.deleted || event.ownerId === subscriber.userId;
    return subscriber.visible.has(event.collectionId);
  }

  private async deliver(subscriber: Subscriber, event: FileEvent): Promise<void> {
    try {
      if (await this.canSee(subscriber, event)) subscriber.push(BrowserFileEvent.parse(event));
    } catch (error) {
      this.log.warn(`event not delivered (${error instanceof Error ? error.name : 'error'})`);
    }
  }

  connect(auth: RequestAuth): Observable<MessageEvent> {
    const workspace = workspaceOf(auth);
    this.listen();
    return new Observable<MessageEvent>((observer) => {
      const subscriber: Subscriber = {
        userId: auth.user.id,
        role: workspace.role,
        workspaceId: workspace.id,
        visible: new Set(),
        loadedAt: 0,
        loading: null,
        push: (event) => observer.next({ type: 'file', data: event }),
      };
      const set = this.byWorkspace.get(workspace.id) ?? new Set<Subscriber>();
      set.add(subscriber);
      this.byWorkspace.set(workspace.id, set);
      void this.refresh(subscriber).catch(() => undefined);
      // Tells the browser the stream is live (it refetches what it may have missed while away).
      observer.next({ type: 'ready', data: { at: new Date().toISOString() } });
      const heartbeat = setInterval(() => observer.next({ type: 'ping', data: '' }), HEARTBEAT_MS);
      return () => {
        clearInterval(heartbeat);
        set.delete(subscriber);
        if (!set.size) this.byWorkspace.delete(workspace.id);
      };
    });
  }

  /** For tests: how many browsers are listening in a workspace. */
  listeners(workspaceId: string): number {
    return this.byWorkspace.get(workspaceId)?.size ?? 0;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}

@ApiTags('events')
@ApiErrors()
@Controller('events')
export class EventsController {
  constructor(@Inject(EventsHub) private readonly hub: EventsHub) {}

  @Sse()
  @RequireRole('viewer')
  @ApiOperation({
    summary:
      'Live file status for this workspace (Server-Sent Events): `file` events as files upload, ' +
      'process, move or leave; `ready` when connected; `ping` every 25 s.',
  })
  @ApiOkResponse({ description: 'text/event-stream', standardSchema: BrowserFileEvent })
  stream(@Ctx() auth: RequestAuth): Observable<MessageEvent> {
    return this.hub.connect(auth);
  }
}

@Module({ controllers: [EventsController], providers: [EventsHub], exports: [EventsHub] })
export class EventsModule {}
