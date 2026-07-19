// Real Gmail sender over SMTP with an app password. Requires 2-Step Verification
// on the account and the org allowing app passwords (F6 open question; if ASU
// blocks them, add a gmail-api.ts behind the same Sender interface instead).
import nodemailer from 'nodemailer';
import type { OutboundEmail, Sender } from './types.js';

export function createGmailSmtpSender(opts?: { user?: string; appPassword?: string }): Sender {
  const user = opts?.user ?? process.env.SENDER_EMAIL;
  const appPassword = opts?.appPassword ?? process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error('SENDER_EMAIL / GMAIL_APP_PASSWORD missing (run with --env-file=.env)');
  }
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass: appPassword.replace(/\s+/g, '') }, // Google renders app passwords with spaces
  });

  return {
    async send(email: OutboundEmail): Promise<{ sentId: string }> {
      const info = await transport.sendMail({
        from: email.from,
        to: email.to,
        subject: email.subject,
        text: email.body,
      });
      return { sentId: info.messageId ?? `smtp-${Date.now()}` };
    },
  };
}
