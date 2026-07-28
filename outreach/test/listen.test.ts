import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { persistDraft } from '../src/approval/ledger.js';
import { runListenLoop } from '../src/pipeline/listen.js';
import type { ApprovalChannel, InboundReply, OutboundDraftMessage } from '../src/approval/channel.js';
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

// A minimal ApprovalChannel whose captureReplies is scripted call-by-call, so
// each "session" (one call) can simulate a batch of replies, a clean end, or
// a thrown stream error, exactly like the real windowMs-bounded captureReplies.
function scriptedChannel(script: (Array<InboundReply> | 'throw')[]) {
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
      if (step === 'throw' || step === undefined) throw new Error('stream broke');
      return step;
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
