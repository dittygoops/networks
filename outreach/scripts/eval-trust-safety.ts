// Trust & Safety eval sets for the hook/draft stage. Both are PROGRAMMATIC:
// no LLM judge, no labels, deterministic. They encode the two failure classes
// this project has actually shipped:
//
//   TS1 Hook groundedness  - a hook must trace to a real stored fact about THIS
//     person, with the value and source_url the draft claims. The system once
//     wrote reason: "matches gap term: olfactory embedding space" for a
//     wireless-sensor paper, and once attributed a dr-jan-delcker page to
//     Nicolai Plintz (57 facts purged from 4 people).
//
//   TS2 Identity plausibility - the address must plausibly belong to the
//     researcher. The system once sent a real cold email to
//     daniel.lee@dlapiper.com (a law firm) intending researcher Daniel Kepple.
//
// Usage: npx tsx scripts/eval-trust-safety.ts [--status awaiting_approval] [--json]
import { openDb } from '../src/db/db.js';
import { nameMatches } from '../src/pipeline/contacts.js';

type Hook = {
  selfFactId?: number; personFactId?: number;
  personValue?: string; personSourceUrl?: string; rationale?: string;
};
type Finding = { draft: string; person: string; set: 'TS1' | 'TS2'; severity: 'fail' | 'review'; detail: string };

const args = process.argv.slice(2);
const status = args.includes('--status') ? args[args.indexOf('--status') + 1]! : 'awaiting_approval';
const asJson = args.includes('--json');

const db = openDb('data/outreach.db');

const drafts = db.prepare(`
  SELECT dr.short_id, dr.person_id, dr.draft_input_json, dr.to_email,
         p.name, p.affiliation, p.email_source, p.homepage_url
  FROM drafts dr JOIN people p ON p.id = dr.person_id
  WHERE dr.status = ? ORDER BY dr.id`).all(status) as any[];

const factById = db.prepare('SELECT id, person_id, value, source_url FROM ontology_facts WHERE id = ?');

// Personal-provider domains are legitimate (one address here was supplied by
// Aditya directly), but they carry no institutional signal, so they are a
// review item rather than a pass or a fail.
const PERSONAL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'icloud.com', 'qq.com', '163.com']);

const findings: Finding[] = [];
let hooksChecked = 0;

for (const d of drafts) {
  const hooks: Hook[] = (() => {
    try { return JSON.parse(d.draft_input_json ?? '{}').hooks ?? []; } catch { return []; }
  })();

  // --- TS1: every hook traces to a real fact about THIS person ---
  if (hooks.length === 0) {
    findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'review', detail: 'draft carries no hooks in its input; cannot verify grounding' });
  }
  for (const h of hooks) {
    hooksChecked++;
    if (h.personFactId == null) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'fail', detail: `hook "${(h.rationale ?? '').slice(0, 50)}" has no personFactId` });
      continue;
    }
    const fact = factById.get(h.personFactId) as any;
    if (!fact) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'fail', detail: `personFactId ${h.personFactId} does not exist` });
      continue;
    }
    if (fact.person_id !== d.person_id) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'fail', detail: `fact ${h.personFactId} belongs to person ${fact.person_id}, not ${d.person_id} (cross-person attribution)` });
      continue;
    }
    if (h.personValue && fact.value && h.personValue.trim().toLowerCase() !== String(fact.value).trim().toLowerCase()) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'fail', detail: `claimed value "${h.personValue}" != stored "${fact.value}"` });
    }
    if (h.personSourceUrl && fact.source_url && h.personSourceUrl !== fact.source_url) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'fail', detail: `claimed source ${h.personSourceUrl} != stored ${fact.source_url}` });
    }
    if (!fact.source_url) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS1', severity: 'fail', detail: `fact ${h.personFactId} has no source_url (ungrounded)` });
    }
  }

  // --- TS2: the address plausibly belongs to this researcher ---
  const email: string | null = d.to_email ?? null;
  if (!email) {
    findings.push({ draft: d.short_id, person: d.name, set: 'TS2', severity: 'fail', detail: 'draft has no to_email' });
  } else {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    const local = email.split('@')[0]?.toLowerCase() ?? '';

    if (PERSONAL.has(domain)) {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS2', severity: 'review', detail: `personal-provider address (${domain}); no institutional signal, confirm by hand` });
    } else {
      // Reuse the PRODUCTION matcher rather than reimplementing it. A hand-rolled
      // version here required a 3+ character surname, which silently skipped the
      // two-character Chinese surnames (Yu, Xu, Li, Hu) that dominate this
      // population and produced six false failures. nameMatches already encodes
      // the corrected rule from the daniel.lee@dlapiper.com incident: a bare
      // first-name match is not enough, it needs a second independent signal.
      if (!nameMatches(local, String(d.name))) {
        findings.push({
          draft: d.short_id, person: d.name, set: 'TS2', severity: 'fail',
          detail: `${email} does not name-match "${d.name}" (dlapiper.com-shaped risk)`,
        });
      }
      // The glued-label class: extraction once produced "emaila.sajan@vu.nl" and
      // "emailqianhu@hkbu.edu.hk" by swallowing an adjacent "Email" label. The
      // regex was fixed (commit 20e42c7) but drafts written before that fix
      // still carry the malformed address, and sending to it would bounce.
      if (/^(e[-_.]?mail|contact|correspondence)/i.test(local) && local.length > 8) {
        findings.push({
          draft: d.short_id, person: d.name, set: 'TS2', severity: 'fail',
          detail: `${email} local part begins with a swallowed label (glued-label extraction bug); address is malformed`,
        });
      }
      // Separate, weaker signal: the address domain is unrelated to the stored
      // affiliation. Legitimate for movers and for co-author addresses, so it is
      // a review item, never a gate failure.
      const hay = `${d.affiliation ?? ''} ${d.homepage_url ?? ''}`.toLowerCase().replace(/[^a-z]/g, '');
      const root = domain.split('.').slice(0, -1).join('.').replace(/[^a-z]/g, '');
      if (d.affiliation && root.length >= 3 && !hay.includes(root)) {
        findings.push({
          draft: d.short_id, person: d.name, set: 'TS2', severity: 'review',
          detail: `domain ${domain} unrelated to stored affiliation "${d.affiliation}" (mover, co-author address, or homonym)`,
        });
      }
    }
  }
}

const fails = findings.filter((f) => f.severity === 'fail');
const reviews = findings.filter((f) => f.severity === 'review');

if (asJson) {
  console.log(JSON.stringify({ status, drafts: drafts.length, hooksChecked, findings }, null, 2));
} else {
  console.log(`\nTrust & Safety eval  (status='${status}')`);
  console.log(`  drafts checked : ${drafts.length}`);
  console.log(`  hooks checked  : ${hooksChecked}`);
  console.log(`  TS1 groundedness : ${fails.filter(f=>f.set==='TS1').length} fail, ${reviews.filter(f=>f.set==='TS1').length} review`);
  console.log(`  TS2 identity     : ${fails.filter(f=>f.set==='TS2').length} fail, ${reviews.filter(f=>f.set==='TS2').length} review`);
  console.log(`\n  HARD GATE (both sets must be 0 fail): ${fails.length === 0 ? 'PASS' : 'FAIL'}\n`);
  for (const f of [...fails, ...reviews]) {
    console.log(`  [${f.severity.toUpperCase().padEnd(6)}] ${f.set} ${f.draft.padEnd(4)} ${f.person.slice(0, 22).padEnd(22)} ${f.detail}`);
  }
  console.log('');
}
process.exit(fails.length === 0 ? 0 : 1);
