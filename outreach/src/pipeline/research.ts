// Person research: resolve a paper author to a canonical OpenAlex identity,
// then mine ontology facts. Spec: docs/spec-profile-mining.md (D3a, D4, D5b, D6a).
import { parse } from 'tldts';
import {
  classifyWebPage,
  hostMatches,
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
  venues?: string[]; // work venues
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


// D-vocabulary: the recommended fact key set per facet, kept in one place so the
// spec, the extraction prompt, and the code agree. `key` and `value` are part of
// the D11 dedup identity, so consistent keys are what make dedup real. Unknown
// keys still pass through (snake-cased) rather than being dropped.
export const FACT_VOCABULARY: Record<OntologyFact['facet'], readonly string[]> = {
  academic: ['research_area', 'method', 'dataset', 'key_paper', 'venue', 'advisor', 'lab', 'collaborator', 'project'],
  trajectory: ['institution', 'company', 'role', 'location'],
  interest: ['hobby', 'side_project', 'oss_project', 'community', 'writing'],
};

// Common non-canonical spellings the LLM emits, mapped to the canonical key.
// Applied after snake-casing, so entries are the snake_case form of the variant.
const KEY_VARIANTS: Record<string, string> = {
  methods: 'method',
  projects: 'project',
  research_areas: 'research_area',
  research_interest: 'research_area',
  research_interests: 'research_area',
  datasets: 'dataset',
  venues: 'venue',
  advisors: 'advisor',
  labs: 'lab',
  collaborators: 'collaborator',
  hobbies: 'hobby',
  institutions: 'institution',
  companies: 'company',
  roles: 'role',
  locations: 'location',
};

const snakeCase = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// D6a: canonicalize a fact key to the D-vocabulary form. Lowercases and
// snake_cases, then maps known variants (e.g. `methods` -> `method`) to their
// canonical key. Unknown keys pass through snake-cased (never dropped).
export function normalizeKey(_facet: OntologyFact['facet'], key: string): string {
  const snake = snakeCase(key);
  return KEY_VARIANTS[snake] ?? snake;
}

const OPENALEX_URL = (id: string): string => `https://openalex.org/${id}`;

// Canonical form of a concept value for dedup: lowercased, parenthetical
// qualifiers stripped ("Rendering (computer graphics)" -> "rendering"), and
// whitespace collapsed. Used only as a dedup key; the first-seen display value
// is what gets stored.
const canonicalConcept = (value: string): string =>
  value.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();

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
  // Dedup near-identical concepts (case + parenthetical qualifiers) so the three
  // "graphics" variants do not create redundant research_area facts. First-seen
  // display value wins; later synonyms are skipped.
  const seenAreas = new Set<string>();
  for (const concept of candidate.concepts) {
    const canon = canonicalConcept(concept);
    if (!canon || seenAreas.has(canon)) continue;
    seenAreas.add(canon);
    push('academic', 'research_area', concept, 0.85);
  }
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
  // Paper co-authors reduced to {firstInitial, lastName}, dropping last names
  // under 4 chars (the "Ng" trap).
  const paperCoauthors = (ctx.coauthors ?? [])
    .map((n) => tokens(n))
    .filter((t) => t.length >= 2 && (t.at(-1) ?? '').length >= 4)
    .map((t) => ({ initial: t[0]![0]!, last: t.at(-1)! }));

  let best: { author: OpenAlexCandidate; signals: string[]; score: number } | null = null;

  for (const author of candidates) {
    if (!personNameMatches(author.displayName, targetName)) continue;
    const signals = corroborationSignals(author, ctx, paperCoauthors);
    const strong = signals.filter((s) => s === 'coauthor' || s === 'title' || s === 'arxiv').length;
    const weak = signals.filter((s) => s === 'concept' || s === 'affiliation').length;
    if (strong < 1 && weak < 2) continue;
    const score = strong * 10 + weak;
    if (!best || score > best.score) best = { author, signals, score };
  }

  return best ? { author: best.author, signals: best.signals } : null;
}

interface PaperCoauthor {
  initial: string;
  last: string;
}

