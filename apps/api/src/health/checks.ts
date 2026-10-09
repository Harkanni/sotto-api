import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import amqp from 'amqplib';
import { Redis } from 'ioredis';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { StorageService } from '../infra.module.js';

/** A dependency the api needs before it should receive traffic. */
export interface DependencyCheck {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}

export const DEPENDENCY_CHECKS = Symbol('DEPENDENCY_CHECKS');

@Injectable()
export class PostgresCheck implements DependencyCheck {
  readonly name = 'database';
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async check(): Promise<void> {
    await this.prisma.client.$queryRaw`SELECT 1`;
  }
}

@Injectable()
export class RedisCheck implements DependencyCheck, OnModuleDestroy {
  readonly name = 'redis';
  private readonly redis: Redis;

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    // lazyConnect: nothing happens until the first check, so builds and tests need no Redis.
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    this.redis.on('error', () => undefined); // reported through the check, not as an unhandled event
  }

  async check(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
    await this.redis.ping();
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}

/**
 * Uploads, reading and playback all need storage, and so does signing their URLs: no credentials
 * means no upload. Checking it here makes a deploy that can't reach the bucket fail instead of
 * going green (the demo once shipped with containers that had no AWS credentials; ADR 0018).
 */
@Injectable()
export class StorageCheck implements DependencyCheck {
  readonly name = 'storage';
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  async check(signal: AbortSignal): Promise<void> {
    await this.storage.ping(signal);
  }
}

@Injectable()
export class RabbitCheck implements DependencyCheck {
  readonly name = 'queue';
  constructor(@Inject(APP_CONFIG) private readonly config: ApiConfig) {}

  async check(): Promise<void> {
    const connection = await amqp.connect(this.config.RABBITMQ_URL, { timeout: 2_000 });
    await connection.close();
  }
}
