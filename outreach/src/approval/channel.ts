// The approval channel seam. This plan implements approve and skip only; F5
// (docs/spec-imessage-approval-loop.md) owns the edit path and will implement
// this same interface.
import { parseShortId, formatShortId } from './ids.js';

export interface OutboundDraftMessage {
  shortId: string;
  subject: string;
  body: string;
  to: string;
  personName: string;
}

export interface InboundReply {
  text: string;
  messageId: string;
}

export type ParsedReply =
  | { kind: 'approve'; shortId: string }
  | { kind: 'skip'; shortId: string }
  | { kind: 'address'; shortId: string; email: string }
  | { kind: 'unsupported'; shortId: string }
  | { kind: 'unparseable' };

// Why a returned value and not a rejection: the real channel deliberately does
// not throw out of an unattended daemon (one bad session must not kill the
// process), so before this type existed a stream failure and a clean end were
// literally the same observation, and the listener's failure ceiling and
// backoff were unreachable code. The outcome makes the difference data.
// `detail` is present only on 'error' and carries the stringified cause.
export interface StreamOutcome {
  reason: 'ended' | 'error';
  detail?: string;
}

export interface ApprovalChannel {
  sendDraftMessage(msg: OutboundDraftMessage): Promise<void>;
  notify(text: string): Promise<void>;
  // Batch semantics: collect for a bounded window, then return everything at
  // once. Right for the daily run, wrong for a daemon, since nothing is handed
  // back until the window closes.
  captureReplies(windowMs: number): Promise<InboundReply[]>;
  // Push semantics: invoke onReply as each message arrives, and resolve only
  // when the underlying stream ends. This is what a long-lived listener needs.
  // A real approval sat unprocessed in captureReplies' array because the
  // daemon was waiting on a 24 day window to expire before seeing it.
  // Resolving with an outcome rather than throwing keeps a transport hiccup
  // from killing an unattended daemon while still telling it what happened.
  streamReplies(onReply: (reply: InboundReply) => Promise<void>): Promise<StreamOutcome>;
  close?(): Promise<void>;
}

const APPROVE = new Set(['y', 'yes', 'send', 'ok', 'approve']);
const SKIP = new Set(['n', 'no', 'skip', 'reject']);

