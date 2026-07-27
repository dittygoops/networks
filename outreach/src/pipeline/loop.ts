// One full outreach cycle, then exit. Order matters: approvals drain first so a
// reply to yesterday's message is acted on before today's discovery adds more.
// Spec: docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md
import type { DB } from '../db/db.js';
import { getPerson } from '../db/db.js';
import type { ApprovalChannel } from '../approval/channel.js';
import { parseReply } from '../approval/channel.js';
import { decide, markSendFailed, markSent, persistDraft, priorThreads, logEvent } from '../approval/ledger.js';
import { parseShortId } from '../approval/ids.js';
import type { LoopConfig } from '../discovery/config.js';
import { discoverAll } from '../discovery/index.js';
import { filterUnseen, getQueued, recordDiscovered, setRelevance, setStatus } from '../discovery/seenLedger.js';
import { gateCandidate } from '../discovery/relevanceGate.js';
import type { Candidate, DiscoverySource } from '../discovery/types.js';
import type { Draft, DraftInput } from './draft.js';
import type { OrchestrateResult } from './orchestrate.js';
import type { Sender } from '../sender/types.js';
import type { LLMClient } from '../llm/client.js';

export interface LoopDeps {
  db: DB;
  channel: ApprovalChannel;
  config: LoopConfig;
  sources: DiscoverySource[];
  terms: string[];
  processPaper: (deps: unknown, arxivId: string) => Promise<OrchestrateResult>;
  generateDraft: (llm: LLMClient, input: DraftInput) => Promise<Draft>;
  buildDraftInput: (r: OrchestrateResult) => DraftInput;
  sender: Sender;
  llm?: LLMClient;
  orchestrateDeps?: unknown;
  replyWindowMs?: number;
  senderEmail?: string; // OutboundEmail.from; defaults to SENDER_EMAIL
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
  errors: string[];
}

