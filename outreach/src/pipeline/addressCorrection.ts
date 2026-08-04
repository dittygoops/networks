// The one place a human-supplied address becomes state. Split out of loop.ts
// so both the batch loop and `outreach listen` reach the identical logic
// through handleReply and cannot drift, and so it is testable without a
// channel or a sender.
//
// This module writes state. It never sends. A corrected draft still requires a
// separate explicit `dN y`, which runs the unchanged send path: decide
// first-write-wins, loadApprovedSend, assertSafeOutbound, beginSendAttempt's
// conditional UPDATE, markSent. Nothing here bypasses any of it.
import { parse as parseHost } from 'tldts';
import type { DB } from '../db/db.js';
import { formatShortId } from '../approval/ids.js';
import { logEvent } from '../approval/ledger.js';
import { setStatus } from '../discovery/seenLedger.js';
import { formatNeedsAddressMessage } from '../approval/channel.js';
import { nameMatches, type RejectedCandidate } from './contacts.js';

// Belt and braces beside assertSafeOutbound, which stays the real gate. This
// exists only so a malformed reply is refused with a useful message at
// correction time instead of at send time. Same shape as SINGLE_ADDRESS in
// sender/types.ts: exactly one bare address, no display name, no comma, no
// angle brackets.
const CORRECTION_SHAPE = /^[^\s<>,;:\\"]+@[^\s<>,;:\\"]+\.[^\s<>,;:\\"]+$/;

// The two reasons this feature writes into seen_papers.reason. Spelled out in
// full in both places they are used (here and in strandedReport) so the
// predicate that makes a row stranded and the predicate that un-strands it
// cannot drift. A collapsed pattern like 'a%address correction%' looks
// tempting and is wrong: it does not match 'address correction not yet
// requested'.
export const AWAITING_REASON_LIKE = 'awaiting address correction%';
export const DEFERRED_REASON_LIKE = 'address correction not yet requested%';

export type CorrectionResult =
  | { kind: 'applied'; shortId: string; personId: number; personName: string; email: string; nameMatched: boolean }
  | { kind: 'refused'; message: string };

export function addressWasRequested(db: DB, draftId: number): boolean {
  return (
    db.prepare("SELECT 1 FROM draft_events WHERE draft_id = ? AND type = 'address_requested'").get(draftId) !== undefined
  );
}

// Keyed on the PERSON, not the draft. `dN n` sets drafts.status = 'skipped',
// and priorThreads (ledger.ts) matches only sent%/approved/awaiting_approval,
// so a skip UNBLOCKS the person while leaving people.email NULL. The next paper
// by the same author would then re-draft and re-ask, forever. The re-ask
// arrives on a different draft id, so a per-draft record could never suppress
// it. json_extract on draft_events is the same shape stallAlreadyReported
// already uses, so no migration is needed.
export function addressRequestDeclined(db: DB, personId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM draft_events
          WHERE type = 'address_request_declined'
            AND json_extract(detail_json, '$.personId') = ?`,
      )
      .get(personId) !== undefined
  );
}

export function pendingAddressCount(db: DB): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM seen_papers
          WHERE status = 'drafted_unsendable'
            AND (reason LIKE ? OR reason LIKE ?)`,
      )
      .get(AWAITING_REASON_LIKE, DEFERRED_REASON_LIKE) as { n: number }
  ).n;
}

interface DraftRow {
  shortId: string;
  status: string;
  attemptedAt: string | null;
  personId: number;
  personName: string;
  personEmail: string | null;
  personEmailSource: string | null;
}

