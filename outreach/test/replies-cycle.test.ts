import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson, type DB } from '../src/db/db.js';
import { persistDraft, logEvent } from '../src/approval/ledger.js';
import { adoptOrphanedSends, rearmUnresolvable } from '../src/pipeline/sentThreads.js';
import { pollState } from '../src/pipeline/replyState.js';
import { createStubChannel } from '../src/approval/channel.js';
import { runReplyCycle, type ReplyCycleDeps } from '../src/pipeline/replies.js';
import type { GmailReader, ThreadMessage } from '../src/sender/gmailReader.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const SENDER_EMAIL = 'apgupta3@asu.edu';

const draftInput: DraftInput = {
  recipient: { name: 'Daniel Kepple', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 's', body: 'b', grounded: true, wordCount: 1, notes: [] };

// isGmailShapedId (sentThreads.ts) requires lowercase hex ONLY, so every
// outbound sent-message id used as a fixture here must be pure hex or
// adoptOrphanedSends marks the row 'unresolvable' on sight and the row never
// becomes selectable, silently invalidating whatever the test meant to check.
const hex = (n: number): string => n.toString(16).padStart(6, '0');

// The same shape test/sent-threads.test.ts uses, for the same reason:
// foreign_keys = ON, so sent_threads.draft_id/person_id are real REFERENCES
// and cannot be invented.
function seedSent(db: DB, sentId: string, threadId?: string, name = 'Daniel Kepple', arxiv = '2601.00001') {
  const personId = upsertPerson(db, { name, openalexId: `A-${arxiv}`, email: 'dk@example.edu' });
  const p = persistDraft(db, {
    personId, paperArxivId: arxiv, paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  logEvent(db, p.draftId, 'sent', threadId ? { sentId, threadId } : { sentId });
  return { personId, draftId: p.draftId };
}

function secondDraft(db: DB, personId: number, arxiv: string) {
  const p = persistDraft(db, {
    personId, paperArxivId: arxiv, paperTitle: 'Another Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  return p.draftId;
}

function msg(id: string, threadId: string, internalDateMs: string, headers: Record<string, string>): ThreadMessage {
  return { id, threadId, internalDate: internalDateMs, headers };
}

// A GmailReader whose responses/failures are entirely scripted per test.
function fakeReader(
  byThread: Record<string, ThreadMessage[] | (() => ThreadMessage[])>,
  fail: Record<string, unknown[]> = {},   // threadId -> queue of errors to throw, in order
): GmailReader {
  const failQueues: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(fail)) failQueues[k] = [...v];
  return {
    async threadIdForMessage() {
      return null;
    },
    async getThreadMetadata(threadId: string) {
      const q = failQueues[threadId];
      if (q && q.length) throw q.shift();
      const entry = byThread[threadId];
      if (!entry) return [];
      return typeof entry === 'function' ? entry() : entry;
    },
  };
}

function baseDeps(db: DB, reader: GmailReader, overrides: Partial<ReplyCycleDeps> = {}): ReplyCycleDeps {
  return {
    db, reader, senderEmail: SENDER_EMAIL,
    // The REAL clock, deliberately, not a hardcoded calendar date: markAllDue
    // and every `next_poll_at <= datetime('now')` assertion below compare
    // against SQLite's real datetime('now'), so an injected `now` pinned to a
    // fixed past date computes a next_poll_at that is STILL in the past under
    // that real comparison, and a row that should read as freshly-polled
    // reads as still-due instead.
    now: () => new Date(),
    sleep: async () => {},
    log: () => {},
    ...overrides,
  };
}

function gaxiosError(status: number, message = 'boom'): Error {
  return Object.assign(new Error(message), { status });
}

function markAllDue(db: DB): void {
  db.prepare("UPDATE sent_threads SET next_poll_at = datetime('now', '-1 hour')").run();
}

// The two message shapes every fixture below reuses: our own outbound send
// (never a reply, matched by sentMessageId) and a plain human reply.
function humanReply(id: string, threadId: string, from: string, when: string): ThreadMessage {
  return msg(id, threadId, String(new Date(when).getTime()), { from, date: when });
}
function autoReply(id: string, threadId: string, from: string, when: string): ThreadMessage {
  return msg(id, threadId, String(new Date(when).getTime()), {
    from, date: when, 'auto-submitted': 'auto-replied',
  });
}

describe('blocker 1: a repeat sighting is a no-op, not a rollback', () => {
  it('sees an auto-reply three times as a no-op, then still detects the human reply', async () => {
    const db = openDb(':memory:');
    const { draftId } = seedSent(db, hex(1), 't1');
    adoptOrphanedSends(db);
    const reader = fakeReader({
      t1: [
        msg(hex(1), 't1', '1', {}),   // our own sent message, filtered by sentMessageId
        autoReply('auto1', 't1', 'Someone <oof@example.edu>', 'Wed, 05 Aug 2026 08:00:00 +0000'),
      ],
    });

    const results: { summary: Awaited<ReturnType<typeof runReplyCycle>>; afterPollAt: string }[] = [];
    let now = new Date();
    for (let i = 0; i < 3; i++) {
      markAllDue(db);
      const capturedNow = now;
      const summary = await runReplyCycle(baseDeps(db, reader, { now: () => capturedNow }));
      const afterPollAt = (db.prepare('SELECT next_poll_at AS n FROM sent_threads WHERE draft_id = ?').get(draftId) as { n: string }).n;
      results.push({ summary, afterPollAt });
      now = new Date(now.getTime() + 3600_000);
    }

    const row = db.prepare(
      'SELECT watch_state AS w, poll_failures AS f FROM sent_threads WHERE draft_id = ?',
    ).get(draftId) as { w: string; f: number };
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT kind FROM replies').get() as { kind: string }).kind).toBe('auto_reply');
    expect(row.w).toBe('open');
    expect(row.f).toBe(0);
    // next_poll_at must have advanced each cycle (not stuck at the same value,
    // which is what the rollback under a plain INSERT would produce).
    expect(results[0]!.afterPollAt).not.toBe(results[1]!.afterPollAt);
    expect(results[1]!.afterPollAt).not.toBe(results[2]!.afterPollAt);
    expect(results[0]!.summary.notified).toBe(0);
    expect(results[1]!.summary.notified).toBe(0);
    expect(results[2]!.summary.notified).toBe(0);

    // cycle 4: a human reply now shows up alongside the (still repeating) auto-reply.
    const channel = createStubChannel();
    markAllDue(db);
    const reader2 = fakeReader({
      t1: [
        msg(hex(1), 't1', '1', {}),
        autoReply('auto1', 't1', 'Someone <oof@example.edu>', 'Wed, 05 Aug 2026 08:00:00 +0000'),
        humanReply('human1', 't1', 'Daniel Kepple <dk@example.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000'),
      ],
    });
    const summary4 = await runReplyCycle(
      baseDeps(db, reader2, { now: () => new Date(now.getTime() + 3600_000), channel: async () => channel }),
    );
    expect(summary4.notified).toBe(1);
    expect(channel.notices).toHaveLength(1);
    expect(channel.notices[0]).toContain('Daniel Kepple');
    const finalRow = db.prepare('SELECT watch_state AS w FROM sent_threads WHERE draft_id = ?').get(draftId) as { w: string };
    expect(finalRow.w).toBe('replied');
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(2);
  });
});

describe('blocker 2: failure scope', () => {
  it('a cycle-wide failure touches NO row and destroys nothing', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 10; i++) seedSent(db, hex(i), `t${i}`, `Person ${i}`, `2601.100${i}`);
    adoptOrphanedSends(db);

    for (let cycle = 0; cycle < 5; cycle++) {
      markAllDue(db);
      const readerCycle = fakeReader({}, { t0: [gaxiosError(401, 'invalid_grant')] });
      const summary = await runReplyCycle(baseDeps(db, readerCycle));
      expect(summary.cycleFailure).toBe('invalid_grant');
      const rows = db.prepare('SELECT watch_state AS w, poll_failures AS f FROM sent_threads').all() as { w: string; f: number }[];
      expect(rows).toHaveLength(10);
      for (const r of rows) {
        expect(r.w).toBe('open');
        expect(r.f).toBe(0);
      }
      expect(pollState(db).consecutiveCycleFailures).toBe(cycle + 1);
    }
  });

  it('a 404 on ONE thread is charged to that thread and to nothing else', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 10; i++) seedSent(db, hex(i), `t${i}`, `Person ${i}`, `2601.200${i}`);
    adoptOrphanedSends(db);
    markAllDue(db);

    const byThread: Record<string, ThreadMessage[]> = {};
    for (let i = 0; i < 10; i++) byThread[`t${i}`] = [msg(hex(i), `t${i}`, '1', {})];
    const reader = fakeReader(byThread, { t3: [gaxiosError(404)] });

    const summary = await runReplyCycle(baseDeps(db, reader));
    expect(summary.cycleFailure).toBeUndefined();
    const rows = db.prepare('SELECT sent_message_id AS s, watch_state AS w, poll_failures AS f FROM sent_threads').all() as
      { s: string; w: string; f: number }[];
    const t3row = rows.find((r) => r.s === hex(3))!;
    expect(t3row.w).toBe('open');
    expect(t3row.f).toBe(1);
    for (const r of rows) {
      if (r.s === hex(3)) continue;
      expect(r.w).toBe('open');
      expect(r.f).toBe(0);
    }
    expect(pollState(db).consecutiveCycleFailures).toBe(0);
  });

  it('five consecutive thread-scoped failures mark that row unresolvable, and a success resets', async () => {
    const db = openDb(':memory:');
    const { draftId } = seedSent(db, hex(1), 'tfail');
    adoptOrphanedSends(db);

    for (let i = 0; i < 5; i++) {
      markAllDue(db);
      const reader = fakeReader({}, { tfail: [gaxiosError(404)] });
      await runReplyCycle(baseDeps(db, reader));
    }
    let row = db.prepare('SELECT watch_state AS w, poll_failures AS f FROM sent_threads WHERE draft_id = ?').get(draftId) as
      { w: string; f: number };
    expect(row.w).toBe('unresolvable');
    expect(row.f).toBe(5);

    expect(rearmUnresolvable(db)).toBe(1);
    markAllDue(db);
    const reader = fakeReader({ tfail: [msg(hex(1), 'tfail', '1', {})] });
    await runReplyCycle(baseDeps(db, reader));
    row = db.prepare('SELECT watch_state AS w, poll_failures AS f FROM sent_threads WHERE draft_id = ?').get(draftId) as
      { w: string; f: number };
    expect(row.f).toBe(0);
    expect(row.w).toBe('open');
  });
});

