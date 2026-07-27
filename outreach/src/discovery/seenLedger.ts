// Dedup ledger and audit trail: one row per paper, ever.
import type { DB } from '../db/db.js';
import type { Candidate, SeenStatus } from './types.js';

export interface SeenRow {
  arxivId: string;
  title: string;
  relevance: number | null;
  status: SeenStatus;
  reason: string | null;
}

// Drops any candidate already in the ledger. Also dedups within the batch so a
// paper surfaced by two sources in one run is processed once.
export function filterUnseen(db: DB, candidates: Candidate[]): Candidate[] {
  const stmt = db.prepare('SELECT 1 FROM seen_papers WHERE arxiv_id = ?');
  const batch = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (batch.has(c.arxivId)) continue;
    if (stmt.get(c.arxivId)) continue;
    batch.add(c.arxivId);
    out.push(c);
  }
  return out;
}

// First writer wins, so the recorded source is the one that found it first.
export function recordDiscovered(db: DB, c: Candidate): void {
  db.prepare(
    `INSERT OR IGNORE INTO seen_papers (arxiv_id, title, discovered_via, source_detail)
     VALUES (?, ?, ?, ?)`,
  ).run(c.arxivId, c.title, c.discoveredVia, c.sourceDetail);
}

// Audit-trail semantics: reason and draft_id are append-only, not clearable. Omitting
// an arg preserves any existing value (via COALESCE), by design. This ensures the
// columns retain complete historical record and never lose prior context.
export function setStatus(
  db: DB,
  arxivId: string,
  status: SeenStatus,
  reason?: string,
  draftId?: number,
): void {
  db.prepare(
    `UPDATE seen_papers
     SET status = ?, reason = COALESCE(?, reason), draft_id = COALESCE(?, draft_id),
         updated_at = datetime('now')
     WHERE arxiv_id = ?`,
  ).run(status, reason ?? null, draftId ?? null, arxivId);
}

export function setRelevance(db: DB, arxivId: string, relevance: number): void {
  db.prepare("UPDATE seen_papers SET relevance = ?, updated_at = datetime('now') WHERE arxiv_id = ?").run(
    relevance,
    arxivId,
  );
}

// Sendable drafts deferred by the per-run message cap, highest relevance first.
export function getQueued(db: DB, limit: number): SeenRow[] {
  return db
    .prepare(
      `SELECT arxiv_id AS arxivId, title, relevance, status, reason
       FROM seen_papers WHERE status = 'queued_for_message'
       ORDER BY relevance DESC, arxiv_id LIMIT ?`,
    )
    .all(limit) as SeenRow[];
}