// Deliberately narrow, and the same shape assertSafeOutbound enforces: exactly
// one bare address, no display name, no comma, no angle brackets. This is a
// convenience refusal so a malformed reply gets a useful message at correction
// time; assertSafeOutbound remains the real gate at send time.
const ADDRESS_SHAPE = /^[^\s<>,;:\\"]+@[^\s<>,;:\\"]+\.[^\s<>,;:\\"]+$/;

// The local part of an address is not formally case-insensitive, so it is read
// from the RAW token and preserved; only the domain is lowercased. One run of
// trailing sentence punctuation is stripped because iOS inserts a period on a
// double space, and no real address ends in one.
function normalizeAddress(rawToken: string): string | null {
  const trimmed = rawToken.replace(/[.,;:!?]+$/, '');
  if (!ADDRESS_SHAPE.test(trimmed)) return null;
  const at = trimmed.lastIndexOf('@');
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

export function parseReply(text: string): ParsedReply {
  // Two parallel arrays, deliberately. The id-stripping loop below removes the
  // id token WHEREVER it appears, not only at position 0, so `rest` is not
  // positionally aligned with the input: parseReply('to d70 a@b.edu') yields
  // rest = ['to','a@b.edu'] exactly like the normal form. Recovering the
  // original-case address by indexing `raw` at rest's own index would read
  // 'd70' as the address. `restIdx` records the ORIGINAL index instead.
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const tokens = raw.map((t) => t.toLowerCase());
  if (!tokens.length) return { kind: 'unparseable' };

  let shortId: string | undefined;
  const rest: string[] = [];
  const restIdx: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const id = shortId === undefined ? parseShortId(t) : null;
    if (id !== null) {
      shortId = formatShortId(id);
    } else {
      rest.push(t);
      restIdx.push(i);
    }
  }
  if (shortId === undefined) return { kind: 'unparseable' };

  // Ambiguity never resolves toward sending, with no exceptions. An id alone
  // is a noun: "d7" or "7" could be an accidental text, a year, a house
  // number, or a reply meant for another conversation, and ids are permanent
  // so a stale one still names a real draft. An approval must contain a verb.
  // This costs one character and the outbound message advertises exactly that
  // form ("Reply \"d7 y\" to send").
  if (rest.length === 0) return { kind: 'unparseable' };
  if (rest.length === 1 && APPROVE.has(rest[0] ?? '')) return { kind: 'approve', shortId };
  if (rest.length === 1 && SKIP.has(rest[0] ?? '')) return { kind: 'skip', shortId };
  // One advertised form only. A bare "d70 someone@uni.edu" stays unsupported,
  // matching the existing "d70 y" shape and keeping the grammar small.
  if (rest.length === 2 && rest[0] === 'to') {
    const email = normalizeAddress(raw[restIdx[1]!] ?? '');
    if (email) return { kind: 'address', shortId, email };
  }
  return { kind: 'unsupported', shortId }; // an edit instruction: F5 owns this
}

// --- The needs-address message -------------------------------------------
// Lives here, not in photonChannel.ts, because two places need it and must not
// drift: the loop sends it, and the channel must recognise a tapback on it.
//
// It MUST begin with the literal 'NEEDS ADDRESS' and no line of it may begin
// with `dN:`. draftIdFromReactedText (photonChannel.ts) turns any message whose
// text starts /^\s*(d\d+):/ into a tapback-approvable draft, so a needs-address
// message with that header would let one thumbs up send the very email that was
// flagged as going to the wrong person. The header therefore puts the id AFTER
// the word 'for' and never follows it with a colon, so even a tolerant future
// parser finds nothing to bind.
export interface NeedsAddressMessage {
  shortId: string;
  personName: string;
  affiliation?: string | null;
  paperTitle: string;
  rejected: Array<{ email: string; source: string; reason: string }>;
}

const NEEDS_ADDRESS_HEADER = /^NEEDS ADDRESS for (d\d+)\b/;

export function formatNeedsAddressMessage(m: NeedsAddressMessage): string {
  const who = m.affiliation ? `${m.personName} (${m.affiliation})` : m.personName;
  return [
    `NEEDS ADDRESS for ${m.shortId}`,
    who,
    `Paper: ${m.paperTitle}`,
    ...m.rejected.map((r) => `Rejected: ${r.email} (${r.source}) because ${r.reason}`),
    `Reply "${m.shortId} to their@address.edu" with the right address, or "${m.shortId} n" to skip.`,
  ].join('\n');
}

export function needsAddressDraftId(text: string | undefined): string | null {
  const m = NEEDS_ADDRESS_HEADER.exec((text ?? '').trim());
  return m ? m[1]! : null;
}

// A tapback is the owner's trained reflex, and on this message it used to
// produce total silence, which is indistinguishable from a dead listener.
// Begins with "d70 " and no colon, so the hint is not itself an approval button.
export function needsAddressTapbackHint(shortId: string): string {
  return `${shortId} needs a typed address, not a tapback. Reply "${shortId} to their@address.edu", or "${shortId} n" to skip.`;
}

// --- Reply-tracking notifications ----------------------------------------
// Here, not in replies.ts, for the same reason formatNeedsAddressMessage is
// here: the job that SENDS these and the channel that must recognise a TAPBACK
// on them both need them, and they must not drift.
//
// Every one of these begins with literal text and cannot parse as a draft id.
// draftIdFromReactedText (photonChannel.ts:135-138) turns any message whose
// text starts /^\s*(d\d+):/ into a tapback-approvable draft, so `d19: Daniel
// Kepple replied` would make a thumbs up on good news decode to `d19 y`. This
// project has been bitten by that shape twice.
export interface ReplyNotice {
  shortId: string;
  personName: string;
  ageText: string;
}

// Coalescing bounds the message COUNT (at most 3 per cycle: replies, bounces,
// failure). It does nothing about the LENGTH of one, and a burst day would
// otherwise produce a single text listing thirty names. The caller must set
// notified_at on EVERY covered row, including the ones folded into the tail,
// or a 12-reply cycle re-notifies the unnamed 7 forever.
export const MAX_NAMES_PER_NOTICE = 5;

function nameList(rs: ReplyNotice[]): string {
  const shown = rs.slice(0, MAX_NAMES_PER_NOTICE).map((r) => `${r.personName} (${r.shortId})`).join(', ');
  const hidden = rs.length - Math.min(rs.length, MAX_NAMES_PER_NOTICE);
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
}

export function formatHumanReplyNotice(rs: ReplyNotice[]): string {
  if (rs.length === 0) return '';
  if (rs.length === 1) {
    const r = rs[0]!;
    return `Reply from ${r.personName} (${r.shortId}), ${r.ageText}. Read it in Gmail.`;
  }
  return `${rs.length} replies: ${nameList(rs)}. Read them in Gmail.`;
}

export function formatBounceNotice(rs: ReplyNotice[]): string {
  if (rs.length === 0) return '';
  if (rs.length === 1) return `Bounced: ${rs[0]!.shortId} to ${rs[0]!.personName} did not deliver.`;
  return `${rs.length} bounced: ${nameList(rs)}.`;
}

// err.message only. Never the error object: a GaxiosError carries its response
// and request config as own enumerable properties, so console.error(e) prints
// header values (From addresses, under format=metadata) and the full URL.
export function formatPollFailureNotice(cycles: number, message: string): string {
  return `Reply polling has failed ${cycles} cycles running: ${message}.`;
}

// A tapback on one of the above used to produce total silence: no `dN:` header
// so draftIdFromReactedText returns null, and no NEEDS ADDRESS header so
// needsAddressDraftId returns null too. Reacting to good news is the most
// natural thing a human does with these messages, and silence is
// indistinguishable from a dead listener.
//
// Unlike a needs-address message there is no typed command that would help, so
// the hint says exactly that and stops. It begins with a letter, so it cannot
// itself become an approval button.
const REPLY_NOTICE = /^(Reply from |\d+ replies: |Bounced: |\d+ bounced: |Reply polling has failed )/;

export function replyNoticeTapbackHint(text: string | undefined): string | null {
  if (!REPLY_NOTICE.test((text ?? '').trim())) return null;
  return 'Nothing to approve on a reply notification. Open Gmail to read it.';
}

export interface StubChannel extends ApprovalChannel {
  sent: OutboundDraftMessage[];
  notices: string[];
  queueReply(text: string): void;
}

export function createStubChannel(): StubChannel {
  const sent: OutboundDraftMessage[] = [];
  const notices: string[] = [];
  let pending: InboundReply[] = [];
  let n = 0;
  return {
    sent,
    notices,
    queueReply(text: string) {
      pending.push({ text, messageId: `stub-${++n}` });
    },
    async sendDraftMessage(msg) {
      sent.push(msg);
    },
    async notify(text) {
      notices.push(text);
    },
    async captureReplies() {
      const out = pending;
      pending = [];
      return out;
    },
    async streamReplies(onReply: (reply: InboundReply) => Promise<void>): Promise<StreamOutcome> {
      const batch = pending;
      pending = [];
      for (const r of batch) await onReply(r);
      return { reason: 'ended' };
    },
  };
}
