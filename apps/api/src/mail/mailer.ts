import { Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Thrown when the api has no way to send email (SMTP_URL unset). */
export class MailNotConfiguredError extends Error {
  readonly code = 'MAIL_NOT_CONFIGURED';
  constructor() {
    super('Email is not set up on this server');
    this.name = 'MailNotConfiguredError';
  }
}

/** Sends the app's email: sign-in links and invites. Swapped for a capturing fake in tests. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Any SMTP server, chosen by SMTP_URL: Mailpit locally (smtp://localhost:1025), and SES or
 * another provider in deployments (smtps://user:pass@email-smtp.eu-west-2.amazonaws.com:465).
 * Message bodies carry sign-in links, so nothing about them is ever logged.
 */
export class SmtpMailer extends Mailer {
  private readonly transport: Transporter;
  private readonly log = new Logger('mail');

  constructor(
    url: string,
    private readonly from: string,
  ) {
    super();
    this.transport = createTransport(url);
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.from, ...message });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.log.error(`send failed: ${typeof code === 'string' ? code : 'error'}`);
      throw error;
    }
  }
}

/** Used when SMTP_URL is unset: every send fails with a clear error the web can show. */
export class UnconfiguredMailer extends Mailer {
  async send(): Promise<void> {
    throw new MailNotConfiguredError();
  }
}
