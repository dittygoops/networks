// Counts REAL Tavily calls made by one processPaper run, per phase.
//
// Why this exists: the Tavily /usage endpoint is not real-time (verified
// 2026-08-02: a live search returning real results left plan_usage unchanged
// for minutes), so a before/after read around a run measures nothing. This
// counts the calls directly at the client seam instead.
//
// Reads nothing from the billing API and writes nothing to the ledger.
// Usage: npx tsx --env-file=.env scripts/probe-paid-calls.ts <arxivId>
import { openDb } from '../src/db/db.js';
import { processPaper } from '../src/pipeline/orchestrate.js';
import { createTavilyClient } from '../src/search/tavily.js';
import { createOpenRouterClient } from '../src/llm/client.js';

const arxivId = process.argv[2];
if (!arxivId) throw new Error('usage: probe-paid-calls.ts <arxivId>');

const key = process.env.TAVILY_API_KEY;
if (!key) throw new Error('TAVILY_API_KEY is not set (use --env-file=.env)');

const real = createTavilyClient(key);
const log: { kind: 'search' | 'fetch'; detail: string; at: number }[] = [];
const t0 = Date.now();

const counting = {
  async search(query: string) {
    log.push({ kind: 'search', detail: query, at: Date.now() - t0 });
    return real.search(query);
  },
  async fetch(urls: string[]) {
    log.push({ kind: 'fetch', detail: `${urls.length} url(s)`, at: Date.now() - t0 });
    return real.fetch(urls);
  },
};

const db = openDb('data/outreach.db');
const r = await processPaper({ db, search: counting, fetcher: counting, llm: createOpenRouterClient() }, arxivId);

console.log(`\nprocessPaper(${arxivId})`);
console.log(`  target        : ${r.target}`);
console.log(`  resolved      : ${r.resolved}`);
console.log(`  hooks         : ${r.hooks.length}${r.noStrongHook ? ' (noStrongHook)' : ''}`);
console.log(`  email         : ${r.email ? `${r.email.email} (${r.email.source})` : 'none'}`);
console.log(`  facts         : ${r.factCount}`);
console.log(`\n  PAID CALLS: ${log.length}  (${log.filter(l => l.kind === 'search').length} search, ${log.filter(l => l.kind === 'fetch').length} fetch)`);
for (const l of log) console.log(`    +${String(l.at).padStart(6)}ms  ${l.kind.padEnd(6)} ${l.detail.slice(0, 76)}`);
if (log.length === 0) {
  console.log('    (none)');
  console.log('\n  A hook-passing paper making ZERO paid calls means minePersonWeb did not');
  console.log('  run or returned before searching. That would defeat the enrichment step.');
}
console.log('');
