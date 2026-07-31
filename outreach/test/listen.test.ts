import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { persistDraft } from '../src/approval/ledger.js';
import { runListenLoop } from '../src/pipeline/listen.js';
import type { ApprovalChannel, InboundReply, OutboundDraftMessage, StreamOutcome } from '../src/approval/channel.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Jane Doe', paperTitle: 'A Paper' },
  hooks: [],
  intent: 'seeking direction',
  senderName: 'Aditya Gupta',
};

const groundedDraft: Draft = {
  subject: 'quick question on your rss-gap work',
  body: 'body text',
  grounded: true,
  wordCount: 2,
  notes: [],
};

function seedDraft(db: ReturnType<typeof openDb>) {
  const personId = upsertPerson(db, { name: 'Jane Doe', email: 'jane@uni.edu' });
  return persistDraft(db, {
    personId,
    paperArxivId: '2501.00001',
    paperTitle: 'A Paper',
    intent: 'seeking direction',
    draftInput,
    draft: groundedDraft,
    contextJson: {},
  });
}

// A minimal ApprovalChannel scripted call-by-call, so each "session" (one
// call) can simulate replies, a clean end, a reported stream error, or a
// rejection. Critically, the default failure shape is a RESOLVED outcome of
// reason 'error', because that is what the real photonChannel does: it catches
// its own stream errors and never rejects. The previous version of this fake
// threw, so the suite proved a contract production did not implement, and the
// daemon's entire failure path was dead code nothing tested.
type Step = InboundReply[] | 'error' | 'throw';

function scriptedChannel(script: Step[]) {
  let call = 0;
  const notices: string[] = [];
  const sent: OutboundDraftMessage[] = [];
  let closeCount = 0;
  const channel: ApprovalChannel = {
    async sendDraftMessage(msg) {
      sent.push(msg);
    },
    async notify(text) {
      notices.push(text);
    },
    async captureReplies() {
      const step = script[call++];
      if (step === 'throw' || step === 'error' || step === undefined) throw new Error('stream broke');
      return step;
    },
    async streamReplies(onReply): Promise<StreamOutcome> {
      const step = script[call++];
      if (step === 'throw') throw new Error('stream broke');
      if (step === 'error' || step === undefined) return { reason: 'error', detail: 'stream broke' };
      for (const r of step) await onReply(r);
      return { reason: 'ended' };
    },
    async close() {
      closeCount++;
    },
  };
  return { channel, notices, sent, closeCount: () => closeCount, calls: () => call };
}

function noopSleep() {
  return Promise.resolve();
}

describe('runListenLoop', () => {
  it('sends on an approver "y" reply for an existing draft', async () => {
    const db = openDb(':memory:');
    const p = seedDraft(db);
    const { channel, notices } = scriptedChannel([[{ text: `${p.shortId} y`, messageId: 'm1' }]]);
    const send = vi.fn().mockResolvedValue({ sentId: 'msg-1' });
    const exit = vi.fn();

    await runListenLoop({
      connect: async () => channel,
      db,
      sender: { send },
      sleep: noopSleep,
      exit,
      log: () => {},
      maxCycles: 1,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'jane@uni.edu', draftShortId: p.shortId });
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('sent');
    expect(notices.some((n) => n.includes('sent to jane@uni.edu'))).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not send on an approver "n" reply', async () => {
    const db = openDb(':memory:');
    const p = seedDraft(db);
    const { channel } = scriptedChannel([[{ text: `${p.shortId} n`, messageId: 'm1' }]]);
    const send = vi.fn();

    await runListenLoop({
      connect: async () => channel,
      db,
      sender: { send },
      sleep: noopSleep,
      log: () => {},
      maxCycles: 1,
    });

    expect(send).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('skipped');
  });

  it('does not crash on an unknown draft id, and sends nothing', async () => {
    const db = openDb(':memory:');
    seedDraft(db);
    const { channel, notices } = scriptedChannel([[{ text: 'd999 y', messageId: 'm1' }]]);
    const send = vi.fn();

    await expect(
      runListenLoop({
        connect: async () => channel,
        db,
        sender: { send },
        sleep: noopSleep,
        log: () => {},
        maxCycles: 1,
      }),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(notices.some((n) => n.includes('No draft found'))).toBe(true);
  });

  it('reconnects rather than exiting when the underlying connect briefly fails', async () => {
    const db = openDb(':memory:');
    const good = scriptedChannel([[]]);
    let attempts = 0;
    const connect = vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('connect failed');
      return good.channel;
    });
    const exit = vi.fn();

    await runListenLoop({
      connect,
      db,
      sender: { send: vi.fn() },
      sleep: noopSleep,
      exit,
      log: () => {},
      maxCycles: 2,
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits after a ceiling of consecutive failures instead of looping forever', async () => {
    const db = openDb(':memory:');
    const connect = vi.fn(async (): Promise<ApprovalChannel> => {
      throw new Error('always broken');
    });
    const exit = vi.fn();

    await runListenLoop({
      connect,
      db,
      sender: { send: vi.fn() },
      sleep: noopSleep,
      exit,
      log: () => {},
      maxConsecutiveFailures: 3,
      // No maxCycles: exit() is expected to be the thing that stops the loop.
      // The fake exit() below does not actually terminate the process, so if
      // the loop failed to stop on its own this test would hang and time out.
    });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('sends a startup notice once after the first successful connect', async () => {
    const db = openDb(':memory:');
    const { channel, notices } = scriptedChannel([[]]);

    await runListenLoop({
      connect: async () => channel,
      db,
      sender: { send: vi.fn() },
      sleep: noopSleep,
      log: () => {},
      startupNotice: 'sending is broken',
      maxCycles: 1,
    });

    expect(notices).toEqual(['sending is broken']);
  });
});

describe('runListenLoop delivery semantics', () => {
  // Regression for a real production failure: the daemon used captureReplies,
  // which only returns when its window expires. An approver's "d8 y" was
  // accepted by the transport and then sat unprocessed in memory behind a 24
  // day window. A listener must consume replies by push, never by batch.
  it('consumes replies via streamReplies and never calls the batch window API', async () => {
    let captureCalls = 0;
    let streamCalls = 0;
    const delivered: string[] = [];
    const channel: ApprovalChannel = {
      sendDraftMessage: async () => {},
      notify: async () => {},
      captureReplies: async () => {
        captureCalls++;
        return [] as InboundReply[];
      },
      streamReplies: async (onReply): Promise<StreamOutcome> => {
        streamCalls++;
        await onReply({ text: 'hello', messageId: 'm1' });
        return { reason: 'ended' };
      },
      close: async () => {},
    };
    await runListenLoop({
      db: openDb(':memory:'),
      connect: async () => channel,
      sender: { send: async () => ({ sentId: 'x' }) },
      senderEmail: 'a@b.c',
      maxCycles: 1,
      sleep: noopSleep,
      exit: () => {},
      log: (m: string) => delivered.push(m),
    });
    expect(streamCalls).toBe(1);
    expect(captureCalls).toBe(0);
  });
});
