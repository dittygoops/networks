// Recommend source: expands seed papers via the Semantic Scholar
// recommendations API. Seeds are the union of papers already drafted against
// and papers named by the user's own key_paper self-ontology facts, so
// discovery also expands outward from the papers the research gaps came from,
// not only from where discovery has already been. Much of the digital
// olfaction literature publishes in Science, Nature, Chemical Senses and
// bioRxiv, which arXiv search cannot reach, so seeding this path from the
// key papers is the main route to that non-arXiv work.
import type { DB } from '../../db/db.js';
import type { Candidate, DiscoverySource, SourceResult } from '../types.js';
import { queryArxivFeed, sleep, type ArxivQueryOptions } from './arxivQuery.js';

// D4. What is actually shared with arxivQuery.ts, and what deliberately is
// not. Shared: `sleep`, and the same one-request-per-few-seconds courtesy, and
// (since this file was corrected) the same failure contract, a SourceResult
// carrying errors rather than a swallowed catch. NOT shared: `arxivGate`, the
// process-wide chain that serialises requests to export.arxiv.org. Semantic
// Scholar is a different host with a different rate limit, and routing it
// through the arXiv gate would make the two sources contend for one another's
// pacing budget for no reason.
export interface RecommendOptions {
  fetchFn?: typeof fetch;
  // D5. Recommendations requested per seed paper. This is NOT the same unit as
  // ArxivQueryOptions.maxResults ("arXiv results per query"), which is why this
  // type is no longer an empty alias of it: the alias read as though the two
  // meant the same thing.
  maxResultsPerSeed?: number;
  delayMs?: number;
}

// D1. The verified shape of one element of `recommendedPapers`, checked live
// against GET /recommendations/v1/papers/forpaper/arXiv:2506.02373 on
// 2026-07-30. The endpoint returns
//   {"recommendedPapers": [ {paperId, title, abstract, externalIds} ]}
// so the paper objects ARE the array elements. There is no `paper` wrapper and
// no `data` key. The previous code read `rec.paper?.externalIds?.ArXiv`, which
// was undefined for every element, so `if (!arxivId) continue` fired every
// time and this source returned zero every day since it was written. Because
// it returned [] rather than failing, discoverAll recorded no error and the
// dead source was indistinguishable from a quiet day.
interface S2Paper {
  externalIds?: { ArXiv?: string } | null;
  title?: string;
  abstract?: string | null;
}

// Matches a modern arXiv id (YYMM.NNNNN, optionally "arXiv:" prefixed and
// versioned) or an old-style "archive/YYMMNNN" id such as cond-mat/0703470.
const ARXIV_ID_RE = /(?:arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})/;

// Extracts an arXiv id directly from free text, when the text already
// contains one. Returns null rather than guessing.
export function extractArxivId(text: string): string | null {
  const m = ARXIV_ID_RE.exec(text);
  if (!m) return null;
  const id = m[1];
  if (id === undefined) return null;
  return id.replace(/v\d+$/, '');
}