export function applyAddressCorrection(db: DB, draftId: number, rawEmail: string): CorrectionResult {
  const email = rawEmail.trim();
  const row = db
    .prepare(
      `SELECT d.short_id AS shortId, d.status AS status, d.send_attempted_at AS attemptedAt,
              d.person_id AS personId, p.name AS personName, p.email AS personEmail,
              p.email_source AS personEmailSource
         FROM drafts d JOIN people p ON p.id = d.person_id
        WHERE d.id = ?`,
    )
    .get(draftId) as DraftRow | undefined;
  if (!row) return { kind: 'refused', message: `No draft found for ${formatShortId(draftId)}. Nothing recorded.` };

  if (!CORRECTION_SHAPE.test(email)) {
    return {
      kind: 'refused',
      message: `${row.shortId} not changed: that is not a single plain address. Nothing recorded.`,
    };
  }

  // Which drafts may be corrected, decided by what the send path can still
  // refuse. awaiting_approval covers the needs-address flow and `outreach
  // add`'s manual-lookup queue. approved-with-no-attempt is the remedy for the
  // no_snapshot and recipient_changed refusals, both of which return before the
  // claim; a further explicit `dN y` is still required.
  if (row.status !== 'awaiting_approval' && row.status !== 'approved') {
    return {
      kind: 'refused',
      message: `${row.shortId} is ${row.status}. The recipient of a decided draft is never rewritten. Nothing recorded.`,
    };
  }
  if (row.attemptedAt !== null) {
    // The one send attempt is spent and Gmail's outcome is unknown. Nothing
    // here may resolve that.
    return {
      kind: 'refused',
      message: `${row.shortId} already has a send attempt recorded at ${row.attemptedAt}. Nothing recorded; check the Gmail Sent folder.`,
    };
  }

  // Refusal 2, the typo blocker. d17 and d70 are one keystroke apart. Aiming at
  // a person the machine already resolved would overwrite a verified address
  // permanently, because runContactExtraction's on-record shortcut
  // (orchestrate.ts:150-155) returns early forever once people.email is set and
  // upsertPerson's `email = coalesce(?, email)` cannot displace a non-NULL
  // value. Both intended uses survive by construction: the needs-address flow
  // has people.email NULL, and re-correcting your own typo overwrites a
  // 'user_provided' value.
  if (row.personEmail && row.personEmailSource !== 'user_provided') {
    return {
      kind: 'refused',
      message:
        `${row.shortId} not changed: ${row.personName} already has ${row.personEmail} on record ` +
        `(${row.personEmailSource ?? 'unknown source'}). Did you mean a different draft? Nothing recorded.`,
    };
  }

  // Refusal 3, the residue Refusal 2 lets through: aiming at a person whose
  // stored address is already 'user_provided' from an earlier correction.
  if (row.personEmail && !addressWasRequested(db, draftId)) {
    return {
      kind: 'refused',
      message:
        `${row.shortId} not changed: no address was requested for it, and ${row.personName} already has ` +
        `${row.personEmail}. Nothing recorded.`,
    };
  }

  // Advisory only, never a gate. Running the check that just failed as a gate
  // would be circular, and it would block the unusual-but-correct addresses
  // this feature exists to rescue (ishen@stu.hit.edu.cn for Xiongri Shen is the
  // measured example). As an echo it costs nothing and surfaces the typo class
  // from a second direction.
  const localPart = email.slice(0, email.lastIndexOf('@'));
  const host = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const nameMatched = nameMatches(localPart, row.personName);
  const registrable = parseHost(`http://${host}`).domain ?? host;

  db.transaction(() => {
    // Both writes are mandatory and neither alone works. Writing only
    // drafts.to_email leaves people.email NULL, and loadApprovedSend compares
    // row.toEmail !== row.currentEmail (ledger.ts:192), so 'x@y.edu' !== null
    // returns recipient_changed and the send is refused forever. Writing only
    // people.email leaves the frozen snapshot NULL and returns no_snapshot.
    db.prepare(
      `UPDATE people SET email = ?, email_confidence = 1.0, email_source = 'user_provided',
              updated_at = datetime('now') WHERE id = ?`,
    ).run(email, row.personId);
    db.prepare('UPDATE drafts SET to_email = ? WHERE id = ?').run(email, draftId);
    // Third write. Without it the seen_papers row still reads 'awaiting address
    // correction' after a successful send, and `outreach stranded` prints a
    // resolved item forever. The row stays at drafted_unsendable on purpose:
    // the paper was never messaged as a draft candidate, so promoting it would
    // claim something that has not happened.
    db.prepare(
      `UPDATE seen_papers SET reason = ?, updated_at = datetime('now')
        WHERE draft_id = ? AND status = 'drafted_unsendable'
          AND (reason LIKE ? OR reason LIKE ?)`,
    ).run(`address corrected (${row.shortId})`, draftId, AWAITING_REASON_LIKE, DEFERRED_REASON_LIKE);
    logEvent(db, draftId, 'address_corrected', {
      personId: row.personId,
      personName: row.personName,
      priorEmail: row.personEmail,
      priorEmailSource: row.personEmailSource,
      correctedEmail: email,
      correctedHost: host,
      correctedDomain: registrable,
      priorDraftStatus: row.status,
      nameMatched,
      via: 'imessage',
    });
  })();

  return {
    kind: 'applied',
    shortId: row.shortId,
    personId: row.personId,
    personName: row.personName,
    email,
    nameMatched,
  };
}

