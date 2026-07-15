// Debug view: show Tavily pages, their classification, and email candidates.
import { classifyWebPage, extractWebEmailCandidates, scoreCandidate } from '../src/pipeline/contacts.js';
import { createTavilyClient } from '../src/search/tavily.js';

const apiKey = process.env.TAVILY_API_KEY!;
const name = process.argv[2]!;
const aff = process.argv[3] ?? '';
const client = createTavilyClient(apiKey, 6);

for (const q of [`"${name}" ${aff} email`.trim(), `"${name}" github`]) {
  console.log(`\n### QUERY: ${q}`);
  const pages = await client.search(q);
  for (const p of pages) {
    console.log(`  [${classifyWebPage(p, name)}] ${p.url}`);
  }
  const cands = extractWebEmailCandidates(pages, name);
  console.log('  candidates:', cands.map((c) => `${c.email}(${c.source},score=${scoreCandidate(c, name)})`).join(', ') || 'none');
}
