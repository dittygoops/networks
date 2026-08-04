// Exercises captureReplies' allowlist and content-shape guards against a
// fake Spectrum app (never a real gRPC connection), via the injected
// PhotonConnectFn (R7). This is the only place a raw inbound message is
// decoded, so it is also where R3's "log every inbound message, including
// ignored ones, without leaking a non-approver's number or text" lives.
import { describe, expect, it, vi } from 'vitest';
import { assertApproverPhone, createPhotonChannel } from '../src/approval/photonChannel.js';
import type { PhotonApp, PhotonDm, RawMessage } from '../src/approval/photonChannel.js';

const APPROVER = '+15555550123';

function fakeApp(messages: RawMessage[]): { app: PhotonApp; stopped: () => boolean } {
  let stopped = false;
  const app: PhotonApp = {
    messages: (async function* () {
      for (const m of messages) yield [{ id: 'space-1' }, m] as [unknown, RawMessage];
    })(),
    async stop() {
      stopped = true;
    },
  };
  return { app, stopped: () => stopped };
}

async function channelFor(messages: RawMessage[]) {
  const { app, stopped } = fakeApp(messages);
  const dmSend = vi.fn().mockResolvedValue(undefined);
  const dm: PhotonDm = { send: dmSend };
  const channel = await createPhotonChannel(
    { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
    async () => ({ app, dm }),
  );
  return { channel, dmSend, stopped };
}

describe('createPhotonChannel captureReplies', () => {
  it('accepts a text message from the approver', async () => {
    const { channel, dmSend } = await channelFor([
      { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } },
    ]);
    const replies = await channel.captureReplies(200);
    expect(replies).toEqual([{ text: 'd7 y', messageId: 'm1' }]);
    expect(dmSend).not.toHaveBeenCalled(); // captureReplies never sends a reply itself
  });

  it('ignores a message from a non-approver and never reflects a reply to them', async () => {
    const { channel, dmSend } = await channelFor([
      { id: 'm1', sender: { id: '+15555550199' }, content: { type: 'text', text: 'd7 y' } },
    ]);
    const replies = await channel.captureReplies(200);
    expect(replies).toEqual([]);
    expect(dmSend).not.toHaveBeenCalled();
  });

  it('ignores an approver message with an unreadable content shape', async () => {
    const { channel } = await channelFor([
      { id: 'm1', sender: { id: APPROVER }, content: { type: 'attachment' } },
    ]);
    const replies = await channel.captureReplies(200);
    expect(replies).toEqual([]);
  });

  it('logs every inbound message without leaking a non-approver number or text', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg);
    });
    try {
      const { channel } = await channelFor([
        { id: 'm1', sender: { id: '+15555550199' }, content: { type: 'text', text: 'SECRET-TEXT' } },
      ]);
      await channel.captureReplies(200);
    } finally {
      spy.mockRestore();
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain('+15555550199');
      expect(line).not.toContain('SECRET-TEXT');
    }
  });

  it('closes the underlying app on close()', async () => {
    const { channel, stopped } = await channelFor([]);
    await channel.close?.();
    expect(stopped()).toBe(true);
  });
});

describe('createPhotonChannel streamReplies', () => {
  it('reports reason "ended" when the stream finishes cleanly', async () => {
    const { channel } = await channelFor([
      { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } },
    ]);
    const seen: string[] = [];
    const outcome = await channel.streamReplies(async (r) => {
      seen.push(r.text);
    });
    expect(seen).toEqual(['d7 y']);
    expect(outcome).toEqual({ reason: 'ended' });
  });

  // The defect this replaces: the whole for-await was wrapped in try/catch and
  // resolved normally on error, so the daemon inferring health from "did it
  // reject" always concluded healthy. The failure is now in the return value.
  it('reports reason "error" instead of resolving as if nothing happened', async () => {
    const failing: PhotonApp = {
      messages: (async function* () {
        yield [{ id: 'space-1' }, { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } }] as [
          unknown,
          RawMessage,
        ];
        throw new Error('stream died');
      })(),
      async stop() {},
    };
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: failing, dm: { send: vi.fn().mockResolvedValue(undefined) } }),
    );
    const seen: string[] = [];
    const outcome = await channel.streamReplies(async (r) => {
      seen.push(r.text);
    });
    expect(seen).toEqual(['d7 y']); // replies before the error are still delivered
    expect(outcome.reason).toBe('error');
    expect(outcome.detail).toContain('stream died');
  });

  it('survives a handler that throws and still reports the stream end', async () => {
    const { channel } = await channelFor([
      { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } },
      { id: 'm2', sender: { id: APPROVER }, content: { type: 'text', text: 'd8 n' } },
    ]);
    const seen: string[] = [];
    const outcome = await channel.streamReplies(async (r) => {
      seen.push(r.text);
      if (r.messageId === 'm1') throw new Error('handler blew up');
    });
    expect(seen).toEqual(['d7 y', 'd8 n']);
    expect(outcome).toEqual({ reason: 'ended' });
  });
});

