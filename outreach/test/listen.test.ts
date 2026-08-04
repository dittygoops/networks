import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { persistDraft } from '../src/approval/ledger.js';
import { runListenLoop } from '../src/pipeline/listen.js';
import { handleReply } from '../src/pipeline/loop.js';
import type { LoopSummary } from '../src/pipeline/loop.js';
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
    expect(notices.some((n) => n.includes('jane@uni.edu') && n.includes('Jane Doe'))).toBe(true);
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

// A channel matching the REAL photonChannel contract in the failure case the
// production defect lived in: the stream errors or ends the instant it is
// connected (revoked auth, degraded Spectrum, network down), and the channel
// resolves normally rather than throwing.
function instantEndChannel(reason: 'ended' | 'error' = 'ended') {
  let connects = 0;
  const channel: ApprovalChannel = {
    sendDraftMessage: async () => {},
    notify: async () => {},
    captureReplies: async () => [],
    streamReplies: async (): Promise<StreamOutcome> => ({ reason }),
    close: async () => {},
  };
  return { channel, connect: async () => { connects++; return channel; }, connects: () => connects };
}

describe('runListenLoop hot-spin regression', () => {
  // The defect: streamReplies resolved normally on error, the listener read
  // health from "did it reject", so consecutiveFailures reset every cycle,
  // backoff never applied, and the loop became connect -> return -> close ->
  // connect with ZERO sleep against the live service. This is the same class
  // as the shipped bug where a 1 year timeout overflowed Node's 32 bit timer
  // field, became 1ms, and caused 4 rebuilds in 45 seconds.
  //
  // The assertion that matters is elapsed virtual time, not a call count: a
  // call-count assertion passes against the hot-spinning code.
  it('sleeps on every cycle and escalates when the stream ends immediately', async () => {
    let virtualNow = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      virtualNow += ms;
    };
    const { connect, connects } = instantEndChannel('ended');
    const CYCLES = 20;

    await runListenLoop({
      connect,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep,
      now: () => virtualNow,
      exit: () => {},
      log: () => {},
      maxCycles: CYCLES,
      maxConsecutiveFailures: 1000, // not the subject of this test
    });

    expect(connects()).toBe(CYCLES);
    expect(slept).toHaveLength(CYCLES); // every cycle slept, no exceptions
    expect(Math.min(...slept)).toBeGreaterThanOrEqual(1000);
    // Escalating backoff is actually applied instead of being reset each cycle.
    expect(slept[slept.length - 1]).toBe(300_000);
    // 20 immediate-end cycles cost over an hour of wall clock, not 0ms.
    expect(virtualNow).toBeGreaterThan(60 * 60 * 1000);
  });

  it('applies the same pacing when the stream reports an error outcome', async () => {
    let virtualNow = 0;
    const slept: number[] = [];
    const { connect } = instantEndChannel('error');

    await runListenLoop({
      connect,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        slept.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit: () => {},
      log: () => {},
      maxCycles: 5,
      maxConsecutiveFailures: 1000,
    });

    expect(slept).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
  });

  // The ceiling at listen.ts:150 was unreachable against the real channel.
  // This is the test that says it is reachable now.
  it('exits for a supervisor restart after a ceiling of stream failures', async () => {
    const { connect } = instantEndChannel('error');
    const exit = vi.fn();
    let virtualNow = 0;

    await runListenLoop({
      connect,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit,
      log: () => {},
      maxConsecutiveFailures: 3,
      // No maxCycles: exit() must be the thing that stops the loop. The fake
      // exit does not terminate the process, so a loop that failed to stop
      // would hang this test rather than pass it.
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  // A quiet night is the normal case for a listener. Silence must never be the
  // failure signal, or the retry budget burns down for no reason.
  it('treats a long-lived session that ends cleanly as healthy', async () => {
    let virtualNow = 0;
    const slept: number[] = [];
    const channel: ApprovalChannel = {
      sendDraftMessage: async () => {},
      notify: async () => {},
      captureReplies: async () => [],
      streamReplies: async (): Promise<StreamOutcome> => {
        virtualNow += 10 * 60 * 1000; // ten quiet hours' worth of a session
        return { reason: 'ended' };
      },
      close: async () => {},
    };
    const exit = vi.fn();

    await runListenLoop({
      connect: async () => channel,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        slept.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit,
      log: () => {},
      maxCycles: 4,
    });

    // A session that already ran ten simulated minutes has, by itself,
    // already satisfied the floor (at most one connect() per second), so the
    // floor adds nothing on top of it. Corrected from the plan's original
    // assertion of four 1000ms sleeps: that expectation contradicted the
    // floor's own stated purpose (bounding the RECONNECT rate, not padding
    // every cycle unconditionally) and contradicted the elapsed-based
    // implementation the same plan specifies, which every other floor test in
    // this file (the hot-spin and short-session cases) depends on. The
    // invariant this test actually pins is what matters here: no backoff, no
    // exit, however long or short the healthy session ran.
    expect(slept).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });

  // A session that did its job is healthy however short it was, so a burst of
  // approvals cannot be mistaken for a broken stream.
  it('treats a short session that delivered a reply as healthy', async () => {
    const slept: number[] = [];
    let virtualNow = 0;
    const channel: ApprovalChannel = {
      sendDraftMessage: async () => {},
      notify: async () => {},
      captureReplies: async () => [],
      streamReplies: async (onReply): Promise<StreamOutcome> => {
        await onReply({ text: 'd999 y', messageId: 'm1' });
        return { reason: 'ended' };
      },
      close: async () => {},
    };

    await runListenLoop({
      connect: async () => channel,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        slept.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit: () => {},
      log: () => {},
      maxCycles: 3,
    });

    expect(slept).toEqual([1_000, 1_000, 1_000]);
  });
});

describe('listener summary honesty', () => {
  // The listener has to hand handleReply a LoopSummary because that is the
  // signature, but ten of its eleven fields describe a batch run that the
  // listener never performs. This probe pins the claim that only `sent` is
  // live. If handleReply ever starts reading or writing another field, this
  // fails here rather than the listener silently feeding it a fabricated zero.
  it('handleReply touches only the sent field of the summary it is given', async () => {
    const db = openDb(':memory:');
    const p = seedDraft(db);
    const touched = new Set<string>();
    const target: LoopSummary = {
      dryRun: false,
      sent: 0,
      seen: 0,
      filtered: 0,
      unsendable: 0,
      messaged: 0,
      queued: 0,
      wouldMessage: 0,
      resumed: 0,
      retryable: 0,
      stranded: 0,
      errors: [],
    };
    const probe = new Proxy(target, {
      get(t, k, r) {
        if (typeof k === 'string') touched.add(k);
        return Reflect.get(t, k, r);
      },
      set(t, k, v, r) {
        if (typeof k === 'string') touched.add(k);
        return Reflect.set(t, k, v, r);
      },
    });
    const { channel } = scriptedChannel([[]]);
    const reply: InboundReply = { text: `${p.shortId} y`, messageId: 'm1' };

    await handleReply(
      { db, channel, sender: { send: vi.fn().mockResolvedValue({ sentId: 'msg-1' }) }, senderEmail: 'a@b.c' },
      { dryRun: false },
      probe,
      reply,
    );

    expect([...touched]).toEqual(['sent']);
    expect(target.sent).toBe(1);
  });

  it('logs a cumulative send count so the one live field is observable', async () => {
    const db = openDb(':memory:');
    const p = seedDraft(db);
    const { channel } = scriptedChannel([[{ text: `${p.shortId} y`, messageId: 'm1' }]]);
    const logs: string[] = [];

    await runListenLoop({
      connect: async () => channel,
      db,
      sender: { send: vi.fn().mockResolvedValue({ sentId: 'msg-1' }) },
      sleep: noopSleep,
      exit: () => {},
      log: (m) => logs.push(m),
      maxCycles: 1,
    });

    expect(logs.some((l) => l.includes('sends this process: 1'))).toBe(true);
  });
});
