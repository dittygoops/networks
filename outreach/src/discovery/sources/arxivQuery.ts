// Shared arXiv query machinery. The saved-query and author-watch sources differ
// only by search prefix and label, so the sequential-with-delay loop, the
// per-term isolation, and the Atom parsing live here once.
import { XMLParser } from 'fast-xml-parser';
import type { Candidate, DiscoveredVia } from '../types.js';

export interface ArxivQueryOptions {
  fetchFn?: typeof fetch;
  maxResults?: number;
  delayMs?: number;
}

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function parseSearchFeed(xml: string): Array<{ arxivId: string; title: string; abstract: string }> {
  const feed = parser.parse(xml)?.feed;
  return asArray<AtomEntry>(feed?.entry)
    .map((e) => {
      const idUrl = String(e.id ?? '');
      const rawId = idUrl.split('/abs/')[1];
      if (rawId === undefined) return null;
      const arxivId = rawId.replace(/v\d+$/, '');
      return { arxivId, title: clean(e.title), abstract: clean(e.summary) };
    })
    .filter((x): x is { arxivId: string; title: string; abstract: string } => x !== null);
}

// arXiv etiquette is roughly one request per three seconds, so terms run
// sequentially with a delay between them.
export const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function queryArxivFeed(
  prefix: 'all' | 'au',
  terms: string[],
  via: DiscoveredVia,
  label: (term: string) => string,
  opts: ArxivQueryOptions = {},
): Promise<Candidate[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxResults = opts.maxResults ?? 20;
  const delayMs = opts.delayMs ?? 3000;

  const out: Candidate[] = [];
  let i = 0;
  for (const term of terms) {
    if (i > 0) await sleep(delayMs);
    try {
      const url =
        `http://export.arxiv.org/api/query?search_query=${prefix}:${encodeURIComponent(`"${term}"`)}` +
        `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
      const res = await fetchFn(url);
      if (!res.ok) continue; // one bad term must not sink the rest
      for (const e of parseSearchFeed(await res.text())) {
        out.push({
          arxivId: e.arxivId,
          title: e.title,
          abstract: e.abstract,
          discoveredVia: via,
          sourceDetail: label(term),
        });
      }
    } catch {
      continue;
    } finally {
      i++;
    }
  }
  return out;
}
