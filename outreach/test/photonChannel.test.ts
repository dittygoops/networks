// Exercises captureReplies' allowlist and content-shape guards against a
// fake Spectrum app (never a real gRPC connection), via the injected
// PhotonConnectFn (R7). This is the only place a raw inbound message is
// decoded, so it is also where R3's "log every inbound message, including
// ignored ones, without leaking a non-approver's number or text" lives.
import { describe, expect, it, vi } from 'vitest';
import { createPhotonChannel } from '../src/approval/photonChannel.js';
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
