// CLI: `outreach add <arxiv-id>` runs the full profile-mining pipeline for a
// paper's target author and prints contact + ontology + hooks. Run with:
//   npx tsx --env-file=.env src/cli.ts add <arxiv-id>
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { openDb, saveSelfFacts, replaceSelfFacts, factRows, getPerson } from './db/db.js';
import { processPaper } from './pipeline/orchestrate.js';
import { generateDraft } from './pipeline/draft.js';
import { buildSelfOntology } from './pipeline/persona.js';
import { extractPdfText } from './pipeline/pdf.js';
import { createTavilyClient } from './search/tavily.js';
import { createOpenRouterClient } from './llm/client.js';
import type { OntologyFact } from './pipeline/research.js';

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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'persona') return runPersona(rest);
  if (command === 'self') {
    showSelfFacts(openDb(DB_PATH));
    return;
  }

  const arg = rest[0];
  if (command !== 'add' || !arg) {
    console.error('usage: cli.ts add <arxiv-id>  |  cli.ts persona <doc-path...> [--answers <file.json>]');
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
  if (r.resolved && r.hooks.length > 0 && r.personId != null) {
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

    console.log(`\n--- DRAFT (review only, not sent) ---`);
    console.log(`Subject: ${draft.subject}`);
    console.log(`\n${draft.body}`);
    console.log(`\n(${draft.wordCount} words${draft.grounded ? '' : ', CHECK: may be ungrounded'})`);
    if (draft.notes.length) console.log(`draft notes: ${draft.notes.join('; ')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
