// Live end-to-end for Step C: seed self ontology -> resolve+mine+persist a
// person -> compute intersections against self, print the ranked hooks.
import { readFileSync } from 'node:fs';
import { fetchAuthorCandidates, fetchIdentityAnchors } from '../src/openalex/client.js';
import { minePerson, resolveAuthor, type MineDeps } from '../src/pipeline/research.js';
import { createOpenRouterClient } from '../src/llm/client.js';
import { createTavilyClient } from '../src/search/tavily.js';
import { persistPerson } from '../src/pipeline/persist.js';
import { openDb, saveSelfFacts } from '../src/db/db.js';
import { computeIntersections } from '../src/pipeline/intersect.js';
import type { PaperContext } from '../src/pipeline/contacts.js';
import type { OntologyFact } from '../src/pipeline/research.js';

const name = process.argv[2] ?? 'Bernhard Kerbl';
const ctx: PaperContext = {
  coauthors: (process.argv[3] ?? 'Georgios Kopanas,George Drettakis').split(','),
  arxivId: process.argv[4] ?? '2308.04079',
  areaTerms: ['computer graphics'],
};

const db = openDb(':memory:');
const selfFacts = JSON.parse(readFileSync(new URL('../test/fixtures/self-ontology.json', import.meta.url), 'utf8')) as OntologyFact[];
saveSelfFacts(db, selfFacts);

const fetched = await fetchAuthorCandidates(name);
const resolution = resolveAuthor(fetched.map((f) => f.candidate), name, ctx);
if (!resolution) { console.log('UNRESOLVED'); process.exit(0); }
const raw = fetched.find((f) => f.candidate.id === resolution.author.id)!.raw;
resolution.author.homepageUrls = await fetchIdentityAnchors(raw);

const tavily = createTavilyClient(process.env.TAVILY_API_KEY!);
const llm = createOpenRouterClient();
const deps: MineDeps = { search: tavily, fetcher: tavily, llm };
const mineResult = await minePerson(deps, resolution, raw);
const personId = persistPerson(db, resolution, raw, mineResult);

const { ranked, noStrongHook } = await computeIntersections(db, { llm }, personId);
console.log(`\n${name}: ${ranked.length} intersections (noStrongHook=${noStrongHook})\n`);
for (const x of ranked) {
  console.log(`  [${x.tier}] ${x.strength.toFixed(2)}  ${x.rationale}`);
  console.log(`         mine: ${x.selfValue}`);
  console.log(`         them: ${x.personValue}`);
}