describe('createPhotonChannel approver invariant', () => {
  // The allowlist is the single control that stops a possibly shared iMessage
  // line from being an open reflector, and the comparison is a bare !==. An
  // empty approverPhone would accept any message whose sender.id is also
  // empty. photonOptionsFromEnv rejects empty env values, but the factory
  // accepts any PhotonOptions, so the invariant belongs at construction.
  it('refuses to construct with an empty approver phone, and never connects', async () => {
    const connect = vi.fn();
    await expect(
      createPhotonChannel({ projectId: 'p', projectSecret: 's', approverPhone: '' }, connect),
    ).rejects.toThrow(/E\.164/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses formats the provider never emits, so a misconfiguration fails at boot', async () => {
    const connect = vi.fn();
    for (const bad of ['15555550123', '(555) 555-0123', '+1 555 555 0123', '  +15555550123  ', '+0555555012']) {
      await expect(
        createPhotonChannel({ projectId: 'p', projectSecret: 's', approverPhone: bad }, connect),
      ).rejects.toThrow(/E\.164/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('accepts the exact format the provider was observed to emit', () => {
    expect(() => assertApproverPhone('+15555550123')).not.toThrow();
  });

  it('does not put the configured number in the error text', async () => {
    await expect(
      createPhotonChannel({ projectId: 'p', projectSecret: 's', approverPhone: '5555550123' }, vi.fn()),
    ).rejects.toThrow(expect.not.stringContaining('5555550123'));
  });
});

describe('createPhotonChannel allowlist diagnostics', () => {
  // The all-quiet failure this exists for: if APPROVER_PHONE ever diverges in
  // format from what the provider emits, every approval is silently ignored
  // and the symptom is indistinguishable from Aditya not replying. That class
  // of failure has already cost this project a lost approval and required
  // attaching a separate diagnostic listener to diagnose.
  it('warns specifically when a rejected sender differs only by formatting', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });
    try {
      const { channel, dmSend } = await channelFor([
        { id: 'm1', sender: { id: '15555550123' }, content: { type: 'text', text: 'd7 y' } },
      ]);
      const replies = await channel.captureReplies(50);
      expect(replies).toEqual([]); // still rejected: the diagnostic never authorizes
      expect(dmSend).not.toHaveBeenCalled(); // and never answers a rejected sender
    } finally {
      spy.mockRestore();
    }
    expect(warns.some((w) => w.includes('APPROVER_PHONE is misconfigured'))).toBe(true);
    for (const w of warns) expect(w).not.toContain('15555550123');
  });

  it('does not warn about misconfiguration for an unrelated stranger', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });
    try {
      const { channel, dmSend } = await channelFor([
        { id: 'm1', sender: { id: '+15555550199' }, content: { type: 'text', text: 'd7 y' } },
      ]);
      expect(await channel.captureReplies(50)).toEqual([]);
      expect(dmSend).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(warns.some((w) => w.includes('APPROVER_PHONE is misconfigured'))).toBe(false);
  });
});

// A fake app whose stream is driven by the test rather than by an array, so a
// message can be made to arrive at a chosen moment relative to the window.
function controllableApp() {
  const queued: Array<[unknown, RawMessage]> = [];
  let waiting: ((r: IteratorResult<[unknown, RawMessage]>) => void) | undefined;
  let returnCalls = 0;
  let stopped = false;
  const iterator: AsyncIterator<[unknown, RawMessage]> = {
    next() {
      const head = queued.shift();
      if (head !== undefined) return Promise.resolve({ value: head, done: false });
      return new Promise<IteratorResult<[unknown, RawMessage]>>((resolve) => {
        waiting = resolve;
      });
    },
    async return() {
      returnCalls++;
      return { value: undefined, done: true };
    },
  };
  const app: PhotonApp = {
    messages: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<[unknown, RawMessage]>,
    async stop() {
      stopped = true;
    },
  };
  return {
    app,
    deliver(m: RawMessage) {
      const value: [unknown, RawMessage] = [{ id: 'space-1' }, m];
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w({ value, done: false });
      } else {
        queued.push(value);
      }
    },
    returnCalls: () => returnCalls,
    stopped: () => stopped,
  };
}

