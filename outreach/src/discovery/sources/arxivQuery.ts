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

// arXiv etiquette is roughly one request per three seconds. Sources run
// concurrently (see discoverAll), so pacing has to be process wide: a per call
// delay would let two arXiv backed sources burst against the same endpoint,
// which is how this project earned an IP level block before.
let arxivChain: Promise<void> = Promise.resolve();
let lastArxivRequestAt = 0;

function arxivGate(delayMs: number): Promise<void> {
  arxivChain = arxivChain.then(async () => {
    const wait = lastArxivRequestAt + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastArxivRequestAt = Date.now();
  });
  return arxivChain;
}

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
  const failures: string[] = [];

  for (const term of terms) {
    await arxivGate(delayMs);
    try {
      const url =
        `http://export.arxiv.org/api/query?search_query=${prefix}:${encodeURIComponent(`"${term}"`)}` +
        `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
      const res = await fetchFn(url);
      if (!res.ok) {
        // One bad term must not sink the rest, but it must not vanish either.
        failures.push(`${term}: HTTP ${res.status}`);
        console.warn(`arXiv query failed for ${JSON.stringify(term)}: HTTP ${res.status}`);
        continue;
      }
      for (const e of parseSearchFeed(await res.text())) {
        out.push({
          arxivId: e.arxivId,
          title: e.title,
          abstract: e.abstract,
          discoveredVia: via,
          sourceDetail: label(term),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${term}: ${msg}`);
      console.warn(`arXiv query failed for ${JSON.stringify(term)}: ${msg}`);
    }
  }

  // A total wipeout is indistinguishable from a quiet day if we stay silent,
  // and "seen 0" would read as "no new papers" when arXiv is actually refusing
  // us. Throwing here routes it into discoverAll's per source error list, which
  // reaches the run summary the approver is texted.
  if (terms.length > 0 && failures.length === terms.length) {
    throw new Error(`all ${terms.length} arXiv ${prefix} queries failed (${failures[0] ?? 'unknown'})`);
  }
  return out;
}
