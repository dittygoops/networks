import { describe, expect, it } from 'vitest';
import { extractAddress, isOurs, classifyKind } from '../src/pipeline/replyClassify.js';

describe('RFC 5322 mailbox extraction', () => {
  it.each([
    ['Aditya Gupta <apgupta3@asu.edu>', 'apgupta3@asu.edu'],
    ['<apgupta3@asu.edu>', 'apgupta3@asu.edu'],
    ['apgupta3@asu.edu', 'apgupta3@asu.edu'],
    ['  apgupta3@asu.edu  ', 'apgupta3@asu.edu'],
    ['"Gupta, Aditya" <apgupta3@asu.edu>', 'apgupta3@asu.edu'],
    // A display name that itself contains angle brackets. Taking the LAST
    // group is what makes this right; taking the first reads the display name.
    ['"a <fake@evil.com>" <real@asu.edu>', 'real@asu.edu'],
  ])('extracts %s', (raw, expected) => {
    expect(extractAddress(raw)).toBe(expected);
  });
});

describe('is this message ours', () => {
  // THE test that stops the system fabricating its own ground truth. Before
  // extraction, `'Aditya Gupta <apgupta3@asu.edu>' !== 'apgupta3@asu.edu'` is
  // true, so every one of Aditya's own follow-ups reads as an inbound reply.
  it('recognises our own mailbox in every shape Gmail sends it', () => {
    for (const raw of [
      'Aditya Gupta <apgupta3@asu.edu>',
      '<APGUPTA3@ASU.EDU>',
      'apgupta3@asu.edu',
      '"Gupta, Aditya" <ApGupta3@Asu.Edu>',
    ]) {
      expect(isOurs(raw, 'apgupta3@asu.edu')).toBe(true);
    }
  });

  it('does not swallow a different address, including a near miss', () => {
    expect(isOurs('Daniel Kepple <dkepple@example.edu>', 'apgupta3@asu.edu')).toBe(false);
    expect(isOurs('<apgupta3@asu.edu.evil.com>', 'apgupta3@asu.edu')).toBe(false);
    expect(isOurs('<notapgupta3@asu.edu>', 'apgupta3@asu.edu')).toBe(false);
  });

  it('compares against SENDER_EMAIL and against nothing else', () => {
    expect(isOurs('<apgupta3@asu.edu>', 'other@gmail.com')).toBe(false);
  });
});

describe('classification, from headers only', () => {
  it('classifies a bounce from the daemon addresses', () => {
    expect(classifyKind({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' })).toBe('bounce');
    expect(classifyKind({ from: '<postmaster@example.edu>' })).toBe('bounce');
    expect(classifyKind({ from: 'MAILER-DAEMON@EXAMPLE.EDU' })).toBe('bounce');
  });

  it('classifies an out-of-office from any of the three signals', () => {
    expect(classifyKind({ from: 'a@b.edu', 'auto-submitted': 'auto-replied' })).toBe('auto_reply');
    expect(classifyKind({ from: 'a@b.edu', precedence: 'bulk' })).toBe('auto_reply');
    expect(classifyKind({ from: 'a@b.edu', 'x-autoreply': 'yes' })).toBe('auto_reply');
  });

  // 'Auto-Submitted: no' is the value a NORMAL message carries. Treating
  // "header present" as auto would classify most real replies as noise and
  // notify about none of them.
  it('does not treat Auto-Submitted: no as an auto-reply', () => {
    expect(classifyKind({ from: 'a@b.edu', 'auto-submitted': 'no' })).toBe('human');
  });

  it('defaults to human', () => {
    expect(classifyKind({ from: 'Daniel Kepple <dkepple@example.edu>' })).toBe('human');
    expect(classifyKind({})).toBe('human');
  });
});
