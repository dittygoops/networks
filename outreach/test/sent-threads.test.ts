import { describe, expect, it } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { persistDraft, logEvent } from '../src/approval/ledger.js';
import {
  isGmailShapedId, recordSentThread, adoptOrphanedSends, nextPollAt,
  selectDueThreads, rearmUnresolvable,
} from '../src/pipeline/sentThreads.js';
import { toSqlTime } from '../src/db/time.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Daniel Kepple', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 's', body: 'b', grounded: true, wordCount: 1, notes: [] };

function seedSent(sentId: string, threadId?: string) {
  const db = openDb(':memory:');
  const personId = upsertPerson(db, { name: 'Daniel Kepple', openalexId: 'A-dk', email: 'dk@example.edu' });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  logEvent(db, p.draftId, 'sent', threadId ? { sentId, threadId } : { sentId });
  return { db, personId, draftId: p.draftId };
}

// A SECOND real draft for the same person, for the two tests below that need
// two watch rows. foreign_keys = ON (db.ts:18) and sent_threads.draft_id
// REFERENCES drafts(id), so `draftId + 1000` is not a spare id, it is a
// SQLITE_CONSTRAINT_FOREIGNKEY. An earlier draft of this plan used it and both
// tests threw instead of asserting anything.
function secondDraft(db: ReturnType<typeof openDb>, personId: number): number {
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00002', paperTitle: 'Another Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  return p.draftId;
}

describe('the Gmail-shape guard', () => {
  it('accepts the shape all 56 real sent ids have', () => {
    expect(isGmailShapedId('19fca6e82b8956ad')).toBe(true);
  });

  // A non-Gmail send path must never make the poller spin.
  it('rejects an SMTP Message-ID and both fallback timestamp forms', () => {
    expect(isGmailShapedId('smtp-1785931200000')).toBe(false);
    expect(isGmailShapedId('gmail-1785931200000')).toBe(false);
    expect(isGmailShapedId('<abc@mail.example.com>')).toBe(false);
    expect(isGmailShapedId('abc@example.com')).toBe(false);
    expect(isGmailShapedId('19FCA6E82B8956AD')).toBe(false);   // lowercase hex only
    expect(isGmailShapedId('')).toBe(false);
  });
});

describe('adoptOrphanedSends', () => {
  // This runs at the head of EVERY cycle with zero API calls, so a swallowed
  // recordSentThread failure heals itself on the next run instead of leaving a
  // thread permanently unpolled with nothing counting the gap.
  it('projects a sent event with no watch row, and reports how many it adopted', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad', '19fca6e82b8956aa');
    expect(adoptOrphanedSends(db)).toBe(1);
    const row = db.prepare('SELECT * FROM sent_threads WHERE draft_id = ?').get(draftId) as Record<string, unknown>;
    expect(row.sent_message_id).toBe('19fca6e82b8956ad');
    expect(row.thread_id).toBe('19fca6e82b8956aa');
    expect(row.watch_state).toBe('open');
  });

  // It runs every cycle over an append-only log, so it MUST be idempotent.
  it('is a no-op on the second run', () => {
    const { db } = seedSent('19fca6e82b8956ad', '19fca6e82b8956aa');
    expect(adoptOrphanedSends(db)).toBe(1);
    expect(adoptOrphanedSends(db)).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM sent_threads').get() as { n: number }).n).toBe(1);
  });

  // The 56 historical sent events have no threadId: the field is new. The
  // backfill fills sent_threads.thread_id for them, not the event rows, because
  // draft_events is append-only.
  it('adopts a legacy send with no threadId, leaving thread_id NULL', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad');
    expect(adoptOrphanedSends(db)).toBe(1);
    expect((db.prepare('SELECT thread_id AS t FROM sent_threads WHERE draft_id = ?').get(draftId) as { t: null }).t)
      .toBeNull();
  });

  it('marks a non-Gmail id unresolvable rather than queueing it forever', () => {
    const { db, draftId } = seedSent('smtp-1785931200000');
    adoptOrphanedSends(db);
    expect((db.prepare('SELECT watch_state AS w FROM sent_threads WHERE draft_id = ?').get(draftId) as { w: string }).w)
      .toBe('unresolvable');
  });

  it('writes sent_at in the canonical form, so the cadence can compare it', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad', 't1');
    adoptOrphanedSends(db);
    const at = (db.prepare('SELECT sent_at AS a FROM sent_threads WHERE draft_id = ?').get(draftId) as { a: string }).a;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('recordSentThread', () => {
  it('writes the watch row after a send', () => {
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 't1');
    recordSentThread(db, draftId, personId, '19fca6e82b8956ad', 't1');
    expect((db.prepare('SELECT count(*) AS n FROM sent_threads').get() as { n: number }).n).toBe(1);
  });

  it('is idempotent, so it cannot collide with the adopt that runs every cycle', () => {
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 't1');
    recordSentThread(db, draftId, personId, '19fca6e82b8956ad', 't1');
    expect(() => recordSentThread(db, draftId, personId, '19fca6e82b8956ad', 't1')).not.toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM sent_threads').get() as { n: number }).n).toBe(1);
  });
});