function corroborationSignals(author: OpenAlexCandidate, ctx: PaperContext, paperCoauthors: PaperCoauthor[]): string[] {
  const signals: string[] = [];

  // A co-author matches only when its LAST token equals a paper co-author's
  // surname AND its first initial matches, so common surnames (Wang, Chen) or a
  // surname appearing as someone's first name do not spuriously corroborate.
  const authorCoauthors = author.coauthors.map(tokens).filter((t) => t.length >= 2);
  if (
    paperCoauthors.some((pc) =>
      authorCoauthors.some((t) => t.at(-1) === pc.last && t[0]![0] === pc.initial),
    )
  ) {
    signals.push('coauthor');
  }

  if (ctx.arxivId) {
    const wanted = ctx.arxivId.toLowerCase().replace(/^arxiv:/, '');
    if (author.externalIds.some((id) => id.toLowerCase().includes(wanted))) signals.push('arxiv');
  }

  if (ctx.title) {
    const wanted = normalize(ctx.title);
    // Require a substantial normalized title on both sides to avoid an
    // empty/near-empty work title matching everything.
    if (wanted.length >= 8) {
      const match = author.workTitles.some((t) => {
        const nt = normalize(t);
        return nt.length >= 8 && (nt.includes(wanted) || wanted.includes(nt));
      });
      if (match) signals.push('title');
    }
  }

  const areaTerms = (ctx.areaTerms ?? []).map((a) => a.toLowerCase());
  if (areaTerms.some((a) => author.concepts.some((c) => c.toLowerCase().includes(a) || a.includes(c.toLowerCase())))) {
    signals.push('concept');
  }

  if (ctx.affiliationHint && affiliationMatches(ctx.affiliationHint, author.affiliations)) {
    signals.push('affiliation');
  }

  return signals;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const STOPWORDS = new Set(['of', 'the', 'and', 'for', 'at', 'de', 'du', 'la', 'le']);

// Acronym of the significant words in an institution name: "Massachusetts
// Institute of Technology" -> "mit".
const acronym = (s: string): string =>
  tokens(s).filter((t) => !STOPWORDS.has(t)).map((t) => t[0]).join('');

// Affiliation match handles both full names and short acronyms (MIT, NYU, CMU),
// which the plain substring test misses.
function affiliationMatches(hint: string, affiliations: string[]): boolean {
  const hintLc = hint.toLowerCase();
  const hintTokens = tokens(hint).filter((t) => !STOPWORDS.has(t));
  const hintAcronym = hintTokens.length > 1 ? hintTokens.map((t) => t[0]).join('') : hintLc.replace(/[^a-z]/g, '');
  return affiliations.some((aff) => {
    const affLc = aff.toLowerCase();
    if (affLc.includes(hintLc)) return true;
    if (hintTokens.some((h) => h.length >= 4 && affLc.includes(h))) return true;
    return hintAcronym.length >= 2 && acronym(aff) === hintAcronym;
  });
}

// ---------------------------------------------------------------------------
// D4 personal-facet mining: Tavily pages -> cheap LLM -> clamped ontology facts.
// ---------------------------------------------------------------------------

export interface MineDeps {
  search: SearchClient;
  fetcher: PageFetcher;
  llm: LLMClient;
}

// D3 source class for a fetched web page (OpenAlex facts get tier A directly in
// factsFromOpenAlex and never flow through here). Refines classifyWebPage with
// the path/host distinctions the spec calls out (blog under a homepage, social).
type SourceClass = 'homepage' | 'directory' | 'github_profile' | 'blog' | 'social' | 'aggregator';

// D3 tier caps: a source class can never yield a fact above its cap.
const TIER_CAP: Record<SourceClass, 'A' | 'B' | 'C'> = {
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
  if (hostMatches(hostname(page.url), SOCIAL_HOSTS)) return 'social';
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

const VALID_FACETS = new Set<OntologyFact['facet']>(['academic', 'trajectory', 'interest']);

const isFacet = (v: unknown): v is OntologyFact['facet'] => VALID_FACETS.has(v as OntologyFact['facet']);

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
    try {
      const facts = parseFacts(await llm.complete(EXTRACT_SYSTEM, user));
      if (facts) return facts;
    } catch {
      // LLM call itself threw (network/5xx/non-JSON body): count as a failed
      // attempt and retry once, then skip the page.
    }
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
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const author = resolution.author;
  const name = author.displayName;

  // OpenAlex facts are computed first and unconditionally, so a failure in the
  // web/LLM personal pass still yields a useful ontology.
  const facts: OntologyFact[] = factsFromOpenAlex(author, raw);

  try {
    await minePersonalFacts(deps, author, raw, facts);
  } catch {
    // Tavily/LLM failure: keep the OpenAlex facts, skip personal facets.
  }

  let profileSummary = '';
  try {
    profileSummary = (await deps.llm.complete(SUMMARY_SYSTEM, buildSummaryUser(name, facts))).trim();
  } catch {
    // Summary is best-effort; an LLM failure must not lose the mined facts.
  }

  return { facts, profileSummary };
}

const MAX_FACTS_PER_PAGE = 25; // bound attacker/LLM-controlled fact volume per page
const MAX_VALUE_LEN = 300; // truncate over-long fact values

// D4/D5b/D6a: the domain-gated, tier-clamped personal-facet pass. Appends to
// `facts`. Throws only on a hard external failure (caller degrades).
async function minePersonalFacts(
  deps: MineDeps,
  author: OpenAlexCandidate,
  raw: OpenAlexAuthorRaw,
  facts: OntologyFact[],
): Promise<void> {
  const name = author.displayName;
  const affiliation = currentAffiliation(raw) ?? '';
  const queries = [
    `"${name}" ${affiliation} homepage`.replace(/\s+/g, ' ').trim(),
    `"${name}" blog OR talk`,
    `"${name}" github`,
  ];

  const seen = new Set<string>();
  const ranked: WebPage[] = [];
  for (const query of queries) {
    for (const page of await deps.search.search(query)) {
      if (seen.has(page.url) || safeClassify(page, name) === 'aggregator') continue;
      seen.add(page.url);
      ranked.push(page);
    }
  }

  const rankedByUrl = new Map(ranked.map((p) => [p.url, p]));
  const fetched = await deps.fetcher.fetch(ranked.slice(0, D4_MAX_FETCH).map((p) => p.url));
  const pages: WebPage[] = fetched.map((f) => ({
    url: f.url,
    title: rankedByUrl.get(f.url)?.title || f.title,
    content: f.content,
  }));

  const gate = buildDomainGate(author);
  let extractCalls = 0;
  for (const page of pages) {
    if (!gate(page)) continue; // D5b: off-domain (homonym) pages are dropped
    if (extractCalls >= D4_MAX_EXTRACT_PAGES) break; // D4 budget
    extractCalls++;
    const cap = TIER_CAP[pageSourceClass(page, name)];
    const rawFacts = await extractFactsFromPage(deps.llm, name, page);
    if (!rawFacts) continue; // parse failed twice: skip this page
    for (const rf of rawFacts.slice(0, MAX_FACTS_PER_PAGE)) {
      if (!isFacet(rf.facet) || !rf.key || !rf.value) continue;
      const confidence = Number.isFinite(rf.confidence) ? Math.max(0, Math.min(1, rf.confidence as number)) : 0.5;
      facts.push({
        facet: rf.facet,
        key: normalizeKey(rf.facet, String(rf.key).slice(0, MAX_VALUE_LEN)),
        value: String(rf.value).slice(0, MAX_VALUE_LEN),
        sourceUrl: page.url,
        confidence,
        tier: clampTier(rf.proposedTier ?? 'C', cap),
      });
    }
  }
}

// classifyWebPage does `new URL()`; a malformed result URL must not crash the run.
function safeClassify(page: WebPage, name: string): ReturnType<typeof classifyWebPage> | 'aggregator' {
  try {
    return classifyWebPage(page, name);
  } catch {
    return 'aggregator'; // treat unparseable URLs as non-contributing
  }
}
