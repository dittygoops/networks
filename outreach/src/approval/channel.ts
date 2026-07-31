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

export function parseReply(text: string): ParsedReply {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: 'unparseable' };

  let shortId: string | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    const id = shortId === undefined ? parseShortId(t) : null;
    if (id !== null) {
      shortId = formatShortId(id);
    } else {
      rest.push(t);
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
  return { kind: 'unsupported', shortId }; // an edit instruction: F5 owns this
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
