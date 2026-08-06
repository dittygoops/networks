// The reply poll cycle: take the run lease, adopt orphaned sends from
// draft_events with zero API calls, poll every due thread with one `await`
// per thread, commit one synchronous transaction per thread, then notify on
// newly-detected human replies and bounces before marking them notified.
//
// See docs/superpowers/plans/2026-08-04-reply-tracking.md (Task 9) and
// docs/superpowers/specs/2026-08-04-reply-tracking-design.md (Changes 4-7).
import type { DB } from '../db/db.js';
import type { ApprovalChannel } from '../approval/channel.js';
import { formatHumanReplyNotice, formatBounceNotice, formatPollFailureNotice, type ReplyNotice } from '../approval/channel.js';
import { formatShortId } from '../approval/ids.js';
import type { GmailReader, ThreadMessage } from '../sender/gmailReader.js';
import { classifyFailure } from '../sender/gmailReader.js';
import { extractAddress, isOurs, classifyKind } from './replyClassify.js';
import { adoptOrphanedSends, selectDueThreads, nextPollAt, type DueThread } from './sentThreads.js';
import {
  acquireLease, releaseLease, recordCycleAttempt, recordCycleSuccess, recordCycleFailure, markFailureNotified,
} from './replyState.js';
import { toSqlTime, fromInternalDate } from '../db/time.js';

// NOT `ReplyDeps`. `loop.ts:62` already exports an interface by that name,
// with a completely different shape (a required `channel` VALUE and a
// `sender`, no reader, no lease), for `performApprovedSend` and `handleReply`.
// Two exported `ReplyDeps` with different shapes in one pipeline directory is
// a rename waiting to happen in the middle of the one task that touches the
// irreversible send path, so this cycle gets its own name.
export interface ReplyCycleDeps {
  db: DB;
  reader: GmailReader;
  // A FACTORY, not a value. Typing this as `channel?: ApprovalChannel` makes
  // "never construct a channel on a quiet cycle" unachievable: whatever
  // builds the deps object would have to have constructed the channel BEFORE
  // runReplyCycle is entered, so the property would already be a live
  // connection no matter what this function does with it. As a factory, the
  // connection does not exist until step 4 finds something to say (or a
  // cycle-wide failure crosses the 3-alarm threshold), and a quiet cycle
  // simply never calls it.
  channel?: () => Promise<ApprovalChannel>;
  senderEmail: string;                // REQUIRED. Never defaulted. See below.
  // The caller already holds the run lease and will release it. cmdReplies
  // (Task 10) sets this, because --backfill (the largest single quota spend
  // in the feature) runs BEFORE this function and must be inside the lease
  // too. Left unset, this function takes and releases the lease itself, which
  // is what a direct caller and every test in this file does.
  leaseHeld?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  maxThreadsPerCycle?: number;        // default 400
  maxCallsPerMinute?: number;         // default 100
  dryRun?: boolean;
}

export interface ReplyCycleSummary {
  adopted: number;
  polled: number;
  newReplies: number;
  alreadyKnown: number;
  notified: number;
  unresolvable: number;
  skippedNoLease: boolean;
  cycleFailure?: string;
}

const EMPTY_SUMMARY: ReplyCycleSummary = {
  adopted: 0, polled: 0, newReplies: 0, alreadyKnown: 0,
  notified: 0, unresolvable: 0, skippedNoLease: false,
};

function countUnresolvable(db: DB): number {
  return (db.prepare("SELECT count(*) AS n FROM sent_threads WHERE watch_state = 'unresolvable'").get() as { n: number }).n;
}

// Charged to the WHOLE thread (WHERE thread_id), not to the single draft row
// selectDueThreads happened to attribute it to: the same sibling-row hazard
// persistThread's settle step guards against below. Five consecutive
// thread-scoped failures move the row to 'unresolvable'; any successful poll
// resets the counter to 0 in persistThread.
function bumpThreadFailure(db: DB, threadId: string, now: Date): void {
  db.prepare(
    `UPDATE sent_threads
        SET poll_failures = poll_failures + 1,
            last_polled_at = ?,
            watch_state = CASE WHEN poll_failures + 1 >= 5 THEN 'unresolvable' ELSE watch_state END
      WHERE thread_id = ? AND watch_state = 'open'`,
  ).run(toSqlTime(now), threadId);
}

