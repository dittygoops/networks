// Live smoke: resolve an author via OpenAlex, then mine ontology facts.
// Requires OPENROUTER_API_KEY (and optionally MODEL_CHEAP) and a Tavily key
// (TAVILY_API_KEY) in the environment. Run by the repo owner:
//   OPENROUTER_API_KEY=... TAVILY_API_KEY=... npx tsx scripts/smoke-mine.ts "Bernhard Kerbl"
import { fetchAuthorCandidates, fetchIdentityAnchors } from '../src/openalex/client.js';
import { minePerson, resolveAuthor, type MineDeps } from '../src/pipeline/research.js';
import { createOpenRouterClient } from '../src/llm/client.js';
import { createTavilyClient } from '../src/search/tavily.js';
import type { PaperContext } from '../src/pipeline/contacts.js';

const name = process.argv[2] ?? 'Bernhard Kerbl';
const ctx: PaperContext = {
  coauthors: (process.argv[3] ?? 'Georgios Kopanas,Thomas Leimkuhler,George Drettakis').split(','),
  arxivId: process.argv[4] ?? '2308.04079',
  areaTerms: ['computer graphics'],
  affiliationHint: process.argv[5] ?? 'TU Wien',
};

const tavilyKey = process.env.TAVILY_API_KEY;
if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');

const fetched = await fetchAuthorCandidates(name);
const resolution = resolveAuthor(fetched.map((f) => f.candidate), name, ctx);
if (!resolution) {
  console.log('UNRESOLVED (identity unconfirmed): skipping academic facts.');
  process.exit(0);
}

const raw = fetched.find((f) => f.candidate.id === resolution.author.id)!.raw;
// Populate domain-gate anchors from the resolved author's institutions.
resolution.author.homepageUrls = await fetchIdentityAnchors(raw);
const tavily = createTavilyClient(tavilyKey);
const deps: MineDeps = { search: tavily, fetcher: tavily, llm: createOpenRouterClient() };

const { facts, profileSummary } = await minePerson(deps, resolution, raw);

console.log(`RESOLVED: ${resolution.author.displayName} (signals: ${resolution.signals.join(', ')})`);
console.log(`facts: ${facts.length}`);
for (const f of facts) {
  console.log(`  [${f.tier}] ${f.facet}/${f.key} = ${f.value}  (conf ${f.confidence}) <- ${f.sourceUrl}`);
}
console.log('\nprofile summary:\n' + profileSummary);
