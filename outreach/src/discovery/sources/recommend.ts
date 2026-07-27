// Recommend source: expands seed papers via the Semantic Scholar
// recommendations API. Seeds auto derive from papers already drafted against.
import type { DB } from '../../db/db.js';
import type { Candidate, DiscoverySource } from '../types.js';
import { sleep, type ArxivQueryOptions } from './arxivQuery.js';

// Semantic Scholar, not arXiv, but the same pacing and isolation apply.
export type RecommendOptions = ArxivQueryOptions;

interface S2Recommendation {
  paper?: { externalIds?: { ArXiv?: string }; title?: string; abstract?: string };
}

export function deriveSeedPapers(db: DB): string[] {
  const rows = db
    .prepare('SELECT DISTINCT paper_arxiv_id AS id FROM drafts WHERE paper_arxiv_id IS NOT NULL')
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id).filter(Boolean);
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
