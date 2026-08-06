// The read seam, and the privacy boundary stated as code structure.
//
// Everything above this file sees ThreadMessage and nothing else. It cannot see
// a body, a snippet, a subject, or a label, because they are not in the type
// and not in the object. That is the whole defence, together with the scope
// itself: gmail.metadata "View your email message metadata such as labels and
// headers, but not the email body" is structurally incapable of returning a
// body, so even a buggy implementation here cannot fetch a researcher's reply
// text. Google enforces it, not our restraint.
//
// This module has NO Sender dependency and must never be given one. It reads
// Gmail; it does not write email of any kind.
import { google } from 'googleapis';

export interface ThreadMessage {
  id: string;
  threadId: string;
  internalDate: string;      // epoch ms, as a string, exactly as Gmail sends it
  headers: Record<string, string>;
}

export interface GmailReader {
  // Do NOT assume the first message in a thread has id == threadId. It is
  // widely observed and nowhere documented, and the check costs 20 quota units.
  threadIdForMessage(messageId: string): Promise<string | null>;
  getThreadMetadata(threadId: string): Promise<ThreadMessage[]>;
}

// The five the classifier in replyClassify.ts needs, and no more. Subject is
// deliberately absent: it is the researcher's text, it is almost always 'Re:'
// our own subject, and it buys nothing.
export const METADATA_HEADERS = ['From', 'Date', 'Auto-Submitted', 'Precedence', 'X-Autoreply'] as const;
const WANTED = new Set(METADATA_HEADERS.map((h) => h.toLowerCase()));

// Project at the boundary, unconditionally. Whether format=metadata actually
// returns a snippet is ASSUMED, not documented, and this drops one either way:
// it costs nothing if the assumption is wrong and is the whole defence if it is
// right.
export function projectMessage(raw: unknown): ThreadMessage | null {
  const m = raw as {
    id?: string; threadId?: string; internalDate?: string;
    payload?: { headers?: { name?: string; value?: string }[] };
  } | null;
  if (!m?.id || !m.threadId || !m.internalDate) return null;
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const name = (h.name ?? '').toLowerCase();
    if (WANTED.has(name) && h.value != null) headers[name] = h.value;
  }
  return { id: m.id, threadId: m.threadId, internalDate: m.internalDate, headers };
}

export type FailureScope = 'thread' | 'cycle';

// Blocker 2. A per-thread failure and a cycle-wide one are different animals,
// and the earlier design had one counter for both. An expired refresh token, a
// 429, a 5xx or a SQLITE_BUSY fails EVERY row selected in that cycle at once;
// counting five of those against each row marks the entire watch set
// unresolvable in about 30 hours, and unresolvable had no recovery path.
//
// Only a failure attributable to ONE thread may increment that thread's
// counter. Everything else aborts the cycle without touching any row.
export function classifyFailure(err: unknown): FailureScope {
  const e = err as { status?: number; code?: string | number; message?: string } | null;
  const status = typeof e?.status === 'number' ? e.status : undefined;

  // 404: this thread was deleted. Genuinely about this thread.
  if (status === 404) return 'thread';
  // 401/403 are credentials or scope, 429 is quota: all cycle-wide by nature.
  if (status === 401 || status === 403 || status === 429) return 'cycle';
  if (status !== undefined && status >= 500) return 'cycle';
  // Any other 4xx is a malformed request about this specific id.
  if (status !== undefined && status >= 400) return 'thread';

  const code = typeof e?.code === 'string' ? e.code : '';
  if (code.startsWith('SQLITE_')) return 'cycle';          // BUSY, READONLY, FULL
  if (/^(ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)$/.test(code)) return 'cycle';
  if (typeof e?.message === 'string' && /invalid_grant|invalid_client|unauthorized/i.test(e.message)) return 'cycle';

  // Unknown. Stop the run and raise the alarm rather than blaming whichever
  // thread happened to be in hand. Failing loud beats failing wide.
  return 'cycle';
}

export function createGmailReader(opts?: {
  clientId?: string; clientSecret?: string; refreshToken?: string;
}): GmailReader {
  const clientId = opts?.clientId ?? process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = opts?.clientSecret ?? process.env.GMAIL_OAUTH_CLIENT_SECRET;
  // A SEPARATE token from GMAIL_OAUTH_REFRESH_TOKEN, carrying gmail.metadata
  // only. The read path is structurally unable to send and the send path is
  // structurally unable to read.
  const refreshToken = opts?.refreshToken ?? process.env.GMAIL_OAUTH_READ_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    // Fail loud with the remedy, in the style of createGmailApiSender
    // (gmail-api.ts:33-37). Never degrade to a silent no-op: a reply poller
    // that reports nothing is indistinguishable from nobody having replied.
    throw new Error(
      'GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_READ_REFRESH_TOKEN missing. ' +
        'Run: npx tsx --env-file=.env scripts/gmail-auth.ts --scope=gmail.metadata',
    );
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });

  return {
    async threadIdForMessage(messageId) {
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata' });
      return res.data.threadId ?? null;
    },
    async getThreadMetadata(threadId) {
      // users.messages.list explicitly rejects `q` under gmail.metadata
      // ("Parameter cannot be used when accessing the api using the
      // gmail.metadata scope"). This design never needs it: threads.get takes
      // an id, and it touches only threads this system started, so the code
      // never enumerates Aditya's inbox at all.
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: [...METADATA_HEADERS],
      });
      return (res.data.messages ?? []).map(projectMessage).filter((m): m is ThreadMessage => m !== null);
    },
  };
}