async function drainApprovals(deps: LoopDeps, opts: LoopOptions, summary: LoopSummary): Promise<void> {
  const replies = await deps.channel.captureReplies(deps.replyWindowMs ?? 0);
  for (const reply of replies) {
    const parsed = parseReply(reply.text);
    if (parsed.kind === 'unparseable') {
      await deps.channel.notify(`Could not read "${reply.text}". Reply like "d7 y" or "d7 n".`);
      continue;
    }
    const draftId = parseShortId(parsed.shortId);
    if (draftId === null) continue;

    if (parsed.kind === 'unsupported') {
      // Edits are F5 territory (docs/spec-imessage-approval-loop.md).
      logEvent(deps.db, draftId, 'edit_reply_unsupported', { text: reply.text });
      await deps.channel.notify(`Edits are not yet supported for ${parsed.shortId}. Reply "y" to send or "n" to skip.`);
      continue;
    }

    if (parsed.kind === 'skip') {
      const res = decide(deps.db, draftId, 'skip', 'imessage');
      await deps.channel.notify(
        res.applied ? `${parsed.shortId} skipped.` : `${parsed.shortId} was already ${res.existing.action}.`,
      );
      continue;
    }

    const res = decide(deps.db, draftId, 'send', 'imessage');
    if (!res.applied) {
      await deps.channel.notify(`${parsed.shortId} was already ${res.existing.action}.`);
      continue;
    }
    if (opts.dryRun) {
      await deps.channel.notify(`${parsed.shortId} approved (dry run, nothing sent).`);
      continue;
    }

    const row = deps.db
      .prepare(
        `SELECT d.person_id AS personId, r.subject AS subject, r.body AS body
         FROM drafts d JOIN revisions r ON r.id = d.sendable_revision_id
         WHERE d.id = ?`,
      )
      .get(draftId) as { personId: number; subject: string; body: string } | undefined;
    if (!row) {
      await deps.channel.notify(`${parsed.shortId} has no grounded revision to send.`);
      continue;
    }
    const person = getPerson(deps.db, row.personId);
    if (!person?.email) {
      await deps.channel.notify(`${parsed.shortId} has no email on record.`);
      continue;
    }
    try {
      const { sentId } = await deps.sender.send({
        to: person.email,
        from: deps.senderEmail ?? process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
        subject: row.subject,
        body: row.body,
        draftShortId: parsed.shortId,
      });
      markSent(deps.db, draftId, sentId);
      summary.sent++;
      await deps.channel.notify(`${parsed.shortId} sent to ${person.email}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markSendFailed(deps.db, draftId, msg);
      await deps.channel.notify(`${parsed.shortId} failed to send: ${msg}`);
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
  if (summary.messaged >= deps.config.gate.maxMessagesPerRun) {
    setStatus(deps.db, c.arxivId, 'queued_for_message', 'deferred by max_messages_per_run');
    summary.queued++;
    return;
  }
  if (opts.dryRun) {
    setStatus(deps.db, c.arxivId, 'queued_for_message', 'dry run, not messaged');
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

    let result: OrchestrateResult;
    try {
      result = await deps.processPaper(deps.orchestrateDeps, c.arxivId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', `pipeline failed: ${msg}`);
      summary.unsendable++;
      summary.errors.push(`${c.arxivId}: ${msg}`);
      return;
    }

    if (!result.personId) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'identity unconfirmed');
      summary.unsendable++;
      return;
    }
    if (!result.email) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no email resolved');
      summary.unsendable++;
      return;
    }
    if (result.noStrongHook || result.hooks.length === 0) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no grounded hook');
      summary.unsendable++;
      return;
    }
    const prior = priorThreads(deps.db, result.personId);
    if (prior.length > 0) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', `prior thread exists (${prior[0]?.shortId ?? ''})`);
      summary.unsendable++;
      return;
    }

    const input = deps.buildDraftInput(result);
    const draft = await deps.generateDraft(deps.llm as LLMClient, input);
    if (!draft.grounded) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', `grounding failed: ${draft.notes.join('; ')}`);
      summary.unsendable++;
      return;
    }

    const persisted = persistDraft(deps.db, {
      personId: result.personId,
      paperArxivId: result.arxivId,
      paperTitle: result.paperTitle,
      intent: input.intent,
      draftInput: input,
      draft,
      contextJson: { discoveredVia: c.discoveredVia, sourceDetail: c.sourceDetail, relevance: verdict.score },
    });
    setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, persisted.draftId);
    await emit(deps, opts, summary, c, persisted.shortId, draft.subject, draft.body, result.email.email, result.target);
  } catch (e) {
    // gateCandidate or generateDraft (or anything else unexpected) threw. One
    // bad candidate must never sink the whole run (F1: survive partial failure).
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', `pipeline error: ${msg}`);
    summary.unsendable++;
    summary.errors.push(`${c.arxivId}: ${msg}`);
  }
}

// Retries drafts already at status 'approved' (explicit user approval already
// happened; this never promotes anything into that status) whose previous
// send attempt failed. markSendFailed leaves a draft 'approved' precisely so
// this step can heal it; without this nothing ever retried it (Fix 3).
async function retryApprovedUnsent(deps: LoopDeps, summary: LoopSummary): Promise<void> {
  const rows = deps.db
    .prepare(
      `SELECT d.id AS draftId, d.short_id AS shortId, d.person_id AS personId, r.subject AS subject, r.body AS body
       FROM drafts d JOIN revisions r ON r.id = d.sendable_revision_id
       WHERE d.status = 'approved' AND d.sendable_revision_id IS NOT NULL`,
    )
    .all() as { draftId: number; shortId: string; personId: number; subject: string; body: string }[];

  for (const row of rows) {
    const person = getPerson(deps.db, row.personId);
    if (!person?.email) {
      await deps.channel.notify(`${row.shortId} has no email on record.`);
      continue;
    }
    try {
      const { sentId } = await deps.sender.send({
        to: person.email,
        from: deps.senderEmail ?? process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
        subject: row.subject,
        body: row.body,
        draftShortId: row.shortId,
      });
      markSent(deps.db, row.draftId, sentId);
      summary.sent++;
      await deps.channel.notify(`${row.shortId} sent to ${person.email}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markSendFailed(deps.db, row.draftId, msg);
      summary.errors.push(`${row.shortId}: retry send failed: ${msg}`);
      await deps.channel.notify(`${row.shortId} failed to send: ${msg}`);
    }
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
    errors: [],
  };

  try {
    await drainApprovals(deps, opts, summary);

    // Retry approved-but-unsent drafts before anything else (F3): the user's
    // approval already happened, so a transient send failure must heal here,
    // not wait on a step that only runs for newly discovered/queued work.
    // Never runs in a dry run: a dry run must send nothing.
    if (!opts.dryRun) {
      try {
        await retryApprovedUnsent(deps, summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push(`retry approved unsent failed: ${msg}`);
      }
    }

    // Queued drafts from earlier runs go out before anything newly discovered.
    if (!opts.dryRun) {
      for (const q of getQueued(deps.db, deps.config.gate.maxMessagesPerRun)) {
        if (summary.messaged >= deps.config.gate.maxMessagesPerRun) break;
        const row = deps.db
          .prepare(
            `SELECT d.short_id AS shortId, d.person_id AS personId, r.subject AS subject, r.body AS body
             FROM seen_papers s JOIN drafts d ON d.id = s.draft_id
             JOIN revisions r ON r.id = d.sendable_revision_id
             WHERE s.arxiv_id = ?`,
          )
          .get(q.arxivId) as { shortId: string; personId: number; subject: string; body: string } | undefined;
        if (!row) continue;
        const person = getPerson(deps.db, row.personId);
        if (!person?.email) continue;
        try {
          await deps.channel.sendDraftMessage({
            shortId: row.shortId,
            subject: row.subject,
            body: row.body,
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

    const discovered = await discoverAll(deps.sources);
    summary.errors.push(...discovered.errors);

    const fresh = filterUnseen(deps.db, discovered.candidates);
    summary.seen = fresh.length;
    for (const c of fresh) recordDiscovered(deps.db, c);

    for (const c of fresh) {
      await processCandidate(deps, opts, summary, c);
    }
  } catch (e) {
    // Nothing above should throw anymore (each stage catches its own
    // failures), but if something unexpected still escapes, the run must
    // still complete and still notify (F1) rather than reject silently.
    const msg = e instanceof Error ? e.message : String(e);
    summary.errors.push(`run failed: ${msg}`);
  } finally {
    const line =
      `outreach loop${opts.dryRun ? ' (dry run)' : ''}: seen ${summary.seen}, filtered ${summary.filtered}, ` +
      `unsendable ${summary.unsendable}, messaged ${summary.messaged}, queued ${summary.queued}, sent ${summary.sent}` +
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
