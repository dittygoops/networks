// CLI: `outreach add <arxiv-id>` runs the full profile-mining pipeline for a
// paper's target author and prints contact + ontology + hooks. Run with:
//   npx tsx --env-file=.env src/cli.ts add <arxiv-id>
import { readFileSync } from 'node:fs';
import { openDb, saveSelfFacts, factRows } from './db/db.js';
import { processPaper } from './pipeline/orchestrate.js';
import { createTavilyClient } from './search/tavily.js';
import { createOpenRouterClient } from './llm/client.js';
import type { OntologyFact } from './pipeline/research.js';

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

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command !== 'add' || !arg) {
    console.error('usage: cli.ts add <arxiv-id>');
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
