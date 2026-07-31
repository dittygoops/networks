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
