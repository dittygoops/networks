// The bug this file exists to make impossible, measured on this machine
// 2026-08-05:
//
//   strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour') <= datetime('now')  ->  0
//   strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')  <= datetime('now')  ->  1
//   strftime('%Y-%m-%d %H:%M:%S','now','-1 hour')  <= datetime('now')  ->  1
//
// SQLite compares TEXT bytewise and 'T' (0x54) sorts above ' ' (0x20), so an
// ISO-Z due time loses the comparison ONLY while its date prefix equals today's.
// A due time an hour in the past reads NOT YET DUE; one a day in the past reads
// due. So the failure is not permanent silence, it is a cadence collapse: every
// tier degenerates to about one poll a day, with no error and no notification.
//
// That same-UTC-day window is why the round-trip test below pins its past time
// to the START of the database's current UTC day rather than to `Date.now() -
// 1 hour`. With a relative hour, a suite run between 00:00 and 01:00 UTC puts
// the fixture on the PREVIOUS date, the mutation in Step 6 stays GREEN, and the
// plan sends the implementer to investigate a bug that is really a clock.
//
// julianday() parses BOTH forms identically (2461256.91666667 for each), so a
// cadence test written with julianday passes under the bug and proves nothing.
// The round-trip test below therefore uses the REAL selection query.
//
// foreign_keys = ON (db.ts:18) and sent_threads.draft_id / person_id are both
// REFERENCES, so these fixtures cannot invent ids: seedWatchRow creates a real
// person and a real draft first. An earlier draft of this plan inserted
// (draft_id, person_id) = (1, 1) into an empty database, which throws
// SQLITE_CONSTRAINT_FOREIGNKEY and tests nothing at all.
import { describe, expect, it } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { persistDraft } from '../src/approval/ledger.js';
import { toSqlTime, fromInternalDate, addHours, SQL_TIME_SHAPE } from '../src/db/time.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Daniel Kepple', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 's', body: 'b', grounded: true, wordCount: 1, notes: [] };

// The same shape Task 6's seedSent uses, for the same reason. Returns real ids
// that satisfy both foreign keys.
function seedWatchRow(): { db: ReturnType<typeof openDb>; draftId: number; personId: number } {
  const db = openDb(':memory:');
  const personId = upsertPerson(db, { name: 'Daniel Kepple', openalexId: 'A-dk', email: 'dk@example.edu' });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  return { db, draftId: p.draftId, personId };
}

describe('the one canonical timestamp form', () => {
  it('emits the datetime(\'now\') shape, with no T and no Z', () => {
    const s = toSqlTime(new Date(Date.UTC(2026, 7, 4, 10, 0, 0)));
    expect(s).toBe('2026-08-04 10:00:00');
    expect(SQL_TIME_SHAPE.test(s)).toBe(true);
    expect(s).not.toContain('T');
    expect(s).not.toContain('Z');
  });

  it('converts Gmail internalDate epoch milliseconds', () => {
    // internalDate arrives as a STRING of epoch ms, not a number.
    expect(fromInternalDate('1785931200000')).toBe(toSqlTime(new Date(1785931200000)));
    expect(SQL_TIME_SHAPE.test(fromInternalDate('1785931200000'))).toBe(true);
  });

  it('addHours stays in the canonical form across a day boundary', () => {
    expect(addHours(new Date(Date.UTC(2026, 7, 4, 22, 0, 0)), 4)).toBe('2026-08-05 02:00:00');
  });

  // THE test. Not julianday, not a shape check: the real predicate the poller
  // uses to decide what is due. This is the only assertion that can catch the
  // ISO-Z bug end to end.
  it('a past due time actually selects, through the real query', () => {
    const { db, draftId, personId } = seedWatchRow();
    // Pinned to the START of the database's own current UTC day, NOT to
    // Date.now() - 1 hour. It is always <= datetime('now') (equal at worst), and
    // it is always on the SAME UTC date, which is the only window in which the
    // ISO-Z bug is observable. A relative offset would put the fixture on
    // yesterday's date for any run in the first hour of the UTC day, and the
    // Step 6 mutation would then quietly stay green.
    const today = (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
    const past = toSqlTime(new Date(`${today}T00:00:00Z`));
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, sent_at, next_poll_at)
       VALUES (?, ?, 'abc123', ?, ?)`,
    ).run(draftId, personId, past, past);
    const due = db
      .prepare("SELECT draft_id FROM sent_threads WHERE watch_state = 'open' AND next_poll_at <= datetime('now')")
      .all();
    expect(due).toHaveLength(1);
  });

  it('a future due time does not select, so the predicate is not vacuously true', () => {
    const { db, draftId, personId } = seedWatchRow();
    const now = toSqlTime(new Date());
    const future = toSqlTime(new Date(Date.now() + 86400_000));   // tomorrow, so the date prefix differs
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, sent_at, next_poll_at)
       VALUES (?, ?, 'abc123', ?, ?)`,
    ).run(draftId, personId, now, future);
    expect(
      db.prepare("SELECT draft_id FROM sent_threads WHERE watch_state = 'open' AND next_poll_at <= datetime('now')").all(),
    ).toHaveLength(0);
  });
});

describe('the three new tables reach a live database', () => {
  it('creates all three, and reply_poll_state has exactly one row', () => {
    const db = openDb(':memory:');
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    expect(names.has('sent_threads')).toBe(true);
    expect(names.has('replies')).toBe(true);
    expect(names.has('reply_poll_state')).toBe(true);
    expect((db.prepare('SELECT count(*) AS n FROM reply_poll_state').get() as { n: number }).n).toBe(1);
  });

  it('is idempotent, because openDb execs schema.sql on EVERY open', () => {
    const db = openDb(':memory:');
    // Simulate the second open on a live file: re-running the singleton insert
    // must not produce a second row or throw.
    db.exec("INSERT OR IGNORE INTO reply_poll_state (id) VALUES (1)");
    expect((db.prepare('SELECT count(*) AS n FROM reply_poll_state').get() as { n: number }).n).toBe(1);
  });

  it('rejects a second reply row for the same gmail_message_id', () => {
    // Real ids again: replies.draft_id and replies.person_id are REFERENCES too.
    const { db, draftId, personId } = seedWatchRow();
    const ins = db.prepare(
      `INSERT INTO replies (draft_id, person_id, gmail_message_id, thread_id, from_address, received_at, kind)
       VALUES (?, ?, 'msg1', 't1', 'a@b.edu', '2026-08-04 10:00:00', 'human')
       ON CONFLICT(gmail_message_id) DO NOTHING`,
    );
    expect(ins.run(draftId, personId).changes).toBe(1);
    expect(ins.run(draftId, personId).changes).toBe(0);   // a repeat sighting is a NO-OP, not a throw
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(1);
  });
});
