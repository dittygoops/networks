// From is an RFC 5322 mailbox, not a bare address. Gmail returns
// 'Aditya Gupta <apgupta3@asu.edu>', so a naive
// `header.from !== process.env.SENDER_EMAIL` compare is ALWAYS true. That would
// classify Aditya's own follow-up in a thread as an inbound reply, notify him
// about himself, close the thread, and write fabricated ground truth into the
// exact table the whole evaluation section depends on.
export type ReplyKind = 'human' | 'auto_reply' | 'bounce';

// The LAST <...> group, because a display name may legitimately contain angle
// brackets and an adversarial one certainly will:
// '"a <fake@evil.com>" <real@asu.edu>' must yield real@asu.edu.
export function extractAddress(mailbox: string): string {
  const groups = [...mailbox.matchAll(/<([^<>]*)>/g)];
  const raw = groups.length > 0 ? groups[groups.length - 1]![1]! : mailbox;
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

// Case-insensitive on both sides, and compared against SENDER_EMAIL and
// nothing else. If SENDER_EMAIL is unset the CALLER refuses to start rather
// than defaulting, which is why this takes it as a parameter instead of
// reading process.env: a default here would silently make every message
// inbound.
export function isOurs(mailbox: string, senderEmail: string): boolean {
  return extractAddress(mailbox).toLowerCase() === senderEmail.trim().toLowerCase();
}

const AUTO_PRECEDENCE = new Set(['auto_reply', 'bulk', 'junk']);

// Header-only. Misclassification is cheap by construction: it can change a
// notification and a metric slice, never an outbound action, and the row is
// reclassifiable by hand because from_address and kind are both stored.
export function classifyKind(headers: Record<string, string>): ReplyKind {
  const from = extractAddress(headers.from ?? '').toLowerCase();
  if (/^(mailer-daemon|postmaster)@/.test(from)) return 'bounce';

  const autoSubmitted = (headers['auto-submitted'] ?? '').trim().toLowerCase();
  // 'no' is what a normal message carries; presence alone means nothing.
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_reply';
  if (AUTO_PRECEDENCE.has((headers.precedence ?? '').trim().toLowerCase())) return 'auto_reply';
  if ((headers['x-autoreply'] ?? '').trim().toLowerCase() === 'yes') return 'auto_reply';

  return 'human';
}