describe('notify-then-mark ordering', () => {
  it('does not set notified_at when notify throws, and notifies exactly once across both runs', async () => {
    const db = openDb(':memory:');
    const { draftId } = seedSent(db, hex(1), 'tnotify');
    adoptOrphanedSends(db);
    markAllDue(db);

    const reader = fakeReader({
      tnotify: [humanReply('h1', 'tnotify', 'Daniel Kepple <dk@example.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000')],
    });
    let notifyCalls = 0;
    const throwingChannel = {
      sendDraftMessage: async () => {},
      notify: async () => {
        notifyCalls++;
        throw new Error('spectrum down');
      },
      captureReplies: async () => [],
      streamReplies: async () => ({ reason: 'ended' as const }),
    };
    await expect(runReplyCycle(baseDeps(db, reader, { channel: async () => throwingChannel }))).rejects.toThrow('spectrum down');
    expect(notifyCalls).toBe(1);
    const row = db.prepare('SELECT notified_at AS n FROM replies WHERE draft_id = ?').get(draftId) as { n: string | null };
    expect(row.n).toBeNull();

    // Next cycle: the same reply is still there (already recorded, conflict
    // ignored), notified_at is still NULL, so it notifies exactly once now.
    markAllDue(db);
    const reader2 = fakeReader({
      tnotify: [humanReply('h1', 'tnotify', 'Daniel Kepple <dk@example.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000')],
    });
    const channel = createStubChannel();
    const summary = await runReplyCycle(baseDeps(db, reader2, { channel: async () => channel }));
    expect(summary.notified).toBe(1);
    expect(channel.notices).toHaveLength(1);
    const row2 = db.prepare('SELECT notified_at AS n FROM replies WHERE draft_id = ?').get(draftId) as { n: string | null };
    expect(row2.n).not.toBeNull();
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(1);
  });
});

