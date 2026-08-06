// CLI: `outreach add <arxiv-id>` runs the full profile-mining pipeline for a
// paper's target author and prints contact + ontology + hooks. Run with:
//   npx tsx --env-file=.env src/cli.ts add <arxiv-id>
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { openDb, saveSelfFacts, replaceSelfFacts, factRows, getPerson } from './db/db.js';
import { decide, markSendFailed, markSent, persistDraft, priorThreads } from './approval/ledger.js';
import { recordSentThread, rearmUnresolvable } from './pipeline/sentThreads.js';
import { createGmailApiSender } from './sender/gmail-api.js';
import { createGmailSmtpSender } from './sender/gmail.js';
import type { Sender } from './sender/types.js';
import { createGmailReader, type GmailReader } from './sender/gmailReader.js';
import { runReplyCycle } from './pipeline/replies.js';
import { acquireLease, releaseLease } from './pipeline/replyState.js';
import { parseShortId } from './approval/ids.js';
import type { ApprovalChannel } from './approval/channel.js';

// Pick the sender: Gmail API OAuth if configured (the path that works on ASU
// Workspace, which blocks SMTP app passwords), else SMTP for personal accounts.
function makeSender(): Sender {
  if (process.env.GMAIL_OAUTH_REFRESH_TOKEN) return createGmailApiSender();
  return createGmailSmtpSender();
}
import { processPaper } from './pipeline/orchestrate.js';
import { generateDraft } from './pipeline/draft.js';
import { buildSenderFacts } from './pipeline/credibility.js';
import { buildSelfOntology } from './pipeline/persona.js';
import { extractPdfText } from './pipeline/pdf.js';
import { createTavilyClient } from './search/tavily.js';
import { createOpenRouterClient } from './llm/client.js';
import type { OntologyFact } from './pipeline/research.js';
import { runLoop } from './pipeline/loop.js';
import { runListenLoop } from './pipeline/listen.js';
import { loadConfig } from './discovery/config.js';
import { strandedReport } from './discovery/seenLedger.js';
import { createSavedQuerySource } from './discovery/sources/savedQuery.js';
import { createAuthorWatchSource } from './discovery/sources/authorWatch.js';
import { createRecommendSource, resolveKeyPaperSeeds } from './discovery/sources/recommend.js';
import { createStubChannel } from './approval/channel.js';
import { createPhotonChannel, photonOptionsFromEnv } from './approval/photonChannel.js';

// Read a source document as text (PDF via unpdf, otherwise UTF-8).
async function readDocument(path: string): Promise<{ label: string; text: string }> {
  const label = basename(path).replace(/\.[^.]+$/, '');
  if (path.toLowerCase().endsWith('.pdf')) {
    return { label, text: await extractPdfText(new Uint8Array(readFileSync(path))) };
  }
  return { label, text: readFileSync(path, 'utf8') };
}

const DB_PATH = process.env.OUTREACH_DB ?? 'data/outreach.db';


// Dev only (D9): seed Aditya's self ontology from the fixture until the persona
// subsystem exists. Runs once, when the self ontology is empty.
function ensureSelfOntology(db: ReturnType<typeof openDb>): void {
  if (factRows(db, null).length > 0) return;
  const facts = JSON.parse(
    readFileSync(new URL('../test/fixtures/self-ontology.json', import.meta.url), 'utf8'),
  ) as OntologyFact[];
  saveSelfFacts(db, facts);
  console.log(`seeded ${facts.length} self-ontology facts (dev fixture)`);
}

// `persona <doc-path...> [--answers <file.json>]`: build the self ontology from
// curated documents plus optional interview answers, replacing what is stored.
async function runPersona(args: string[]): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const answersIdx = args.indexOf('--answers');
  const answers =
    answersIdx >= 0 && args[answersIdx + 1]
      ? (JSON.parse(readFileSync(args[answersIdx + 1]!, 'utf8')) as Record<string, string>)
      : {};
  const answerFileIdx = answersIdx >= 0 ? answersIdx + 1 : -1;
  const docPaths = args.filter((a, i) => !a.startsWith('--') && i !== answerFileIdx);
  if (docPaths.length === 0 && Object.keys(answers).length === 0) {
    console.error('usage: cli.ts persona <doc-path...> [--answers <file.json>]');
    process.exit(1);
  }
  const documents = await Promise.all(docPaths.map(readDocument));

  const facts = await buildSelfOntology({ llm: createOpenRouterClient() }, { documents, answers });
  const db = openDb(DB_PATH);
  replaceSelfFacts(db, facts);

  console.log(`\nbuilt self-ontology: ${facts.length} facts from ${documents.length} docs + interview`);
  showSelfFacts(db);
}

