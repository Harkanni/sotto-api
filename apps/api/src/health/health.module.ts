import { Module } from '@nestjs/common';
import {
  DEPENDENCY_CHECKS,
  type DependencyCheck,
  PostgresCheck,
  RabbitCheck,
  RedisCheck,
  StorageCheck,
} from './checks.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { StatusController } from './status.controller.js';

@Module({
  controllers: [HealthController, StatusController],
  providers: [
    PostgresCheck,
    RedisCheck,
    RabbitCheck,
    StorageCheck,
    {
      provide: DEPENDENCY_CHECKS,
      useFactory: (...checks: DependencyCheck[]) => checks,
      inject: [PostgresCheck, RedisCheck, RabbitCheck, StorageCheck],
    },
    HealthService,
  ],
})
export class HealthModule {}
