import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { UsageController } from './usage.controller.js';
import { UsageService } from './usage.service.js';

/** Metering, plans and payments. Global: Ask, uploads and AI settings all check the plan. */
@Global()
@Module({
  controllers: [UsageController, BillingController],
  providers: [UsageService, BillingService],
  exports: [UsageService, BillingService],
})
export class BillingModule {}
