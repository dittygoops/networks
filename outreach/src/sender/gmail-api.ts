// Real Gmail sender over the Gmail API with OAuth (F6). Needed because ASU
// Workspace blocks SMTP app passwords; OAuth with the gmail.send scope is the
// supported path. Credentials come from a one-time consent (scripts/gmail-auth.ts).
import { google } from 'googleapis';
import type { OutboundEmail, Sender } from './types.js';

// Build an RFC 2822 message and base64url-encode it, as the Gmail API expects.
function toRawMessage(email: OutboundEmail): string {
  const headers = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${email.body}`;
  return Buffer.from(message, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createGmailApiSender(opts?: {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}): Sender {
  const clientId = opts?.clientId ?? process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = opts?.clientSecret ?? process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = opts?.refreshToken ?? process.env.GMAIL_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN missing. Run scripts/gmail-auth.ts once to get the refresh token.',
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });

  return {
    async send(email: OutboundEmail): Promise<{ sentId: string }> {
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: toRawMessage(email) },
      });
      return { sentId: res.data.id ?? `gmail-${Date.now()}` };
    },
  };
}
