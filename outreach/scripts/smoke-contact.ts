// Live smoke test for tier-2/3 contact extraction.
// Usage: node --env-file=.env --experimental-strip-types scripts/smoke-contact.ts "Name" "Affiliation"
import { extractContact } from '../src/pipeline/contacts.js';
import { createTavilyClient } from '../src/search/tavily.js';

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) throw new Error('TAVILY_API_KEY missing (run with --env-file=.env)');

const name = process.argv[2] ?? 'Jonathan Barron';
const affiliation = process.argv[3] ?? 'Google';

const result = await extractContact({ search: createTavilyClient(apiKey) }, { name, affiliation }, null);
console.log(JSON.stringify({ name, affiliation, result }, null, 2));
