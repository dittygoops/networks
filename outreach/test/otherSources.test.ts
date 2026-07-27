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

function insertDraft(db: ReturnType<typeof openDb>, shortId: string, personId: number, status: string): void {
  db.prepare(
    `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, draft_input_json)
     VALUES (?, ?, '2508.09217', 'T', '{}')`,
  ).run(shortId, personId);
  db.prepare('UPDATE drafts SET status = ? WHERE short_id = ?').run(status, shortId);
}

describe('deriveWatchAuthors', () => {
  it('does not watch a person with no draft', () => {
    const db = openDb(':memory:');
    upsertPerson(db, { name: 'No Draft Person' });
    expect(deriveWatchAuthors(db)).toEqual([]);
  });

  it('watches a person with a draft whose status is sent', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Sent Person' });
    insertDraft(db, 'd1', pid, 'sent');
    expect(deriveWatchAuthors(db)).toEqual(['Sent Person']);
  });

  it('watches a person with a draft whose status is approved', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Approved Person' });
    insertDraft(db, 'd2', pid, 'approved');
    expect(deriveWatchAuthors(db)).toEqual(['Approved Person']);
  });

  it('does not watch a person whose only drafts are skipped or awaiting approval', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Skipped Person' });
    insertDraft(db, 'd3', pid, 'skipped');
    insertDraft(db, 'd4', pid, 'awaiting_approval');
    expect(deriveWatchAuthors(db)).toEqual([]);
  });

  it('lists a person once even with two qualifying drafts', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Twice Contacted Person' });
    insertDraft(db, 'd5', pid, 'sent');
    insertDraft(db, 'd6', pid, 'approved');
    expect(deriveWatchAuthors(db)).toEqual(['Twice Contacted Person']);
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

  it('skips an author whose request fails but still returns the others', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(FEED, { status: 200 }));
    const src = createAuthorWatchSource(['Broken', 'Working'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got).toHaveLength(1);
    expect(got[0]?.sourceDetail).toBe('author: Working');
  });

  // A silent wipeout reads as "no new papers" when arXiv is actually refusing
  // us, so total failure has to surface rather than return an empty list.
  it('throws when every author request fails, so the run reports it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createAuthorWatchSource(['A', 'B'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    await expect(src.fetch()).rejects.toThrow('all 2 arXiv au queries failed');
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