describe('notified_at covers the WHOLE cycle, including the "and N more" tail', () => {
  it('marks every covered row notified, not only the ones named in the text', async () => {
    const db = openDb(':memory:');
    const byThread: Record<string, ThreadMessage[]> = {};
    for (let i = 0; i < 7; i++) {
      seedSent(db, hex(i), `tt${i}`, `Tail ${i}`, `2601.800${i}`);
      byThread[`tt${i}`] = [humanReply(`rt${i}`, `tt${i}`, `p${i} <p${i}@example.edu>`, 'Wed, 05 Aug 2026 09:00:00 +0000')];
    }
    adoptOrphanedSends(db);
    markAllDue(db);
    const channel = createStubChannel();
    const summary = await runReplyCycle(baseDeps(db, fakeReader(byThread), { channel: async () => channel }));
    expect(summary.notified).toBe(7);   // ALL seven, not just the 5 shown by name
    expect(channel.notices).toHaveLength(1);
    expect(channel.notices[0]).toContain('and 2 more');
    const unnotified = db.prepare('SELECT count(*) AS n FROM replies WHERE notified_at IS NULL').get() as { n: number };
    expect(unnotified.n).toBe(0);

    // A second cycle finds nothing left to notify: the tail was covered too.
    markAllDue(db);
    const summary2 = await runReplyCycle(
      baseDeps(db, fakeReader(byThread), { channel: async () => { throw new Error('must not connect: nothing to notify'); } }),
    );
    expect(summary2.notified).toBe(0);
  });
});

