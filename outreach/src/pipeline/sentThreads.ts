// sent_threads is a PROJECTION of draft_events, not a second source of truth.
// draft_events is append-only and authoritative and should stay a log, not a
// polling index; this table is where the mutable polling state lives so that no
// volatile column lands next to the frozen approval state in drafts.
import type { DB } from '../db/db.js';
import { toSqlTime, addHours } from '../db/time.js';

// Only a Gmail-shaped sentId is pollable: lowercase hex, no '@', no fallback
// prefix. All 56 current ids pass (16 lowercase hex chars, newest
// 19fca6e82b8956ad). Anything else is an SMTP Message-ID or one of the two
// synthesized fallbacks (gmail-${Date.now()} at gmail-api.ts:52,
// smtp-${Date.now()} at gmail.ts:31) and is recorded once as unresolvable and
// never retried, so a non-Gmail send path can never make the poller spin.
export function isGmailShapedId(sentId: string): boolean {
  return /^[0-9a-f]+$/.test(sentId) && !sentId.includes('@');
}

// Called by the CALLER, AFTER markSent returns, and wrapped by the caller so
// any throw is logged and swallowed. Never inside markSent's transaction: that
// transaction exists so the status UPDATE and the audit record of an
// irreversible email are one unit (ledger.ts:117-118), and an INSERT here would
// give it a brand new way to abort AFTER Gmail already accepted the message,
// rolling back both and leaving a genuinely sent email recorded as
// approved-and-unsent. stalledApprovals would then report it and a human would
// be steered toward sending a second cold email to a stranger.
//
// ON CONFLICT DO NOTHING because adoptOrphanedSends runs every cycle over the
// same log and the two must not race each other into a primary-key throw.
export function recordSentThread(
  db: DB, draftId: number, personId: number, sentId: string, threadId?: string,
): void {
  db.prepare(
    `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, watch_state)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(draft_id) DO NOTHING`,
  ).run(draftId, personId, sentId, threadId ?? null, isGmailShapedId(sentId) ? 'open' : 'unresolvable');
}

// Head of EVERY cycle. Zero API calls: a pure SQL anti-join against the log.
// This is what makes recordSentThread's swallow actually self-healing. The
// earlier design put the only recovery behind an explicit --backfill flag that
// the plist never passes, so a swallowed throw meant a thread that was never
// polled and nothing that counted the gap. The caller logs the return value on
// every run, including 0: a persistently non-zero N is the signal that
// recordSentThread is failing.
export function adoptOrphanedSends(db: DB): number {
  const res = db.prepare(
    `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, watch_state)
     SELECT e.draft_id, d.person_id,
            json_extract(e.detail_json, '$.sentId'),
            json_extract(e.detail_json, '$.threadId'),
            e.created_at,
            CASE WHEN json_extract(e.detail_json, '$.sentId') GLOB '[0-9a-f]*'
                  AND json_extract(e.detail_json, '$.sentId') NOT GLOB '*[^0-9a-f]*'
                 THEN 'open' ELSE 'unresolvable' END
       FROM draft_events e
       JOIN drafts d ON d.id = e.draft_id
       LEFT JOIN sent_threads st ON st.draft_id = e.draft_id
      WHERE e.type = 'sent'
        AND st.draft_id IS NULL
        AND json_extract(e.detail_json, '$.sentId') IS NOT NULL
     ON CONFLICT(draft_id) DO NOTHING`,
  ).run();
  // e.created_at is already datetime('now') format, which is exactly why
  // sent_at uses that form and not ISO. See src/db/time.ts.
  return res.changes;
}

const DAY_MS = 86400_000;

// Aligned to the ACTUAL fire times: 07:30, 12:30, 17:30, 21:30. The gaps are
// 5h, 5h, 4h, 10h, so +4h is the largest interval that lands inside every one
// of them. A +6h tier (the earlier draft) gives the newest and most valuable
// threads about 2 polls a day, not the 4 the quota arithmetic assumed:
// 07:30 -> due 13:30 misses the 12:30 run and waits for 17:30.
export function nextPollAt(sentAt: Date, now: Date): { next: string } | { close: true } {
  const ageDays = (now.getTime() - sentAt.getTime()) / DAY_MS;
  // 60 days, not 30. Academics answer cold email on week-to-month timescales,
  // and a 30 day close stops watching exactly where the slower half lands.
  if (ageDays >= 60) return { close: true };
  if (ageDays < 3) return { next: addHours(now, 4) };
  if (ageDays < 14) return { next: addHours(now, 24) };
  return { next: addHours(now, 72) };
}

export interface DueThread {
  draftId: number;
  personId: number;
  threadId: string;
  sentMessageId: string;
  sentAt: string;
}

// One row per DISTINCT thread_id: one thread can map to more than one draft
// (two --to-self sends, or a --force second email to one person), and polling
// it twice would double the quota spend for one answer. Any reply found is
// attributed to the lowest open draft_id carrying that thread; replies still
// has UNIQUE(gmail_message_id), so the same inbound message can never produce
// two rows regardless.
//
// Oldest-due first so nothing starves under the per-cycle cap, and overflow
// simply waits for the next run.
export function selectDueThreads(db: DB, limit: number): DueThread[] {
  return db.prepare(
    `SELECT min(draft_id) AS draftId, min(person_id) AS personId, thread_id AS threadId,
            min(sent_message_id) AS sentMessageId, min(sent_at) AS sentAt
       FROM sent_threads
      WHERE watch_state = 'open'
        AND thread_id IS NOT NULL
        AND next_poll_at <= datetime('now')
      GROUP BY thread_id
      ORDER BY min(next_poll_at) ASC
      LIMIT ?`,
  ).all(limit) as DueThread[];
}

// unresolvable MUST be re-armable. Under the failure taxonomy in
// gmailReader.ts this should now be reachable only one thread at a time, but
// the recovery has to exist: the earlier design could reach it wholesale and
// terminally, and a terminal state with no recovery path is how a feature
// deletes its own reason to exist.
//
// thread_id IS NOT NULL is what keeps --rearm all from resurrecting a genuinely
// unpollable row (an SMTP Message-ID, a fallback timestamp) into a permanent
// spin. Re-arming loses nothing: the polls are idempotent and replies is keyed
// on gmail_message_id.
//
// Two-argument form: `db` and an OPTIONAL list of draft ids. A bare
// rearmUnresolvable(db) means "all unresolvable rows", which is how Task 6's
// tests call it; cmdReplies (Task 10) passes a specific list for a targeted
// `--rearm <id>`. The plan's own interface line already carries this shape
// (`draftIds?: number[]`), so the "one argument in tests, two in cmdReplies"
// tension the reviewer flagged resolves by the second argument being optional,
// not by two incompatible signatures.
export function rearmUnresolvable(db: DB, draftIds?: number[]): number {
  const scope = draftIds?.length ? ` AND draft_id IN (${draftIds.map(() => '?').join(',')})` : '';
  return db.prepare(
    `UPDATE sent_threads
        SET watch_state = 'open', poll_failures = 0,
            next_poll_at = datetime('now'), rearmed_at = datetime('now')
      WHERE watch_state = 'unresolvable' AND thread_id IS NOT NULL${scope}`,
  ).run(...(draftIds ?? [])).changes;
}
