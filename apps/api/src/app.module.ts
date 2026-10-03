import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { CoreModule } from './core.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { MeModule } from './me/me.controller.js';

@Module({
  imports: [CoreModule, MailModule, AuthModule, HealthModule, MeModule],
})
export class AppModule {}
