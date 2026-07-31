import { describe, expect, it } from 'vitest';
import { createStubChannel, parseReply } from '../src/approval/channel.js';

describe('parseReply', () => {
  it('parses approvals with a short id', () => {
    expect(parseReply('yes d7')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('  Y D7 ')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('send d12')).toEqual({ kind: 'approve', shortId: 'd12' });
  });

  it('parses skips', () => {
    expect(parseReply('skip d7')).toEqual({ kind: 'skip', shortId: 'd7' });
    expect(parseReply('n d7')).toEqual({ kind: 'skip', shortId: 'd7' });
    expect(parseReply('no d7')).toEqual({ kind: 'skip', shortId: 'd7' });
  });

  // Tightened deliberately (D5). Draft ids are global and permanent, so a
  // stray "d3" typed months later would otherwise approve whatever old
  // awaiting_approval draft holds id 3, and an approval is an irreversible
  // cold email. The prefix is an id, not a verb. The keyword forms below are
  // what the outbound message advertises, and are what Aditya already types.
  it('rejects a bare prefixed id as unparseable, not approval', () => {
    expect(parseReply('d7')).toEqual({ kind: 'unparseable' });
    expect(parseReply('D12')).toEqual({ kind: 'unparseable' });
  });

  it('still approves and skips the advertised keyword forms', () => {
    expect(parseReply('d7 y')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('d7 n')).toEqual({ kind: 'skip', shortId: 'd7' });
  });

  it('rejects an unprefixed bare digit as unparseable, not approval', () => {
    expect(parseReply('7')).toEqual({ kind: 'unparseable' });
    expect(parseReply('2026')).toEqual({ kind: 'unparseable' });
  });

  it('accepts a bare digit id paired with an explicit keyword', () => {
    expect(parseReply('7 y')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('7 n')).toEqual({ kind: 'skip', shortId: 'd7' });
  });

  it('treats an edit instruction as unsupported, not as approval', () => {
    expect(parseReply('d7 make it shorter')).toEqual({ kind: 'unsupported', shortId: 'd7' });
  });

  it('returns unparseable for text with no short id', () => {
    expect(parseReply('what is this')).toEqual({ kind: 'unparseable' });
  });
});

describe('createStubChannel', () => {
  it('records sent messages and replays queued replies', async () => {
    const ch = createStubChannel();
    await ch.sendDraftMessage({ shortId: 'd7', subject: 's', body: 'b', to: 'x@y.z', personName: 'X' });
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]?.shortId).toBe('d7');

    ch.queueReply('yes d7');
    expect(await ch.captureReplies(0)).toEqual([{ text: 'yes d7', messageId: 'stub-1' }]);
    expect(await ch.captureReplies(0)).toEqual([]);
  });

  it('records notices', async () => {
    const ch = createStubChannel();
    await ch.notify('seen 3, messaged 1');
    expect(ch.notices).toEqual(['seen 3, messaged 1']);
  });
});