// --- Requesting an address ------------------------------------------------

export interface AddressRequestInput {
  db: DB;
  notify: (text: string) => Promise<void>;
  arxivId: string;
  draftId: number;
  shortId: string;
  personId: number;
  personName: string;
  affiliation?: string | null;
  paperTitle: string;
  rejected: RejectedCandidate[];
}

const REASON_MSG: Record<RejectedCandidate['reason'], string> = {
  identity_mismatch: 'the local part names a different person',
};

function messageFor(r: Omit<AddressRequestInput, 'notify' | 'db'>): string {
  return formatNeedsAddressMessage({
    shortId: r.shortId,
    personName: r.personName,
    affiliation: r.affiliation,
    paperTitle: r.paperTitle,
    rejected: r.rejected.map((x) => ({ email: x.email, source: x.source, reason: REASON_MSG[x.reason] })),
  });
}

function payload(r: Omit<AddressRequestInput, 'notify' | 'db'>): Record<string, unknown> {
  return {
    personId: r.personId,
    personName: r.personName,
    affiliation: r.affiliation ?? null,
    paperTitle: r.paperTitle,
    rejected: r.rejected,
    via: 'loop',
  };
}

// Returns false when the text could not be delivered, having parked the row so
// the next run's drain retries it. Mirrors `emit`'s failure handling in loop.ts.
export async function requestAddress(r: AddressRequestInput): Promise<boolean> {
  const first = r.rejected[0]?.email ?? 'unknown';
  try {
    await r.notify(messageFor(r));
  } catch {
    deferAddressRequest(r);
    return false;
  }
  // The draft id is load-bearing, not tidiness: strandedReport's orphanDrafts
  // query excludes drafts a seen_papers row points at. Without it, the moment a
  // correction sets people.email the draft appears as an orphan and `outreach
  // stranded` raises that alarm forever.
  setStatus(r.db, r.arxivId, 'drafted_unsendable', `awaiting address correction (${r.shortId}): rejected ${first}`, r.draftId);
  logEvent(r.db, r.draftId, 'address_requested', payload(r));
  return true;
}

// The per-run address budget is spent, or the text failed. The event carries
// the full structured payload so the drain can rebuild the exact message later
// instead of parsing the address back out of a reason string.
export function deferAddressRequest(r: Omit<AddressRequestInput, 'notify'>): void {
  const first = r.rejected[0]?.email ?? 'unknown';
  setStatus(
    r.db, r.arxivId, 'drafted_unsendable',
    `address correction not yet requested (${r.shortId}): rejected ${first}`, r.draftId,
  );
  logEvent(r.db, r.draftId, 'address_request_deferred', payload(r));
}

export interface DeferredAddressRow {
  arxivId: string;
  draftId: number;
  shortId: string;
  paperTitle: string;
}

// Oldest first. Restricted to drafts still awaiting a decision whose person
// still has no address, so a correction that landed via another draft, or a
// `dN n`, silently drops the row out of the queue instead of re-asking.
export function deferredAddressRequests(db: DB, limit: number): DeferredAddressRow[] {
  return db
    .prepare(
      `SELECT s.arxiv_id AS arxivId, s.draft_id AS draftId, d.short_id AS shortId, d.paper_title AS paperTitle
         FROM seen_papers s
         JOIN drafts d ON d.id = s.draft_id
         JOIN people p ON p.id = d.person_id
        WHERE s.status = 'drafted_unsendable'
          AND s.reason LIKE ?
          AND d.status = 'awaiting_approval'
          AND p.email IS NULL
        ORDER BY s.first_seen_at ASC, s.arxiv_id ASC
        LIMIT ?`,
    )
    .all(DEFERRED_REASON_LIKE, limit) as DeferredAddressRow[];
}

export function deferredPayload(
  db: DB,
  draftId: number,
): { personId: number; personName: string; affiliation: string | null; rejected: RejectedCandidate[] } | null {
  const row = db
    .prepare(
      `SELECT detail_json AS detail FROM draft_events
        WHERE draft_id = ? AND type = 'address_request_deferred' ORDER BY id DESC LIMIT 1`,
    )
    .get(draftId) as { detail: string | null } | undefined;
  if (!row?.detail) return null;
  try {
    const d = JSON.parse(row.detail) as { personId: number; personName: string; affiliation: string | null; rejected: RejectedCandidate[] };
    return { personId: d.personId, personName: d.personName, affiliation: d.affiliation ?? null, rejected: d.rejected ?? [] };
  } catch {
    return null;
  }
}
