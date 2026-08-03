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
import {
  buildExtractUser,
  buildPaperExtractUser,
  buildSummaryUser,
  EXTRACT_SYSTEM,
  PAPER_EXTRACT_SYSTEM,
  SUMMARY_SYSTEM,
} from '../llm/prompts.js';
import { occursInSource, personNameInText } from '../text/match.js';

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

// D6a fact schema. `value` is a crisp, canonical ENTITY (e.g. "nuScenes",
// "3D Gaussian Splatting", "chess") that intersections match on; `detail` is the
// specific supporting context (e.g. "used the mini split to measure recall") that
// the draft can cite. tier is the D3 usability tier; confidence is 0..1.
export interface OntologyFact {
  facet: 'academic' | 'trajectory' | 'interest';
  key: string;
  value: string;
  detail?: string;
  // Honesty marker: 'done' = actually built/ran/shipped; 'exploring' = a research
  // direction, gap, or proposal being considered but NOT yet done. The draft must
  // never claim an 'exploring' fact as completed work. Undefined = treat as done
  // (recipient/OpenAlex facts are published work).
  stance?: 'done' | 'exploring';
  sourceUrl: string;
  confidence: number;
  tier: 'A' | 'B' | 'C';
}


// D-vocabulary: the recommended fact key set per facet, kept in one place so the
// spec, the extraction prompt, and the code agree. `key` and `value` are part of
// the D11 dedup identity, so consistent keys are what make dedup real. Unknown
// keys still pass through (snake-cased) rather than being dropped.
export const FACT_VOCABULARY: Record<OntologyFact['facet'], readonly string[]> = {
  academic: ['research_area', 'method', 'dataset', 'tool', 'key_paper', 'venue', 'advisor', 'lab', 'collaborator', 'project'],
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

// Recalibrated against a real 25 paper run, which produced 24 mined profiles.
// The first cut used "80 collaborators OR 40 institutions" and flagged 8 of 25,
// including two people who are plainly a single researcher.
//
// The run showed INSTITUTION COUNT is the discriminating signal, not
// collaborator count. One human works at a handful of institutions over a
// career; a large collaborator list is just productivity. Observed:
//
//   Yitong Zhu     834 collab / 165 inst  AI + nuclear physics       merged
//   Zhuo Li        185 collab / 128 inst  AI + mathematics           merged
//   Yifan Liu      125 collab / 121 inst  biochem + nanotech         merged
//   Zhizhong Wang   88 collab /  74 inst  CS + internal medicine     merged
//   Viet Nguyen     75 collab /  49 inst  AI + data mining           merged
//   Yuejiang Liu   218 collab /   4 inst  AI/ML only                 ONE PERSON
//   Zhiying Du      80 collab /   8 inst  AI/CV only                 ONE PERSON
//
// So institutions alone flags a merge. Collaborators only corroborate, and
// only when institutions are also elevated, which keeps prolific-but-single
// researchers (4 or 8 institutions) out of the net. Blocking them is not a
// safe default: it silently drops people worth contacting.
//
// KNOWN AND ACCEPTED BLIND SPOT: these thresholds only catch a GROSS merge.
// A two- or three-person merge, which is the common case for a common Chinese
// or Korean name, produces roughly 10 institutions and is NOT flagged. That is
// deliberate, not an oversight: the calibration run above shows a threshold low
// enough to catch it would also flag Yuejiang Liu (4 institutions) and Zhiying
// Du (8 institutions), who are single real researchers, and silently dropping a
// real person is not a safe default either.
//
// This detector is therefore NOT the defense for that population. The defense is
// pageIsAboutPerson (below), which requires the surname as a complete token plus
// a nearby given name before any web page may contribute a fact. Until 2026-07,
// that gate was a no-op for short surnames, so BOTH defenses were degraded on
// the SAME population at the same time. If pageIsAboutPerson is ever loosened,
// these thresholds must be revisited in the same change.
export const COLLISION_MIN_INSTITUTIONS = 40;
export const COLLISION_MIN_COLLABORATORS = 200;
// Collaborators only count as evidence alongside this much institutional spread.
export const COLLISION_CORROBORATING_INSTITUTIONS = 20;

export interface IdentityCollisionVerdict {
  suspected: boolean;
  reason?: string;
}

// Pure function: counts distinct collaborator and institution fact values
// (case-insensitively) and flags a profile whose counts imply more than one
// person was merged into a single OpenAlex identity.
export function detectIdentityCollision(facts: OntologyFact[]): IdentityCollisionVerdict {
  const collaborators = new Set<string>();
  const institutions = new Set<string>();
  for (const f of facts) {
    if (f.facet === 'academic' && f.key === 'collaborator') collaborators.add(f.value.trim().toLowerCase());
    if (f.facet === 'trajectory' && f.key === 'institution') institutions.add(f.value.trim().toLowerCase());
  }

  const suspected =
    institutions.size >= COLLISION_MIN_INSTITUTIONS ||
    (collaborators.size >= COLLISION_MIN_COLLABORATORS &&
      institutions.size >= COLLISION_CORROBORATING_INSTITUTIONS);
  if (!suspected) return { suspected: false };

  return {
    suspected: true,
    reason: `identity collision suspected (${collaborators.size} collaborators, ${institutions.size} institutions)`,
  };
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
    return (parse(url).hostname ?? '').toLowerCase().replace(/^www\./, '');
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
  detail?: string;
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

// D5b domain gate: a page contributes facts only if it plausibly belongs to a
// known identity anchor (the resolved author's homepage / affiliation domains
// from OpenAlex). This is what stops a same-named homonym's page.
//
// Two admission rules, both needed:
//
// 1. EXACT HOSTNAME match (modulo a leading "www."). Any page on the identical
//    host as an anchor is the same site, regardless of how generic its label
//    is. This is what lets `cas.cn` (bare) still admit more pages on that
//    exact host without opening the door to sibling subdomains.
//
// 2. LABEL match (registrable domain minus public suffix), but ONLY when the
//    label is distinctive enough to identify a single institution. This is
//    what makes `tuwien.at` (marketing domain) admit `www.cg.tuwien.ac.at`
//    (academic domain): they share the label "tuwien", a name no other
//    organization uses, even though the registrable domains differ.
//
//    The label rule is deliberately NOT applied when the label is short/
//    generic, because for some institutions the label is shared across many
//    independently-run sub-institutions living on different SUBDOMAINS of the
//    same registrable domain, which hostname-equality (rule 1) does not
//    collapse but label-equality alone would:
//      - Chinese Academy of Sciences: label "cas" (english.qdio.cas.cn is the
//        Qingdao Institute of Oceanology; english.ie.cas.cn is the Institute
//        of Electronics. Same label, different institutes, different hosts.)
//      - Oxford: label "ox" (balliol.ox.ac.uk is Balliol College;
//        maths.ox.ac.uk is the Mathematics department. Same label, different
//        organizations, different hosts.)
//    MIN_DISTINCTIVE_LABEL_LENGTH=4 draws the line above these observed
//    collision-prone labels ("ox"=2, "cas"=3, and other umbrella-org labels
//    like "edu"=3, "ac"=2) and below real, unique institution names
//    ("tuwien"=6, "stanford"=8). Any label under the threshold falls back to
//    exact-hostname matching only (rule 1), which is the conservative,
//    never-fabricate-safe default: reject rather than guess.
export const MIN_DISTINCTIVE_LABEL_LENGTH = 4;

// The two-rule test itself, exported so the one-off purge script (Phase 2 data
// cleanup) can re-apply the exact same admission logic against DB-stored URLs
// without duplicating it.
export function anchorAdmitsUrl(anchorUrl: string, candidateUrl: string): boolean {
  const anchorHost = hostname(anchorUrl);
  const pageHost = hostname(candidateUrl);
  if (!anchorHost || !pageHost) return false;
  if (anchorHost === pageHost) return true; // rule 1: exact same site
  const anchorLabel = domainLabel(anchorUrl);
  const pageLabel = domainLabel(candidateUrl);
  return (
    anchorLabel != null &&
    pageLabel != null &&
    anchorLabel === pageLabel &&
    pageLabel.length >= MIN_DISTINCTIVE_LABEL_LENGTH
  ); // rule 2: distinctive shared institution name across TLDs
}

function buildDomainGate(author: OpenAlexCandidate): (page: WebPage) => boolean {
  const anchors = (author.homepageUrls ?? []).filter((url) => hostname(url));
  return (page: WebPage) => anchors.some((anchor) => anchorAdmitsUrl(anchor, page.url));
}

const domainLabel = (url: string): string | null => {
  try {
    return (parse(url).domainWithoutSuffix || '').toLowerCase() || null;
  } catch {
    return null;
  }
};

// Best-effort: an LLM failure must not lose the mined facts. Returns '' on
// failure; persistPerson converts that to NULL so it cannot erase a stored
// summary.
async function summarize(llm: LLMClient, name: string, facts: OntologyFact[]): Promise<string> {
  try {
    return (await llm.complete(SUMMARY_SYSTEM, buildSummaryUser(name, facts))).trim();
  } catch {
    return '';
  }
}

// The free half: OpenAlex-derived facts only. Makes no Tavily call, so it is
// safe to run before the hook gate on every candidate (see the hook-first
// gating spec). Kept separate from minePersonWeb so paid mining can be
// deferred until we know the person is worth emailing.
export async function minePersonFree(
  deps: { llm: LLMClient },
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const facts = splitHobbyFacts(factsFromOpenAlex(resolution.author, raw));
  return { facts, profileSummary: await summarize(deps.llm, resolution.author.displayName, facts) };
}

// The paid half: Tavily searches + extracts, domain-gated and tier-clamped.
// Takes the free facts and RETURNS THE COMBINED SET (callers persist the
// return value wholesale). A web failure degrades to the free facts.
export async function minePersonWeb(
  deps: MineDeps,
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
  freeFacts: OntologyFact[],
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const facts = [...freeFacts];
  try {
    await minePersonalFacts(deps, resolution.author, raw, facts);
  } catch {
    // Tavily/LLM failure: keep the free facts, skip personal facets.
  }
  const finalFacts = splitHobbyFacts(facts);
  return { facts: finalFacts, profileSummary: await summarize(deps.llm, resolution.author.displayName, finalFacts) };
}

// D4: mine personal-facet facts for a resolved author. Combines the deterministic
// OpenAlex facts with LLM-extracted, domain-gated, tier-clamped personal facts,
// then writes a short profile summary. Returns data (no SQLite persistence yet).
export async function minePerson(
  deps: MineDeps,
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const free = await minePersonFree(deps, resolution, raw);
  return minePersonWeb(deps, resolution, raw, free.facts);
}

// Split a hobby fact whose value is a list ("chess, hiking") into one fact per
// item, so an overlap matches a specific hobby rather than the whole list.
// Shared by the recipient pipeline (here) and the persona subsystem.
export function splitHobbyFacts(facts: OntologyFact[]): OntologyFact[] {
  const out: OntologyFact[] = [];
  for (const f of facts) {
    if (f.facet === 'interest' && f.key === 'hobby' && /[,;]|\band\b/i.test(f.value)) {
      for (const part of f.value.split(/[,;]|\band\b/i).map((s) => s.trim()).filter(Boolean)) {
        out.push({ ...f, value: part });
      }
    } else {
      out.push(f);
    }
  }
  return out;
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
  // No github query: the D5b domain gate admits only pages on the author's
  // institution domain, so a github.com result can never survive it. Matching
  // GitHub by username was tried and reverted: usernames are pseudonymous, so
  // it both missed real profiles and matched same-surname strangers. Re-add
  // this query only alongside an identity check that does not guess from a name.
  const queries = [
    `"${name}" ${affiliation} homepage`.replace(/\s+/g, ' ').trim(),
    `"${name}" blog OR talk`,
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
    if (!pageIsAboutPerson(page, name)) continue; // page is on-domain but about someone else
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
        detail: rf.detail ? String(rf.detail).slice(0, 400) : undefined,
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

// D5b page-identity gate: the domain gate only proves the page is on a known
// institution's site, not that the page is ABOUT the target person. A
// colleague's profile on the same site (a lab-mate's staff page, another
// student's directory entry) passes the domain gate cleanly, which is exactly
// how a stranger's facts got attributed to the wrong recipient in production
// (17 Arctic sea ice facts on one person, 10 facts about a colleague named
// Jan Delcker on another).
//
// The gate takes evidence from three IDENTITY surfaces, never from the page
// body: the leading heading line, the page title, and the URL path. Body text
// is excluded on purpose, because a directory or lab-listing page legitimately
// mentions many people in its body, so "the name appears somewhere on the
// page" is not evidence the page is about them.
//
// All three surfaces use personNameInText (src/text/match.ts), which requires
// the SURNAME as a complete token plus a nearby given name or initial. The
// previous implementation used contacts.ts's nameMatches, which is substring
// containment written for email local parts. Verified by execution, that made
// the gate a NO-OP for short surnames: nameMatches('publications', 'Wei Li')
// returned true, so any on-domain page passed for Li, He, Xu, Wu, Ye, or An.
//
// github_profile is still accepted on classification alone: a github.com page
// is personal by construction, and in practice the domain gate never admits
// one anyway (anchors are institutional).
export function pageIsAboutPerson(page: WebPage, personName: string): boolean {
  if (safeClassify(page, personName) === 'github_profile') return true;
  const heading = (page.content ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (personNameInText(heading, personName)) return true;
  if (personNameInText(page.title ?? '', personName)) return true;
  return urlSlugMatchesPerson(page.url, personName) === true;
}

// URL-only sibling of pageIsAboutPerson, used by pageIsAboutPerson itself and
// by the Phase 2 purge script, which has only a stored source_url and no
// re-fetchable title or content. Checks whether ANY path segment carries the
// target's name under the same strict rule (surname as a complete token, or a
// concatenated slug form like "wli" / "BernhardKerbl"). Every segment is
// checked, not just the last, so a sub-page of a person's own profile
// ("/people/wli/publications") still matches on its "wli" segment.
//
// Returns null (not false) when the URL has no path segment to judge (a bare
// domain root) or cannot be parsed, since that is "cannot evaluate", not
// "fails". Guessing either way would be fabrication, so the caller must treat
// null as its own case.
export function urlSlugMatchesPerson(url: string, personName: string): boolean | null {
  let segments: string[] = [];
  try {
    segments = new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (segments.length === 0) return null;
  return segments.some((seg) => personNameInText(seg, personName));
}

// ---------------------------------------------------------------------------
// Paper-fact extraction: let the discovered paper itself contribute facts
// about its author, so the paper that justified contacting someone can also
// justify what the draft says to them. The paper is a verified document with
// their name on it, so this is not fabrication, but it is also not as strong
// evidence as OpenAlex or a personal homepage: every fact caps at tier B
// (never A, see PAPER_TIER_CAP) so a real profile-derived tier A hook always
// outranks it (TIER_RANK in intersect.ts), and it can never be the ONLY
// possible hook source discovered when the profile already has one.
// ---------------------------------------------------------------------------

export interface PaperFactContext {
  arxivId: string;
  title: string;
  abstract: string;
  authorName: string;
}

// Never 'A': a single paper's title/abstract is not the institutional-grade
// evidence a mined profile fact is.
const PAPER_TIER_CAP: OntologyFact['tier'] = 'B';

// The canonical source_url stamped on every paper-derived fact. Also used
// (via isPaperSourceUrl) to recognize a paper-derived hook downstream.
export function paperSourceUrl(arxivId: string): string {
  return `https://arxiv.org/abs/${arxivId}`;
}

const PAPER_SOURCE_RE = /^https:\/\/arxiv\.org\/abs\//;

// True when a fact's (or hook's) source_url is a paper-fact source_url, i.e.
// it came from extractPaperFacts rather than OpenAlex or a mined web page.
export function isPaperSourceUrl(url: string | undefined): boolean {
  return typeof url === 'string' && PAPER_SOURCE_RE.test(url);
}

// Derive ontology facts about a paper's author FROM THE PAPER ITSELF (title +
// abstract only). Same JSON-parsing-with-retry robustness as
// extractFactsFromPage: never throws, returns [] when the model output cannot
// be parsed twice in a row, so an unattended run never crashes here. Every
// returned fact is stance 'done' (published work) and sourced at the paper's
// abs URL, regardless of what the model returned for those fields.
export async function extractPaperFacts(llm: LLMClient, ctx: PaperFactContext): Promise<OntologyFact[]> {
  const user = buildPaperExtractUser(ctx);
  // The untrusted span, exactly as the model saw it, is what every returned
  // fact must be grounded in.
  const sourceText = `${ctx.title}\n${ctx.abstract.slice(0, 4000)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = parseFacts(await llm.complete(PAPER_EXTRACT_SYSTEM, user));
      if (raw) return normalizePaperFacts(raw, paperSourceUrl(ctx.arxivId), sourceText, ctx.arxivId);
    } catch {
      // LLM call itself threw (network/5xx/non-JSON body): count as a failed
      // attempt and retry once, then give up quietly.
    }
  }
  return [];
}

// D2 injection gate. An arXiv title and abstract are ATTACKER-INFLUENCED text:
// anyone can post to arXiv, and this text is fed to an LLM whose output is
// persisted as an asserted fact ABOUT A NAMED REAL PERSON, then opens an
// irreversible cold email. The drafter's grounding check compares the email
// body to the hook, so it CONFIRMS an injected claim instead of catching it.
//
// The defense that does not trust the model: every fact value must occur,
// token-wise, in the title plus abstract we actually supplied. A value the
// paper does not contain cannot be a fact the paper supports, whether it came
// from an injection, a hallucination, or the model's own world knowledge.
// `detail` gets the same test, but failing it drops only the detail: the
// entity is still real, the model just embroidered its context.
//
// Drops are LOGGED, never silent. A silent drop would hide both a prompt
// regression (the model suddenly paraphrasing instead of quoting) and a live
// injection attempt, and there would be nothing to notice.
function normalizePaperFacts(
  raw: RawFact[],
  sourceUrl: string,
  sourceText: string,
  arxivId: string,
): OntologyFact[] {
  const facts: OntologyFact[] = [];
  const dropped: string[] = [];
  for (const rf of raw.slice(0, MAX_FACTS_PER_PAGE)) {
    if (!isFacet(rf.facet) || !rf.key || !rf.value) continue;
    const value = String(rf.value).slice(0, MAX_VALUE_LEN);
    if (!occursInSource(value, sourceText)) {
      dropped.push(value);
      continue;
    }
    const detail = rf.detail ? String(rf.detail).slice(0, 400) : undefined;
    const groundedDetail = detail && occursInSource(detail, sourceText) ? detail : undefined;
    if (detail && !groundedDetail) dropped.push(`(detail) ${detail}`);
    const confidence = Number.isFinite(rf.confidence) ? Math.max(0, Math.min(1, rf.confidence as number)) : 0.5;
    facts.push({
      facet: rf.facet,
      key: normalizeKey(rf.facet, String(rf.key).slice(0, MAX_VALUE_LEN)),
      value,
      detail: groundedDetail,
      stance: 'done', // the author's own published paper: this is completed work
      sourceUrl,
      confidence,
      tier: PAPER_TIER_CAP, // never 'A', see PAPER_TIER_CAP above
    });
  }
  if (dropped.length > 0) {
    console.warn(
      `[paper-facts] ${arxivId}: dropped ${dropped.length} ungrounded item(s): ${dropped.join(' | ')}`,
    );
  }
  return facts;
}
