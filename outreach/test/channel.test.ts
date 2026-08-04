import { describe, expect, it } from 'vitest';
import {
  createStubChannel,
  parseReply,
  formatNeedsAddressMessage,
  needsAddressDraftId,
  needsAddressTapbackHint,
} from '../src/approval/channel.js';

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

describe('parseReply address corrections', () => {
  it('parses the advertised form', () => {
    expect(parseReply('d70 to someone@uni.edu')).toEqual({ kind: 'address', shortId: 'd70', email: 'someone@uni.edu' });
  });

  // The id-stripping loop removes the id token wherever it appears, so `rest`
  // is NOT positionally aligned with the input. Measured: parseReply('to d70
  // a@b.edu') yields rest = ['to','a@b.edu'], identical to the normal form.
  // Recovering the original-case address by indexing the raw split at rest's
  // own index would read 'd70' as the address here.
  it('maps the address back to the ORIGINAL token position, not to its index in rest', () => {
    expect(parseReply('to d70 a@b.edu')).toEqual({ kind: 'address', shortId: 'd70', email: 'a@b.edu' });
  });

  // iOS turns a double space into a period. Without this, the single most
  // likely real reply fails.
  it('strips trailing sentence punctuation', () => {
    expect(parseReply('d70 to a@b.edu.')).toEqual({ kind: 'address', shortId: 'd70', email: 'a@b.edu' });
    expect(parseReply('d70 to a@b.edu!')).toEqual({ kind: 'address', shortId: 'd70', email: 'a@b.edu' });
  });

  // A local part is not formally case-insensitive; a domain is.
  it('preserves local-part case and lowercases the domain', () => {
    expect(parseReply('d70 to A.B@Uni.EDU')).toEqual({ kind: 'address', shortId: 'd70', email: 'A.B@Uni.EDU'.replace('Uni.EDU', 'uni.edu') });
  });

  it('leaves the edit path alone', () => {
    expect(parseReply('d70 to the point')).toEqual({ kind: 'unsupported', shortId: 'd70' });
    // Measured today: this is 'unsupported', NOT 'unparseable'. One advertised
    // form only, matching the existing "an approval must contain a verb" rule.
    expect(parseReply('d70 a@b.edu')).toEqual({ kind: 'unsupported', shortId: 'd70' });
  });
});

describe('the needs-address message', () => {
  const msg = {
    shortId: 'd70', personName: 'Xiyu Zhang', affiliation: 'Tongji University',
    paperTitle: 'A Paper',
    rejected: [{ email: 'zhangyanghui@tongji.edu.cn', source: 'homepage', reason: 'the local part names a different person' }],
  };

  // THE safety property of this whole feature. draftIdFromReactedText converts
  // any message starting `dN:` into a tapback-approvable draft, so a
  // needs-address message with that header would let one thumbs up send the
  // very email that was flagged as going to the wrong person.
  it('begins with NEEDS ADDRESS and has no line beginning with a draft id and a colon', () => {
    const text = formatNeedsAddressMessage(msg);
    expect(text.startsWith('NEEDS ADDRESS for d70')).toBe(true);
    for (const line of text.split('\n')) expect(/^\s*d\d+:/.test(line)).toBe(false);
  });

  it('advertises the correction syntax and the skip', () => {
    const text = formatNeedsAddressMessage(msg);
    expect(text).toContain('"d70 to their@address.edu"');
    expect(text).toContain('"d70 n"');
  });

  it('recognises its own header and nothing else', () => {
    expect(needsAddressDraftId(formatNeedsAddressMessage(msg))).toBe('d70');
    expect(needsAddressDraftId('d70: Xiyu Zhang (a@b.edu)')).toBeNull();
    expect(needsAddressDraftId('d25 sent to jiaruizhao@cuhk.edu.hk.')).toBeNull();
    expect(needsAddressDraftId(undefined)).toBeNull();
  });

  it('hints without becoming an approval button itself', () => {
    const hint = needsAddressTapbackHint('d70');
    expect(/^\s*d\d+:/.test(hint)).toBe(false);
    expect(hint).toContain('"d70 to their@address.edu"');
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

  it('reports a stream outcome so a caller can tell an end from a failure', async () => {
    const ch = createStubChannel();
    ch.queueReply('d7 y');
    const seen: string[] = [];
    const outcome = await ch.streamReplies(async (r) => {
      seen.push(r.text);
    });
    expect(seen).toEqual(['d7 y']);
    expect(outcome).toEqual({ reason: 'ended' });
  });
});
