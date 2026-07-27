import { describe, expect, it } from 'vitest';
import { discoverAll } from '../src/discovery/index.js';
import type { Candidate, DiscoverySource } from '../src/discovery/types.js';

const cand = (arxivId: string, via: Candidate['discoveredVia']): Candidate => ({
  arxivId,
  title: `Paper ${arxivId}`,
  discoveredVia: via,
  sourceDetail: 'detail',
});

const src = (name: Candidate['discoveredVia'], result: Candidate[] | Error): DiscoverySource => ({
  name,
  fetch: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

describe('discoverAll', () => {
  it('merges candidates from every source', async () => {
    const got = await discoverAll([
      src('saved_query', [cand('2601.00001', 'saved_query')]),
      src('author_watch', [cand('2601.00002', 'author_watch')]),
    ]);
    expect(got.candidates.map((c) => c.arxivId).sort()).toEqual(['2601.00001', '2601.00002']);
    expect(got.errors).toEqual([]);
  });

  it('dedups the same paper found by two sources, keeping the first', async () => {
    const got = await discoverAll([
      src('saved_query', [cand('2601.00001', 'saved_query')]),
      src('recommend', [cand('2601.00001', 'recommend')]),
    ]);
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]?.discoveredVia).toBe('saved_query');
  });

  it('isolates a throwing source and still returns the others', async () => {
    const got = await discoverAll([
      src('saved_query', new Error('arXiv 429')),
      src('author_watch', [cand('2601.00002', 'author_watch')]),
    ]);
    expect(got.candidates.map((c) => c.arxivId)).toEqual(['2601.00002']);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('saved_query');
    expect(got.errors[0]).toContain('arXiv 429');
  });

  it('returns empty results when every source fails', async () => {
    const got = await discoverAll([src('saved_query', new Error('down')), src('recommend', new Error('down'))]);
    expect(got.candidates).toEqual([]);
    expect(got.errors).toHaveLength(2);
  });
});
