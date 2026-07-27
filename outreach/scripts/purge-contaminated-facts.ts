// ONE-OFF cleanup script (Phase 2 of the fact-fabrication bug fix): re-applies
// the NEW gate rules (buildDomainGate's anchorAdmitsUrl, and a URL-only sibling
// of the new pageIsAboutPerson check) against every already-persisted person
// fact whose source_url is a scraped web page, and reports which facts would
// never have been admitted under the fixed gates.
//
// Two checks are re-run per fact, both derivable from data actually stored in
// the DB (no network calls, no LLM):
//
//   DOMAIN check: anchorAdmitsUrl(person.homepage_url, fact.source_url).
//     Only the FIRST OpenAlex identity anchor is persisted per person
//     (persist.ts stores homepageUrls[0]; mining may have used up to 4), so a
//     domain mismatch here is not perfect ground truth for "was this outside
//     every anchor used at mining time" -- a person who legitimately moved
//     institutions can trip it. It is still real, useful evidence: it is
//     exactly what catches the label-collapse bugs (cas.cn / ox.ac.uk).
//
//   PERSON check: urlSlugMatchesPerson(fact.source_url, person.name). Checks
//     whether any URL path segment carries the person's name (nameMatches).
//     This is the one signal that catches a same-domain colleague page (the
//     domain check alone cannot).
//
// A fact is flagged for removal if EITHER check fails. Both checks passing,
// or one passing and the other unevaluable (no stored anchor / no path
// segment), keeps the fact. A fact where BOTH checks are unevaluable is
// reported separately as "could not evaluate" and is NEVER auto-flagged for
// deletion: the instruction here is to report uncertainty, not guess.
//
// Every flagged fact is reported with WHICH check(s) failed, so a human
// reviewing the dry run can tell a double-confirmed case (domain AND person
// both fail, e.g. Hanbo Bi, Nicolai Plintz) from a single-signal case that
// may deserve a closer manual look (e.g. a real institution mover) before
// applying.
//
// Usage:
//   npx tsx scripts/purge-contaminated-facts.ts             # dry run (default)
//   npx tsx scripts/purge-contaminated-facts.ts --apply      # actually delete
//   npx tsx scripts/purge-contaminated-facts.ts --db path/to/other.db
//
// Never deletes drafts or revisions rows (append-only by project rule).
// Deletes intersections rows that reference a deleted fact (a hook built on a
// removed fact is invalid), via self_fact_id / person_fact_id foreign keys.

import { openDb, type DB } from '../src/db/db.js';
import { anchorAdmitsUrl, urlSlugMatchesPerson } from '../src/pipeline/research.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbFlagIdx = args.indexOf('--db');
const dbPath = dbFlagIdx >= 0 ? args[dbFlagIdx + 1] : 'data/outreach.db';
if (!dbPath) throw new Error('--db requires a path argument');

interface CandidateFactRow {
  id: number;
  person_id: number;
  person_name: string;
  homepage_url: string | null;
  facet: string;
  key: string;
  value: string;
  source_url: string;
}

type Verdict = 'pass' | 'fail' | 'unknown';

interface Evaluated {
  fact: CandidateFactRow;
  domain: Verdict;
  person: Verdict;
  decision: 'remove' | 'keep' | 'cannot_evaluate';
  reasons: string[];
}

function evaluate(fact: CandidateFactRow): Evaluated {
  const domain: Verdict = fact.homepage_url ? (anchorAdmitsUrl(fact.homepage_url, fact.source_url) ? 'pass' : 'fail') : 'unknown';
  const slugMatch = urlSlugMatchesPerson(fact.source_url, fact.person_name);
  const person: Verdict = slugMatch === null ? 'unknown' : slugMatch ? 'pass' : 'fail';

  const reasons: string[] = [];
  if (domain === 'fail') reasons.push(`domain: source is not on any anchor domain (stored anchor: ${fact.homepage_url})`);
  if (person === 'fail') reasons.push('person: no URL path segment matches the target name');

  let decision: Evaluated['decision'];
  if (domain === 'fail' || person === 'fail') decision = 'remove';
  else if (domain === 'unknown' && person === 'unknown') decision = 'cannot_evaluate';
  else decision = 'keep';

  return { fact, domain, person, decision, reasons };
}

