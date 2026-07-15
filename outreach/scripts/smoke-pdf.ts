// Live smoke test for tier-1 extraction on a real arXiv paper.
// Usage: npx tsx scripts/smoke-pdf.ts <arxiv-id> "Target Author Name"
import { extractPaperEmailCandidates, selectEmail } from '../src/pipeline/contacts.js';
import { extractPdfText } from '../src/pipeline/pdf.js';

const arxivId = process.argv[2] ?? '2308.04079';
const name = process.argv[3] ?? 'Bernhard Kerbl';

const res = await fetch(`https://arxiv.org/pdf/${arxivId}`);
if (!res.ok) throw new Error(`arXiv fetch failed: ${res.status}`);
const text = await extractPdfText(new Uint8Array(await res.arrayBuffer()));
const candidates = extractPaperEmailCandidates(text);
console.log(JSON.stringify({ arxivId, name, candidates, selected: selectEmail(candidates, name) }, null, 2));
