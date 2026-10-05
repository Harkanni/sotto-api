import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { aiEnv, embeddingProviderFrom, privateChatFrom } from '@sotto/ai';
import { baseEnv, loadEnv } from '@sotto/config';
import {
  DEAD_LETTER_QUEUE,
  type FileEvent,
  type QueueName,
  Queues,
  eventsChannel,
} from '@sotto/contracts';
import { createPrismaClient } from '@sotto/db';
import { Storage, storageEnv } from '@sotto/storage';
import amqp from 'amqplib';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { decide } from './consumer.js';
import { log } from './log.js';
import {
  type Deps,
  PermanentFailure,
  failureCode,
  markFailed,
  onFileUploaded,
  onTranscribeCompleted,
  onTranscribeProgress,
  purgeTrash,
} from './pipeline.js';

const env = loadEnv(
  baseEnv.extend({
    RABBITMQ_URL: z.string().min(1).default('amqp://sotto:sotto@localhost:5672'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
    /** Jobs handled at once. Embedding and PDF parsing are CPU-heavy; keep it small on tiny servers. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    WORKER_MAX_DOCUMENT_MB: z.coerce.number().int().positive().default(100),
    ...storageEnv.shape,
    ...aiEnv.shape,
  }),
);

/** Attempts before a job is given up on: the file is marked FAILED and the message dead-lettered. */
const MAX_ATTEMPTS = 3;
const PURGE_EVERY_MS = 60 * 60_000;

const prisma = createPrismaClient(env.DATABASE_URL);
const storage = new Storage(env);
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
redis.on('error', () => undefined); // events are best effort; the database is the truth

let channel: amqp.Channel | undefined;
let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
let shuttingDown = false;

const deps: Deps = {
  prisma,
  storage,
  embeddings: embeddingProviderFrom(env),
  chat: privateChatFrom(env),
  maxDocumentBytes: env.WORKER_MAX_DOCUMENT_MB * 1024 * 1024,
  async publish(queue, message) {
    if (!channel) throw new Error('queue not connected');
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
    });
  },
  async emit(workspaceId, event) {
    const full: FileEvent = { type: 'file', at: new Date().toISOString(), ...event };
    await redis.publish(eventsChannel(workspaceId), JSON.stringify(full)).catch(() => undefined);
  },
};

// Probes: liveness is "the process runs"; readiness is "connected to the queue".
const health = createServer((req, res) => {
  if (req.url !== '/healthz' && req.url !== '/readyz') {
    res.writeHead(404).end();
    return;
  }
  const ready = req.url === '/readyz' ? Boolean(channel) : true;
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ready ? 'ok' : 'connecting' }));
});
health.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');

type Handler = (message: never) => Promise<void>;
const handlers: Partial<Record<QueueName, Handler>> = {
  [Queues.fileUploaded]: (m) => onFileUploaded(deps, m),
  [Queues.transcribeProgress]: (m) => onTranscribeProgress(deps, m),
  [Queues.transcribeCompleted]: (m) => onTranscribeCompleted(deps, m),
};

/**
 * One message: validate, handle, ack. A transient failure is retried with backoff by
 * republishing with an attempt count (so the queue keeps moving meanwhile); a permanent one, or
 * the last attempt, marks the file FAILED and parks the message in the dead-letter queue.
 */
async function handle(ch: amqp.Channel, queue: QueueName, msg: amqp.ConsumeMessage) {
  const decision = decide(queue, msg.content);
  if (decision.action === 'reject') {
    log('warn', 'rejected message', { queue, reason: decision.reason });
    ch.sendToQueue(DEAD_LETTER_QUEUE, msg.content, {
      persistent: true,
      headers: { queue, reason: decision.reason },
    });
    ch.ack(msg);
    return;
  }
  const message = decision.message as { fileId?: string; workspaceId?: string };
  const attempt = Number(msg.properties.headers?.['x-attempt'] ?? 1);
  const started = Date.now();
  try {
    await handlers[queue]!(decision.message as never);
    if (queue !== Queues.transcribeProgress) {
      log('info', 'handled', { queue, fileId: message.fileId, ms: Date.now() - started });
    }
    ch.ack(msg);
  } catch (error) {
    const code = failureCode(error);
    const permanent = error instanceof PermanentFailure;
    log(permanent ? 'warn' : 'error', 'job failed', {
      queue,
      fileId: message.fileId,
      attempt,
      code,
      error: error instanceof Error ? error.name : 'error',
    });
    if (!permanent && attempt < MAX_ATTEMPTS) {
      await sleep(2_000 * 4 ** (attempt - 1)); // 2 s, 8 s
      ch.sendToQueue(queue, msg.content, {
        persistent: true,
        contentType: 'application/json',
        headers: { 'x-attempt': attempt + 1 },
      });
      ch.ack(msg);
      return;
    }
    if (message.fileId && message.workspaceId) {
      await markFailed(deps, message.workspaceId, message.fileId, code).catch(() => undefined);
    }
    ch.sendToQueue(DEAD_LETTER_QUEUE, msg.content, {
      persistent: true,
      headers: { queue, code, attempts: attempt },
    });
    ch.ack(msg);
  }
}

async function connect(): Promise<void> {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      const conn = await amqp.connect(env.RABBITMQ_URL);
      const ch = await conn.createChannel();
      // How many jobs run at once in this process (each queue gets its own share).
      await ch.prefetch(env.WORKER_CONCURRENCY);
      for (const queue of [...Object.values(Queues), DEAD_LETTER_QUEUE]) {
        await ch.assertQueue(queue, { durable: true });
      }
      for (const queue of Object.keys(handlers) as QueueName[]) {
        await ch.consume(queue, (msg) => {
          if (msg) void handle(ch, queue, msg);
        });
      }
      conn.on('close', () => {
        channel = undefined;
        connection = undefined;
        if (!shuttingDown) {
          log('warn', 'queue connection closed, reconnecting');
          void connect();
        }
      });
      conn.on('error', (error: Error) =>
        log('error', 'queue connection error', { error: error.name }),
      );
      connection = conn;
      channel = ch;
      log('info', 'connected to queue', {
        attempt,
        embeddings: `${deps.embeddings.id}:${deps.embeddings.model}`,
        notes: deps.chat ? `${deps.chat.provider.id}:${deps.chat.model}` : 'basic (no chat model)',
      });
      return;
    } catch (error) {
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      log('warn', 'queue not reachable yet', {
        attempt,
        retryInMs: delay,
        error: error instanceof Error ? error.name : 'error',
      });
      await sleep(delay);
    }
  }
}

// The trash empties itself: files deleted more than 30 days ago go for good, every hour.
const purge = setInterval(() => {
  purgeTrash(deps)
    .then((n) => n && log('info', 'purged trashed files', { count: n }))
    .catch((error: unknown) =>
      log('warn', 'purge failed', { error: error instanceof Error ? error.name : 'error' }),
    );
}, PURGE_EVERY_MS);
purge.unref();

async function shutdown(signal: string): Promise<void> {
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  clearInterval(purge);
  health.close();
  await connection?.close().catch(() => undefined);
  redis.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log('info', 'starting', { version: env.APP_VERSION, commit: env.GIT_SHA });
await connect();
