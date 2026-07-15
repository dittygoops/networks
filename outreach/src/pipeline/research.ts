// Person research: resolve a paper author to a canonical OpenAlex identity,
// then mine ontology facts. Spec: docs/spec-profile-mining.md (D3a, D4, D5b).
import type { PaperContext } from './contacts.js';

// Normalized OpenAlex author candidate (shape the client produces from raw API).
export interface OpenAlexCandidate {
  id: string;
  displayName: string;
  concepts: string[];
  affiliations: string[];
  coauthors: string[]; // full names across the candidate's recent works
  workTitles: string[];
  externalIds: string[]; // arXiv ids / DOIs across works
}

export interface AuthorResolution {
  author: OpenAlexCandidate;
  signals: string[]; // which corroboration signals fired
}

const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);

// D5b name prefilter: candidate name carries the target's surname and first
// name (or first initial). Rejects collaborators surfaced by fuzzy search.
export function personNameMatches(candidateName: string, targetName: string): boolean {
  const t = tokens(targetName);
  const c = tokens(candidateName);
  if (t.length < 2 || c.length === 0) return false;
  const first = t[0]!;
  const last = t[t.length - 1]!;
  const lastMatch = c.includes(last);
  const firstMatch = c.includes(first) || c.some((tok) => tok.length === 1 && tok === first[0]);
  return lastMatch && firstMatch;
}

// D5b: resolve the paper author to one OpenAlex candidate. Accept the strongest
// candidate with >=1 strong signal or >=2 weak signals; else UNRESOLVED (null).
export function resolveAuthor(
  candidates: OpenAlexCandidate[],
  targetName: string,
  ctx: PaperContext,
): AuthorResolution | null {
  const paperCoauthorLastNames = (ctx.coauthors ?? [])
    .map((n) => tokens(n).at(-1) ?? '')
    .filter((ln) => ln.length >= 4); // avoid the "Ng" trap

  let best: { author: OpenAlexCandidate; signals: string[]; score: number } | null = null;

  for (const author of candidates) {
    if (!personNameMatches(author.displayName, targetName)) continue;
    const signals = corroborationSignals(author, ctx, paperCoauthorLastNames);
    const strong = signals.filter((s) => s === 'coauthor' || s === 'title' || s === 'arxiv').length;
    const weak = signals.filter((s) => s === 'concept' || s === 'affiliation').length;
    if (strong < 1 && weak < 2) continue;
    const score = strong * 10 + weak;
    if (!best || score > best.score) best = { author, signals, score };
  }

  return best ? { author: best.author, signals: best.signals } : null;
}

function corroborationSignals(author: OpenAlexCandidate, ctx: PaperContext, coauthorLastNames: string[]): string[] {
  const signals: string[] = [];

  const authorCoauthorTokens = new Set(author.coauthors.flatMap(tokens));
  if (coauthorLastNames.some((ln) => authorCoauthorTokens.has(ln))) signals.push('coauthor');

  if (ctx.arxivId) {
    const wanted = ctx.arxivId.toLowerCase().replace(/^arxiv:/, '');
    if (author.externalIds.some((id) => id.toLowerCase().includes(wanted))) signals.push('arxiv');
  }

  if (ctx.title) {
    const wanted = ctx.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (wanted && author.workTitles.some((t) => normalize(t).includes(wanted) || wanted.includes(normalize(t)))) {
      signals.push('title');
    }
  }

  const areaTerms = (ctx.areaTerms ?? []).map((a) => a.toLowerCase());
  if (areaTerms.some((a) => author.concepts.some((c) => c.toLowerCase().includes(a) || a.includes(c.toLowerCase())))) {
    signals.push('concept');
  }

  if (ctx.affiliationHint) {
    const hint = ctx.affiliationHint.toLowerCase();
    const hintTokens = tokens(ctx.affiliationHint);
    if (author.affiliations.some((aff) => hintTokens.some((h) => h.length >= 4 && aff.toLowerCase().includes(h)) || aff.toLowerCase().includes(hint))) {
      signals.push('affiliation');
    }
  }

  return signals;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
