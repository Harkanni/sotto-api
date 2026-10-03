import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CoreModule } from './core.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { MeModule } from './me/me.controller.js';
import { MembersModule } from './members/members.controller.js';
import { WorkspacesModule } from './workspaces/workspaces.controller.js';

@Module({
  imports: [
    CoreModule,
    MailModule,
    AuthModule,
    AuditModule,
    HealthModule,
    MeModule,
    WorkspacesModule,
    MembersModule,
  ],
})
export class AppModule {}
