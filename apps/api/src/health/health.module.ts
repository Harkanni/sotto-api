import { Module } from '@nestjs/common';
import { DEPENDENCY_CHECKS, PostgresCheck, RabbitCheck, RedisCheck } from './checks.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { StatusController } from './status.controller.js';

@Module({
  controllers: [HealthController, StatusController],
  providers: [
    PostgresCheck,
    RedisCheck,
    RabbitCheck,
    {
      provide: DEPENDENCY_CHECKS,
      useFactory: (...checks: Array<PostgresCheck | RedisCheck | RabbitCheck>) => checks,
      inject: [PostgresCheck, RedisCheck, RabbitCheck],
    },
    HealthService,
  ],
})
export class HealthModule {}
