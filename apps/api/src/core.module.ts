import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { loadEnv } from '@sotto/config';
import { createPrismaClient, type PrismaClient } from '@sotto/db';
import { Redis } from 'ioredis';
import { APP_CONFIG, apiEnv, type ApiConfig } from './config.js';

/** One Prisma client per process. It connects lazily on the first query. */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    this.client = createPrismaClient(config.DATABASE_URL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

/**
 * One Redis connection per process (rate limits now, caches later). lazyConnect: nothing
 * happens until first use, so builds, the OpenAPI script and unit tests need no Redis.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    this.client.on('error', () => undefined); // surfaced by readiness and the callers, by code
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadEnv(apiEnv) },
    PrismaService,
    RedisService,
  ],
  exports: [APP_CONFIG, PrismaService, RedisService],
})
export class CoreModule {}
