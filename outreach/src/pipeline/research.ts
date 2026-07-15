// Person research: resolve a paper author to a canonical OpenAlex identity,
// then mine ontology facts. Spec: docs/spec-profile-mining.md (D3a, D4, D5b, D6a).
import { parse } from 'tldts';
import {
  classifyWebPage,
  type PageFetcher,
  type PaperContext,
  type SearchClient,
  type WebPage,
} from './contacts.js';
import { currentAffiliation, type OpenAlexAuthorRaw } from '../openalex/client.js';
import type { LLMClient } from '../llm/client.js';
import { buildExtractUser, buildSummaryUser, EXTRACT_SYSTEM, SUMMARY_SYSTEM } from '../llm/prompts.js';

// Normalized OpenAlex author candidate (shape the client produces from raw API).
export interface OpenAlexCandidate {
  id: string;
  displayName: string;
  concepts: string[];
  affiliations: string[];
  coauthors: string[]; // full names across the candidate's recent works
  workTitles: string[];
  externalIds: string[]; // arXiv ids / DOIs across works
  venues?: string[]; // work venues (optional: client.ts may not populate yet)
  homepageUrls?: string[]; // OpenAlex-listed homepage/host URLs (identity anchors)
}

// D6a fact schema. facet is one of the three ontology facets; tier is the D3
// usability tier after clamping; confidence is 0..1.
export interface OntologyFact {
  facet: 'academic' | 'trajectory' | 'interest';
  key: string;
  value: string;
  sourceUrl: string;
  confidence: number;
  tier: 'A' | 'B' | 'C';
}

// D-vocabulary (Data Model note): recommended keys per facet. Kept as a
// constant for reference; keys are freeform but should be drawn from here.
export const FACT_VOCABULARY = {
  academic: ['research_area', 'method', 'dataset', 'key_paper', 'venue', 'advisor', 'lab', 'collaborator'],
  trajectory: ['institution', 'company', 'role', 'location'],
  interest: ['hobby', 'side_project', 'oss_project', 'community', 'writing'],
} as const;

const OPENALEX_URL = (id: string): string => `https://openalex.org/${id}`;

