// Draft ledger (spec AL4/AL5/AL7 subset for the CLI MVP): persist drafts and
// revisions, decide them exactly once, and enforce the never-email-twice guard.
import type { DB } from '../db/db.js';
import type { Draft, DraftInput } from '../pipeline/draft.js';
import { formatShortId } from './ids.js';

export interface PersistDraftInput {
  personId: number;
  paperArxivId: string;
  paperTitle: string;
  intent: string;
  draftInput: DraftInput;
  draft: Draft;
  contextJson: Record<string, unknown>;
}

export interface PersistedDraft {
  draftId: number;
  shortId: string;
  revisionId: number;
  sendable: boolean;
}

export function logEvent(db: DB, draftId: number | null, type: string, detail?: unknown): void {
  db.prepare('INSERT INTO draft_events (draft_id, type, detail_json) VALUES (?, ?, ?)').run(
    draftId,
    type,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

export function persistDraft(db: DB, input: PersistDraftInput): PersistedDraft {
  const txn = db.transaction((): PersistedDraft => {
    // D2: freeze the recipient here, next to the subject and body that
    // revisions already freezes. people.email is mutable (upsertPerson
    // coalesces a new non-null value in on every re-discovery of the same
    // author), so an address resolved fresh at send time can be one no human
    // ever approved. NULL is legitimate: `outreach add` deliberately parks a
    // draft with no address as a manual-lookup queue, and the send path
    // refuses such a draft rather than guessing.
    const person = db.prepare('SELECT email FROM people WHERE id = ?').get(input.personId) as
      | { email: string | null }
      | undefined;
    const res = db
      .prepare(
        `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, intent, gist, draft_input_json, to_email)
         VALUES ('', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.personId,
        input.paperArxivId,
        input.paperTitle,
        input.intent,
        input.draft.subject,
        JSON.stringify(input.draftInput),
        person?.email ?? null,
      );
    const draftId = Number(res.lastInsertRowid);
    const shortId = formatShortId(draftId);
    db.prepare('UPDATE drafts SET short_id = ? WHERE id = ?').run(shortId, draftId);

    const rev = db
      .prepare(
        `INSERT INTO revisions (draft_id, rev_no, subject, body, provenance, prior_revision_id,
                                instruction, context_json, grounded, grounding_notes)
         VALUES (?, 1, ?, ?, 'model', NULL, NULL, ?, ?, ?)`,
      )
      .run(
        draftId,
        input.draft.subject,
        input.draft.body,
        JSON.stringify(input.contextJson),
        input.draft.grounded ? 1 : 0,
        input.draft.notes.length ? input.draft.notes.join('; ') : null,
      );
    const revisionId = Number(rev.lastInsertRowid);
    if (input.draft.grounded) {
      db.prepare('UPDATE drafts SET sendable_revision_id = ? WHERE id = ?').run(revisionId, draftId);
    }
    logEvent(db, draftId, 'draft_created', { shortId, grounded: input.draft.grounded });
    return { draftId, shortId, revisionId, sendable: input.draft.grounded };
  });
  return txn();
}

export type DecideResult =
  | { applied: true }
  | { applied: false; existing: { action: string; via: string; createdAt: string } };

// First-write-wins (A9): INSERT OR IGNORE + UNIQUE(draft_id); the loser reports
// the existing outcome instead of acting.
export function decide(
  db: DB,
  draftId: number,
  action: 'send' | 'skip',
  via: 'imessage' | 'web' | 'cli',
  reason?: string,
): DecideResult {
  const txn = db.transaction((): DecideResult => {
    const res = db
      .prepare('INSERT OR IGNORE INTO decisions (draft_id, action, reason, via) VALUES (?, ?, ?, ?)')
      .run(draftId, action, reason ?? null, via);
    if (res.changes === 0) {
      const existing = db
        .prepare('SELECT action, via, created_at AS createdAt FROM decisions WHERE draft_id = ?')
        .get(draftId) as { action: string; via: string; createdAt: string };
      return { applied: false, existing };
    }
    const status = action === 'skip' ? 'skipped' : 'approved';
    db.prepare("UPDATE drafts SET status = ?, decided_at = datetime('now') WHERE id = ?").run(status, draftId);
    logEvent(db, draftId, 'decision', { action, via, reason: reason ?? null });
    return { applied: true };
  });
  return txn();
}

// D7: the UPDATE and the audit record are one unit. A crash between them would
// lose the only durable record of an irreversible email.
//
// threadId is OPTIONAL and only widens the payload of an INSERT that already
// happens inside this transaction, so it adds no new way for the transaction
// to fail. The sent_threads watch row is deliberately NOT written here: see
// recordSentThread in src/pipeline/sentThreads.ts and the caller in
// performApprovedSend, which calls it AFTER this transaction commits.
export function markSent(db: DB, draftId: number, sentId: string, threadId?: string): void {
  const txn = db.transaction((): void => {
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftId);
    // Keep the threadId ? conditional rather than always writing the key: the
    // 56 historical events have no such key, and matching their shape when
    // there is nothing to record keeps the log honest.
    logEvent(db, draftId, 'sent', threadId ? { sentId, threadId } : { sentId });
  });
  txn();
}

// The draft stays 'approved' and, critically, the send claim stays in place.
// Nothing automatic retries it (D1: retryApprovedUnsent is gone). A failure and
// a timeout are indistinguishable from here, and only one of them is safe to
// repeat, so a human decides. See docs/superpowers/plans/2026-07-29-send-path-safety.md.
export function markSendFailed(db: DB, draftId: number, error: string): void {
  const txn = db.transaction((): void => {
    const row = db.prepare('SELECT send_attempts AS attempts FROM drafts WHERE id = ?').get(draftId) as
      | { attempts: number }
      | undefined;
    logEvent(db, draftId, 'send_failed', { error, attempt: row?.attempts ?? null });
  });
  txn();
}

export type ApprovedSendLookup =
  | { kind: 'ok'; draftId: number; shortId: string; toEmail: string; subject: string; body: string; personName: string }
  | { kind: 'unknown_draft' }
  | { kind: 'not_approved'; status: string }
  | { kind: 'already_attempted'; attempts: number; attemptedAt: string }
  | { kind: 'not_grounded' }
  | { kind: 'no_snapshot' }
  | { kind: 'recipient_changed'; snapshot: string; current: string | null };

// Read-only. Answers "should this send happen, and with exactly what payload",
// so the caller can refuse for a bad payload BEFORE claiming the one and only
// send attempt. Everything it returns comes from frozen state: the subject and
// body from revisions, the recipient from drafts.to_email.
export function loadApprovedSend(db: DB, draftId: number): ApprovedSendLookup {
  const row = db
    .prepare(
      `SELECT d.short_id AS shortId, d.status AS status, d.to_email AS toEmail,
              d.send_attempts AS attempts, d.send_attempted_at AS attemptedAt,
              d.sendable_revision_id AS revisionId,
              p.email AS currentEmail, p.name AS personName,
              r.subject AS subject, r.body AS body
         FROM drafts d
         JOIN people p ON p.id = d.person_id
         LEFT JOIN revisions r ON r.id = d.sendable_revision_id
        WHERE d.id = ?`,
    )
    .get(draftId) as
    | {
        shortId: string;
        status: string;
        toEmail: string | null;
        attempts: number;
        attemptedAt: string | null;
        revisionId: number | null;
        currentEmail: string | null;
        personName: string;
        subject: string | null;
        body: string | null;
      }
    | undefined;

  if (!row) return { kind: 'unknown_draft' };
  if (row.status !== 'approved') return { kind: 'not_approved', status: row.status };
  if (row.attemptedAt !== null) {
    return { kind: 'already_attempted', attempts: row.attempts, attemptedAt: row.attemptedAt };
  }
  if (row.revisionId === null || row.body === null) return { kind: 'not_grounded' };
  if (!row.toEmail) return { kind: 'no_snapshot' };
  // D2. Refuse rather than choose. Sending to the snapshot mails an address the
  // system now believes is wrong; sending to the current address mails one no
  // human approved. Both act under ambiguity, so do neither and ask.
  if (row.toEmail !== row.currentEmail) {
    return { kind: 'recipient_changed', snapshot: row.toEmail, current: row.currentEmail };
  }
  return {
    kind: 'ok',
    draftId,
    shortId: row.shortId,
    toEmail: row.toEmail,
    subject: row.subject ?? '',
    body: row.body,
    personName: row.personName,
  };
}

export type SendClaim = { ok: true; attempt: number } | { ok: false; reason: string };

// D1. The at-most-once mechanism. One conditional UPDATE, inside a transaction,
// committed BEFORE the caller touches the network. Exactly one caller can see
// changes === 1, in this process or in the other one: SQLite serializes writers
// and the WHERE clause carries the whole precondition, so there is no
// read-then-write gap to lose. Everyone else refuses.
//
// The claim is never released by a failure. A send that times out after Gmail
// accepted the message looks identical to one Gmail never saw (there is no
// idempotency key on gmail.users.messages.send), and re-sending the second is
// harmless while re-sending the first is an unrecoverable second cold email to
// a stranger. So a claimed draft waits for a human.
export function beginSendAttempt(db: DB, draftId: number): SendClaim {
  const txn = db.transaction((): SendClaim => {
    const res = db
      .prepare(
        `UPDATE drafts
            SET send_attempted_at = datetime('now'), send_attempts = send_attempts + 1
          WHERE id = ? AND status = 'approved' AND send_attempted_at IS NULL`,
      )
      .run(draftId);
    if (res.changes === 0) {
      const row = db
        .prepare(
          'SELECT status, send_attempts AS attempts, send_attempted_at AS attemptedAt FROM drafts WHERE id = ?',
        )
        .get(draftId) as { status: string; attempts: number; attemptedAt: string | null } | undefined;
      if (!row) return { ok: false, reason: 'draft does not exist' };
      if (row.attemptedAt !== null) {
        return {
          ok: false,
          reason: `a send attempt was already recorded at ${row.attemptedAt} (attempt ${row.attempts})`,
        };
      }
      return { ok: false, reason: `draft is ${row.status}, not approved` };
    }
    const after = db.prepare('SELECT send_attempts AS attempts FROM drafts WHERE id = ?').get(draftId) as {
      attempts: number;
    };
    logEvent(db, draftId, 'send_attempted', { attempt: after.attempts });
    return { ok: true, attempt: after.attempts };
  });
  return txn();
}

export interface StalledApproval {
  draftId: number;
  shortId: string;
  attempts: number;
  attemptedAt: string | null;
  toEmail: string | null;
}

// D5. Every draft resting at 'approved' is, by definition, an approved email
// that has not gone out. Reported, never auto-sent.
export function stalledApprovals(db: DB): StalledApproval[] {
  return db
    .prepare(
      `SELECT id AS draftId, short_id AS shortId, send_attempts AS attempts,
              send_attempted_at AS attemptedAt, to_email AS toEmail
         FROM drafts WHERE status = 'approved' ORDER BY id`,
    )
    .all() as StalledApproval[];
}

// Bounded reporting: keyed on the attempt count, so one stall produces exactly
// one text, and a human re-arm (which leads to a new attempt number) produces
// exactly one more. Without this, a draft approved against a permanently bad
// address texts Aditya the same failure every single morning forever.
export function stallAlreadyReported(db: DB, draftId: number, attempts: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM draft_events
          WHERE draft_id = ? AND type = 'stall_reported'
            AND json_extract(detail_json, '$.attempts') = ?`,
      )
      .get(draftId, attempts) !== undefined
  );
}

export function markStallReported(db: DB, draftId: number, attempts: number): void {
  logEvent(db, draftId, 'stall_reported', { attempts });
}

export interface PriorThread {
  shortId: string;
  status: string;
  paperTitle: string | null;
  createdAt: string;
}

// F9 hard rule: never email a person with an existing thread without explicit
// override. Sent (any variant), approved-but-unsent, and drafts still pending
// approval all count: a pending draft is an existing thread, so a second
// candidate for the same person within one run (the normal output of an
// author-watch source, which queries by author) must see it and be skipped,
// not draft and message a second cold email before the first is even decided.
//
// excludeDraftId lets a caller that persists the draft it is checking about
// (the CLI's add flow does this, unlike the loop's processCandidate which
// checks before persisting) leave its own just-created awaiting_approval row
// out of the count, so it does not spuriously match itself.
export function priorThreads(db: DB, personId: number, excludeDraftId?: number): PriorThread[] {
  return db
    .prepare(
      `SELECT short_id AS shortId, status, paper_title AS paperTitle, created_at AS createdAt
       FROM drafts
       WHERE person_id = ? AND (status LIKE 'sent%' OR status = 'approved' OR status = 'awaiting_approval')
         AND (? IS NULL OR id != ?)
       ORDER BY id`,
    )
    .all(personId, excludeDraftId ?? null, excludeDraftId ?? null) as PriorThread[];
}
