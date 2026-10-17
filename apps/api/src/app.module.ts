import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.controller.js';
import { AskModule } from './ask/ask.module.js';
import { AuditApiModule } from './audit/audit.controller.js';
import { AuditModule } from './audit/audit.service.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { CollectionsModule } from './collections/collections.controller.js';
import { CoreModule } from './core.module.js';
import { EventsModule } from './events/events.controller.js';
import { FilesModule } from './files/files.controller.js';
import { HealthModule } from './health/health.module.js';
import { InfraModule } from './infra.module.js';
import { LiveModule } from './live/live.controller.js';
import { MailModule } from './mail/mail.module.js';
import { MeModule } from './me/me.controller.js';
import { MembersModule } from './members/members.controller.js';
import { NotetakerModule } from './notetaker/notetaker.controller.js';
import { OnboardingModule } from './onboarding/onboarding.controller.js';
import { WorkspacesModule } from './workspaces/workspaces.controller.js';

@Module({
  imports: [
    CoreModule,
    InfraModule,
    MailModule,
    AuthModule,
    AuditModule,
    BillingModule,
    HealthModule,
    MeModule,
    WorkspacesModule,
    MembersModule,
    CollectionsModule,
    AuditApiModule,
    OnboardingModule,
    FilesModule,
    EventsModule,
    AskModule,
    AiModule,
    LiveModule,
    NotetakerModule,
  ],
})
export class AppModule {}
