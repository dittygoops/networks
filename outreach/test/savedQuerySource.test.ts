import { describe, expect, it, vi } from 'vitest';
import { createSavedQuerySource } from '../src/discovery/sources/savedQuery.js';
import { parseSearchFeed } from '../src/discovery/sources/arxivQuery.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <title>Olfactory Embeddings for Sensor Arrays</title>
    <summary>We map sensor readings into an odor space.</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.00002v2</id>
    <title>Another Paper</title>
    <summary>Unrelated.</summary>
  </entry>
</feed>`;

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

describe('savedQuery source', () => {
  it('parses entries into candidates tagged with the originating query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(FEED, { status: 200 }));
    const src = createSavedQuerySource(['olfactory embedding'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('saved_query');
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({
      arxivId: '2601.00001',
      title: 'Olfactory Embeddings for Sensor Arrays',
      discoveredVia: 'saved_query',
      sourceDetail: 'query: olfactory embedding',
    });
    expect(got[0]!.abstract).toContain('odor space');
  });

  it('handles an empty feed without throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(EMPTY, { status: 200 }));
    const src = createSavedQuerySource(['nothing'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });

  it('skips a query that errors and still returns results from the others', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(FEED, { status: 200 }));
    const src = createSavedQuerySource(['bad', 'good'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got).toHaveLength(2);
    for (const candidate of got) {
      expect(candidate.sourceDetail).toBe('query: good');
    }
  });

  it('makes no requests when there are no queries', async () => {
    const fetchFn = vi.fn();
    const src = createSavedQuerySource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('paces requests process wide, so two sources run concurrently do not burst', async () => {
    const delayMs = 40;
    const callTimes: number[] = [];
    const fetchFn = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return new Response(EMPTY, { status: 200 });
    });

    const sourceA = createSavedQuerySource(['term a1', 'term a2'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs,
    });
    const sourceB = createSavedQuerySource(['term b1', 'term b2'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs,
    });

    await Promise.all([sourceA.fetch(), sourceB.fetch()]);

    expect(callTimes).toHaveLength(4);
    for (let i = 1; i < callTimes.length; i++) {
      const gap = callTimes[i]! - callTimes[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(delayMs - 10);
    }
  });
});

describe('parseSearchFeed', () => {
  it('extracts the arxiv id up to an anchored version suffix, not the first letter v anywhere in the path', () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <title>Modern id</title>
    <summary>s1</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/cond-mat/0703470v2</id>
    <title>Old style id with a slash category</title>
    <summary>s2</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/solv-int/9701004v1</id>
    <title>Category name itself contains the letter v</title>
    <summary>s3</summary>
  </entry>
</feed>`;

    const got = parseSearchFeed(feed);
    expect(got.map((c) => c.arxivId)).toEqual(['2601.00001', 'cond-mat/0703470', 'solv-int/9701004']);
  });

  it('handles a single-entry feed (parser returns object, not array)', () => {
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00003v1</id>
    <title>Solo Entry</title>
    <summary>Only one entry in this feed.</summary>
  </entry>
</feed>`;

    const got = parseSearchFeed(feed);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ arxivId: '2601.00003', title: 'Solo Entry' });
  });
});

describe('savedQuery total failure reporting', () => {
  const FEED_OK = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>http://arxiv.org/abs/2601.00009v1</id><title>Fine</title><summary>ok</summary></entry>
</feed>`;

  it('throws when every query fails, rather than reporting an empty quiet day', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createSavedQuerySource(['a', 'b', 'c'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    await expect(src.fetch()).rejects.toThrow('all 3 arXiv all queries failed');
  });

  it('does not throw when at least one query succeeds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(FEED_OK, { status: 200 }));
    const src = createSavedQuerySource(['bad', 'good'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    expect(await src.fetch()).toHaveLength(1);
  });

  it('an empty query list is not a failure', async () => {
    const fetchFn = vi.fn();
    const src = createSavedQuerySource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });
});