describe('the quiet-cycle property', () => {
  it('never CALLS the channel factory on a quiet cycle', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 3; i++) seedSent(db, hex(i), `tq${i}`, `Q Person ${i}`, `2601.300${i}`);
    adoptOrphanedSends(db);
    markAllDue(db);
    const byThread: Record<string, ThreadMessage[]> = {};
    for (let i = 0; i < 3; i++) byThread[`tq${i}`] = [msg(hex(i), `tq${i}`, '1', {})];
    const reader = fakeReader(byThread);
    const factory = vi.fn(async () => { throw new Error('a quiet cycle must not connect'); });
    const summary = await runReplyCycle(baseDeps(db, reader, { channel: factory }));
    expect(factory).not.toHaveBeenCalled();
    expect(summary.notified).toBe(0);
  });

  it('calls the factory exactly ONCE when there are several notices to send', async () => {
    const db = openDb(':memory:');
    seedSent(db, hex(1), 'th1', 'Human One', '2601.4001');
    seedSent(db, hex(2), 'th2', 'Human Two', '2601.4002');
    adoptOrphanedSends(db);
    markAllDue(db);
    const reader = fakeReader({
      th1: [humanReply('rh1', 'th1', 'A <a@example.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000')],
      th2: [humanReply('rh2', 'th2', 'B <b@example.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000')],
    });
    const channel = createStubChannel();
    const factory = vi.fn(async () => channel);
    const summary = await runReplyCycle(baseDeps(db, reader, { channel: factory }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(summary.notified).toBe(2);
    // Both replies coalesced into ONE human-reply notice (one notify call).
    expect(channel.notices).toHaveLength(1);
  });
});