describe('createPhotonChannel captureReplies does not drop a reply', () => {
  // The defect: when the deadline won with a next() in flight, the 500ms grace
  // covered the common case, but a message settling after the grace had been
  // pulled off the iterator and was then discarded. The reply was consumed and
  // lost, and an approval that is consumed and lost looks exactly like an
  // approval that was never sent.
  it('carries an in-flight message to the next call instead of discarding it', async () => {
    const fake = controllableApp();
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: fake.app, dm: { send: vi.fn().mockResolvedValue(undefined) } }),
    );

    // Window and grace both expire with nothing delivered.
    expect(await channel.captureReplies(30)).toEqual([]);

    // The message settles well after the grace period is over.
    fake.deliver({ id: 'm-late', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } });

    // The next call sees it. Before the fix, this returned [].
    expect(await channel.captureReplies(30)).toEqual([{ text: 'd7 y', messageId: 'm-late' }]);
  });

  it('applies the identical allowlist to a carried-over message', async () => {
    const fake = controllableApp();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: fake.app, dm: { send: dmSend } }),
    );

    expect(await channel.captureReplies(30)).toEqual([]);
    fake.deliver({ id: 'm-late', sender: { id: '+15555550199' }, content: { type: 'text', text: 'd7 y' } });
    expect(await channel.captureReplies(30)).toEqual([]);
    expect(dmSend).not.toHaveBeenCalled(); // a stranger gets nothing back, ever
  });

  it('closes the iterator rather than abandoning it, and still stops the app', async () => {
    const fake = controllableApp();
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: fake.app, dm: { send: vi.fn().mockResolvedValue(undefined) } }),
    );
    await channel.captureReplies(30);
    await channel.close?.();
    expect(fake.returnCalls()).toBe(1);
    expect(fake.stopped()).toBe(true);
  });
});

// Tapback approval. Verified live 2026-08-03: Spectrum delivers an iMessage
// reaction as a normal inbound message with content.type 'reaction', carrying
// `emoji` and a `target` whose content.text is the message reacted to. Draft
// messages begin "d25: Name (email)" (formatDraftMessage), so the draft id
// parses off the target with no schema change and no in-memory map, which
// matters because a map would not survive a daemon restart.
//
// A reaction is translated into the SAME text command a human would type, so
// every downstream safety gate (decision claim, prior-thread check, send
// refusal) is reached unchanged. This is the irreversible path: a thumbs up
// sends a real cold email to a named stranger.
const reaction = (emoji: string, targetText: string, id = 'r1'): RawMessage =>
  ({
    id,
    sender: { id: APPROVER },
    content: { type: 'reaction', emoji, target: { id: 'm-target', content: { type: 'text', text: targetText } } },
  }) as unknown as RawMessage;

const DRAFT_MSG = 'd25: Jiarui Meng (jiaruizhao@cuhk.edu.hk)\nSubject: quick question\n\nHi Jiarui,\n\nReply "d25 y" to send, "d25 n" to skip.';

describe('createPhotonChannel tapback approval', () => {
  it('translates a thumbs up on a draft into that draft\'s approval command', async () => {
    const { channel } = await channelFor([reaction('\u{1F44D}', DRAFT_MSG)]);
    expect(await channel.captureReplies(200)).toEqual([{ text: 'd25 y', messageId: 'r1' }]);
  });

  it('translates a thumbs down into the skip command', async () => {
    const { channel } = await channelFor([reaction('\u{1F44E}', DRAFT_MSG)]);
    expect(await channel.captureReplies(200)).toEqual([{ text: 'd25 n', messageId: 'r1' }]);
  });

  it('accepts a skin-tone modified thumbs up (the default on many phones)', async () => {
    const { channel } = await channelFor([reaction('\u{1F44D}\u{1F3FD}', DRAFT_MSG)]);
    expect(await channel.captureReplies(200)).toEqual([{ text: 'd25 y', messageId: 'r1' }]);
  });

  // An ambiguous reaction must never send an email. iMessage offers heart,
  // laugh, emphasis and question alongside the two thumbs; none of them mean
  // "send this to a stranger".
  it.each(['❤️', '\u{1F602}', '‼️', '❓'])('ignores the non-committal reaction %s', async (emoji) => {
    const { channel } = await channelFor([reaction(emoji, DRAFT_MSG)]);
    expect(await channel.captureReplies(200)).toEqual([]);
  });

  it('ignores a thumbs up on something that is not a draft message', async () => {
    const { channel } = await channelFor([reaction('\u{1F44D}', 'd25 sent to jiaruizhao@cuhk.edu.hk.')]);
    expect(await channel.captureReplies(200)).toEqual([]);
  });

  it('ignores a reaction whose target text is missing entirely', async () => {
    const bad = { id: 'r9', sender: { id: APPROVER }, content: { type: 'reaction', emoji: '\u{1F44D}' } } as unknown as RawMessage;
    const { channel } = await channelFor([bad]);
    expect(await channel.captureReplies(200)).toEqual([]);
  });

  it('applies the sender allowlist to reactions too, so a stranger cannot approve by tapping', async () => {
    const stranger = { ...reaction('\u{1F44D}', DRAFT_MSG), sender: { id: '+15555550199' } } as RawMessage;
    const { channel } = await channelFor([stranger]);
    expect(await channel.captureReplies(200)).toEqual([]);
  });
});
