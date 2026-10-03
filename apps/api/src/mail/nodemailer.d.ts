// The slice of nodemailer 10 the api uses. nodemailer ships no types and @types/nodemailer
// trails its major versions, so this declares exactly what we call.
declare module 'nodemailer' {
  export interface SendMailOptions {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }

  export interface Transporter {
    sendMail(options: SendMailOptions): Promise<{ messageId: string }>;
    verify(): Promise<true>;
    close(): void;
  }

  export function createTransport(url: string): Transporter;

  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}
