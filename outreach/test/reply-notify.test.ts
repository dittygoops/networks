import { describe, expect, it } from 'vitest';
import {
  formatHumanReplyNotice, formatBounceNotice, formatPollFailureNotice,
  replyNoticeTapbackHint, MAX_NAMES_PER_NOTICE, type ReplyNotice,
} from '../src/approval/channel.js';

const n = (shortId: string, personName: string): ReplyNotice => ({ shortId, personName, ageText: '2h ago' });

// THE safety property. test/notify-tapback-safety.test.ts CANNOT cover this:
// its predicate is /notify\(\s*\n?\s*`\$\{[A-Za-z.]*[sS]hortId\}:/, which
// matches only an INLINE template literal at a notify( call site. Every format
// here is produced by a function and passed to notify as a variable, so that
// scan is structurally blind to it and would pass whatever these returned.
// This is the direct test on the formatter output itself.
describe('no reply notification can be mistaken for a draft message', () => {
  const ALL_FORMATS: Array<[string, string]> = [
    ['one reply', formatHumanReplyNotice([n('d19', 'Daniel Kepple')])],
    ['several replies', formatHumanReplyNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')])],
    ['capped replies', formatHumanReplyNotice(Array.from({ length: 12 }, (_, i) => n(`d${i}`, `P${i}`)))],
    ['one bounce', formatBounceNotice([n('d19', 'Daniel Kepple')])],
    ['several bounces', formatBounceNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')])],
    ['poll failure', formatPollFailureNotice(3, 'invalid_grant')],
  ];

  it.each(ALL_FORMATS)('%s does not begin with a draft id and a colon', (_label, text) => {
    expect(/^\s*(d\d+):/.test(text)).toBe(false);
    for (const line of text.split('\n')) expect(/^\s*d\d+:/.test(line)).toBe(false);
  });
});

describe('coalescing and the name cap', () => {
  it('names the person on a single reply, because he needs to know who', () => {
    const t = formatHumanReplyNotice([n('d19', 'Daniel Kepple')]);
    expect(t).toBe('Reply from Daniel Kepple (d19), 2h ago. Read it in Gmail.');
  });

  it('coalesces several into ONE message', () => {
    expect(formatHumanReplyNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')]))
      .toBe('2 replies: Daniel Kepple (d19), Ada Chen (d22). Read them in Gmail.');
  });

  // Coalescing bounds the COUNT of messages and says nothing about the LENGTH
  // of one. A burst day would otherwise produce a single text listing thirty
  // names, which is unreadable on a phone and is its own kind of noise.
  it('caps the names shown at 5 and reports the rest as a count', () => {
    const t = formatHumanReplyNotice(Array.from({ length: 12 }, (_, i) => n(`d${i}`, `P${i}`)));
    expect(t).toContain('12 replies:');
    expect(t).toContain('and 7 more');
    expect(t.match(/\(d\d+\)/g)).toHaveLength(MAX_NAMES_PER_NOTICE);
  });

  it('has no tail when the list fits', () => {
    expect(formatHumanReplyNotice([n('d1', 'A'), n('d2', 'B')])).not.toContain('more');
  });

  // MTAs routinely emit several DSNs per message (a delay warning, then a hard
  // failure, sometimes one per hop), each a distinct gmail_message_id and so
  // each a distinct row. Uncoalesced, one bad address is three or four texts.
  it('coalesces bounces the same way, which the earlier design did not', () => {
    expect(formatBounceNotice([n('d19', 'Daniel Kepple')]))
      .toBe('Bounced: d19 to Daniel Kepple did not deliver.');
    expect(formatBounceNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')]))
      .toBe('2 bounced: Daniel Kepple (d19), Ada Chen (d22).');
  });

  it('carries only err.message on the failure line, never an object', () => {
    expect(formatPollFailureNotice(3, 'invalid_grant'))
      .toBe('Reply polling has failed 3 cycles running: invalid_grant.');
  });

  it('returns empty string for an empty list, so the caller sends nothing', () => {
    expect(formatHumanReplyNotice([])).toBe('');
    expect(formatBounceNotice([])).toBe('');
  });
});

// A tapback on one of these used to produce TOTAL SILENCE: no dN: header so
// draftIdFromReactedText returns null, and no NEEDS ADDRESS header so
// needsAddressDraftId returns null too. It fell straight into the "reaction on
// a non-draft message, ignoring" branch. That is indistinguishable from a dead
// listener, and it is the exact failure the needs-address hint branch exists to
// fix.
describe('the reply-notice tapback recognizer', () => {
  it('recognises every notification format this feature sends', () => {
    for (const t of [
      formatHumanReplyNotice([n('d19', 'Daniel Kepple')]),
      formatHumanReplyNotice([n('d19', 'A'), n('d22', 'B')]),
      formatBounceNotice([n('d19', 'Daniel Kepple')]),
      formatBounceNotice([n('d19', 'A'), n('d22', 'B')]),
      formatPollFailureNotice(3, 'boom'),
    ]) {
      expect(replyNoticeTapbackHint(t)).not.toBeNull();
    }
  });

  it('recognises nothing else, because the line may be shared', () => {
    expect(replyNoticeTapbackHint('d25 sent to jiaruizhao@cuhk.edu.hk.')).toBeNull();
    expect(replyNoticeTapbackHint('d70: Xiyu Zhang (a@b.edu)')).toBeNull();
    expect(replyNoticeTapbackHint('NEEDS ADDRESS for d70')).toBeNull();
    expect(replyNoticeTapbackHint(undefined)).toBeNull();
    expect(replyNoticeTapbackHint('')).toBeNull();
  });

  it('is not itself an approval button', () => {
    const hint = replyNoticeTapbackHint(formatHumanReplyNotice([n('d19', 'Daniel Kepple')]))!;
    expect(/^\s*d\d+:/.test(hint)).toBe(false);
  });
});
