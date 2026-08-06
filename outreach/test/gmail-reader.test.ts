import { describe, expect, it } from 'vitest';
import { projectMessage, classifyFailure, METADATA_HEADERS } from '../src/sender/gmailReader.js';

// Whether Gmail returns a snippet under format=metadata is ASSUMED, not
// documented: no Google documentation says so either way. The design behaves as
// though one is always present. This fixture therefore carries a snippet AND a
// body payload, so the test does not depend on the assumption either.
const RAW = {
  id: '19fca6e82b8956ad',
  threadId: '19fca6e82b8956aa',
  internalDate: '1785931200000',
  snippet: 'Thanks Aditya, I would be glad to chat about the olfactory work',
  labelIds: ['INBOX', 'IMPORTANT'],
  sizeEstimate: 4821,
  payload: {
    mimeType: 'text/plain',
    body: { size: 812, data: 'SSB3b3VsZCBiZSBnbGFkIHRvIGNoYXQ=' },
    headers: [
      { name: 'From', value: 'Daniel Kepple <dkepple@example.edu>' },
      { name: 'Date', value: 'Tue, 4 Aug 2026 10:00:00 -0700' },
      { name: 'Subject', value: 'Re: your work on olfactory embeddings' },
      { name: 'Auto-Submitted', value: 'no' },
      { name: 'To', value: 'apgupta3@asu.edu' },
    ],
  },
};

describe('the boundary projection', () => {
  it('returns only id, threadId, internalDate and headers', () => {
    const m = projectMessage(RAW)!;
    expect(Object.keys(m).sort()).toEqual(['headers', 'id', 'internalDate', 'threadId']);
  });

  // THE privacy assertion. Serialize the whole projection and assert the
  // researcher's text is nowhere in it, rather than checking field by field:
  // a field-by-field check passes if a sixth field is added later.
  it('carries no snippet, no body, no subject, and no label anywhere in it', () => {
    const serialized = JSON.stringify(projectMessage(RAW));
    expect(serialized).not.toContain('glad to chat');
    expect(serialized).not.toContain('SSB3b3VsZCBiZSBnbGFk');
    expect(serialized).not.toContain('olfactory embeddings');
    expect(serialized).not.toContain('IMPORTANT');
    expect(serialized).not.toContain('snippet');
  });

  it('lowercases header names and keeps ONLY the five requested', () => {
    const m = projectMessage(RAW)!;
    expect(m.headers.from).toBe('Daniel Kepple <dkepple@example.edu>');
    expect(m.headers['auto-submitted']).toBe('no');
    // Requested but absent on this message: simply not present, not undefined-y.
    expect(Object.keys(m.headers).sort()).toEqual(['auto-submitted', 'date', 'from']);
    // Present on the wire and deliberately dropped.
    expect(m.headers.subject).toBeUndefined();
    expect(m.headers.to).toBeUndefined();
  });

  it('drops a message missing the fields the poller cannot work without', () => {
    expect(projectMessage({ threadId: 't', internalDate: '1' })).toBeNull();
    expect(projectMessage({ id: 'a', threadId: 't' })).toBeNull();
    expect(projectMessage(null)).toBeNull();
  });

  it('requests exactly the five headers the classifier needs', () => {
    expect([...METADATA_HEADERS].sort()).toEqual(
      ['Auto-Submitted', 'Date', 'From', 'Precedence', 'X-Autoreply'].sort(),
    );
  });
});

// The blocker-2 classifier. An expired GMAIL_OAUTH_READ_REFRESH_TOKEN, a 429, a
// 5xx or a SQLITE_BUSY hits EVERY selected row in the same cycle. Counting any
// of those against a single thread marks the entire watch set unresolvable in
// five cycles, which at four runs a day is about 30 hours.
describe('failure scope classification', () => {
  const gaxios = (status: number, message = 'boom') => Object.assign(new Error(message), { status });

  it('treats a 404 as thread-scoped: that one thread is gone', () => {
    expect(classifyFailure(gaxios(404))).toBe('thread');
  });

  it('treats an unrelated per-thread 4xx as thread-scoped', () => {
    expect(classifyFailure(gaxios(400))).toBe('thread');
  });

  it('treats auth, rate limit and server failures as CYCLE-scoped', () => {
    for (const s of [401, 403, 429, 500, 502, 503]) {
      expect(classifyFailure(gaxios(s))).toBe('cycle');
    }
    expect(classifyFailure(new Error('invalid_grant'))).toBe('cycle');
    expect(classifyFailure(Object.assign(new Error('db is locked'), { code: 'SQLITE_BUSY' }))).toBe('cycle');
    expect(classifyFailure(Object.assign(new Error('readonly'), { code: 'SQLITE_READONLY' }))).toBe('cycle');
    expect(classifyFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe('cycle');
  });

  // The safe direction: stop the run and raise the alarm, rather than quietly
  // blaming whichever thread happened to be in hand for an unknown fault.
  it('treats an unclassifiable throw as cycle-scoped', () => {
    expect(classifyFailure(new Error('who knows'))).toBe('cycle');
    expect(classifyFailure('a string')).toBe('cycle');
    expect(classifyFailure(undefined)).toBe('cycle');
  });
});
