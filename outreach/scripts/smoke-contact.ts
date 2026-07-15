// Live smoke test for the full contact pipeline (paper age + web fetch).
// Usage: npx tsx --env-file=.env scripts/smoke-contact.ts "Name" "Affiliation" [paperText] [ageMonths]
import { extractContact } from '../src/pipeline/contacts.js';
import { createTavilyClient } from '../src/search/tavily.js';

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) throw new Error('TAVILY_API_KEY missing (run with --env-file=.env)');

const name = process.argv[2] ?? 'Jonathan Barron';
const affiliation = process.argv[3] ?? 'Google';
const paperText = process.argv[4] ?? null;
const paperAgeMonths = process.argv[5] ? Number(process.argv[5]) : 0;

const client = createTavilyClient(apiKey);
const result = await extractContact(
  { search: client, fetcher: client },
  { name, affiliation },
  paperText,
  { paperAgeMonths },
);
console.log(JSON.stringify({ name, affiliation, paperAgeMonths, result }, null, 2));
