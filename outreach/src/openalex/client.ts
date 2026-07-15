// OpenAlex adapter (D3a): free, no key. Normalizes raw JSON into the shapes
// research.ts consumes, and fetches candidates for an author name.
import type { OpenAlexCandidate } from '../pipeline/research.js';

const BASE = 'https://api.openalex.org';
// Polite pool: OpenAlex asks for a contact in the User-Agent (D3a).
const UA = 'outreach-research (mailto:apgupta3@asu.edu)';

export interface OpenAlexAuthorRaw {
  id: string;
  display_name: string;
  x_concepts?: { display_name: string }[];
  affiliations?: { institution: { display_name: string; id?: string }; years: number[] }[];
}

export interface OpenAlexWorkRaw {
  title?: string | null;
  ids?: { doi?: string; [k: string]: string | undefined };
  primary_location?: { source?: { display_name?: string } | null } | null;
  authorships: { author: { id: string; display_name: string } }[];
}

const bareId = (id: string): string => id.split('/').pop() ?? id;

export function currentAffiliation(author: OpenAlexAuthorRaw): string | null {
  let best: { name: string; year: number } | null = null;
  for (const aff of author.affiliations ?? []) {
    const maxYear = Math.max(...(aff.years.length ? aff.years : [0]));
    if (!best || maxYear > best.year) best = { name: aff.institution.display_name, year: maxYear };
  }
  return best?.name ?? null;
}

export function normalizeAuthor(author: OpenAlexAuthorRaw, works: OpenAlexWorkRaw[]): OpenAlexCandidate {
  const id = bareId(author.id);
  const coauthors = new Set<string>();
  const venues = new Set<string>();
  const workTitles: string[] = [];
  const externalIds: string[] = [];
  for (const work of works) {
    if (work.title) workTitles.push(work.title);
    const venue = work.primary_location?.source?.display_name;
    if (venue) venues.add(venue);
    for (const key of ['doi', 'arxiv', 'pmid']) {
      const v = work.ids?.[key];
      if (v) externalIds.push(v);
    }
    for (const a of work.authorships) {
      if (bareId(a.author.id) !== id) coauthors.add(a.author.display_name);
    }
  }
  return {
    id,
    displayName: author.display_name,
    concepts: (author.x_concepts ?? []).map((c) => c.display_name),
    affiliations: (author.affiliations ?? []).map((a) => a.institution.display_name),
    coauthors: [...coauthors],
    workTitles,
    externalIds,
    venues: [...venues],
  };
}

// D5b domain-gate anchors: fetch homepage URLs for the author's institutions,
// so a page's domain can be matched against where the person actually works.
export async function fetchIdentityAnchors(
  author: OpenAlexAuthorRaw,
  opts: { fetchFn?: FetchFn; maxInstitutions?: number } = {},
): Promise<string[]> {
  const doFetch = opts.fetchFn ?? fetch;
  const headers = { 'User-Agent': UA };
  const ids: string[] = [];
  for (const aff of author.affiliations ?? []) {
    const id = aff.institution.id ? bareId(aff.institution.id) : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  const anchors: string[] = [];
  for (const id of ids.slice(0, opts.maxInstitutions ?? 4)) {
    const inst = (await (await doFetch(`${BASE}/institutions/${id}`, { headers })).json()) as { homepage_url?: string };
    if (inst.homepage_url) anchors.push(inst.homepage_url);
  }
  return anchors;
}

export type FetchFn = typeof fetch;

// Fetch name-matching author candidates with their recent works, ready for
// resolveAuthor. Injectable fetch so the pipeline is testable offline.
export async function fetchAuthorCandidates(
  name: string,
  opts: { fetchFn?: FetchFn; perAuthorWorks?: number; maxCandidates?: number } = {},
): Promise<{ raw: OpenAlexAuthorRaw; candidate: OpenAlexCandidate }[]> {
  const doFetch = opts.fetchFn ?? fetch;
  const maxCandidates = opts.maxCandidates ?? 5;
  const perWorks = opts.perAuthorWorks ?? 15;
  const headers = { 'User-Agent': UA };

  const search = new URL(`${BASE}/authors`);
  search.searchParams.set('search', name);
  search.searchParams.set('per_page', String(maxCandidates));
  const authors = (await (await doFetch(search, { headers })).json()) as { results?: OpenAlexAuthorRaw[] };

  const out: { raw: OpenAlexAuthorRaw; candidate: OpenAlexCandidate }[] = [];
  for (const author of authors.results ?? []) {
    const worksUrl = new URL(`${BASE}/works`);
    worksUrl.searchParams.set('filter', `author.id:${bareId(author.id)}`);
    worksUrl.searchParams.set('per_page', String(perWorks));
    const works = (await (await doFetch(worksUrl, { headers })).json()) as { results?: OpenAlexWorkRaw[] };
    out.push({ raw: author, candidate: normalizeAuthor(author, works.results ?? []) });
  }
  return out;
}