// Review surface: print every stored self-fact with its source and tier, grouped
// by facet, so each fact is traceable to where it came from before it is used.
function showSelfFacts(db: ReturnType<typeof openDb>): void {
  const rows = db.prepare(
    `SELECT facet, key, value, confidence, usability_tier AS tier, source_url
       FROM ontology_facts WHERE person_id IS NULL ORDER BY facet, usability_tier`,
  ).all() as { facet: string; key: string; value: string; confidence: number; tier: string; source_url: string }[];
  if (rows.length === 0) {
    console.log('no self-ontology yet. Build it: cli.ts persona <doc-path...> [--answers <file.json>]');
    return;
  }
  const byTier = rows.reduce((a: Record<string, number>, r) => ((a[r.tier] = (a[r.tier] ?? 0) + 1), a), {});
  console.log(`self-ontology: ${rows.length} facts  ${JSON.stringify(byTier)}`);
  let facet = '';
  for (const r of rows) {
    if (r.facet !== facet) { facet = r.facet; console.log(`\n${facet}:`); }
    const src = r.source_url.replace(/^self:/, '');
    console.log(`  [${r.tier}] ${r.key} = ${r.value}  (conf ${r.confidence}, source: ${src})`);
  }
}

// `loop [--dry-run]`: one full discover-gate-draft-message cycle. A dry run
// must never construct the real Photon channel and must never send email
// (SAFETY, non-negotiable): the stub channel and a zero reply window keep it
// fully offline on the notify/message side.
async function cmdLoop(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const db = openDb(DB_PATH);
  const config = loadConfig(db);
  const llm = createOpenRouterClient();

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set');
  const tavily = createTavilyClient(tavilyKey);

  // deriveSeedPapers (inside loadConfig) stays synchronous and only picks up
  // key_paper facts that already contain an arXiv id. A bare-title key_paper
  // fact needs a network title lookup, so that resolution happens here, after
  // config load, and is merged into the seed list before the recommend
  // source is built.
  const titleResolvedSeeds = await resolveKeyPaperSeeds(db);
  const seeds = [...new Set([...config.seeds, ...titleResolvedSeeds])];

  const sources = [
    createSavedQuerySource(config.queries),
    createAuthorWatchSource(config.authors),
    createRecommendSource(seeds),
  ];

  // A dry run must never touch the real iMessage thread.
  const channel = dryRun ? createStubChannel() : await createPhotonChannel(photonOptionsFromEnv());

  try {
    const summary = await runLoop(
      {
        db,
        channel,
        config,
        sources,
        terms: config.queries,
        // LoopDeps types this as (deps: unknown, arxivId) for pipeline-agnostic
        // callers; processPaper's real deps type is OrchestrateDeps, so the
        // cast below just bridges that, orchestrateDeps below is still the
        // real OrchestrateDeps shape at the call site.
        processPaper: (deps, arxivId) => processPaper(deps as Parameters<typeof processPaper>[0], arxivId),
        generateDraft,
        buildDraftInput: (r) => ({
          recipient: { name: r.target, paperTitle: r.paperTitle },
          hooks: r.hooks,
          intent: 'seeking direction',
          senderName: 'Aditya Gupta',
          // Credibility is a separate job from the hook. Without these the
          // drafter has only the hook list to mine for a credential, which is
          // how a real draft came to open "I used Claude in my Content Farm
          // project": true, but table stakes, and unrelated to the ask.
          senderFacts: buildSenderFacts(db),
        }),
        sender: makeSender(),
        senderEmail: process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
        llm,
        orchestrateDeps: { db, search: tavily, fetcher: tavily, llm },
        replyWindowMs: dryRun ? 0 : 20000,
      },
      { dryRun },
    );

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    // Must run even if runLoop throws: the real channel holds a resumable
    // message stream open, so skipping this leaves the process hanging
    // forever and the next scheduled run never starts.
    await channel.close?.();
  }
}

