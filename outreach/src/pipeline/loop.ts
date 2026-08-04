// One full outreach cycle, then exit. Order matters: approvals drain first so a
// reply to yesterday's message is acted on before today's discovery adds more.
// Spec: docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md
// Stranding fixes (resume, attempts, orphan adoption, the shared prior-thread
// re-check): docs/spec-candidate-stranding.md.
import type { DB } from '../db/db.js';
import { getPerson } from '../db/db.js';
import type { ApprovalChannel } from '../approval/channel.js';
import { parseReply } from '../approval/channel.js';
import {
  beginSendAttempt,
  decide,
  loadApprovedSend,
  markSendFailed,
  markSent,
  markStallReported,
  persistDraft,
  priorThreads,
  logEvent,
  stallAlreadyReported,
  stalledApprovals,
  type PersistedDraft,
} from '../approval/ledger.js';
import { formatShortId, parseShortId } from '../approval/ids.js';
import {
  addressRequestDeclined,
  addressWasRequested,
  applyAddressCorrection,
  deferAddressRequest,
  deferredAddressRequests,
  deferredPayload,
  pendingAddressCount,
  requestAddress,
} from './addressCorrection.js';
import type { LoopConfig } from '../discovery/config.js';
import { discoverAll } from '../discovery/index.js';
import {
  claimCandidate,
  filterUnseen,
  getExhausted,
  getQueued,
  getResumable,
  recordDiscovered,
  setRelevance,
  setStatus,
  type ResumableRow,
} from '../discovery/seenLedger.js';
import { gateCandidate } from '../discovery/relevanceGate.js';
import type { Candidate, DiscoverySource } from '../discovery/types.js';
import type { Draft, DraftInput } from './draft.js';
import type { RejectedCandidate } from './contacts.js';
import type { OrchestrateResult } from './orchestrate.js';
import { assertSafeOutbound, type Sender } from '../sender/types.js';
import type { LLMClient } from '../llm/client.js';

// The subset of LoopDeps that acting on one reply actually needs. Split out
// so `outreach listen` (src/pipeline/listen.ts) can call handleReply without
// fabricating dummy discovery/drafting dependencies it will never use: one
// implementation of "act on a reply" serves both the batch loop and the
// persistent listener, so their never-email-twice and never-send-without-
// approval invariants can never drift apart between the two callers.
export interface ReplyDeps {
  db: DB;
  channel: ApprovalChannel;
  sender: Sender;
  senderEmail?: string; // OutboundEmail.from; defaults to SENDER_EMAIL
}

export interface LoopDeps extends ReplyDeps {
  config: LoopConfig;
  sources: DiscoverySource[];
  terms: string[];
  processPaper: (deps: unknown, arxivId: string) => Promise<OrchestrateResult>;
  generateDraft: (llm: LLMClient, input: DraftInput) => Promise<Draft>;
  buildDraftInput: (r: OrchestrateResult) => DraftInput;
  llm?: LLMClient;
  orchestrateDeps?: unknown;
  replyWindowMs?: number;
}

export interface LoopOptions {
  dryRun: boolean;
}

export interface LoopSummary {
  dryRun: boolean;
  sent: number;
  seen: number;
  filtered: number;
  unsendable: number;
  messaged: number;
  queued: number;
  // D3. Candidates a dry run would have texted. Deliberately not `messaged`
  // and deliberately not `queued`: nothing was messaged, and nothing was
  // queued, because a dry run must not arm a later run. Always 0 in a real run.
  wouldMessage: number;
  // docs/spec-candidate-stranding.md (CS8.1).
  resumed: number;
  retryable: number;
  stranded: number;
  // Approved drafts that have not gone out, reported by this run (D5).
  // Optional so listen.ts's LoopSummary literal still compiles; this plan does
  // not own that file.
  stalled?: number;
  // Needs-address texts sent this run. Deliberately NOT `messaged`: nothing was
  // messaged as an approvable draft, and conflating them would hide an address
  // request inside a number the summary line already reports. Optional, like
  // `stalled`, because listen.ts builds a LoopSummary literal.
  addressRequested?: number;
  // The whole outstanding backlog, reported every run. It otherwise appears
  // only in `outreach stranded`, and 18 drafts once sat undelivered because
  // nothing that requires going somewhere gets read.
  addressesPending?: number;
  errors: string[];
}

// Small on purpose. Measured drafts per day on data/outreach.db were 11, 6 and
// 7 over the three days before this shipped, against a max_messages_per_run of
// 10, so the message cap is NOT saturated daily and this is hygiene rather than
// an emergency. Raise it once the real rate of rejections is measured.
const DEFAULT_MAX_ADDRESS_REQUESTS_PER_RUN = 3;

// A parsed short id only proves the text was well formed, not that the draft
// it names exists. decisions.draft_id and draft_events.draft_id both
// REFERENCES drafts(id) with foreign_keys = ON, and INSERT OR IGNORE does NOT
// suppress a foreign key violation, so passing an unknown id straight through
// to decide/logEvent throws and, uncaught, would take the whole batch down
// with it. Check existence first and report unknown ids without throwing.
function draftExists(db: DB, draftId: number): boolean {
  return db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(draftId) !== undefined;
}

