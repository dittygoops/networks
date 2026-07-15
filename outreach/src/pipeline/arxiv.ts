// arXiv intake: fetch paper metadata (Atom API), pick the target author, and
// build the PaperContext the rest of the pipeline consumes. Spec D3a/D4/D5.
import { XMLParser } from 'fast-xml-parser';
import type { PaperContext } from './contacts.js';
import type { FetchFn } from '../openalex/client.js';

const ARXIV_API = 'https://export.arxiv.org/api/query';

export interface ArxivPaper {
  arxivId: string;
  title: string;
  abstract: string;
  authors: string[];
  primaryCategory: string;
  affiliationHint: string | null;
}

// arXiv primary categories mapped to human research-area terms (for D5b concept
// corroboration and areaTerms). Unknown categories fall back to the raw code.
const CATEGORY_TERMS: Record<string, string> = {
  'cs.CV': 'computer vision',
  'cs.GR': 'computer graphics',
  'cs.RO': 'robotics',
  'cs.LG': 'machine learning',
  'cs.AI': 'artificial intelligence',
  'cs.CL': 'natural language processing',
  'cs.NE': 'neural networks',
  'eess.IV': 'image and video processing',
  'stat.ML': 'machine learning',
};

const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim();
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function parseArxivAtom(xml: string): ArxivPaper {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const feed = parser.parse(xml)?.feed;
  const entry = Array.isArray(feed?.entry) ? feed.entry[0] : feed?.entry;
  if (!entry) throw new Error('arXiv response has no entry (bad id?)');

  const idUrl: string = entry.id ?? '';
  const arxivId = (idUrl.split('/abs/')[1] ?? idUrl).replace(/v\d+$/, '');

  const authorEntries = asArray<{ name?: string; 'arxiv:affiliation'?: string }>(entry.author);
  const authors = authorEntries.map((a) => normalizeWs(String(a.name ?? ''))).filter(Boolean);
  const firstAff = authorEntries[0]?.['arxiv:affiliation'];
  const affiliationHint = firstAff ? normalizeWs(String(firstAff)) : null;

  const primaryCategory = entry['arxiv:primary_category']?.['@_term'] ?? asArray(entry.category)[0]?.['@_term'] ?? '';

  return {
    arxivId,
    title: normalizeWs(String(entry.title ?? '')),
    abstract: normalizeWs(String(entry.summary ?? '')),
    authors,
    primaryCategory,
    affiliationHint,
  };
}

export function selectTargetAuthor(paper: ArxivPaper): { name: string; index: number } {
  // Default: first author (usually the grad student, likelier to reply, D-intake).
  return { name: paper.authors[0] ?? '', index: 0 };
}

export function buildPaperContext(paper: ArxivPaper, target: { name: string; index: number }): PaperContext {
  const term = CATEGORY_TERMS[paper.primaryCategory] ?? paper.primaryCategory;
  return {
    arxivId: paper.arxivId,
    title: paper.title,
    affiliationHint: paper.affiliationHint,
    coauthors: paper.authors.filter((_, i) => i !== target.index),
    areaTerms: term ? [term] : [],
  };
}

export async function fetchArxivPaper(arxivId: string, opts: { fetchFn?: FetchFn } = {}): Promise<ArxivPaper> {
  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch(`${ARXIV_API}?id_list=${encodeURIComponent(arxivId)}`);
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status} for ${arxivId}`);
  return parseArxivAtom(await res.text());
}