// The tiers are aligned to the ACTUAL fire times (07:30/12:30/17:30/21:30). A
// +6h tier under that schedule gives the newest threads about 2 polls a day,
// not the 4 the quota arithmetic assumed: 07:30 -> due 13:30 misses 12:30 and
// waits for 17:30. +4h is the largest interval that lands inside every gap
// (the gaps are 5h, 5h, 4h, 10h).
describe('the age-tiered cadence', () => {
  const now = new Date(Date.UTC(2026, 7, 4, 7, 30, 0));
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000);

  it('polls a fresh send every 4 hours', () => {
    expect(nextPollAt(daysAgo(1), now)).toEqual({ next: toSqlTime(new Date(now.getTime() + 4 * 3600_000)) });
  });

  it('drops to daily between 3 and 14 days', () => {
    expect(nextPollAt(daysAgo(5), now)).toEqual({ next: toSqlTime(new Date(now.getTime() + 24 * 3600_000)) });
  });

  it('drops to every third day between 14 and 60', () => {
    expect(nextPollAt(daysAgo(30), now)).toEqual({ next: toSqlTime(new Date(now.getTime() + 72 * 3600_000)) });
  });

  // 60 days, not 30. Academics answer cold email on week-to-month timescales,
  // and a 30 day close stops watching exactly where the slower half lands.
  it('closes at 60 days', () => {
    expect(nextPollAt(daysAgo(61), now)).toEqual({ close: true });
    expect(nextPollAt(daysAgo(59), now)).not.toEqual({ close: true });
  });
});

describe('selectDueThreads', () => {
  it('returns overdue open threads oldest-due first, and respects the limit', () => {
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 't1');
    adoptOrphanedSends(db);
    const older = toSqlTime(new Date(Date.now() - 7200_000));
    db.prepare('UPDATE sent_threads SET next_poll_at = ? WHERE draft_id = ?').run(older, draftId);
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, next_poll_at)
       VALUES (?, ?, 'aa11', 't2', ?, ?)`,
    ).run(secondDraft(db, personId), personId, older, toSqlTime(new Date(Date.now() - 3600_000)));
    const due = selectDueThreads(db, 10);
    expect(due.map((d) => d.threadId)).toEqual(['t1', 't2']);
    expect(selectDueThreads(db, 1)).toHaveLength(1);
  });

  it('skips a row with no thread_id, because there is nothing to poll', () => {
    const { db } = seedSent('19fca6e82b8956ad');
    adoptOrphanedSends(db);
    expect(selectDueThreads(db, 10)).toEqual([]);
  });

  it('polls each DISTINCT thread once, even when two drafts share it', () => {
    // Gmail threads on subject plus participants, so two --to-self sends land
    // in one thread and a --force second email to one person can too.
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 'shared');
    adoptOrphanedSends(db);
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, next_poll_at)
       VALUES (?, ?, 'bb22', 'shared', datetime('now'), datetime('now'))`,
    ).run(secondDraft(db, personId), personId);
    const due = selectDueThreads(db, 10);
    expect(due).toHaveLength(1);
    // Attributed to the LOWEST open draft_id carrying that thread, which is the
    // seedSent one: secondDraft's id is strictly greater.
    expect(due[0]!.draftId).toBe(draftId);
  });
});

describe('rearmUnresolvable', () => {
  it('returns a failed thread to open at zero failures', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad', 't1');
    adoptOrphanedSends(db);
    db.prepare("UPDATE sent_threads SET watch_state='unresolvable', poll_failures=5 WHERE draft_id=?").run(draftId);
    expect(rearmUnresolvable(db)).toBe(1);
    const r = db.prepare('SELECT watch_state AS w, poll_failures AS f, rearmed_at AS r FROM sent_threads WHERE draft_id=?')
      .get(draftId) as { w: string; f: number; r: string | null };
    expect(r).toMatchObject({ w: 'open', f: 0 });
    expect(r.r).not.toBeNull();
  });

  // The guard that keeps --rearm all from resurrecting a genuinely unpollable
  // row into a permanent spin.
  it('leaves a row with no thread_id unresolvable', () => {
    const { db } = seedSent('smtp-1785931200000');
    adoptOrphanedSends(db);
    expect(rearmUnresolvable(db)).toBe(0);
  });
});