interface PersistOutcome { newReplies: number; alreadyKnown: number }

// The ONE synchronous transaction per thread. better-sqlite3 transactions are
// synchronous: this function is called AFTER the `await getThreadMetadata`
// above it resolves, never around it, so nothing inside the transaction body
// ever awaits.
function persistThread(db: DB, t: DueThread, messages: ThreadMessage[], senderEmail: string, now: Date): PersistOutcome {
  const txn = db.transaction((): PersistOutcome => {
    let newReplies = 0;
    let alreadyKnown = 0;
    let sawHuman = false;
    for (const m of messages) {
      if (m.id === t.sentMessageId) continue;                     // our own outbound message
      if (isOurs(m.headers.from ?? '', senderEmail)) continue;     // our own follow-up in the thread
      const kind = classifyKind(m.headers);
      // ON CONFLICT DO NOTHING: a repeat sighting is a NORMAL no-op, the
      // expected steady state for any thread carrying an auto-reply, forever.
      // A plain INSERT would throw here, rolling back the settle UPDATE below
      // with it: that rollback IS blocker 1.
      const res = db.prepare(
        `INSERT INTO replies (draft_id, person_id, gmail_message_id, thread_id, from_address, received_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(gmail_message_id) DO NOTHING`,
      ).run(
        t.draftId, t.personId, m.id, m.threadId,
        extractAddress(m.headers.from ?? ''), fromInternalDate(m.internalDate), kind,
      );
      if (res.changes === 1) newReplies++; else alreadyKnown++;
      if (kind === 'human') sawHuman = true;
    }
    // ONLY a human reply may close a thread. auto_reply and bounce leave it
    // OPEN: closing on a Monday out-of-office would blind the thread to the
    // real reply that follows it.
    const tier = nextPollAt(new Date(`${t.sentAt.replace(' ', 'T')}Z`), now);
    const nextAt = 'next' in tier ? tier.next : toSqlTime(now);
    const watchState = sawHuman ? 'replied' : 'close' in tier ? 'closed_no_reply' : 'open';
    // WHERE thread_id, not WHERE draft_id. selectDueThreads groups by
    // thread_id and returns ONE row per distinct thread, attributed to the
    // lowest open draft_id carrying it, so a thread shared by two drafts (two
    // --to-self sends, or a --force second email to one person) has a sibling
    // row this cycle never selected. Settling only t.draftId would leave that
    // sibling at its old next_poll_at, so the same thread gets fetched AGAIN
    // next cycle, doubling the quota spend on it until the tier catches up.
    // Restricted to 'open' so this can never resurrect a row already settled
    // as replied, closed_no_reply or unresolvable.
    db.prepare(
      `UPDATE sent_threads
          SET last_polled_at = ?, poll_failures = 0, next_poll_at = ?, watch_state = ?
        WHERE thread_id = ? AND watch_state = 'open'`,
    ).run(toSqlTime(now), nextAt, watchState, t.threadId);
    return { newReplies, alreadyKnown };
  });
  return txn();
}

// The --dry-run mirror of persistThread: same classification, zero writes.
// Reports what WOULD have been recorded, per row, so `outreach replies
// --dry-run` is not the trivial "reports nothing, changes nothing" check the
// spec calls out as unable to fail.
interface PreviewOutcome { newReplies: number; alreadyKnown: number; lines: string[] }

function previewThread(db: DB, t: DueThread, messages: ThreadMessage[], senderEmail: string): PreviewOutcome {
  const known = new Set(
    (db.prepare('SELECT gmail_message_id AS id FROM replies WHERE thread_id = ?').all(t.threadId) as { id: string }[])
      .map((r) => r.id),
  );
  let newReplies = 0;
  let alreadyKnown = 0;
  const lines: string[] = [];
  for (const m of messages) {
    if (m.id === t.sentMessageId) continue;
    if (isOurs(m.headers.from ?? '', senderEmail)) continue;
    if (known.has(m.id)) { alreadyKnown++; continue; }
    newReplies++;
    const kind = classifyKind(m.headers);
    lines.push(`[dry-run] would record a ${kind} reply on thread ${t.threadId} (${formatShortId(t.draftId)})`);
  }
  return { newReplies, alreadyKnown, lines };
}

