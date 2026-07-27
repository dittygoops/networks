import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { createAuthorWatchSource, deriveWatchAuthors } from '../src/discovery/sources/authorWatch.js';
import { createRecommendSource, deriveSeedPapers } from '../src/discovery/sources/recommend.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00003v1</id>
    <title>New Work</title>
    <summary>Fresh results.</summary>
  </entry>
</feed>`;

describe('deriveWatchAuthors', () => {
  it('returns people already in the database', () => {
    const db = openDb(':memory:');
    upsertPerson(db, { name: 'Akshay Sajan' });
    upsertPerson(db, { name: 'Wenwen Zhang' });
    expect(deriveWatchAuthors(db).sort()).toEqual(['Akshay Sajan', 'Wenwen Zhang']);
  });
});

describe('authorWatch source', () => {
  it('tags candidates with the author that surfaced them', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(FEED, { status: 200 }));
    const src = createAuthorWatchSource(['Akshay Sajan'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('author_watch');
    expect(got[0]).toMatchObject({
      arxivId: '2601.00003',
      discoveredVia: 'author_watch',
      sourceDetail: 'author: Akshay Sajan',
    });
  });

  it('skips an author whose request fails', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const src = createAuthorWatchSource(['X'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });
});

describe('deriveSeedPapers', () => {
  it('returns distinct arXiv ids already drafted against', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'A' });
    for (const id of ['2508.09217', '2508.09217', '2604.09758']) {
      db.prepare(
        `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, draft_input_json)
         VALUES (?, ?, ?, 'T', '{}')`,
      ).run(`d${Math.random()}`, pid, id);
    }
    expect(deriveSeedPapers(db).sort()).toEqual(['2508.09217', '2604.09758']);
  });
});

describe('recommend source', () => {
  it('expands a seed into related candidates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ paper: { externalIds: { ArXiv: '2601.00004' }, title: 'Related' } }] }), {
        status: 200,
      }),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('recommend');
    expect(got[0]).toMatchObject({
      arxivId: '2601.00004',
      title: 'Related',
      discoveredVia: 'recommend',
      sourceDetail: 'seed: 2508.09217',
    });
  });

  it('ignores recommendations that have no arXiv id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ paper: { externalIds: {}, title: 'No arXiv' } }] }), { status: 200 }),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });
});