describe('--dry-run', () => {
  it('writes nothing at all, but still reports what it WOULD do', async () => {
    const db = openDb(':memory:');
    const { draftId } = seedSent(db, hex(1), 'tdry');
    adoptOrphanedSends(db);
    markAllDue(db);
    const before = db.prepare('SELECT * FROM sent_threads WHERE draft_id = ?').get(draftId);
    const beforeReplies = (db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n;

    const reader = fakeReader({
      tdry: [humanReply('hdry', 'tdry', 'Daniel Kepple <dk@example.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000')],
    });
    const factory = vi.fn(async () => { throw new Error('dry run must not connect'); });
    const lines: string[] = [];
    const summary = await runReplyCycle(baseDeps(db, reader, { channel: factory, dryRun: true, log: (m) => lines.push(m) }));

    expect(factory).not.toHaveBeenCalled();
    expect(summary.newReplies).toBe(1);
    expect(lines.some((l) => l.includes('would record') && l.includes('human'))).toBe(true);

    const after = db.prepare('SELECT * FROM sent_threads WHERE draft_id = ?').get(draftId);
    expect(after).toEqual(before);
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(beforeReplies);
  });
});

describe('privacy: err.message only, never the error object', () => {
  it('logs no address, no subject and no snippet, even when the reader throws a Gaxios-shaped error', async () => {
    const db = openDb(':memory:');
    seedSent(db, hex(1), 'tpriv');
    adoptOrphanedSends(db);
    markAllDue(db);

    const leaky = Object.assign(new Error('invalid_grant'), {
      status: 401,
      response: { headers: { from: 'Daniel Kepple <dkepple@example.edu>' } },
      config: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/tpriv?format=metadata' },
    });
    const reader = fakeReader({}, { tpriv: [leaky] });
    const lines: string[] = [];
    await runReplyCycle(baseDeps(db, reader, { log: (m) => lines.push(m) }));
    const joined = lines.join('\n');
    expect(joined).not.toContain('dkepple@example.edu');
    expect(joined).not.toContain('googleapis.com');
    expect(joined).toContain('invalid_grant');
  });
});

describe('pacing and limits', () => {
  it('paces at maxCallsPerMinute using the INJECTED sleep, so the suite stays fast', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 3; i++) seedSent(db, hex(i), `tp${i}`, `P${i}`, `2601.500${i}`);
    adoptOrphanedSends(db);
    markAllDue(db);
    const byThread: Record<string, ThreadMessage[]> = {};
    for (let i = 0; i < 3; i++) byThread[`tp${i}`] = [msg(hex(i), `tp${i}`, '1', {})];
    const reader = fakeReader(byThread);
    const sleep = vi.fn(async (_ms: number) => {});
    await runReplyCycle(baseDeps(db, reader, { sleep, maxCallsPerMinute: 120 }));
    expect(sleep).toHaveBeenCalledTimes(3);
    for (const call of sleep.mock.calls) expect(call[0]).toBe(500);
  });

  it('honours maxThreadsPerCycle, and the overflow is simply due next run', async () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 3; i++) seedSent(db, hex(i), `to${i}`, `O${i}`, `2601.600${i}`);
    adoptOrphanedSends(db);
    markAllDue(db);
    const byThread: Record<string, ThreadMessage[]> = {};
    for (let i = 0; i < 3; i++) byThread[`to${i}`] = [msg(hex(i), `to${i}`, '1', {})];
    const reader = fakeReader(byThread);
    const summary1 = await runReplyCycle(baseDeps(db, reader, { maxThreadsPerCycle: 2 }));
    expect(summary1.polled).toBe(2);
    const stillDue = db.prepare("SELECT count(*) AS n FROM sent_threads WHERE next_poll_at <= datetime('now')").get() as { n: number };
    expect(stillDue.n).toBe(1);

    const summary2 = await runReplyCycle(baseDeps(db, reader, { maxThreadsPerCycle: 2 }));
    expect(summary2.polled).toBe(1);
  });
});

