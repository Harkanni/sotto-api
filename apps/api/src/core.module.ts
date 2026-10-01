import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { loadEnv } from '@sotto/config';
import { createPrismaClient, type PrismaClient } from '@sotto/db';
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

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadEnv(apiEnv) }, PrismaService],
  exports: [APP_CONFIG, PrismaService],
})
export class CoreModule {}
