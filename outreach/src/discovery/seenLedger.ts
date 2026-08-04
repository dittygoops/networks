// Dedup ledger and audit trail: one row per paper, ever.
import type { DB } from '../db/db.js';
import type { Candidate, DiscoveredVia, SeenStatus } from './types.js';

export interface SeenRow {
  arxivId: string;
  title: string;
  relevance: number | null;
  status: SeenStatus;
  reason: string | null;
}

// A row at 'discovered' reconstructed for the resume step
// (docs/spec-candidate-stranding.md, CS1/CS4).
export interface ResumableRow {
  arxivId: string;
  title: string;
  discoveredVia: DiscoveredVia;
  sourceDetail: string | null;
  abstract: string | null;
  draftId: number | null;
  attempts: number;
  firstSeenAt: string;
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
// The abstract is stored too (CS1.3): the gate scores title plus abstract, so
// a row resumed without one would score systematically lower than it did as a
// fresh candidate.
export function recordDiscovered(db: DB, c: Candidate): void {
  db.prepare(
    `INSERT OR IGNORE INTO seen_papers (arxiv_id, title, discovered_via, source_detail, abstract)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(c.arxivId, c.title, c.discoveredVia, c.sourceDetail, c.abstract ?? null);
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

// Durable attempt increment (CS3.2). Called before processing a fresh or
// resumed candidate, so a crash mid-processing still counts the attempt: the
// increment must commit before the work starts, or a poison candidate that
// hard-kills the process would be retried, and would kill, every future run.
export function claimCandidate(db: DB, arxivId: string): void {
  db.prepare("UPDATE seen_papers SET attempts = attempts + 1, updated_at = datetime('now') WHERE arxiv_id = ?").run(
    arxivId,
  );
}

// Rows to resume, oldest first (CS1.2, stable tiebreak on arxiv_id), excluding
// rows that have already exhausted their retries (CS3.3).
export function getResumable(db: DB, limit: number, maxAttempts: number): ResumableRow[] {
  return db
    .prepare(
      `SELECT arxiv_id AS arxivId, title, discovered_via AS discoveredVia, source_detail AS sourceDetail,
              abstract, draft_id AS draftId, attempts, first_seen_at AS firstSeenAt, relevance, status, reason
       FROM seen_papers
       WHERE status = 'discovered' AND attempts < ?
       ORDER BY first_seen_at ASC, arxiv_id ASC
       LIMIT ?`,
    )
    .all(maxAttempts, limit) as ResumableRow[];
}

// Rows at 'discovered' whose attempts have run out. Swept by the caller per
// CS3.4; also used, unconditionally, purely for reporting (CS8) since a dry
// run must count these without abandoning anything.
export function getExhausted(db: DB, maxAttempts: number): ResumableRow[] {
  return db
    .prepare(
      `SELECT arxiv_id AS arxivId, title, discovered_via AS discoveredVia, source_detail AS sourceDetail,
              abstract, draft_id AS draftId, attempts, first_seen_at AS firstSeenAt, relevance, status, reason
       FROM seen_papers
       WHERE status = 'discovered' AND attempts >= ?
       ORDER BY first_seen_at ASC, arxiv_id ASC`,
    )
    .all(maxAttempts) as ResumableRow[];
}

// Sendable drafts deferred by the per-run message cap. Age-first (CS7.3):
// every row here already cleared the relevance gate, so relevance has already
// done its job, and re-applying it as a queue priority would starve a resumed
// row (which scores lower without a fresh abstract, CS1.3) behind fresh
// arrivals forever. This changes existing behaviour; see CS-T8 and the
// updated ordering test in test/seenLedger.test.ts.
export function getQueued(db: DB, limit: number): SeenRow[] {
  return db
    .prepare(
      `SELECT arxiv_id AS arxivId, title, relevance, status, reason
       FROM seen_papers WHERE status = 'queued_for_message'
       ORDER BY first_seen_at ASC, arxiv_id LIMIT ?`,
    )
    .all(limit) as SeenRow[];
}

export interface StrandedDiscoveredRow {
  arxivId: string;
  attempts: number;
  firstSeenAt: string;
  reason: string | null;
}

export interface StrandedTerminalRow {
  arxivId: string;
  status: SeenStatus;
  reason: string | null;
  draftId: number | null;
}

export interface OrphanDraftRow {
  shortId: string;
  personId: number;
  personName: string;
  paperArxivId: string | null;
}

export interface StrandedReport {
  discovered: StrandedDiscoveredRow[];
  terminalStranded: StrandedTerminalRow[];
  orphanDrafts: OrphanDraftRow[];
}

// CS8.2, read-only. `discovered` is every row still resting (attempts and all,
// not just near-exhausted, so the whole live backlog is visible).
// `terminalStranded` is every row this spec's own sweep or ambiguity handling
// has parked. `orphanDrafts` deliberately excludes a plain `outreach add`
// manual-lookup-queue draft (no email; correction C2) and excludes any draft
// whose paper the loop never discovered at all (no seen_papers row for that
// arxiv id): that shape is a normal in-flight `outreach add` draft awaiting a
// reply, not something this system stranded (correction C3), so counting it
// here would be a permanent false alarm.
//
// maxAttempts is accepted (matching the interface this command was specced
// with) but unused: the discovered list below is deliberately every resting
// row, not just near-exhausted ones, so an operator can see the whole backlog
// depth, not only what is about to be swept.
export function strandedReport(db: DB, _maxAttempts: number): StrandedReport {
  const discovered = db
    .prepare(
      `SELECT arxiv_id AS arxivId, attempts, first_seen_at AS firstSeenAt, reason
       FROM seen_papers WHERE status = 'discovered' ORDER BY first_seen_at ASC`,
    )
    .all() as StrandedDiscoveredRow[];

  const terminalStranded = db
    .prepare(
      `SELECT arxiv_id AS arxivId, status, reason, draft_id AS draftId
       FROM seen_papers
       WHERE status = 'drafted_unsendable'
         AND (reason LIKE 'abandoned after%'
           OR reason LIKE 'ambiguous orphan drafts%'
           -- The two reasons the address-correction feature creates. Both
           -- describe a real person the system wants to email and cannot,
           -- waiting on one text message from a human. Deliberately scoped:
           -- the other ~250 drafted_unsendable rows stay invisible, and
           -- 'address corrected%' is deliberately absent so a resolved row
           -- stops printing.
           OR reason LIKE 'awaiting address correction%'
           OR reason LIKE 'address correction not yet requested%')
       ORDER BY updated_at DESC`,
    )
    .all() as StrandedTerminalRow[];

  const orphanDrafts = db
    .prepare(
      `SELECT d.short_id AS shortId, d.person_id AS personId, p.name AS personName,
              d.paper_arxiv_id AS paperArxivId
       FROM drafts d
       JOIN people p ON p.id = d.person_id
       WHERE d.status = 'awaiting_approval'
         AND p.email IS NOT NULL
         AND d.paper_arxiv_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM seen_papers s WHERE s.arxiv_id = d.paper_arxiv_id)
         AND NOT EXISTS (SELECT 1 FROM seen_papers s2 WHERE s2.draft_id = d.id)
       ORDER BY d.id`,
    )
    .all() as OrphanDraftRow[];

  return { discovered, terminalStranded, orphanDrafts };
}
