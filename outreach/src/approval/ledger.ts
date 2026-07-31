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

export function markSent(db: DB, draftId: number, sentId: string): void {
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftId);
  logEvent(db, draftId, 'sent', { sentId });
}

export function markSendFailed(db: DB, draftId: number, error: string): void {
  // Stays 'approved': healed by retrying the send later (AL4 status semantics).
  logEvent(db, draftId, 'send_failed', { error });
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