// `stranded`: read-only operator surface (docs/spec-candidate-stranding.md,
// CS8.2). Prints what the loop has parked and not messaged: rows still
// resting at 'discovered', rows abandoned or marked ambiguous by the resume
// step, and orphan awaiting_approval drafts the loop never adopted. Writes
// nothing and needs no API keys; the remedy for everything it prints is an
// existing human action (a `dX n`/`dX y` reply, or `outreach add` on a paper).
function cmdStranded(): void {
  const db = openDb(DB_PATH);
  const config = loadConfig(db);
  const report = strandedReport(db, config.gate.maxResumeAttempts);

  console.log(`discovered, resting (${report.discovered.length}):`);
  for (const r of report.discovered) {
    console.log(`  ${r.arxivId}  attempts ${r.attempts}  since ${r.firstSeenAt}  ${r.reason ?? '(no reason yet)'}`);
  }

  console.log(`\nabandoned or ambiguous (${report.terminalStranded.length}):`);
  for (const r of report.terminalStranded) {
    console.log(`  ${r.arxivId}  ${r.status}  draft ${r.draftId ?? '(none)'}  ${r.reason ?? ''}`);
  }

  console.log(`\norphan awaiting_approval drafts (${report.orphanDrafts.length}):`);
  for (const r of report.orphanDrafts) {
    console.log(`  ${r.shortId}  ${r.personName} (person ${r.personId})  paper ${r.paperArxivId ?? '(none)'}`);
  }
}

// `listen`: a long-running process that stays connected to Spectrum and acts
// on approval replies as they arrive (R1). The batch `loop` command only
// holds a connection open for ~20 seconds a day; Spectrum does not deliver
// messages to a client that was disconnected when they were sent, so a reply
// sent while the batch is not connected is lost for good. This is the fix.
//
// R5: createGmailApiSender() throws when its OAuth env vars are missing. If
// that throw happened here unguarded, the process would die before it ever
// connected to Spectrum, and under launchd's KeepAlive it would just die
// again on every restart, never receiving anything. So the sender is
// constructed defensively: a construction failure is caught, logged, and
// replaced with a stand-in whose send() always fails; the receive side (and
// decision recording) keeps working regardless, and Aditya is told once, on
// connect, that sending needs to be fixed.
async function cmdListen(): Promise<void> {
  const db = openDb(DB_PATH);
  const senderEmail = process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu';

  let sender: Sender;
  let startupNotice = 'outreach listen: connected and watching for replies.';
  try {
    sender = makeSender();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`listen: sender construction failed, sends will fail until fixed: ${msg}`);
    startupNotice = `outreach listen: connected, but email sending is broken (${msg}). Approvals will be recorded but nothing will send until this is fixed.`;
    sender = {
      async send() {
        throw new Error(`sender unavailable: ${msg}`);
      },
    };
  }

  await runListenLoop({
    connect: () => createPhotonChannel(photonOptionsFromEnv()),
    db,
    sender,
    senderEmail,
    startupNotice,
  });
}