// Lowercase, strip punctuation, collapse whitespace, and drop a trailing
// parenthetical (e.g. "(Zanineli 2026)") so a fact's free-text title can be
// compared against a search result's title.
function normalizeTitle(s: string): string {
  return s
    .replace(/\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyPaperFactValues(db: DB): string[] {
  const rows = db
    .prepare(`SELECT value FROM ontology_facts WHERE person_id IS NULL AND key = 'key_paper'`)
    .all() as Array<{ value: string | null }>;
  return rows.map((r) => (r.value ?? '').trim()).filter(Boolean);
}

// Synchronous seed derivation: papers already drafted against, plus any
// key_paper self facts whose text already contains an arXiv id. No network.
export function deriveSeedPapers(db: DB): string[] {
  const draftRows = db
    .prepare('SELECT DISTINCT paper_arxiv_id AS id FROM drafts WHERE paper_arxiv_id IS NOT NULL')
    .all() as Array<{ id: string }>;
  const seeds = new Set<string>(draftRows.map((r) => r.id).filter(Boolean));

  for (const value of keyPaperFactValues(db)) {
    const id = extractArxivId(value);
    if (id) seeds.add(id);
  }
  return [...seeds];
}

// Async companion to deriveSeedPapers: resolves key_paper facts that are a
// bare title (no arXiv id in the text) by searching arXiv for a confident
// title match. Kept separate and async so deriveSeedPapers, and loadConfig
// which calls it, stay synchronous; callers that can afford the network round
// trip (the loop command) merge this in on top of deriveSeedPapers's result.
export async function resolveKeyPaperSeeds(db: DB, opts: ArxivQueryOptions = {}): Promise<string[]> {
  const unresolved = keyPaperFactValues(db).filter((v) => extractArxivId(v) === null);
  const out: string[] = [];

  for (const value of unresolved) {
    const target = normalizeTitle(value);
    if (!target) continue;

    let found: Candidate[];
    try {
      const res = await queryArxivFeed('ti', [value], 'recommend', () => 'key_paper title lookup', {
        ...opts,
        maxResults: opts.maxResults ?? 5,
      });
      // queryArxivFeed no longer throws for an upstream failure, so its errors
      // arrive here as data. Seed resolution is best effort and a failure to
      // resolve one key_paper title must not fail the run, so these are warned
      // and the fact is skipped, exactly as the old catch did.
      for (const err of res.errors) {
        console.warn(`key_paper title lookup failed for ${JSON.stringify(value)}: ${err}`);
      }
      found = res.candidates;
    } catch (e) {
      // Defensive only: nothing in queryArxivFeed throws for an expected
      // upstream failure any more. A throw here is a bug, not a 429.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`key_paper title lookup failed for ${JSON.stringify(value)}: ${msg}`);
      continue;
    }

    const match = found.find((c) => normalizeTitle(c.title) === target);
    if (match) {
      out.push(match.arxivId);
    } else {
      console.warn(
        `key_paper fact ${JSON.stringify(value)} did not confidently resolve to an arXiv id, no seed produced`,
      );
    }
  }
  return out;
}

export function createRecommendSource(seeds: string[], opts: RecommendOptions = {}): DiscoverySource {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxResultsPerSeed = opts.maxResultsPerSeed ?? 10;
  const delayMs = opts.delayMs ?? 3000;

  return {
    name: 'recommend',
    async fetch(): Promise<SourceResult> {
      const candidates: Candidate[] = [];
      const failures: string[] = [];

      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        if (s === undefined) continue;
        if (i > 0) await sleep(delayMs);
        try {
          const url =
            `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:${encodeURIComponent(s)}` +
            `?fields=title,abstract,externalIds&limit=${maxResultsPerSeed}`;
          const res = await fetchFn(url);
          if (!res.ok) {
            // Semantic Scholar rate limits aggressively without an API key, so
            // a 429 here is the expected failure mode, not an exotic one. It
            // used to hit a bare `continue` and vanish.
            failures.push(`${s}: HTTP ${res.status}`);
            console.warn(`Semantic Scholar recommendations failed for seed ${s}: HTTP ${res.status}`);
            continue;
          }
          const body = (await res.json()) as { recommendedPapers?: S2Paper[] | null };
          for (const rec of body.recommendedPapers ?? []) {
            const arxivId = rec.externalIds?.ArXiv;
            // The pipeline is arXiv only. Verified live: many recommendations
            // carry only a DOI, and dropping those is correct and is NOT a
            // failure, so nothing is pushed to `failures` here.
            if (!arxivId) continue;
            candidates.push({
              // seen_papers keys on an unversioned id, and parseSearchFeed
              // strips the suffix too, so the two paths agree on the key.
              arxivId: arxivId.replace(/v\d+$/, ''),
              title: rec.title ?? '',
              abstract: rec.abstract ?? undefined,
              discoveredVia: 'recommend',
              sourceDetail: `seed: ${s}`,
            });
          }
        } catch (e) {
          // Covers a network throw and a res.json() parse failure. Both used
          // to hit a bare `catch { continue; }`.
          const msg = e instanceof Error ? e.message : String(e);
          failures.push(`${s}: ${msg}`);
          console.warn(`Semantic Scholar recommendations failed for seed ${s}: ${msg}`);
        }
      }

      if (failures.length === 0) return { candidates, errors: [] };

      // Same contract as queryArxivFeed (D4): one headline per source, total
      // distinguished from partial in the first word, first failure quoted.
      const total = failures.length === seeds.length;
      const headline = total
        ? `all ${seeds.length} Semantic Scholar seeds failed (${failures[0] ?? 'unknown'})`
        : `${failures.length} of ${seeds.length} Semantic Scholar seeds failed (${failures[0] ?? 'unknown'})`;
      return { candidates, errors: [headline] };
    },
  };
}
