// READ-ONLY report: nameMatches (D2, in src/pipeline/contacts.ts) was
// tightened to fix two verified bugs:
//   BUG A: EMAIL_RE swallowed a glued UI label ("Emaila.sajan" -> local part
//          included "Email").
//   BUG B: a first name ALONE used to be sufficient to match any person with
//          that first name, regardless of surname (nameMatches('daniel.lee',
//          'Daniel Kepple') was true; a real email was sent to the wrong
//          person because of it).
//
// This script re-runs the FIXED nameMatches against every already-persisted
// people.email row and lists the ones that no longer match. It changes
// NOTHING in the database: SELECT only, no --apply flag, no UPDATE/DELETE.
// Aditya needs this list to know which pending drafts to skip/re-verify
// before approving them, since an approved draft sends a real email.
//
// Usage:
//   npx tsx scripts/audit-name-match-tightening.ts [--db path/to/other.db]

import { openDb } from '../src/db/db.js';
import { nameMatches } from '../src/pipeline/contacts.js';

const args = process.argv.slice(2);
const dbFlagIdx = args.indexOf('--db');
const dbPath = dbFlagIdx >= 0 ? args[dbFlagIdx + 1] : 'data/outreach.db';
if (!dbPath) throw new Error('--db requires a path argument');

interface PersonRow {
  id: number;
  name: string;
  email: string;
  email_confidence: number | null;
  email_source: string | null;
}

interface DraftRow {
  short_id: string;
  status: string;
}

const db = openDb(dbPath);

const people = db
  .prepare(
    `SELECT id, name, email, email_confidence, email_source
     FROM people
     WHERE email IS NOT NULL AND email != ''
     ORDER BY id`,
  )
  .all() as PersonRow[];

const draftStmt = db.prepare(
  `SELECT short_id, status FROM drafts WHERE person_id = ? ORDER BY id`,
);

const rejected: { person: PersonRow; localPart: string; drafts: DraftRow[] }[] = [];

for (const person of people) {
  const localPart = person.email.split('@')[0] ?? '';
  if (nameMatches(localPart, person.name)) continue;
  const drafts = draftStmt.all(person.id) as DraftRow[];
  rejected.push({ person, localPart, drafts });
}

console.log('='.repeat(78));
console.log(`NAME-MATCH TIGHTENING AUDIT (read-only, no rows modified)`);
console.log(`  people with a stored email: ${people.length}`);
console.log(`  now rejected by the fixed nameMatches: ${rejected.length}`);
console.log('='.repeat(78));

if (rejected.length === 0) {
  console.log('\nNone. Every stored address still matches under the fixed rule.');
} else {
  console.log('\n--- REJECTED ROWS (fixed nameMatches now returns false) ---\n');
  for (const { person, localPart, drafts } of rejected) {
    console.log(`person_id=${person.id}  ${person.name}`);
    console.log(`  email:      ${person.email}  (local part checked: "${localPart}")`);
    console.log(`  confidence: ${person.email_confidence ?? 'n/a'}  source: ${person.email_source ?? 'n/a'}`);
    if (drafts.length === 0) {
      console.log('  drafts:     none');
    } else {
      for (const d of drafts) {
        const flag = d.status === 'awaiting_approval' ? '  <-- PENDING, do not approve without re-verifying' : '';
        console.log(`  draft ${d.short_id}: ${d.status}${flag}`);
      }
    }
    console.log('');
  }
}

console.log('Read-only script: no UPDATE or DELETE was run against the database.');