// Resolves thread_id for every legacy send that has none: one
// users.messages.get per row (20 quota units each; 56 for the historical
// sends this feature exists to backfill, the single largest quota spend in
// the whole feature). Never assumes the first message in a thread has
// id == threadId: that is widely observed and nowhere documented, so this
// always asks (gmailReader.ts:threadIdForMessage). A single row's failure (a
// deleted message, a transient fault) is logged and skipped, not fatal to the
// rest of the backfill: one bad historical row must not block the other 55.
async function backfillThreadIds(db: ReturnType<typeof openDb>, reader: GmailReader): Promise<number> {
  const rows = db.prepare(
    `SELECT draft_id AS draftId, sent_message_id AS sentMessageId
       FROM sent_threads WHERE thread_id IS NULL AND watch_state = 'open'`,
  ).all() as { draftId: number; sentMessageId: string }[];
  let resolved = 0;
  for (const row of rows) {
    try {
      const threadId = await reader.threadIdForMessage(row.sentMessageId);
      if (threadId) {
        db.prepare('UPDATE sent_threads SET thread_id = ? WHERE draft_id = ?').run(threadId, row.draftId);
        resolved++;
      }
    } catch (e) {
      console.log(
        `backfill: could not resolve a thread id for draft ${row.draftId}: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    }
  }
  return resolved;
}

// `--rearm all` (or `--rearm` with nothing after it) means every unresolvable
// row; `--rearm d19 d22` (or bare `19 22`) means only those drafts. Reuses
// parseShortId so 'd19', 'D19' and bare '19' all work, the same ergonomics as
// a tapback reply. undefined means "no filter", which is what
// rearmUnresolvable (sentThreads.ts) treats as "all".
function parseRearmIds(argv: string[]): number[] | undefined {
  const idx = argv.indexOf('--rearm');
  if (idx === -1) return undefined;
  const rest = argv.slice(idx + 1).filter((a) => !a.startsWith('--'));
  if (rest.length === 0 || rest[0] === 'all') return undefined;
  const ids = rest.map(parseShortId).filter((n): n is number => n !== null);
  return ids.length ? ids : undefined;
}

export interface RepliesSeams {
  dbPath?: string;
  createReader?: () => GmailReader;
  lazyChannel?: () => Promise<ApprovalChannel>;
}

// `replies [--dry-run] [--backfill] [--rearm all|<draftId>...]`: poll every
// due thread once, adopt orphaned sends, and notify on new human replies and
// bounces. Every field of `seams` defaults to the real implementation, so
// main's dispatch below calls cmdReplies(argv) exactly as it would with no
// seams argument at all; the seam exists only so a test can prove what this
// command does and does not connect to, without a real Gmail token or a real
// Spectrum session.
export async function cmdReplies(argv: string[], seams: RepliesSeams = {}): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const senderEmail = process.env.SENDER_EMAIL;
  // Fail loud, with the remedy, exactly like createGmailApiSender
  // (gmail-api.ts:33-37). Never degrade to a silent no-op: without this the
  // job would treat every message as inbound, including Aditya's own
  // follow-ups, and write fabricated ground truth into the exact table the
  // whole evaluation section depends on.
  if (!senderEmail) throw new Error('SENDER_EMAIL is not set; the reply poller refuses to start without it');

  const db = openDb(seams.dbPath ?? DB_PATH);
  const createReader = seams.createReader ?? createGmailReader;
  const lazyChannel = seams.lazyChannel ?? (() => createPhotonChannel(photonOptionsFromEnv()));

  // THE LEASE WRAPS EVERYTHING THIS COMMAND DOES, not just runReplyCycle.
  // --backfill is up to 56 `messages.get` calls, the single largest spend in
  // the whole feature, and it runs BEFORE the cycle. With the lease taken
  // inside runReplyCycle instead, a hand-run `replies --backfill` during a
  // scheduled cycle would spend the whole backfill and only then discover it
  // lost the lease. --rearm returns before the cycle is even reached, so it
  // would never be covered at all. Taking it here, before either branch,
  // covers --rearm, --backfill and the cycle under one lock.
  if (!acquireLease(db, process.pid, new Date())) {
    console.log('another reply cycle holds the lease; exiting');
    return;   // exit 0: not a success, not a failure. Touch no counters.
  }

  // A dry run constructs NO channel at all, and a quiet cycle never connects
  // to Spectrum either. Both properties come from this being a FACTORY that
  // nothing calls until there is something to say: passing `await
  // lazyChannel()` eagerly here would connect to Spectrum on every
  // non-dry-run cycle before runReplyCycle is even entered, which is exactly
  // what spec Change 5 forbids, and no assertion inside runReplyCycle could
  // see it happen. A second connected Spectrum client competes on the line
  // carrying irreversible approvals.
  let channel: ApprovalChannel | undefined;
  const channelFactory = async (): Promise<ApprovalChannel> => (channel ??= await lazyChannel());

  try {
    if (argv.includes('--rearm')) {
      console.log(`re-armed ${rearmUnresolvable(db, parseRearmIds(argv))} threads`);
      return;
    }

    const reader = createReader();
    if (argv.includes('--backfill')) {
      const n = await backfillThreadIds(db, reader);
      console.log(`backfilled ${n} thread ids`);
    }

    const summary = await runReplyCycle({
      db, reader, senderEmail, dryRun,
      leaseHeld: true,                                   // taken above, released below
      channel: dryRun ? undefined : channelFactory,
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    // cmdReplies owns its own catch and never lets a Gaxios error reach the
    // top-level handler, where a bare console.error on the error object would
    // print the response headers and the request URL into
    // data/replies.err.log.
    console.error(e instanceof Error ? e.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    releaseLease(db);
    await channel?.close?.();   // the local, never the factory
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'persona') return runPersona(rest);
  if (command === 'self') {
    showSelfFacts(openDb(DB_PATH));
    return;
  }
  if (command === 'loop') return cmdLoop(rest);
  if (command === 'listen') return cmdListen();
  if (command === 'stranded') {
    cmdStranded();
    return;
  }
  if (command === 'replies') return cmdReplies(rest);

  const arg = rest[0];
  if (command !== 'add' || !arg) {
    console.error(
      'usage: cli.ts add <arxiv-id>  |  cli.ts persona <doc-path...> [--answers <file.json>]  |  cli.ts loop [--dry-run]  |  cli.ts listen  |  cli.ts stranded  |  cli.ts replies [--dry-run] [--backfill] [--rearm all|<draftId>...]',
    );
    process.exit(1);
  }
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set');
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

  const db = openDb(DB_PATH);
  ensureSelfOntology(db);
  const tavily = createTavilyClient(tavilyKey);

  const r = await processPaper(
    { db, search: tavily, fetcher: tavily, llm: createOpenRouterClient() },
    arg,
    // One deliberate human invocation, not a 184-paper batch: look up the
    // address even when the author does not resolve or does not hook,
    // because printing "not found" for a lookup that never ran would be a
    // false report.
    { alwaysExtractContact: true },
  );

  console.log(`\n=== ${r.target}  (arXiv ${r.arxivId}) ===`);
  console.log(`resolved: ${r.resolved}`);
  console.log(`email:    ${r.email ? `${r.email.email}  (${r.email.confidence}, ${r.email.source})` : 'not found (manual queue)'}`);
  console.log(`facts:    ${r.factCount}`);
  console.log(`hooks:    ${r.hooks.length}${r.noStrongHook ? ' (no strong hook)' : ''}`);
  for (const h of r.hooks.slice(0, 5)) {
    console.log(`  [${h.tier}] ${h.strength.toFixed(2)}  ${h.rationale}`);
    console.log(`         mine: ${h.selfValue}`);
    console.log(`         them: ${h.personValue}`);
  }
  if (r.notes.length) console.log(`notes:    ${r.notes.join('; ')}`);

  // DR6: draft the email if the person resolved and we have at least one hook.
  // Matches the loop's gate (loop.ts): a weak hook or a suspected identity
  // collision must not produce a draft here either.
  if (r.resolved && r.personId != null && !r.noStrongHook && r.hooks.length > 0 && !r.identityCollisionReason) {
    const self = factRows(db, null);
    const intent = self.find((f) => f.facet === 'interest' && f.key === 'writing')?.value
      ?? 'connect and get direction on future olfaction / smell research';
    const senderFacts = self
      .filter((f) => f.facet === 'academic')
      .slice(0, 8)
      .map((f) => ({ text: f.detail ? `${f.value}: ${f.detail}` : f.value, stance: f.stance }));
    const affiliation = getPerson(db, r.personId)?.affiliation ?? undefined;

    // Prefer a frontier model for drafts (DR1), but fall back to the working
    // cheap model when MODEL_FRONTIER is unset or the account lacks credits.
    const draftLlm = createOpenRouterClient({
      model: process.env.MODEL_FRONTIER ?? process.env.MODEL_CHEAP ?? 'deepseek/deepseek-chat',
      temperature: 0.4,
    });
    const draft = await generateDraft(draftLlm, {
      recipient: { name: r.target, affiliation, profileSummary: r.profileSummary, paperTitle: r.paperTitle },
      hooks: r.hooks.slice(0, 3),
      intent,
      senderName: 'Aditya Gupta',
      senderFacts,
    });

    console.log(`\n--- DRAFT ---`);
    console.log(`Subject: ${draft.subject}`);
    console.log(`\n${draft.body}`);
    console.log(`\n(${draft.wordCount} words${draft.grounded ? '' : ', CHECK: may be ungrounded'})`);
    if (draft.notes.length) console.log(`draft notes: ${draft.notes.join('; ')}`);

    if (!draft.subject || !draft.body) {
      console.log('draft generation failed; nothing persisted');
      return;
    }

    // Persist to the ledger (spec AL4): draft + revision 1 + audit events.
    const topHook = r.hooks[0]!;
    const persisted = persistDraft(db, {
      personId: r.personId,
      paperArxivId: r.arxivId,
      paperTitle: r.paperTitle,
      intent,
      draftInput: {
        recipient: { name: r.target, affiliation, profileSummary: r.profileSummary, paperTitle: r.paperTitle },
        hooks: r.hooks.slice(0, 3),
        intent,
        senderName: 'Aditya Gupta',
        senderFacts,
      },
      draft,
      contextJson: {
        intent,
        hook: { entity: topHook.personValue, tier: topHook.tier },
        recipientProfileSummary: r.profileSummary ?? null,
        groundingTerms: {
          recipientTerms: r.hooks.flatMap((h) => [h.personValue, h.personDetail ?? '']).concat(r.paperTitle).filter(Boolean),
          senderTerms: r.hooks.flatMap((h) => [h.selfValue, h.selfDetail ?? '']).concat(senderFacts.map((f) => f.text)).filter(Boolean),
        },
      },
    });
    console.log(`\nledgered as ${persisted.shortId}`);

    // CLI approval gate (MVP for F5): nothing sends without an explicit yes.
    if (!r.email) {
      console.log('no email found: draft stays awaiting_approval in the manual-lookup queue');
      // Not the same as "we looked and found nothing". A rejected candidate is
      // an address the machine found and refused because its local part names a
      // different person, which is exactly the case a human can resolve.
      for (const rej of r.rejectedEmails ?? []) {
        console.log(`  rejected candidate: ${rej.email} (${rej.source}) does not name this person`);
      }
      return;
    }
    if (!persisted.sendable) {
      console.log('draft failed grounding: not sendable; fix and re-run before any send');
      return;
    }

    // F9 hard rule: warn (and require override) when this person already has a thread.
    const prior = priorThreads(db, r.personId, persisted.draftId);
    if (prior.length > 0 && !process.argv.includes('--force')) {
      console.log(`REFUSED: ${r.target} already has a thread (${prior.map((t) => `${t.shortId} ${t.status}`).join(', ')}).`);
      console.log('Re-run with --force to override.');
      return;
    }

    // --to-self: first-live-test mode; the email goes to Aditya's own inbox
    // instead of the real recipient, everything else identical.
    const toSelf = process.argv.includes('--to-self');
    const toAddr = toSelf ? (process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu') : r.email.email;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nsend to ${toAddr}${toSelf ? ' (SELF-TEST, real recipient withheld)' : ''}? [y = send / s = skip / anything else = leave pending] `)).trim().toLowerCase();
    rl.close();

    if (answer === 'y' || answer === 'yes') {
      const decision = decide(db, persisted.draftId, 'send', 'cli');
      if (!decision.applied) {
        console.log(`already decided: ${decision.existing.action} via ${decision.existing.via} at ${decision.existing.createdAt}`);
        return;
      }
      const sender = makeSender();
      let sentThreadInfo: { sentId: string; threadId?: string } | null = null;
      try {
        const { sentId, threadId } = await sender.send({
          to: toAddr,
          from: process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
          subject: draft.subject,
          body: draft.body,
          draftShortId: persisted.shortId,
        });
        markSent(db, persisted.draftId, sentId, threadId);
        sentThreadInfo = { sentId, threadId };
        console.log(`SENT ${persisted.shortId} to ${toAddr} (${sentId})`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        markSendFailed(db, persisted.draftId, msg);
        console.log(`send failed (${msg}); ${persisted.shortId} stays approved, re-run send later`);
      }

      // OUTSIDE the try, deliberately, and swallowed: see the identical
      // comment in performApprovedSend (src/pipeline/loop.ts). This path
      // bypasses beginSendAttempt entirely, so recordSentThread must not
      // assume the invariants that give it its at-most-one-send property;
      // that is why it is ON CONFLICT DO NOTHING.
      if (sentThreadInfo) {
        try {
          recordSentThread(db, persisted.draftId, r.personId, sentThreadInfo.sentId, sentThreadInfo.threadId);
        } catch (e) {
          console.warn(
            `recordSentThread failed for ${persisted.shortId}: ${e instanceof Error ? e.message : 'unknown error'}`,
          );
        }
      }
    } else if (answer === 's' || answer === 'skip') {
      const rl2 = createInterface({ input: process.stdin, output: process.stdout });
      const reason = (await rl2.question('skip reason (optional): ')).trim();
      rl2.close();
      decide(db, persisted.draftId, 'skip', 'cli', reason || undefined);
      console.log(`${persisted.shortId} skipped`);
    } else {
      console.log(`${persisted.shortId} left awaiting_approval`);
    }
  }
}

// Only run main() when this file is the process entry point, not when it is
// imported for its exports (cmdReplies, RepliesSeams). Without this guard,
// importing cli.ts from a test runs the whole CLI as a side effect of module
// load: process.argv is the test runner's, so it falls through to the usage
// branch and calls process.exit(1) mid test run.
const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  main().catch((e) => {
    // .stack, not the object. A bare console.error on the error object
    // appends its own enumerable properties, which on a GaxiosError means
    // response.headers (From addresses under format=metadata) and config.url.
    // Verified on Node 24. Keeping the stack preserves what every other
    // command relies on for debugging and drops only the appended dump.
    console.error(e instanceof Error ? (e.stack ?? e.message) : 'unknown error');
    process.exit(1);
  });
}
