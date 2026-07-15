// Live end-to-end: resolve -> mine -> persist -> read back from SQLite.
import { fetchAuthorCandidates, fetchIdentityAnchors } from '../src/openalex/client.js';
import { minePerson, resolveAuthor, type MineDeps } from '../src/pipeline/research.js';
import { createOpenRouterClient } from '../src/llm/client.js';
import { createTavilyClient } from '../src/search/tavily.js';
import { persistPerson } from '../src/pipeline/persist.js';
import { openDb, getFacts, getPerson } from '../src/db/db.js';
import type { PaperContext } from '../src/pipeline/contacts.js';

const name = process.argv[2] ?? 'Bernhard Kerbl';
const ctx: PaperContext = {
  coauthors: (process.argv[3] ?? 'Georgios Kopanas,George Drettakis').split(','),
  arxivId: process.argv[4] ?? '2308.04079',
  areaTerms: ['computer graphics'],
};

const fetched = await fetchAuthorCandidates(name);
const resolution = resolveAuthor(fetched.map((f) => f.candidate), name, ctx);
if (!resolution) { console.log('UNRESOLVED'); process.exit(0); }

const raw = fetched.find((f) => f.candidate.id === resolution.author.id)!.raw;
resolution.author.homepageUrls = await fetchIdentityAnchors(raw);
const tavily = createTavilyClient(process.env.TAVILY_API_KEY!);
const deps: MineDeps = { search: tavily, fetcher: tavily, llm: createOpenRouterClient() };
const mineResult = await minePerson(deps, resolution, raw);

const db = openDb('data/outreach.db');
const id = persistPerson(db, resolution, raw, mineResult);

// Read back from the database to prove the round trip.
const person = getPerson(db, id);
const facts = getFacts(db, id);
console.log(`persisted person #${id}: ${person?.name} @ ${person?.affiliation} (openalex ${person?.openalex_id})`);
console.log(`facts in db: ${facts.length}`);
console.log('by tier:', JSON.stringify(facts.reduce((a: Record<string, number>, f) => ((a[f.tier] = (a[f.tier] ?? 0) + 1), a), {})));
console.log('sample:', facts.slice(0, 3).map((f) => `[${f.tier}] ${f.facet}/${f.key}=${f.value}`).join(' | '));
