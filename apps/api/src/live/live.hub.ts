import {
  Inject,
  Injectable,
  Logger,
  type MessageEvent,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { Observable } from 'rxjs';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { RedisService } from '../core.module.js';

/** What a live session's stream carries. `id` (segments only) lets a browser resume. */
export interface LiveEvent {
  type: 'session' | 'segment' | 'notes';
  data: unknown;
  id?: string;
}

const CHANNEL = 'sotto:live:';
/** Proxies close idle connections; a comment-sized event every 25 s keeps the stream open. */
const HEARTBEAT_MS = 25_000;

/**
 * Fans one live session's events out to the browsers watching it, through Redis so it works
 * whichever api process received the audio. Access is checked once, when a browser connects
 * (the controller opens the session's file for the viewer); a session's events only ever reach
 * people who could open its meeting.
 */
@Injectable()
export class LiveHub implements OnModuleDestroy {
  private readonly log = new Logger('live');
  private redis: Redis | null = null;
  private readonly bySession = new Map<string, Set<(event: LiveEvent) => void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(RedisService) private readonly publisher: RedisService,
  ) {}

  async publish(sessionId: string, event: LiveEvent): Promise<void> {
    try {
      await this.publisher.client.publish(CHANNEL + sessionId, JSON.stringify(event));
    } catch (error) {
      this.log.warn(`live event not published (${error instanceof Error ? error.name : 'error'})`);
    }
  }

  private listen(): void {
    if (this.redis) return;
    const redis = new Redis(this.config.REDIS_URL, { maxRetriesPerRequest: null });
    redis.on('error', (error: Error) => this.log.warn(`subscriber error (${error.name})`));
    void redis.psubscribe(`${CHANNEL}*`);
    redis.on('pmessage', (_pattern: string, channel: string, raw: string) => {
      const listeners = this.bySession.get(channel.slice(CHANNEL.length));
      if (!listeners?.size) return;
      let event: LiveEvent;
      try {
        event = JSON.parse(raw) as LiveEvent;
      } catch {
        return;
      }
      for (const push of listeners) push(event);
    });
    this.redis = redis;
  }

  /**
   * A stream for one viewer: `first` (the snapshot and the transcript they missed) goes out
   * before anything live, and live events that arrive meanwhile wait behind it, so nothing is
   * lost or shown twice.
   */
  connect(sessionId: string, first: () => Promise<LiveEvent[]>): Observable<MessageEvent> {
    this.listen();
    return new Observable<MessageEvent>((observer) => {
      let ready = false;
      const waiting: LiveEvent[] = [];
      const seen = new Set<string>();
      const send = (event: LiveEvent) => {
        if (event.id) {
          if (seen.has(event.id)) return;
          seen.add(event.id);
        }
        observer.next({
          type: event.type,
          data: event.data as object,
          ...(event.id ? { id: event.id } : {}),
        });
      };
      const push = (event: LiveEvent) => (ready ? send(event) : waiting.push(event));
      const set = this.bySession.get(sessionId) ?? new Set();
      set.add(push);
      this.bySession.set(sessionId, set);
      first().then(
        (events) => {
          for (const event of events) send(event);
          ready = true;
          for (const event of waiting.splice(0)) send(event);
        },
        (error: unknown) => observer.error(error),
      );
      const heartbeat = setInterval(() => observer.next({ type: 'ping', data: '' }), HEARTBEAT_MS);
      return () => {
        clearInterval(heartbeat);
        set.delete(push);
        if (!set.size) this.bySession.delete(sessionId);
      };
    });
  }

  /** For tests: how many browsers watch a session. */
  listeners(sessionId: string): number {
    return this.bySession.get(sessionId)?.size ?? 0;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}
