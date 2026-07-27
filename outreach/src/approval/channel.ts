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

export interface ApprovalChannel {
  sendDraftMessage(msg: OutboundDraftMessage): Promise<void>;
  notify(text: string): Promise<void>;
  captureReplies(windowMs: number): Promise<InboundReply[]>;
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
    const id = parseShortId(t);
    if (id !== null && shortId === undefined) shortId = formatShortId(id);
    else rest.push(t);
  }
  if (shortId === undefined) return { kind: 'unparseable' };

  if (rest.length === 0) return { kind: 'approve', shortId };
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
  };
}