describe('settling every row for a shared thread', () => {
  it('settles EVERY open row for the thread it just polled, not only the selected one', async () => {
    const db = openDb(':memory:');
    const { draftId: d1, personId } = seedSent(db, hex(1), 'shared');
    adoptOrphanedSends(db);
    const d2 = secondDraft(db, personId, '2601.7002');
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, next_poll_at)
       VALUES (?, ?, ?, 'shared', datetime('now'), datetime('now', '-1 hour'))`,
    ).run(d2, personId, hex(2));
    db.prepare("UPDATE sent_threads SET next_poll_at = datetime('now', '-1 hour') WHERE draft_id = ?").run(d1);

    // hex(1) < hex(2), so DueThread.sentMessageId (min) is hex(1): this
    // message is OUR OWN send and must be filtered, leaving no reply row.
    const reader = fakeReader({ shared: [msg(hex(1), 'shared', '1', {})] });
    const summary = await runReplyCycle(baseDeps(db, reader));
    expect(summary.polled).toBe(1);   // one DISTINCT thread selected

    const rows = db.prepare('SELECT draft_id AS d, last_polled_at AS lp, next_poll_at AS np FROM sent_threads').all() as
      { d: number; lp: string | null; np: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.lp).not.toBeNull();
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(0);

    // A second cycle at the same now selects nothing: both rows were settled.
    const dueRows = db.prepare(
      "SELECT count(*) AS n FROM sent_threads WHERE watch_state = 'open' AND next_poll_at <= datetime('now')",
    ).get() as { n: number };
    expect(dueRows.n).toBe(0);
  });
});

describe('last_cycle_at in a finally', () => {
  it('writes last_cycle_at even when the cycle throws something it does not classify', async () => {
    const db = openDb(':memory:');
    seedSent(db, hex(1), 'tuc');
    adoptOrphanedSends(db);
    const before = pollState(db);
    expect(before.lastSuccessAt).toBeNull();

    // Wrap the db so selectDueThreads' own query throws something that
    // classifyFailure never sees, because it happens OUTSIDE the per-thread
    // try/catch entirely (selectDueThreads is called before the loop body
    // that owns the catch).
    const throwing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('GROUP BY thread_id')) throw new Error('unclassified boom');
            return (target as unknown as { prepare: (s: string) => unknown }).prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DB;

    const reader = fakeReader({});
    await expect(runReplyCycle(baseDeps(throwing, reader))).rejects.toThrow('unclassified boom');

    const after = db.prepare(
      'SELECT last_cycle_at AS c, last_success_at AS s, consecutive_cycle_failures AS f FROM reply_poll_state WHERE id = 1',
    ).get() as { c: string | null; s: string | null; f: number };
    expect(after.c).not.toBeNull();
    expect(after.s).toBeNull();
    expect(after.f).toBe(0);
  });
});

describe('does not fabricate ground truth from our own follow-up', () => {
  it('never records our own sent message or our own follow-up as a reply', async () => {
    const db = openDb(':memory:');
    seedSent(db, hex(1), 'town');
    adoptOrphanedSends(db);
    markAllDue(db);
    const reader = fakeReader({
      town: [
        msg(hex(1), 'town', '1', {}),   // our own sent message
        humanReply('follow1', 'town', 'Aditya Gupta <apgupta3@asu.edu>', 'Wed, 05 Aug 2026 09:00:00 +0000'),   // our own follow-up
        humanReply('follow2', 'town', '<APGUPTA3@ASU.EDU>', 'Wed, 05 Aug 2026 09:05:00 +0000'),
      ],
    });
    await runReplyCycle(baseDeps(db, reader));
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(0);
    const row = db.prepare('SELECT watch_state AS w FROM sent_threads').get() as { w: string };
    expect(row.w).toBe('open');
  });
});

describe('bounce and auto_reply leave the thread open and are handled distinctly', () => {
  it('a mailer-daemon bounce is recorded, notifies, and leaves the row open', async () => {
    const db = openDb(':memory:');
    seedSent(db, hex(1), 'tb');
    adoptOrphanedSends(db);
    markAllDue(db);
    const reader = fakeReader({
      tb: [msg('bounce1', 'tb', '1', { from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' })],
    });
    const channel = createStubChannel();
    const summary = await runReplyCycle(baseDeps(db, reader, { channel: async () => channel }));
    expect(summary.notified).toBe(1);
    expect(channel.notices[0]).toContain('Bounced');
    const row = db.prepare('SELECT watch_state AS w FROM sent_threads').get() as { w: string };
    expect(row.w).toBe('open');
  });
});