// D6a: deterministic academic/trajectory facts from OpenAlex. Source class is
// `openalex` so every fact caps at tier A. No LLM involved.
export function factsFromOpenAlex(candidate: OpenAlexCandidate, raw: OpenAlexAuthorRaw): OntologyFact[] {
  const sourceUrl = OPENALEX_URL(candidate.id);
  const facts: OntologyFact[] = [];
  const push = (facet: OntologyFact['facet'], key: string, value: string, confidence: number) => {
    const v = value.trim();
    if (v) facts.push({ facet, key, value: v, sourceUrl, confidence, tier: 'A' });
  };

  const current = currentAffiliation(raw);
  if (current) push('trajectory', 'institution', current, 0.9);
  for (const aff of candidate.affiliations) {
    if (aff !== current) push('trajectory', 'institution', aff, 0.8);
  }
  for (const concept of candidate.concepts) push('academic', 'research_area', concept, 0.85);
  for (const venue of candidate.venues ?? []) push('academic', 'venue', venue, 0.8);
  for (const coauthor of candidate.coauthors) push('academic', 'collaborator', coauthor, 0.7);

  return facts;
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

// ---------------------------------------------------------------------------
// D4 personal-facet mining: Tavily pages -> cheap LLM -> clamped ontology facts.
// ---------------------------------------------------------------------------

export interface MineDeps {
  search: SearchClient;
  fetcher: PageFetcher;
  llm: LLMClient;
}

// D3 source class (deterministic, never LLM). Extends classifyWebPage with the
// path/host refinements the spec calls out (blog under a homepage, social host).
type SourceClass = 'openalex' | 'homepage' | 'directory' | 'github_profile' | 'blog' | 'social' | 'aggregator';

// D3 tier caps: a source class can never yield a fact above its cap.
const TIER_CAP: Record<SourceClass, 'A' | 'B' | 'C'> = {
  openalex: 'A',
  homepage: 'A',
  directory: 'A',
  github_profile: 'A',
  blog: 'B',
  social: 'C',
  aggregator: 'C',
};

const TIER_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

// Known social hosts (D3): dig-only, tier C.
const SOCIAL_HOSTS = [
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'mastodon.social',
  'bsky.app', 'threads.net', 'youtube.com', 'reddit.com', 'tiktok.com',
];

const D4_MAX_FETCH = 3; // budget: <= 3 fetches
const D4_MAX_EXTRACT_PAGES = 3; // budget: <= 3 extraction LLM calls (+1 summary => <= 4)

const hostname = (url: string): string => {
  try {
    return (parse(url).hostname ?? '').replace(/^www\./, '');
  } catch {
    return '';
  }
};

// Refine classifyWebPage into a D3 source class using URL path and host.
function pageSourceClass(page: WebPage, personName: string): SourceClass {
  const host = hostname(page.url);
  if (SOCIAL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return 'social';
  const base = classifyWebPage(page, personName); // homepage | directory | github_profile | aggregator
  if (base === 'homepage') {
    const path = (() => {
      try {
        return new URL(page.url).pathname;
      } catch {
        return '';
      }
    })();
    if (/\/(blog|posts|writing|notes)\//i.test(path)) return 'blog';
  }
  return base;
}

// Clamp a proposed tier up to (never below) the source cap. A is best, C worst.
function clampTier(proposed: string, cap: 'A' | 'B' | 'C'): 'A' | 'B' | 'C' {
  const capRank = TIER_RANK[cap] ?? 2;
  const proposedRank = TIER_RANK[proposed] ?? capRank;
  const rank = Math.max(proposedRank, capRank);
  return (['A', 'B', 'C'] as const)[rank] ?? cap;
}

interface RawFact {
  facet?: string;
  key?: string;
  value?: string;
  confidence?: number;
  proposedTier?: string;
}

const VALID_FACETS = new Set(['academic', 'trajectory', 'interest']);

function parseFacts(text: string): RawFact[] | null {
  // Tolerate a stray code fence around the JSON array.
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? (parsed as RawFact[]) : null;
  } catch {
    return null;
  }
}

// One extraction call with a single retry on parse failure (D6a). Returns null
// if both attempts fail so the caller can skip the page without crashing.
async function extractFactsFromPage(llm: LLMClient, personName: string, page: WebPage): Promise<RawFact[] | null> {
  const user = buildExtractUser(personName, page);
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.complete(EXTRACT_SYSTEM, user);
    const facts = parseFacts(raw);
    if (facts) return facts;
  }
  return null;
}

// D5b domain gate: a page contributes facts only if its registrable domain
// matches a known identity anchor (the resolved author's homepage / affiliation
// domains from OpenAlex). This is what stops a same-named homonym's page.
function buildDomainGate(author: OpenAlexCandidate): (page: WebPage) => boolean {
  // Match on the institution LABEL (registrable domain minus public suffix), not
  // the full registrable domain: an institution's marketing domain (tuwien.at)
  // and its academic domain (tuwien.ac.at) share the label "tuwien" but differ
  // as registrable domains. Homonyms at other institutions have a different
  // label and are still rejected.
  const allowed = new Set<string>();
  for (const url of author.homepageUrls ?? []) {
    const label = domainLabel(url);
    if (label) allowed.add(label);
  }
  return (page: WebPage) => {
    const label = domainLabel(page.url);
    return label != null && allowed.has(label);
  };
}

const domainLabel = (url: string): string | null => {
  try {
    return parse(url).domainWithoutSuffix || null;
  } catch {
    return null;
  }
};

// D4: mine personal-facet facts for a resolved author. Combines the deterministic
// OpenAlex facts with LLM-extracted, domain-gated, tier-clamped personal facts,
// then writes a short profile summary. Returns data (no SQLite persistence yet).
export async function minePerson(
  deps: MineDeps,
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
  paperContext: PaperContext,
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  void paperContext; // reserved (D5a context already applied at resolution time)
  const author = resolution.author;
  const name = author.displayName;
  const affiliation = currentAffiliation(raw) ?? '';

  // D4 personal pass: exactly three searches using the current affiliation.
  const queries = [
    `"${name}" ${affiliation} homepage`.replace(/\s+/g, ' ').trim(),
    `"${name}" blog OR talk`,
    `"${name}" github`,
  ];

  const seen = new Set<string>();
  const ranked: WebPage[] = [];
  for (const query of queries) {
    for (const page of await deps.search.search(query)) {
      if (seen.has(page.url)) continue;
      if (classifyWebPage(page, name) === 'aggregator') continue; // D1b: aggregators contribute nothing
      seen.add(page.url);
      ranked.push(page);
    }
  }

  // Fetch full content for the top non-aggregator pages (budget <= 3), carrying
  // the ranked title through so classification keeps its signal.
  const rankedByUrl = new Map(ranked.map((p) => [p.url, p]));
  const fetched = await deps.fetcher.fetch(ranked.slice(0, D4_MAX_FETCH).map((p) => p.url));
  const pages: WebPage[] = fetched.map((f) => ({
    url: f.url,
    title: rankedByUrl.get(f.url)?.title || f.title,
    content: f.content,
  }));

  const gate = buildDomainGate(author);
  const facts: OntologyFact[] = factsFromOpenAlex(author, raw);

  let extractCalls = 0;
  for (const page of pages) {
    if (!gate(page)) continue; // D5b: off-domain (homonym) pages are dropped
    if (extractCalls >= D4_MAX_EXTRACT_PAGES) break; // D4 budget
    extractCalls++;
    const cap = TIER_CAP[pageSourceClass(page, name)];
    const rawFacts = await extractFactsFromPage(deps.llm, name, page);
    if (!rawFacts) continue; // parse failed twice: skip this page
    for (const rf of rawFacts) {
      if (!rf.facet || !VALID_FACETS.has(rf.facet) || !rf.key || !rf.value) continue;
      const confidence = typeof rf.confidence === 'number' ? Math.max(0, Math.min(1, rf.confidence)) : 0.5;
      facts.push({
        facet: rf.facet as OntologyFact['facet'],
        key: rf.key,
        value: rf.value,
        sourceUrl: page.url,
        confidence,
        tier: clampTier(rf.proposedTier ?? 'C', cap),
      });
    }
  }

  // One more cheap call for the profile summary (D4: <= 4 LLM calls total).
  const profileSummary = (await deps.llm.complete(SUMMARY_SYSTEM, buildSummaryUser(name, facts))).trim();

  return { facts, profileSummary };
}
