import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [CoreModule, HealthModule],
})
export class AppModule {}
