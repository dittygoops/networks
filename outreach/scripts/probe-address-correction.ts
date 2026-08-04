// Live end-to-end probe for the address-correction path (plan Task 11).
//
// Everything in that feature is currently tests agreeing with code, and this
// project's own rules record that both can agree and still disagree with the
// world. This exercises the real channel, the real parser, the real listener
// daemon and the real ledger.
//
// SAFETY. The probe seeds a person whose name is obviously not a researcher and
// whose paper is obviously not a paper, so a rehearsal can never contact a real
// human. `--cleanup` removes every row it created.
//
// Usage:
//   npx tsx --env-file=.env scripts/probe-address-correction.ts --seed
//   npx tsx --env-file=.env scripts/probe-address-correction.ts --status
//   npx tsx --env-file=.env scripts/probe-address-correction.ts --cleanup
import { openDb, upsertPerson, getPerson } from '../src/db/db.js';
import { persistDraft, logEvent } from '../src/approval/ledger.js';
import { formatNeedsAddressMessage } from '../src/approval/channel.js';
import { createPhotonChannel, photonOptionsFromEnv } from '../src/approval/photonChannel.js';

const PROBE_NAME = 'ZZ Probe (address-correction test, not a real person)';
const PROBE_ARXIV = '9999.99999';
const db = openDb('data/outreach.db');
const mode = process.argv.find((a) => a.startsWith('--')) ?? '--status';

function probeRows() {
  const person = db.prepare('SELECT id, name, email, email_source FROM people WHERE name = ?').get(PROBE_NAME) as
    | { id: number; name: string; email: string | null; email_source: string | null }
    | undefined;
  const draft = person
    ? (db
        .prepare('SELECT id, short_id, status, to_email FROM drafts WHERE person_id = ? ORDER BY id DESC LIMIT 1')
        .get(person.id) as { id: number; short_id: string; status: string; to_email: string | null } | undefined)
    : undefined;
  return { person, draft };
}

if (mode === '--cleanup') {
  const { person, draft } = probeRows();
  if (!person) {
    console.log('nothing to clean up.');
    process.exit(0);
  }
  // Order matters: drafts.sendable_revision_id points AT revisions, and
  // seen_papers.draft_id points at drafts, so the references have to be broken
  // before the rows they point to can go.
  db.transaction(() => {
    if (draft) {
      db.prepare('UPDATE drafts SET sendable_revision_id = NULL WHERE id = ?').run(draft.id);
      db.prepare('UPDATE seen_papers SET draft_id = NULL WHERE draft_id = ?').run(draft.id);
      db.prepare('DELETE FROM draft_events WHERE draft_id = ?').run(draft.id);
      db.prepare('DELETE FROM decisions WHERE draft_id = ?').run(draft.id);
      db.prepare('DELETE FROM revisions WHERE draft_id = ?').run(draft.id);
      db.prepare('DELETE FROM drafts WHERE id = ?').run(draft.id);
    }
    db.prepare('DELETE FROM seen_papers WHERE arxiv_id = ?').run(PROBE_ARXIV);
    db.prepare('DELETE FROM intersections WHERE person_id = ?').run(person.id);
    db.prepare('DELETE FROM ontology_facts WHERE person_id = ?').run(person.id);
    db.prepare('DELETE FROM people WHERE id = ?').run(person.id);
  })();
  console.log(`cleaned up probe person ${person.id}${draft ? ` and draft ${draft.short_id}` : ''}.`);
  process.exit(0);
}

if (mode === '--status') {
  const { person, draft } = probeRows();
  if (!person) {
    console.log('no probe seeded. run with --seed');
    process.exit(0);
  }
  console.log(`person ${person.id}: email=${person.email ?? 'NULL'} source=${person.email_source ?? 'NULL'}`);
  if (draft) console.log(`draft ${draft.short_id} (id ${draft.id}): status=${draft.status} to_email=${draft.to_email ?? 'NULL'}`);
  const events = db
    .prepare('SELECT type, detail_json, created_at FROM draft_events WHERE draft_id = ? ORDER BY id')
    .all(draft?.id ?? -1) as { type: string; detail_json: string; created_at: string }[];
  for (const e of events) console.log(`  ${e.created_at}  ${e.type}  ${e.detail_json}`);
  process.exit(0);
}

// --seed
if (probeRows().person) {
  console.log('probe already seeded; run --cleanup first.');
  process.exit(1);
}

const personId = upsertPerson(db, { name: PROBE_NAME, affiliation: 'Nowhere University' });
const { draftId, shortId } = persistDraft(db, {
  personId,
  paperArxivId: PROBE_ARXIV,
  paperTitle: 'A Probe Paper That Does Not Exist',
  intent: 'probe',
  draftInput: { recipient: { name: PROBE_NAME, paperTitle: 'A Probe Paper That Does Not Exist' }, hooks: [] } as never,
  draft: { subject: 'probe subject (nothing will be sent)', body: 'probe body', grounded: true, wordCount: 2, notes: [] },
  contextJson: { probe: true },
});
logEvent(db, draftId, 'address_requested', { personId });

const text = formatNeedsAddressMessage({
  shortId,
  personName: PROBE_NAME,
  affiliation: 'Nowhere University',
  paperTitle: 'A Probe Paper That Does Not Exist',
  rejected: [{ email: 'someoneelse@nowhere.edu', source: 'pdf', reason: 'identity_mismatch' }],
});

console.log('--- message to be sent ---');
console.log(text);
console.log('--------------------------');
console.log('matches the tapback regex?', /^\s*(d\d+):/.test(text));

const channel = await createPhotonChannel(photonOptionsFromEnv());
await channel.notify(text);
await channel.close?.();
console.log(`\nsent. draft is ${shortId}, person ${personId}, to_email NULL.`);
console.log('watch with: npx tsx --env-file=.env scripts/probe-address-correction.ts --status');
process.exit(0);
