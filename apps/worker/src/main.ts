import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { baseEnv, loadEnv } from '@sotto/config';
import { Queues } from '@sotto/contracts';
import amqp from 'amqplib';
import { z } from 'zod';
import { decide } from './consumer.js';
import { log } from './log.js';

const env = loadEnv(
  baseEnv.extend({
    RABBITMQ_URL: z.string().min(1).default('amqp://sotto:sotto@localhost:5672'),
    WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4100),
  }),
);

let connection: Awaited<ReturnType<typeof amqp.connect>> | undefined;
let shuttingDown = false;

// Probes: liveness is "the process runs"; readiness is "connected to the queue".
const health = createServer((req, res) => {
  const ready = req.url === '/readyz' ? Boolean(connection) : true;
  if (req.url !== '/healthz' && req.url !== '/readyz') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ready ? 'ok' : 'connecting' }));
});
health.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');

async function connect(): Promise<void> {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      const conn = await amqp.connect(env.RABBITMQ_URL);
      const channel = await conn.createChannel();
      await channel.prefetch(4);
      for (const queue of Object.values(Queues))
        await channel.assertQueue(queue, { durable: true });

      await channel.consume(Queues.fileUploaded, (msg) => {
        if (!msg) return;
        const decision = decide(Queues.fileUploaded, msg.content);
        if (decision.action === 'reject') {
          log('warn', 'rejected message', { queue: Queues.fileUploaded, reason: decision.reason });
          channel.nack(msg, false, false);
          return;
        }
        // TODO(Phase 4): extract text or request transcription, then chunk and embed.
        log('info', 'received file.uploaded (processing arrives in Phase 4)');
        channel.ack(msg);
      });

      conn.on('close', () => {
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
      log('info', 'connected to queue', { attempt });
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

async function shutdown(signal: string): Promise<void> {
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  health.close();
  await connection?.close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log('info', 'starting', { version: env.APP_VERSION, commit: env.GIT_SHA });
await connect();
