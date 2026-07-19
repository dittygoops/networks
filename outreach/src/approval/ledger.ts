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
    const res = db
      .prepare(
        `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, intent, gist, draft_input_json)
         VALUES ('', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.personId,
        input.paperArxivId,
        input.paperTitle,
        input.intent,
        input.draft.subject,
        JSON.stringify(input.draftInput),
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
// override. Sent (any variant) and approved-but-unsent drafts both count.
export function priorThreads(db: DB, personId: number): PriorThread[] {
  return db
    .prepare(
      `SELECT short_id AS shortId, status, paper_title AS paperTitle, created_at AS createdAt
       FROM drafts
       WHERE person_id = ? AND (status LIKE 'sent%' OR status = 'approved')
       ORDER BY id`,
    )
    .all(personId) as PriorThread[];
}
