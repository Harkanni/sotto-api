import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { Mailer, SmtpMailer, UnconfiguredMailer } from './mailer.js';

@Global()
@Module({
  providers: [
    {
      provide: Mailer,
      inject: [APP_CONFIG],
      useFactory: (config: ApiConfig): Mailer => {
        if (config.SMTP_URL) return new SmtpMailer(config.SMTP_URL, config.MAIL_FROM);
        new Logger('mail').warn('SMTP_URL is not set: sign-in links and invites cannot be sent');
        return new UnconfiguredMailer();
      },
    },
  ],
  exports: [Mailer],
})
export class MailModule {}