// D6: the one and only place that turns an approval into a real email. Both
// callers of handleReply (the batch loop and the listener daemon) reach it,
// and after D1 nothing else in the system sends at all, so the
// never-send-without-approval accounting exists exactly once.
async function performApprovedSend(
  deps: ReplyDeps,
  summary: LoopSummary,
  draftId: number,
  shortId: string,
): Promise<void> {
  // Phase 0, read-only. Refusing here costs nothing: no claim is consumed, so
  // a human can fix the cause and re-approve by texting "dN y" again.
  const lookup = loadApprovedSend(deps.db, draftId);
  switch (lookup.kind) {
    case 'ok':
      break;
    case 'unknown_draft':
      await deps.channel.notify(`No draft found for ${shortId}. Ignoring that reply.`);
      return;
    case 'not_approved':
      // A repeat 'y' on a draft that already went out lands here (status is
      // 'sent' or 'sent (stubbed)', not 'approved'): say "already" plainly so
      // the human reading the reply is not left wondering if it went through.
      await deps.channel.notify(
        lookup.status.startsWith('sent')
          ? `${shortId} was already ${lookup.status}. Nothing sent again.`
          : `${shortId} is ${lookup.status}, not approved. Nothing sent.`,
      );
      return;
    case 'already_attempted':
      // D1. The ambiguous case: Gmail may or may not have delivered it. Never
      // guess, and never let a text message resolve it.
      logEvent(deps.db, draftId, 'send_refused', { reason: 'already_attempted', attempts: lookup.attempts });
      await deps.channel.notify(
        `${shortId} NOT SENT: a send attempt was already recorded at ${lookup.attemptedAt} and never confirmed. ` +
          `Nothing sent. Check the Gmail Sent folder before re-arming it by hand.`,
      );
      return;
    case 'not_grounded':
      await deps.channel.notify(`${shortId} has no grounded revision to send.`);
      return;
    case 'no_snapshot':
      await deps.channel.notify(`${shortId} has no recipient address on record. Nothing sent.`);
      return;
    case 'recipient_changed':
      // D2. Refuse, do not choose. Neither address can be sent to safely.
      logEvent(deps.db, draftId, 'send_refused', {
        reason: 'recipient_changed',
        snapshot: lookup.snapshot,
        current: lookup.current,
      });
      await deps.channel.notify(
        `${shortId} NOT SENT: the address changed since you approved it (approved ${lookup.snapshot}, ` +
          `now ${lookup.current ?? 'none'}). Nothing sent.`,
      );
      return;
  }

  const outbound = {
    to: lookup.toEmail,
    from: deps.senderEmail ?? process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
    subject: lookup.subject,
    body: lookup.body,
    draftShortId: shortId,
  };

  // D3. Validate before claiming, so a poisoned subject does not burn the one
  // and only send attempt. The senders validate again, which is the backstop
  // that also covers `outreach add`.
  try {
    assertSafeOutbound(outbound);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent(deps.db, draftId, 'send_refused', { reason: 'unsafe_outbound', error: msg });
    summary.errors.push(`${shortId}: ${msg}`);
    await deps.channel.notify(`${shortId} refused as unsafe: ${msg}`);
    return;
  }

  // Phase 1, the claim. Synchronous and committed before the await below, so a
  // concurrent process (the 09:00 batch versus the listener) loses this race
  // instead of sending a second copy.
  const claim = beginSendAttempt(deps.db, draftId);
  if (!claim.ok) {
    await deps.channel.notify(`${shortId} not sent: ${claim.reason}.`);
    return;
  }

  // Phase 2, the network. From here on, a failure is NOT retried automatically:
  // a timeout after Gmail accepted the message is indistinguishable from a
  // message Gmail never saw, and only one of those is safe to repeat.
  try {
    const { sentId } = await deps.sender.send(outbound);
    markSent(deps.db, draftId, sentId);
    summary.sent++;
    // Names the human, not just the address. A tapback is one tap, so a
    // mis-tap is easy in a way that typing "d25 y" was not, and the only
    // defence against an irreversible cold email to the wrong person is that
    // the mistake is legible immediately.
    await deps.channel.notify(`SENT ${shortId} to ${lookup.personName} <${outbound.to}>.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markSendFailed(deps.db, draftId, msg);
    summary.errors.push(`${shortId}: send failed: ${msg}`);
    await deps.channel.notify(
      `${shortId} failed to send: ${msg}. Not retried automatically; check the Gmail Sent folder.`,
    );
  }
}

export async function handleReply(
  deps: ReplyDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  reply: { text: string },
): Promise<void> {
  const parsed = parseReply(reply.text);
  if (parsed.kind === 'unparseable') {
    await deps.channel.notify(
      `Could not read "${reply.text}". Reply like "d7 y", "d7 n", or "d7 to their@address.edu".`,
    );
    return;
  }
  const draftId = parseShortId(parsed.shortId);
  if (draftId === null) return;

  if (!draftExists(deps.db, draftId)) {
    await deps.channel.notify(`No draft found for ${parsed.shortId}. Ignoring that reply.`);
    return;
  }

  if (parsed.kind === 'unsupported') {
    // Edits are F5 territory (docs/spec-imessage-approval-loop.md).
    if (!opts.dryRun) logEvent(deps.db, draftId, 'edit_reply_unsupported', { text: reply.text });
    await deps.channel.notify(
      `Edits are not yet supported for ${parsed.shortId}. Reply "${parsed.shortId} to their@address.edu" to set ` +
        `the address, "${parsed.shortId} y" to send, or "${parsed.shortId} n" to skip.`,
    );
    return;
  }

  // D4. The dry-run check comes BEFORE any mutation. `decide` is first-write-
  // wins on UNIQUE(draft_id), so recording a decision during a rehearsal
  // permanently consumes the one and only decision slot for that draft. This is
  // the same rule resolveSendableDraft states below ("A dry run must never call
  // decide"); it now holds in the code rather than being held by the stub
  // channel happening to yield no replies.
  if (opts.dryRun) {
    await deps.channel.notify(
      parsed.kind === 'address'
        ? `${parsed.shortId} DRY RUN: would record ${parsed.email}. Nothing recorded and nothing sent.`
        : `${parsed.shortId} DRY RUN: nothing recorded and nothing sent (would ${parsed.kind}).`,
    );
    return;
  }

  // A correction writes state and never sends. A further explicit
  // "dN y" is still required, and it runs the identical, unmodified send path.
  if (parsed.kind === 'address') {
    const outcome = applyAddressCorrection(deps.db, draftId, parsed.email);
    if (outcome.kind === 'refused') {
      await deps.channel.notify(outcome.message);
      return;
    }
    // Names the PERSON, not just the id and the address. d17 and d70 are one
    // keystroke apart, and the name is the only token here he can check against
    // what he meant. Same argument as the SENT confirmation below.
    await deps.channel.notify(
      `Recorded ${outcome.email} for ${outcome.personName} (${outcome.shortId}).` +
        (outcome.nameMatched ? '' : ' The local part does not name that person.') +
        ` Nothing sent yet.`,
    );
    // Present it in the standard format so tapback works on it as on any other
    // draft. Not counted against max_messages_per_run: it is one message per
    // reply he typed, so it is self-limiting, and a run's cap has no meaning
    // inside `outreach listen`, which has no run.
    const rev = deps.db
      .prepare(
        `SELECT r.subject AS subject, r.body AS body, p.email AS toEmail, p.name AS personName
           FROM drafts d
           JOIN people p ON p.id = d.person_id
           LEFT JOIN revisions r ON r.id = d.sendable_revision_id
          WHERE d.id = ?`,
      )
      .get(draftId) as { subject: string | null; body: string | null; toEmail: string | null; personName: string } | undefined;
    if (rev?.body && rev.toEmail) {
      await deps.channel.sendDraftMessage({
        shortId: outcome.shortId,
        subject: rev.subject ?? '',
        body: rev.body,
        to: rev.toEmail,
        personName: rev.personName,
      });
    }
    return;
  }

  if (parsed.kind === 'skip') {
    const res = decide(deps.db, draftId, 'skip', 'imessage');
    // A skip clears the DRAFT but not the PERSON: priorThreads matches only
    // sent%/approved/awaiting_approval, so 'skipped' unblocks them, and
    // people.email is still NULL, so the next paper by the same author would
    // re-draft and re-ask forever. Record the decline against the person.
    if (res.applied && addressWasRequested(deps.db, draftId)) {
      const owner = deps.db.prepare('SELECT person_id AS personId FROM drafts WHERE id = ?').get(draftId) as
        | { personId: number }
        | undefined;
      if (owner) logEvent(deps.db, draftId, 'address_request_declined', { personId: owner.personId });
    }
    await deps.channel.notify(
      res.applied ? `${parsed.shortId} skipped.` : `${parsed.shortId} was already ${res.existing.action}.`,
    );
    return;
  }

  const res = decide(deps.db, draftId, 'send', 'imessage');
  if (!res.applied) {
    if (res.existing.action !== 'send') {
      await deps.channel.notify(`${parsed.shortId} was already ${res.existing.action}.`);
      return;
    }
    // A repeat approval of a draft already decided 'send'. This is the re-arm
    // button for the common failure (a refusal or a crash before the claim):
    // it is an explicit human approval, and performApprovedSend still refuses
    // if a claim exists or the draft has already gone out, so it can never
    // become a second send.
    logEvent(deps.db, draftId, 're_approval', { via: 'imessage' });
  }
  await performApprovedSend(deps, summary, draftId, parsed.shortId);
}

async function drainApprovals(deps: LoopDeps, opts: LoopOptions, summary: LoopSummary): Promise<void> {
  const replies = await deps.channel.captureReplies(deps.replyWindowMs ?? 0);
  for (const reply of replies) {
    try {
      await handleReply(deps, opts, summary, reply);
    } catch (e) {
      // One malformed or unlucky reply must never discard the rest of the
      // batch: the approved-unsent retry, the queued flush, and discovery
      // all run after this loop and must not be skipped because of it.
      const msg = e instanceof Error ? e.message : String(e);
      summary.errors.push(`reply "${reply.text}": ${msg}`);
      try {
        await deps.channel.notify(`Could not process "${reply.text}": ${msg}`);
      } catch {
        // A notify failure here must not mask the original error; swallow it.
      }
    }
  }
}

// Emits a sendable draft, or queues it when the per-run cap is already spent.
async function emit(
  deps: LoopDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  c: Candidate,
  shortId: string,
  subject: string,
  body: string,
  to: string,
  personName: string,
): Promise<void> {
  // D3. Checked BEFORE the cap, because the cap branch below also writes
  // 'queued_for_message', which is the flush queue: the next real run drains
  // it, texts the draft, and a "y" there sends a real irreversible email. A
  // dry run that arms a later run is not a dry run, over budget or under it.
  //
  // 'discovered' is the correct resting place instead. It means "recorded, not
  // yet resolved", which is exactly true, and it has one reader, the resume
  // step (docs/spec-candidate-stranding.md CS1), which is bounded by
  // max_resume_per_run and max_resume_attempts and is reported in
  // summary.resumed and by `outreach stranded`. So the work is deferred to a
  // real run rather than lost, and it is deferred visibly.
  if (opts.dryRun) {
    setStatus(deps.db, c.arxivId, 'discovered', 'dry run: would message, nothing sent or queued');
    summary.wouldMessage++;
    return;
  }
  if (summary.messaged >= deps.config.gate.maxMessagesPerRun) {
    setStatus(deps.db, c.arxivId, 'queued_for_message', 'deferred by max_messages_per_run');
    summary.queued++;
    return;
  }
  try {
    await deps.channel.sendDraftMessage({ shortId, subject, body, to, personName });
    setStatus(deps.db, c.arxivId, 'messaged');
    summary.messaged++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(deps.db, c.arxivId, 'queued_for_message', `message failed, queued for retry: ${msg}`);
    summary.queued++;
    summary.errors.push(`${c.arxivId}: ${msg}`);
  }
}

// Drafts first, then asks. Drafting is forced, not preferred: the correction
// reply is handled by handleReply, whose dependency set is ReplyDeps, and that
// split exists so `outreach listen` never fabricates drafting dependencies.
// Drafting inside the reply handler would put llm, buildDraftInput and an
// OpenRouter key into the listener daemon. Drafting up front also gives the
// correction a dN to name, which is what makes the reply syntax work.
async function draftAndRequestAddress(
  deps: LoopDeps,
  summary: LoopSummary,
  c: Candidate,
  result: OrchestrateResult,
  rejected: RejectedCandidate[],
  relevanceReason: string,
): Promise<void> {
  const input = deps.buildDraftInput(result);
  const draft = await deps.generateDraft(deps.llm as LLMClient, input);
  if (!draft.grounded) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', `grounding failed: ${draft.notes.join('; ')}`);
    summary.unsendable++;
    return;
  }
  const persisted = deps.db.transaction((): PersistedDraft => {
    const p = persistDraft(deps.db, {
      personId: result.personId as number,
      paperArxivId: result.arxivId,
      paperTitle: result.paperTitle,
      intent: input.intent,
      draftInput: input,
      draft,
      contextJson: { discoveredVia: c.discoveredVia, sourceDetail: c.sourceDetail, relevance: relevanceReason },
    });
    // persistDraft reads people.email (NULL here) into drafts.to_email, which
    // is the shape `outreach add` already parks as a manual-lookup queue and
    // which loadApprovedSend already refuses as no_snapshot.
    setStatus(deps.db, c.arxivId, 'discovered', relevanceReason, p.draftId);
    return p;
  })();

  const person = getPerson(deps.db, result.personId as number);
  const req = {
    db: deps.db,
    arxivId: c.arxivId,
    draftId: persisted.draftId,
    shortId: persisted.shortId,
    personId: result.personId as number,
    personName: result.target,
    affiliation: person?.affiliation ?? null,
    paperTitle: result.paperTitle,
    rejected,
  };
  summary.unsendable++;
  const budget = deps.config.gate.maxAddressRequestsPerRun ?? DEFAULT_MAX_ADDRESS_REQUESTS_PER_RUN;
  if ((summary.addressRequested ?? 0) >= budget) {
    deferAddressRequest(req);
    return;
  }
  if (await requestAddress({ ...req, notify: (t) => deps.channel.notify(t) })) {
    summary.addressRequested = (summary.addressRequested ?? 0) + 1;
  }
}

async function processCandidate(
  deps: LoopDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  c: Candidate,
): Promise<void> {
  try {
    const verdict = await gateCandidate(c, deps.terms, deps.config.gate, deps.llm);
    setRelevance(deps.db, c.arxivId, verdict.score);
    if (!verdict.keep) {
      setStatus(deps.db, c.arxivId, 'filtered_low_relevance', verdict.reason);
      summary.filtered++;
      return;
    }

    const result = await deps.processPaper(deps.orchestrateDeps, c.arxivId);

    if (!result.personId) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'identity unconfirmed');
      summary.unsendable++;
      return;
    }
    if (result.identityCollisionReason) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', result.identityCollisionReason);
      summary.unsendable++;
      return;
    }
    if (result.noStrongHook || result.hooks.length === 0) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no grounded hook');
      summary.unsendable++;
      return;
    }
    // Checked AFTER the hook gate. Hook-first gating means contact extraction
    // does not run for a hookless candidate, so `email: null` there means "not
    // attempted", not "looked and failed".
    if (!result.email) {
      const rejected = result.rejectedEmails ?? [];
      if (rejected.length === 0) {
        setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no email resolved');
        summary.unsendable++;
        return;
      }
      // Duplicated rather than hoisted above the email gate. Hoisting would
      // relabel every candidate that fails both checks from 'no email resolved'
      // to 'prior thread exists', and the hook-first spec's Change 2 is the
      // record of what a gate reorder does to the status buckets.
      const priorForAddress = priorThreads(deps.db, result.personId);
      if (priorForAddress.length > 0) {
        setStatus(deps.db, c.arxivId, 'drafted_unsendable', `prior thread exists (${priorForAddress[0]?.shortId ?? ''})`);
        summary.unsendable++;
        return;
      }
      if (addressRequestDeclined(deps.db, result.personId)) {
        setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'address correction declined for this person');
        summary.unsendable++;
        return;
      }
      if (opts.dryRun) {
        setStatus(deps.db, c.arxivId, 'discovered', 'dry run: would request address');
        summary.wouldMessage++;
        return;
      }
      await draftAndRequestAddress(deps, summary, c, result, rejected, verdict.reason);
      return;
    }
    const prior = priorThreads(deps.db, result.personId);
    if (prior.length > 0) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', `prior thread exists (${prior[0]?.shortId ?? ''})`);
      summary.unsendable++;
      return;
    }

    // D3. A dry run may persist observation, never obligation.
    //
    // Everything above this line is observation: the gate verdict, the people
    // and facts processPaper upserted (idempotent, and true regardless of
    // dry-run mode), and the terminal verdicts the pipeline genuinely reached.
    // A draft is an obligation. persistDraft writes a real drafts row at
    // awaiting_approval, priorThreads matches that status, and the row then
    // blocks this person from EVERY future candidate until a human replies
    // "dX n". The abandonment sweep cannot clear it either: it only retires
    // drafts owned by a row that exhausted its attempts, and a dry run
    // deliberately does not consume attempts (CS7.5, correction C4), so a
    // rehearsal artifact sits there indefinitely.
    //
    // So the rehearsal stops here, having answered the question it is actually
    // asked ("how many candidates would become drafts, and why not the rest"),
    // and leaves the row resting at 'discovered' for a real run to draft. That
    // also keeps the draft-generation LLM spend out of a rehearsal.
    if (opts.dryRun) {
      setStatus(deps.db, c.arxivId, 'discovered', 'dry run: sendable, draft deferred to a real run');
      summary.wouldMessage++;
      return;
    }

    const input = deps.buildDraftInput(result);
    const draft = await deps.generateDraft(deps.llm as LLMClient, input);
    if (!draft.grounded) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', `grounding failed: ${draft.notes.join('; ')}`);
      summary.unsendable++;
      return;
    }

    // CS4.3: persistDraft and the ledger pointer are written atomically, so no
    // crash can leave a draft that seen_papers does not reference.
    const persisted = deps.db.transaction((): PersistedDraft => {
      const p = persistDraft(deps.db, {
        personId: result.personId as number,
        paperArxivId: result.arxivId,
        paperTitle: result.paperTitle,
        intent: input.intent,
        draftInput: input,
        draft,
        contextJson: { discoveredVia: c.discoveredVia, sourceDetail: c.sourceDetail, relevance: verdict.score },
      });
      setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, p.draftId);
      return p;
    })();

    await emit(deps, opts, summary, c, persisted.shortId, draft.subject, draft.body, result.email.email, result.target);
  } catch (e) {
    // CS3.5: a thrown error is retryable, never terminal. Only a *returned*
    // verdict above (filtered, no email, no hook, prior thread, ungrounded) is
    // terminal on attempt one; those are decisions the pipeline made
    // successfully, not failures to make one. attempts was already
    // incremented by claimCandidate before this call started, so the row is
    // picked up again by the next run's resume step and eventually abandoned
    // by the exhaustion sweep (CS3.4) rather than retried forever.
    const msg = e instanceof Error ? e.message : String(e);
    const row = deps.db.prepare('SELECT attempts FROM seen_papers WHERE arxiv_id = ?').get(c.arxivId) as
      | { attempts: number }
      | undefined;
    const attempt = row?.attempts ?? 1;
    setStatus(deps.db, c.arxivId, 'discovered', `attempt ${attempt} failed: ${msg}`);
    summary.retryable++;
    summary.errors.push(`${c.arxivId}: ${msg}`);
  }
}

export interface SendableDraft {
  draftId: number;
  shortId: string;
  personId: number;
  subject: string;
  body: string;
}

type SendableLookup =
  | { kind: 'ok'; draft: SendableDraft }
  | { kind: 'prior_thread'; draft: SendableDraft; priorShortId: string }
  | { kind: 'decided_out_of_band'; draftId: number; status: string }
  | { kind: 'not_grounded'; draftId: number }
  | { kind: 'no_email'; draftId: number }
  | { kind: 'dangling'; draftId: number | null };

// CS5. The one draft-loading query, shared by the queued flush and the resume
// step so the two cannot drift. It also folds in the mandatory
// never-email-twice re-check (correction C1 on docs/spec-candidate-stranding.md):
// the spec as written only put that check on the resume path, which left the
// flush emitting a queued draft, sometimes a day or more old, with no
// prior-thread check at all. Putting it here means both callers get it for
// free and can never independently forget it.
export function loadSendableDraft(db: DB, arxivId: string): SendableLookup {
  const row = db
    .prepare(
      `SELECT s.draft_id AS draftId, d.status AS draftStatus, d.person_id AS personId,
              d.sendable_revision_id AS sendableRevisionId, d.short_id AS shortId,
              r.subject AS subject, r.body AS body
       FROM seen_papers s
       LEFT JOIN drafts d ON d.id = s.draft_id
       LEFT JOIN revisions r ON r.id = d.sendable_revision_id
       WHERE s.arxiv_id = ?`,
    )
    .get(arxivId) as
    | {
        draftId: number | null;
        draftStatus: string | null;
        personId: number | null;
        sendableRevisionId: number | null;
        shortId: string | null;
        subject: string | null;
        body: string | null;
      }
    | undefined;

  if (!row || row.draftId == null || row.draftStatus == null) {
    // Dangling draft_id (points at a draft row that does not exist), or no
    // draft_id at all. Only reachable by manual SQL or a very old crash.
    return { kind: 'dangling', draftId: row?.draftId ?? null };
  }
  if (row.draftStatus !== 'awaiting_approval') {
    // 'sent', 'sent (stubbed)', 'approved', or 'skipped': decided out of band
    // by a human, `outreach listen`, or a concurrent `outreach add --force`.
    return { kind: 'decided_out_of_band', draftId: row.draftId, status: row.draftStatus };
  }
  if (row.sendableRevisionId == null) {
    return { kind: 'not_grounded', draftId: row.draftId };
  }
  const person = getPerson(db, row.personId as number);
  if (!person?.email) {
    // Correction C2: give this an explicit, recorded resolution rather than
    // the bare `if (!person?.email) continue;` the spec left in place, which
    // is the same silent-drop class this whole spec exists to remove.
    return { kind: 'no_email', draftId: row.draftId };
  }
  const draft: SendableDraft = {
    draftId: row.draftId,
    shortId: row.shortId as string,
    personId: row.personId as number,
    subject: row.subject as string,
    body: row.body as string,
  };
  // Correction C1: the mandatory pre-emit priorThreads re-check, in the
  // shared path so both the flush and the resume step get it. excludeDraftId
  // is this row's own draft, so it cannot match (and refuse) itself.
  const prior = priorThreads(db, draft.personId, draft.draftId);
  if (prior.length > 0) {
    return { kind: 'prior_thread', draft, priorShortId: prior[0]?.shortId ?? '' };
  }
  return { kind: 'ok', draft };
}

// Applies loadSendableDraft's resolution: returns the draft to emit, or
// writes the appropriate resting/terminal status and returns null. This is
// CS5.3's table, extended with the no-email case (C2) and with the
// never-email-twice re-check baked in (C1). A dry run must never call
// `decide` (no draft may be retired during a rehearsal), so those calls are
// skipped, and the recorded reason says so.
function resolveSendableDraft(
  db: DB,
  arxivId: string,
  summary: LoopSummary,
  dryRun: boolean,
): SendableDraft | null {
  const lookup = loadSendableDraft(db, arxivId);
  switch (lookup.kind) {
    case 'ok':
      return lookup.draft;

    case 'prior_thread': {
      let note = `own draft ${formatShortId(lookup.draft.draftId)} not retired (dry run)`;
      if (!dryRun) {
        const decision = decide(
          db,
          lookup.draft.draftId,
          'skip',
          'cli',
          `loop: superseded by prior thread ${lookup.priorShortId}`,
        );
        note = decision.applied
          ? `own draft ${formatShortId(lookup.draft.draftId)} skipped`
          : `own draft ${formatShortId(lookup.draft.draftId)} already ${decision.existing.action} via ${decision.existing.via}`;
      }
      setStatus(db, arxivId, 'drafted_unsendable', `prior thread exists (${lookup.priorShortId}), ${note}`);
      summary.unsendable++;
      return null;
    }

    case 'decided_out_of_band': {
      if (lookup.status === 'skipped') {
        setStatus(db, arxivId, 'drafted_unsendable', `draft ${formatShortId(lookup.draftId)} was skipped out of band`);
        summary.unsendable++;
      } else {
        // sent, sent (stubbed), or approved: not terminal on purpose. The
        // audit trail past this point belongs to docs/spec-status-audit-trail.md.
        setStatus(db, arxivId, 'messaged', `draft ${formatShortId(lookup.draftId)} already approved out of band`);
      }
      return null;
    }

    case 'not_grounded': {
      let note = `not retired (dry run)`;
      if (!dryRun) {
        const decision = decide(db, lookup.draftId, 'skip', 'cli', 'loop: draft has no grounded revision');
        note = decision.applied ? 'draft skipped' : `already ${decision.existing.action} via ${decision.existing.via}`;
      }
      setStatus(
        db,
        arxivId,
        'drafted_unsendable',
        `draft ${formatShortId(lookup.draftId)} has no grounded revision, ${note}`,
      );
      summary.unsendable++;
      return null;
    }

    case 'no_email': {
      let note = `not retired (dry run)`;
      if (!dryRun) {
        const decision = decide(db, lookup.draftId, 'skip', 'cli', 'loop: no email on record');
        note = decision.applied ? 'draft skipped' : `already ${decision.existing.action} via ${decision.existing.via}`;
      }
      setStatus(
        db,
        arxivId,
        'drafted_unsendable',
        `no email on record for draft ${formatShortId(lookup.draftId)}, ${note}`,
      );
      summary.unsendable++;
      return null;
    }

    case 'dangling': {
      // Ambiguity resolves toward doing nothing: leave the row resting rather
      // than guessing. Only reachable by manual SQL.
      setStatus(
        db,
        arxivId,
        'discovered',
        `draft_id ${lookup.draftId != null ? formatShortId(lookup.draftId) : '(none)'} does not exist`,
      );
      return null;
    }
  }
}

// CS6.1/CS6.2. Adoptable orphans for one paper: a drafts row for that arxiv id,
// at awaiting_approval, that no seen_papers row already points at. Restricted
// to drafts whose person has a resolved email (correction C2): `outreach add`
// deliberately parks a draft with NO email at awaiting_approval as a
// manual-lookup queue, and that shape must never be adopted as if it were a
// candidate the loop can message, since the loop can never resolve an email
// for it either.
function findAdoptableOrphans(db: DB, arxivId: string): number[] {
  return (
    db
      .prepare(
        `SELECT d.id AS id
         FROM drafts d
         JOIN people p ON p.id = d.person_id
         WHERE d.paper_arxiv_id = ?
           AND d.status = 'awaiting_approval'
           AND p.email IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM seen_papers s WHERE s.draft_id = d.id)
         ORDER BY d.id`,
      )
      .all(arxivId) as { id: number }[]
  ).map((r) => r.id);
}

function candidateFromResumable(row: ResumableRow): Candidate {
  return {
    arxivId: row.arxivId,
    title: row.title,
    discoveredVia: row.discoveredVia,
    sourceDetail: row.sourceDetail ?? '',
    abstract: row.abstract ?? undefined,
  };
}

// CS4.1: a resumed row that already has a draft is emitted, never re-drafted.
// Loads it through the shared path (which carries the CS4.2 prior-thread
// re-check) and, if it is still sendable, emits it.
async function emitExistingDraft(
  deps: LoopDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  arxivId: string,
  candidate: Candidate,
): Promise<void> {
  const draft = resolveSendableDraft(deps.db, arxivId, summary, opts.dryRun);
  if (!draft) return;
  const person = getPerson(deps.db, draft.personId);
  if (!person?.email) return; // resolveSendableDraft already handles this; defensive only
  await emit(deps, opts, summary, candidate, draft.shortId, draft.subject, draft.body, person.email, person.name);
}

// CS1/CS3/CS4/CS6. Resumes rows stuck at 'discovered', bounded by
// max_resume_per_run and max_resume_attempts so a large backlog cannot starve
// fresh discovery and nothing retries a poison candidate forever. Runs in
// dry-run mode too (CS7.5): it drafts and parks, but per correction C4 it does
// not consume the attempt budget, never calls `decide`, and never runs the
// exhaustion sweep, so a rehearsal cannot push real work toward abandonment.
async function resumeStranded(deps: LoopDeps, opts: LoopOptions, summary: LoopSummary): Promise<void> {
  const maxAttempts = deps.config.gate.maxResumeAttempts;
  const rows = getResumable(deps.db, deps.config.gate.maxResumePerRun, maxAttempts);

  for (const row of rows) {
    // Correction C4: a dry run must not consume the attempt budget. Three
    // rehearsal dry runs must not push every resumable row to the abandon
    // threshold.
    if (!opts.dryRun) claimCandidate(deps.db, row.arxivId);
    summary.resumed++;
    const candidate = candidateFromResumable(row);

    if (row.draftId != null) {
      // CS4.1: never re-draft a row that already has one.
      await emitExistingDraft(deps, opts, summary, row.arxivId, candidate);
      continue;
    }

    const orphanIds = findAdoptableOrphans(deps.db, row.arxivId);
    if (orphanIds.length > 1) {
      // CS6.2: ambiguous. Send neither, guess nothing, leave both drafts as
      // they are, and make the state loud (CS8) rather than silent.
      setStatus(
        deps.db,
        row.arxivId,
        'drafted_unsendable',
        `ambiguous orphan drafts (${orphanIds.map((id) => formatShortId(id)).join(', ')}): see outreach stranded`,
      );
      summary.unsendable++;
      summary.stranded++;
      continue;
    }
    if (orphanIds.length === 1) {
      // CS6.1: adopt the single unambiguous orphan, then proceed exactly as
      // CS4.1/CS4.2 require: load it through the shared path, re-check
      // priorThreads, and emit.
      const draftId = orphanIds[0]!;
      setStatus(deps.db, row.arxivId, 'discovered', `adopted orphan draft ${formatShortId(draftId)}`, draftId);
      await emitExistingDraft(deps, opts, summary, row.arxivId, candidate);
      continue;
    }

    // No draft yet and no orphan to adopt: process exactly like a fresh
    // candidate, reusing the one drafting code path (CS1).
    await processCandidate(deps, opts, summary, candidate);
  }

  // CS3.4 exhaustion sweep. getExhausted runs unconditionally so a dry run
  // still reports the backlog that would be abandoned by a real run (CS7.5),
  // but the sweep's writes (which retire drafts and mark rows terminal) never
  // run in a dry run.
  const exhausted = getExhausted(deps.db, maxAttempts);
  if (opts.dryRun) {
    summary.stranded += exhausted.length;
    return;
  }
  for (const row of exhausted) {
    if (row.draftId != null) {
      // The row owns a real draft. Marking it terminal without retiring the
      // draft first would leave that draft at awaiting_approval forever,
      // where priorThreads matches it, making the person permanently
      // uncontactable while the ledger reports a thread that was never sent
      // (the 1.4 failure this whole spec exists to close). Retire the draft
      // first, then the row, as one unit.
      const decision = decide(deps.db, row.draftId, 'skip', 'cli', `loop: abandoned after ${row.attempts} attempts`);
      const draftNote = decision.applied
        ? `draft ${formatShortId(row.draftId)} skipped`
        : `draft ${formatShortId(row.draftId)} already ${decision.existing.action} via ${decision.existing.via}`;
      setStatus(deps.db, row.arxivId, 'drafted_unsendable', `abandoned after ${row.attempts} attempts, ${draftNote}`);
    } else {
      // Nothing was created for this candidate; abandoning it costs only the
      // candidate.
      setStatus(
        deps.db,
        row.arxivId,
        'drafted_unsendable',
        `abandoned after ${row.attempts} attempts: ${row.reason ?? 'unknown'}`,
      );
    }
    summary.unsendable++;
    summary.stranded++;
  }
}

// Retries drafts already at status 'approved' (explicit user approval already
// happened; this never promotes anything into that status) whose previous
// send attempt failed. markSendFailed leaves a draft 'approved' precisely so
// this step can heal it; without this nothing ever retried it (Fix 3).
// D1/D5. What used to be retryApprovedUnsent. It no longer sends: an approved
// draft whose send outcome is unknown can never be safely re-sent from inside
// the process (there is no idempotency key on the Gmail send, so a timeout
// after acceptance looks exactly like a failure before it). It reports instead,
// at most once per attempt count, so a draft approved against a permanently bad
// address does not text Aditya the same failure every morning forever.
//
// Recovery is a human act, by design. See
// docs/superpowers/plans/2026-07-29-send-path-safety.md, "Re-arming".
async function reportStalledApprovals(deps: LoopDeps, summary: LoopSummary): Promise<void> {
  for (const row of stalledApprovals(deps.db)) {
    if (stallAlreadyReported(deps.db, row.draftId, row.attempts)) continue;
    const detail =
      row.attemptedAt === null
        ? `approved but never attempted. Reply "${row.shortId} y" again to send it.`
        : `one send attempt recorded at ${row.attemptedAt}, never confirmed. Not retried automatically: ` +
          `check the Gmail Sent folder for ${row.toEmail ?? 'the recipient'} before re-arming it.`;
    markStallReported(deps.db, row.draftId, row.attempts);
    summary.stalled = (summary.stalled ?? 0) + 1;
    await deps.channel.notify(`${row.shortId} is approved and unsent: ${detail}`);
  }
}

// A deferred needs-address row rests at drafted_unsendable, which is terminal:
// getResumable only looks at 'discovered', and queued_for_message is unusable
// here because resolveSendableDraft's no_email branch RETIRES the draft. So the
// backlog needs its own drain, bounded by the same per-run address budget.
async function drainAddressRequests(deps: LoopDeps, summary: LoopSummary): Promise<void> {
  const budget = deps.config.gate.maxAddressRequestsPerRun ?? DEFAULT_MAX_ADDRESS_REQUESTS_PER_RUN;
  const remaining = budget - (summary.addressRequested ?? 0);
  if (remaining <= 0) return;
  for (const row of deferredAddressRequests(deps.db, remaining)) {
    // Rebuilt from the structured event payload, never by parsing the address
    // back out of a reason string: the reason wording changes twice in this
    // feature and the drain must not be coupled to it.
    const p = deferredPayload(deps.db, row.draftId);
    if (!p) continue;
    const ok = await requestAddress({
      db: deps.db,
      notify: (t) => deps.channel.notify(t),
      arxivId: row.arxivId,
      draftId: row.draftId,
      shortId: row.shortId,
      personId: p.personId,
      personName: p.personName,
      affiliation: p.affiliation,
      paperTitle: row.paperTitle,
      rejected: p.rejected,
    });
    if (ok) summary.addressRequested = (summary.addressRequested ?? 0) + 1;
  }
}

export async function runLoop(deps: LoopDeps, opts: LoopOptions): Promise<LoopSummary> {
  const summary: LoopSummary = {
    dryRun: opts.dryRun,
    sent: 0,
    seen: 0,
    filtered: 0,
    unsendable: 0,
    messaged: 0,
    queued: 0,
    wouldMessage: 0,
    resumed: 0,
    retryable: 0,
    stranded: 0,
    stalled: 0,
    errors: [],
  };

  try {
    await drainApprovals(deps, opts, summary);

    // D1: an approved-but-unsent draft is reported, never re-sent. The user's
    // approval already happened, but a second send of a cold email cannot be
    // taken back, and nothing here can tell a failed send from a delivered one.
    // Never runs in a dry run: a dry run writes nothing and texts nothing.
    if (!opts.dryRun) {
      try {
        await reportStalledApprovals(deps, summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push(`stalled approval report failed: ${msg}`);
      }
    }

    // Queued drafts from earlier runs go out before anything newly discovered.
    if (!opts.dryRun) {
      for (const q of getQueued(deps.db, deps.config.gate.maxMessagesPerRun)) {
        if (summary.messaged >= deps.config.gate.maxMessagesPerRun) break;
        const draft = resolveSendableDraft(deps.db, q.arxivId, summary, opts.dryRun);
        if (!draft) continue;
        const person = getPerson(deps.db, draft.personId);
        if (!person?.email) continue; // resolveSendableDraft already excluded this; defensive only
        try {
          await deps.channel.sendDraftMessage({
            shortId: draft.shortId,
            subject: draft.subject,
            body: draft.body,
            to: person.email,
            personName: person.name,
          });
          setStatus(deps.db, q.arxivId, 'messaged');
          summary.messaged++;
        } catch (e) {
          // Row stays at queued_for_message (no setStatus above); the next
          // run's flush loop will pick it up again (F2).
          const msg = e instanceof Error ? e.message : String(e);
          summary.errors.push(`${q.arxivId}: ${msg}`);
        }
      }
    }

    // After the queued draft flush and before discovery, same reason queued
    // work goes out ahead of new work.
    if (!opts.dryRun) {
      try {
        await drainAddressRequests(deps, summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push(`address request drain failed: ${msg}`);
      }
    }

    // CS1.1: resume discovered rows before discovering anything fresh, same
    // reason queued work goes out ahead of new work. Failure-isolated (CS7.6)
    // so a resume failure never prevents discovery (F1).
    try {
      await resumeStranded(deps, opts, summary);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.errors.push(`resume failed: ${msg}`);
    }

    const discovered = await discoverAll(deps.sources);
    summary.errors.push(...discovered.errors);

    const fresh = filterUnseen(deps.db, discovered.candidates);
    summary.seen = fresh.length;
    for (const c of fresh) recordDiscovered(deps.db, c);

    for (const c of fresh) {
      if (!opts.dryRun) claimCandidate(deps.db, c.arxivId);
      await processCandidate(deps, opts, summary, c);
    }
  } catch (e) {
    // Nothing above should throw anymore (each stage catches its own
    // failures), but if something unexpected still escapes, the run must
    // still complete and still notify (F1) rather than reject silently.
    const msg = e instanceof Error ? e.message : String(e);
    summary.errors.push(`run failed: ${msg}`);
  } finally {
    try {
      summary.addressesPending = pendingAddressCount(deps.db);
    } catch {
      // Read-only reporting must never mask the real failure above.
    }
    const line =
      `outreach loop${opts.dryRun ? ' (dry run)' : ''}: seen ${summary.seen}, filtered ${summary.filtered}, ` +
      `unsendable ${summary.unsendable}, messaged ${summary.messaged}, queued ${summary.queued}, sent ${summary.sent}, ` +
      `resumed ${summary.resumed}` +
      // Only meaningful in a dry run, where messaged and queued are both 0 by
      // construction. Named "would message" rather than "messaged" because the
      // per-run cap is not simulated in a dry run, so this can exceed
      // max_messages_per_run; a real run applies the cap and defers the rest.
      (opts.dryRun ? `, would message ${summary.wouldMessage}` : '') +
      (summary.retryable ? `, retryable ${summary.retryable}` : '') +
      (summary.stranded ? `, stranded ${summary.stranded}` : '') +
      (summary.stalled ? `, stalled approvals ${summary.stalled}` : '') +
      (summary.addressRequested ? `, address requests ${summary.addressRequested}` : '') +
      (summary.addressesPending ? `, addresses pending ${summary.addressesPending}` : '') +
      (summary.errors.length ? `, errors: ${summary.errors.join(' | ')}` : '');
    try {
      await deps.channel.notify(line);
    } catch {
      // A notify transport failure must not mask whatever the real problem
      // was above; swallow it here.
    }
  }

  return summary;
}
