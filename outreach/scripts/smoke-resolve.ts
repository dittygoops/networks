// Live smoke: OpenAlex fetch + D5b resolution end-to-end.
import { fetchAuthorCandidates, currentAffiliation } from '../src/openalex/client.js';
import { resolveAuthor } from '../src/pipeline/research.js';
import type { PaperContext } from '../src/pipeline/contacts.js';

const name = process.argv[2] ?? 'Jonathan Barron';
const ctx: PaperContext = {
  coauthors: (process.argv[3] ?? 'Ben Mildenhall,Matthew Tancik,Ravi Ramamoorthi').split(','),
  arxivId: process.argv[4] ?? '2003.08934',
  areaTerms: ['computer vision'],
  affiliationHint: process.argv[5] ?? 'Google',
};

const fetched = await fetchAuthorCandidates(name);
console.log(`candidates: ${fetched.map((f) => f.candidate.displayName).join(' | ')}`);
const resolution = resolveAuthor(fetched.map((f) => f.candidate), name, ctx);
if (!resolution) {
  console.log('UNRESOLVED');
} else {
  const raw = fetched.find((f) => f.candidate.id === resolution.author.id)!.raw;
  console.log('RESOLVED:', resolution.author.displayName);
  console.log('  signals:', resolution.signals.join(', '));
  console.log('  current affiliation:', currentAffiliation(raw));
}
