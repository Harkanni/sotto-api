import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { type FileEvent, type QueueName, eventsChannel, messageSchemas } from '@sotto/contracts';
import { Storage } from '@sotto/storage';
import amqp from 'amqplib';
import type { z } from 'zod';
import { APP_CONFIG, type ApiConfig } from './config.js';
import { RedisService } from './core.module.js';

/** Object storage, configured from the environment (S3 on AWS, SeaweedFS locally). */
@Injectable()
export class StorageService extends Storage {
  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    super(config);
  }
}

type MessageOf<Q extends QueueName> = z.input<(typeof messageSchemas)[Q]>;

/**
 * Publishes jobs for the worker and transcriber. Connects on first use and reconnects after a
 * drop, so the api starts (and serves everything else) while RabbitMQ is still coming up.
 * Messages are validated against their contract before they leave, and persisted, so a broker
 * restart doesn't lose an upload's job.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger('queue');
  private channel: Promise<amqp.ConfirmChannel> | null = null;
  private connection: amqp.ChannelModel | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: ApiConfig) {}

  private open(): Promise<amqp.ConfirmChannel> {
    this.channel ??= (async () => {
      const connection = await amqp.connect(this.config.RABBITMQ_URL);
      const reset = () => {
        this.channel = null;
        this.connection = null;
      };
      connection.on('close', reset);
      connection.on('error', (error: Error) =>
        this.log.warn(`queue connection error (${error.name})`),
      );
      this.connection = connection;
      return connection.createConfirmChannel();
    })().catch((error: unknown) => {
      this.channel = null;
      throw error;
    });
    return this.channel;
  }

  async publish<Q extends QueueName>(queue: Q, message: MessageOf<Q>): Promise<void> {
    const body = messageSchemas[queue].parse(message);
    const channel = await this.open();
    await channel.assertQueue(queue, { durable: true });
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(body)), {
      persistent: true,
      contentType: 'application/json',
    });
    // Wait for the broker's confirm, so "uploaded" means the job is safely queued.
    await channel.waitForConfirms();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close().catch(() => undefined);
  }
}

/**
 * Publishes file changes to the workspace's Redis channel; the events controller relays them to
 * browsers. Best effort: a missed event only delays a screen until its next refetch, so a Redis
 * hiccup never fails the request that caused it.
 */
@Injectable()
export class EventPublisher {
  private readonly log = new Logger('events');

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async file(workspaceId: string, event: Omit<FileEvent, 'type' | 'at'>): Promise<void> {
    const full: FileEvent = { type: 'file', at: new Date().toISOString(), ...event };
    try {
      await this.redis.client.publish(eventsChannel(workspaceId), JSON.stringify(full));
    } catch (error) {
      this.log.warn(`event not published (${error instanceof Error ? error.name : 'error'})`);
    }
  }
}

@Global()
@Module({
  providers: [StorageService, QueueService, EventPublisher],
  exports: [StorageService, QueueService, EventPublisher],
})
export class InfraModule {}
