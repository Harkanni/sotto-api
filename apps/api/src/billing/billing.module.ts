import { Global, Module } from '@nestjs/common';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

/** Metering, plans and (M6) payments. Global: Ask, uploads and AI settings all check the plan. */
@Global()
@Module({
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class BillingModule {}
