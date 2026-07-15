// Live smoke test for the full contact pipeline.
// Usage: npx tsx --env-file=.env scripts/smoke-contact.ts "Name" "Affiliation" [areaTerms] [paperText] [ageMonths]
import { extractContact } from '../src/pipeline/contacts.js';
import { createTavilyClient } from '../src/search/tavily.js';

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) throw new Error('TAVILY_API_KEY missing (run with --env-file=.env)');

const name = process.argv[2] ?? 'Jonathan Barron';
const affiliation = process.argv[3] ?? 'Google';
const areaTerms = (process.argv[4] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const paperText = process.argv[5] ?? null;
const paperAgeMonths = process.argv[6] ? Number(process.argv[6]) : 0;

const client = createTavilyClient(apiKey);
const result = await extractContact(
  { search: client, fetcher: client },
  { name },
  paperText,
  { paperAgeMonths, paperContext: { affiliationHint: affiliation, areaTerms } },
);
console.log(JSON.stringify({ name, affiliation, areaTerms, paperAgeMonths, result }, null, 2));
