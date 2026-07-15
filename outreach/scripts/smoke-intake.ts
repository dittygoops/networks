// Live smoke test for Task A intake: OpenAlex current-affiliation resolution
// feeding contact extraction end-to-end.
// Usage: npx tsx --env-file=.env scripts/smoke-intake.ts "Name" "PaperAffiliation" [coauthors] [arxivId] [paperText] [ageMonths]
import { resolveAndExtractContact } from '../src/pipeline/intake.js';
import { createTavilyClient } from '../src/search/tavily.js';
import type { PaperContext } from '../src/pipeline/contacts.js';

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) throw new Error('TAVILY_API_KEY missing (run with --env-file=.env)');

const name = process.argv[2] ?? 'Bernhard Kerbl';
const affiliation = process.argv[3] ?? 'INRIA';
const coauthors = (process.argv[4] ?? 'Georgios Kopanas,George Drettakis').split(',').map((s) => s.trim()).filter(Boolean);
const arxivId = process.argv[5] ?? undefined;
const paperText = process.argv[6] ?? null;
const paperAgeMonths = process.argv[7] ? Number(process.argv[7]) : 48;

const client = createTavilyClient(apiKey);
const paperContext: PaperContext = { affiliationHint: affiliation, coauthors, arxivId };

const result = await resolveAndExtractContact(
  { search: client, fetcher: client },
  { name, affiliation },
  paperContext,
  { paperText, paperAgeMonths },
);

console.log(JSON.stringify({ name, paperAffiliation: affiliation, coauthors, arxivId, paperAgeMonths, result }, null, 2));
