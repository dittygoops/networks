// Delivers the draft messages that were created but never texted.
//
// Why they exist: max_messages_per_run caps how many drafts a batch texts (10).
// Drafts past the cap are persisted at 'awaiting_approval' while their
// seen_papers row is parked at 'queued_for_message'. runLoop drains that queue
// on the next run, but only up to the same cap, so when the batch produces more
// than 10 a day the backlog never clears and the drafts are invisible: they
// exist in the ledger and were never sent to a phone.
//
// This flushes the WHOLE backlog with no cap, and does NO discovery, so it
// spends zero Tavily credits and creates no new drafts.
//
// It sends iMessages only. It never sends an email. Every message goes through
// the same sendDraftMessage used by the loop, so the text is byte-identical and
// tapback approval works on these exactly as on any other draft.
//
// Usage: npx tsx --env-file=.env scripts/flush-queued-drafts.ts [--dry-run]
import { openDb, getPerson } from '../src/db/db.js';
import { getQueued, setStatus } from '../src/discovery/seenLedger.js';
import { createPhotonChannel, photonOptionsFromEnv } from '../src/approval/photonChannel.js';

const dryRun = process.argv.includes('--dry-run');
const db = openDb('data/outreach.db');

// No cap: the whole point is that the cap is what stranded these.
const queued = getQueued(db, 10_000);

type Row = { arxivId: string; shortId: string; subject: string; body: string; to: string; personName: string };
const ready: Row[] = [];
const skipped: string[] = [];

for (const q of queued) {
  const row = db
    .prepare(
      `SELECT d.id AS draftId, d.short_id AS shortId, d.status AS status, d.person_id AS personId,
              r.subject AS subject, r.body AS body
         FROM seen_papers s
         JOIN drafts d ON d.id = s.draft_id
         LEFT JOIN revisions r ON r.id = d.sendable_revision_id
        WHERE s.arxiv_id = ?`,
    )
    .get(q.arxivId) as
    | { draftId: number; shortId: string; status: string; personId: number; subject: string | null; body: string | null }
    | undefined;

  // Only ever re-deliver a draft still awaiting a decision. A draft already
  // sent, skipped, or approved must never be texted again: re-presenting a
  // decided draft invites a second approval, and a second send of a cold email
  // cannot be taken back.
  if (!row) { skipped.push(`${q.arxivId}: no draft row`); continue; }
  if (row.status !== 'awaiting_approval') { skipped.push(`${row.shortId}: status is ${row.status}`); continue; }
  if (!row.body) { skipped.push(`${row.shortId}: no grounded revision`); continue; }
  const person = getPerson(db, row.personId);
  if (!person?.email) { skipped.push(`${row.shortId}: no email on record`); continue; }

  ready.push({
    arxivId: q.arxivId, shortId: row.shortId,
    subject: row.subject ?? '', body: row.body,
    to: person.email, personName: person.name,
  });
}

console.log(`queued rows: ${queued.length}  deliverable: ${ready.length}  skipped: ${skipped.length}`);
for (const s of skipped) console.log(`  skip ${s}`);
for (const r of ready) console.log(`  send ${r.shortId} -> ${r.personName} <${r.to}>`);

if (dryRun) {
  console.log('\ndry run: nothing sent, no status changed.');
  process.exit(0);
}
if (ready.length === 0) {
  console.log('\nnothing to flush.');
  process.exit(0);
}

const channel = await createPhotonChannel(photonOptionsFromEnv());
let sent = 0;
for (const r of ready) {
  try {
    await channel.sendDraftMessage(r);
    // Only mark delivered AFTER the send resolves. On failure the row stays at
    // queued_for_message so the loop's own flush retries it later.
    setStatus(db, r.arxivId, 'messaged');
    sent++;
    console.log(`sent ${r.shortId}`);
  } catch (e) {
    console.error(`FAILED ${r.shortId}: ${String(e)}`);
  }
}
await channel.close?.();
console.log(`\nflushed ${sent}/${ready.length}.`);
process.exit(0);