function loadCandidates(db: DB): CandidateFactRow[] {
  return db
    .prepare(
      `SELECT f.id AS id, f.person_id AS person_id, p.name AS person_name, p.homepage_url AS homepage_url,
              f.facet AS facet, f.key AS key, f.value AS value, f.source_url AS source_url
       FROM ontology_facts f
       JOIN people p ON p.id = f.person_id
       WHERE f.person_id IS NOT NULL
         AND f.source_url NOT LIKE '%openalex.org%'
         AND f.source_url NOT LIKE '%arxiv.org%'
       ORDER BY p.name, f.source_url, f.id`,
    )
    .all() as CandidateFactRow[];
}

function printReport(evaluated: Evaluated[]): void {
  const byPerson = new Map<string, Evaluated[]>();
  for (const e of evaluated) {
    const key = `${e.fact.person_id}|${e.fact.person_name}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key)!.push(e);
  }

  const toRemove = evaluated.filter((e) => e.decision === 'remove');
  const cannotEval = evaluated.filter((e) => e.decision === 'cannot_evaluate');
  const kept = evaluated.filter((e) => e.decision === 'keep');

  console.log('='.repeat(78));
  console.log(`PURGE DRY RUN: ${evaluated.length} candidate facts evaluated (source_url is a scraped web page)`);
  console.log(`  would remove:      ${toRemove.length}`);
  console.log(`  keep:              ${kept.length}`);
  console.log(`  could not evaluate: ${cannotEval.length} (no stored anchor AND no name-bearing URL segment)`);
  console.log('='.repeat(78));

  console.log('\n--- FACTS THAT WOULD BE REMOVED, per person ---\n');
  for (const [key, facts] of byPerson) {
    const removals = facts.filter((f) => f.decision === 'remove');
    if (removals.length === 0) continue;
    const [, name] = key.split('|');
    console.log(`${name} (person_id=${facts[0]!.fact.person_id}): ${removals.length} fact(s) to remove`);
    const byUrl = new Map<string, Evaluated[]>();
    for (const r of removals) {
      if (!byUrl.has(r.fact.source_url)) byUrl.set(r.fact.source_url, []);
      byUrl.get(r.fact.source_url)!.push(r);
    }
    for (const [url, items] of byUrl) {
      console.log(`  ${url}`);
      console.log(`    reasons: ${items[0]!.reasons.join('; ')}`);
      for (const item of items) {
        console.log(`    fact#${item.fact.id} [${item.fact.facet}/${item.fact.key}] = ${item.fact.value}`);
      }
    }
    console.log('');
  }

  if (cannotEval.length > 0) {
    console.log('--- COULD NOT EVALUATE (no anchor domain stored, no name-bearing URL segment; NOT flagged, review manually) ---\n');
    for (const e of cannotEval) {
      console.log(`  fact#${e.fact.id} person=${e.fact.person_name} (id=${e.fact.person_id}) url=${e.fact.source_url} [${e.fact.facet}/${e.fact.key}] = ${e.fact.value}`);
    }
    console.log('');
  }
}

function applyDeletions(db: DB, toRemove: Evaluated[]): void {
  const factIds = toRemove.map((e) => e.fact.id);
  if (factIds.length === 0) {
    console.log('Nothing to delete.');
    return;
  }
  const tx = db.transaction((ids: number[]) => {
    const placeholders = ids.map(() => '?').join(',');
    const intersectionsDeleted = db
      .prepare(`DELETE FROM intersections WHERE self_fact_id IN (${placeholders}) OR person_fact_id IN (${placeholders})`)
      .run(...ids, ...ids);
    const factsDeleted = db.prepare(`DELETE FROM ontology_facts WHERE id IN (${placeholders})`).run(...ids);
    return { intersectionsDeleted: intersectionsDeleted.changes, factsDeleted: factsDeleted.changes };
  });
  const { intersectionsDeleted, factsDeleted } = tx(factIds);
  console.log(`Deleted ${factsDeleted} ontology_facts row(s) and ${intersectionsDeleted} intersections row(s) that referenced them.`);
  console.log('drafts and revisions were never touched (append-only by project rule).');
}

const db = openDb(dbPath);
const candidates = loadCandidates(db);
const evaluated = candidates.map(evaluate);
printReport(evaluated);

if (apply) {
  console.log('\n--apply passed: deleting flagged facts now.\n');
  applyDeletions(
    db,
    evaluated.filter((e) => e.decision === 'remove'),
  );
} else {
  console.log('\nDry run only (no --apply passed). Nothing was deleted.');
}
