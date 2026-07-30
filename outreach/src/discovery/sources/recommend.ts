// Recommend source: expands seed papers via the Semantic Scholar
// recommendations API. Seeds are the union of papers already drafted against
// and papers named by the user's own key_paper self-ontology facts, so
// discovery also expands outward from the papers the research gaps came from,
// not only from where discovery has already been. Much of the digital
// olfaction literature publishes in Science, Nature, Chemical Senses and
// bioRxiv, which arXiv search cannot reach, so seeding this path from the
// key papers is the main route to that non-arXiv work.
import type { DB } from '../../db/db.js';
import type { Candidate, DiscoverySource } from '../types.js';
import { queryArxivFeed, sleep, type ArxivQueryOptions } from './arxivQuery.js';

// Semantic Scholar, not arXiv, but the same pacing and isolation apply.
export type RecommendOptions = ArxivQueryOptions;

interface S2Recommendation {
  paper?: { externalIds?: { ArXiv?: string }; title?: string; abstract?: string };
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

    let candidates: Candidate[];
    try {
      candidates = await queryArxivFeed('ti', [value], 'recommend', () => 'key_paper title lookup', {
        ...opts,
        maxResults: opts.maxResults ?? 5,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`key_paper title lookup failed for ${JSON.stringify(value)}: ${msg}`);
      continue;
    }

    const match = candidates.find((c) => normalizeTitle(c.title) === target);
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
  const maxResults = opts.maxResults ?? 10;
  const delayMs = opts.delayMs ?? 3000;

  return {
    name: 'recommend',
    async fetch(): Promise<Candidate[]> {
      const out: Candidate[] = [];
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        if (s === undefined) continue;
        if (i > 0) await sleep(delayMs);
        try {
          const url =
            `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:${encodeURIComponent(s)}` +
            `?fields=title,abstract,externalIds&limit=${maxResults}`;
          const res = await fetchFn(url);
          if (!res.ok) continue;
          const body = (await res.json()) as { recommendedPapers?: S2Recommendation[]; data?: S2Recommendation[] };
          for (const rec of body.recommendedPapers ?? body.data ?? []) {
            const arxivId = rec.paper?.externalIds?.ArXiv;
            if (!arxivId) continue; // the pipeline is arXiv only
            out.push({
              arxivId,
              title: rec.paper?.title ?? '',
              abstract: rec.paper?.abstract ?? undefined,
              discoveredVia: 'recommend',
              sourceDetail: `seed: ${s}`,
            });
          }
        } catch {
          continue;
        }
      }
      return out;
    },
  };
}
