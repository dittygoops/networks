// Cycle-level state that MUST outlive the process.
//
// com.aditya.outreach-replies is StartCalendarInterval with no KeepAlive, so
// every cycle is a fresh short-lived process with no memory of the last one.
// "Notify after 3 consecutive failed cycles" is therefore unimplementable in
// process memory, not merely untested: the count would reset on every run, the
// alarm could never fire, and the silent-death mode it exists to catch is
// exactly the mode it would miss.
import type { DB } from '../db/db.js';
import { toSqlTime } from '../db/time.js';

export const LEASE_MS = 15 * 60_000;
export const FAILURE_ALARM_CYCLES = 3;

// launchd will not start a second copy of a job that has not exited, so the
// SCHEDULED runs cannot collide. But every live verification in the spec
// hand-runs `outreach replies` from a terminal, and that process is invisible
// to launchd's scheduler. Two cycles would select the same due rows under the
// same next_poll_at <= datetime('now') predicate and both spend 40 units each.
//
// One conditional UPDATE, the same shape as beginSendAttempt
// (ledger.ts:219-250): SQLite serializes writers and the WHERE clause carries
// the whole precondition, so there is no read-then-write gap to lose.
export function acquireLease(db: DB, pid: number, now: Date): boolean {
  const res = db.prepare(
    `UPDATE reply_poll_state
        SET lock_pid = ?, lock_expires_at = ?
      WHERE id = 1
        AND (lock_expires_at IS NULL OR lock_expires_at <= ?)`,
  ).run(pid, toSqlTime(new Date(now.getTime() + LEASE_MS)), toSqlTime(now));
  return res.changes === 1;
}

// Called from a finally, so a crashed process blocks at most one cycle rather
// than forever. The expiry above is the backstop for a hard kill.
export function releaseLease(db: DB): void {
  db.prepare('UPDATE reply_poll_state SET lock_pid = NULL, lock_expires_at = NULL WHERE id = 1').run();
}

// last_cycle_at and nothing else: not a success, not a failure, just "this
// process got here". runReplyCycle calls it from a finally.
export function recordCycleAttempt(db: DB): void {
  db.prepare("UPDATE reply_poll_state SET last_cycle_at = datetime('now') WHERE id = 1").run();
}

export function recordCycleSuccess(db: DB): void {
  db.prepare(
    `UPDATE reply_poll_state
        SET last_cycle_at = datetime('now'), last_success_at = datetime('now'),
            consecutive_cycle_failures = 0, last_error = NULL, failure_notified_at = NULL
      WHERE id = 1`,
  ).run();
}

// MUST be called outside any aborted transaction, or the counter rolls back
// with it and the bug returns in a new shape. err.message only: a GaxiosError
// carries its response headers (From addresses, under format=metadata) and its
// request URL as own enumerable properties.
export function recordCycleFailure(db: DB, message: string): { consecutive: number; shouldNotify: boolean } {
  db.prepare(
    `UPDATE reply_poll_state
        SET last_cycle_at = datetime('now'),
            consecutive_cycle_failures = consecutive_cycle_failures + 1,
            last_error = ?
      WHERE id = 1`,
  ).run(message);
  const s = pollState(db);
  return {
    consecutive: s.consecutiveCycleFailures,
    // One text per OUTAGE, not one per cycle for as long as it lasts.
    // recordCycleSuccess clears failure_notified_at, which re-arms the alarm.
    shouldNotify: s.consecutiveCycleFailures >= FAILURE_ALARM_CYCLES && s.failureNotifiedAt === null,
  };
}

export function markFailureNotified(db: DB): void {
  db.prepare("UPDATE reply_poll_state SET failure_notified_at = datetime('now') WHERE id = 1").run();
}

export function pollState(db: DB): {
  consecutiveCycleFailures: number; lastError: string | null;
  lastSuccessAt: string | null; failureNotifiedAt: string | null;
} {
  return db.prepare(
    `SELECT consecutive_cycle_failures AS consecutiveCycleFailures, last_error AS lastError,
            last_success_at AS lastSuccessAt, failure_notified_at AS failureNotifiedAt
       FROM reply_poll_state WHERE id = 1`,
  ).get() as ReturnType<typeof pollState>;
}