interface PendingRow { id: number; draftId: number; personName: string; receivedAt: string; kind: 'human' | 'bounce' }

// notified_at IS NULL AND kind IN ('human','bounce'): an auto_reply is
// recorded and never notified, by design (an out-of-office is noise).
function selectUnnotified(db: DB): PendingRow[] {
  return db.prepare(
    `SELECT r.id AS id, r.draft_id AS draftId, p.name AS personName, r.received_at AS receivedAt, r.kind AS kind
       FROM replies r JOIN people p ON p.id = r.person_id
      WHERE r.notified_at IS NULL AND r.kind IN ('human','bounce')
      ORDER BY r.id ASC`,
  ).all() as PendingRow[];
}

function markNotified(db: DB, ids: number[]): void {
  if (!ids.length) return;
  db.prepare(`UPDATE replies SET notified_at = datetime('now') WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

// Roughly how long ago a message arrived, for a human reading a phone
// notification. Deliberately coarse: the exact minute is in Gmail if he wants
// it.
function ageText(receivedAt: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - new Date(`${receivedAt.replace(' ', 'T')}Z`).getTime());
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Splits the covered rows into the human-reply notice and the bounce notice
// (at most one of each per cycle: Change 6's structural count bound of 3
// messages, the third being the failure alarm handled separately below), and
// hands back every covered id alongside its text so the caller can set
// notified_at on ALL of them, including the ones folded into an `and N more`
// tail: marking only the named rows would re-notify the unnamed ones forever.
function buildNotices(pending: PendingRow[], now: Date): [string, number[]][] {
  const toNotice = (r: PendingRow): ReplyNotice =>
    ({ shortId: formatShortId(r.draftId), personName: r.personName, ageText: ageText(r.receivedAt, now) });
  const humanRows = pending.filter((r) => r.kind === 'human');
  const bounceRows = pending.filter((r) => r.kind === 'bounce');
  const out: [string, number[]][] = [];
  if (humanRows.length) out.push([formatHumanReplyNotice(humanRows.map(toNotice)), humanRows.map((r) => r.id)]);
  if (bounceRows.length) out.push([formatBounceNotice(bounceRows.map(toNotice)), bounceRows.map((r) => r.id)]);
  return out;
}

// `senderEmail` is REQUIRED and never defaulted. If it were optional and
// defaulted, an unset SENDER_EMAIL would make `isOurs` false for every
// message, and every one of Aditya's own follow-ups would be recorded as an
// inbound reply from a stranger. The CLI (Task 10) refuses to start without
// it, in the style of createGmailApiSender's missing-credential error.
export async function runReplyCycle(deps: ReplyCycleDeps): Promise<ReplyCycleSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxCallsPerMinute = deps.maxCallsPerMinute ?? 100;
  const minGapMs = 60_000 / maxCallsPerMinute;

  // The one live channel this cycle ever constructs, held here rather than on
  // deps so `deps.channel` stays a factory a quiet cycle never calls, and the
  // finally still has a concrete value to close.
  let channel: ApprovalChannel | undefined;

  // 1. Lease. A loser exits 0 and is NEITHER a success NOR a failure: it must
  //    not touch consecutive_cycle_failures (three hand-runs during a
  //    scheduled cycle must not fire the 3-cycle alarm) and must not touch
  //    last_cycle_at, so it returns before the try/finally below entirely.
  if (!deps.leaseHeld && !acquireLease(deps.db, process.pid, now())) {
    log('another reply cycle holds the lease; exiting');
    return { ...EMPTY_SUMMARY, skippedNoLease: true };
  }

  const summary: ReplyCycleSummary = { ...EMPTY_SUMMARY };

  try {
    // 2. Adopt, at the head of every cycle, zero API calls. Logged even at 0:
    //    a persistently non-zero N means recordSentThread is failing.
    const adopted = deps.dryRun ? 0 : adoptOrphanedSends(deps.db);
    summary.adopted = adopted;
    log(`adopted ${adopted} sends with no watch row`);
    log(`unresolvable: ${countUnresolvable(deps.db)}`);

    // 3. Poll. ONE await per thread, then ONE synchronous transaction for
    //    that thread. Per-thread rather than per-cycle, so a failure on
    //    thread 200 cannot discard the 199 already resolved.
    for (const t of selectDueThreads(deps.db, deps.maxThreadsPerCycle ?? 400)) {
      let messages: ThreadMessage[];
      try {
        messages = await deps.reader.getThreadMetadata(t.threadId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';   // NEVER the object
        if (classifyFailure(e) === 'cycle') {
          log(`cycle-wide failure, aborting the cycle: ${msg}`);
          // ABORT. Touch no row's poll_failures. Record OUTSIDE any aborted
          // transaction, or the counter rolls back with it.
          const { shouldNotify, consecutive } = recordCycleFailure(deps.db, msg);
          if (shouldNotify) {
            // The alarm IS something to say, so this is a legitimate reason
            // to build the channel. It still goes through the factory.
            channel ??= await deps.channel?.();
            await channel?.notify(formatPollFailureNotice(consecutive, msg));
            markFailureNotified(deps.db);
          }
          summary.cycleFailure = msg;
          return summary;
        }
        log(`thread-scoped failure, continuing: ${msg}`);
        if (!deps.dryRun) bumpThreadFailure(deps.db, t.threadId, now());   // per-thread only; 5 -> unresolvable
        continue;
      }
      if (deps.dryRun) {
        const outcome = previewThread(deps.db, t, messages, deps.senderEmail);
        summary.newReplies += outcome.newReplies;
        summary.alreadyKnown += outcome.alreadyKnown;
        for (const line of outcome.lines) log(line);
      } else {
        const outcome = persistThread(deps.db, t, messages, deps.senderEmail, now());
        summary.newReplies += outcome.newReplies;
        summary.alreadyKnown += outcome.alreadyKnown;
      }
      summary.polled++;
      await sleep(minGapMs);
    }

    // 4. Notify, then mark. A crash between them re-notifies AT MOST ONCE on
    //    the next cycle, which is the correct direction: a duplicate text
    //    about a real reply is recoverable, a silently dropped one is not.
    //    notified_at is set on EVERY covered row, including the ones folded
    //    into the `and N more` tail, or a 12-reply cycle re-notifies the
    //    unnamed 7 forever.
    if (!deps.dryRun) {
      const pending = selectUnnotified(deps.db);
      if (pending.length) {
        // HERE is the first and only other place a quiet cycle would have
        // connected, and it is inside `pending.length`. Nothing above this
        // line (besides the alarm above, which is its own legitimate reason)
        // may touch deps.channel.
        channel ??= await deps.channel?.();
        for (const [text, ids] of buildNotices(pending, now())) {
          await channel!.notify(text);
          markNotified(deps.db, ids);
          summary.notified += ids.length;
        }
      }
    }

    summary.unresolvable = countUnresolvable(deps.db);
    recordCycleSuccess(deps.db);
    return summary;
  } finally {
    // last_cycle_at on EVERY exit from this function, including an
    // unclassified throw that reaches neither recordCycleSuccess nor
    // recordCycleFailure: without this line the one case that most needs a
    // timestamp (an exception nobody anticipated) is the one case that writes
    // neither counter nor timestamp, so the row still shows the last healthy
    // run and the job looks like it never fired. It touches ONLY that column:
    // it is not a success and not a failure.
    recordCycleAttempt(deps.db);
    if (!deps.leaseHeld) releaseLease(deps.db);
    // A leaked Photon connection means the process never exits and launchd
    // never schedules this job again: a leak does not degrade the feature, it
    // silently stops it forever. `channel` is the LOCAL, so this line cannot
    // itself construct one: reading deps.channel here would defeat the whole
    // quiet-cycle property.
    await channel?.close?.();
  }
}
