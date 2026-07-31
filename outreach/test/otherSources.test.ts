import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { createAuthorWatchSource, deriveWatchAuthors } from '../src/discovery/sources/authorWatch.js';
import {
  createRecommendSource,
  deriveSeedPapers,
  extractArxivId,
  resolveKeyPaperSeeds,
} from '../src/discovery/sources/recommend.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00003v1</id>
    <title>New Work</title>
    <summary>Fresh results.</summary>
  </entry>
</feed>`;

function insertKeyPaperFact(db: ReturnType<typeof openDb>, value: string): void {
  db.prepare(
    `INSERT INTO ontology_facts (person_id, facet, key, value, detail, stance, confidence, usability_tier)
     VALUES (NULL, 'academic', 'key_paper', ?, NULL, NULL, 0.9, 'A')`,
  ).run(value);
}

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
    expect(got.errors).toEqual([]);
    expect(got.candidates[0]).toMatchObject({
      arxivId: '2601.00003',
      discoveredVia: 'author_watch',
      sourceDetail: 'author: Akshay Sajan',
    });
  });

  it('skips an author whose request fails but still returns the others, and reports it', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(FEED, { status: 200 }));
    const src = createAuthorWatchSource(['Broken', 'Working'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]?.sourceDetail).toBe('author: Working');
    expect(got.errors[0]).toContain('1 of 2 arXiv au queries failed');
  });

  // A silent wipeout reads as "no new papers" when arXiv is actually refusing
  // us, so total failure has to surface rather than return an empty list.
  it('reports an error when every author request fails, so the run reports it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createAuthorWatchSource(['A', 'B'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
    expect(got.errors[0]).toContain('all 2 arXiv au queries failed');
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

  it('adds a key_paper fact whose text already contains an arXiv id, with no network call', () => {
    const db = openDb(':memory:');
    insertKeyPaperFact(
      db,
      'Heterogeneous Molecular Signatures of Human Odor Perception (arXiv:2604.09758)',
    );
    expect(deriveSeedPapers(db)).toEqual(['2604.09758']);
  });

  it('extracts an old-style archive/YYMMNNN arXiv id', () => {
    expect(extractArxivId('see cond-mat/0703470 for details')).toBe('cond-mat/0703470');
  });

  it('unions and dedups seeds from drafts and key_paper facts', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'A' });
    db.prepare(
      `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, draft_input_json)
       VALUES ('d1', ?, '2508.09217', 'T', '{}')`,
    ).run(pid);
    insertKeyPaperFact(db, 'Some Key Paper (arXiv:2604.09758)');
    // Same id as the draft: must not appear twice.
    insertKeyPaperFact(db, 'Duplicate of the drafted paper 2508.09217');
    expect(deriveSeedPapers(db).sort()).toEqual(['2508.09217', '2604.09758']);
  });
});

describe('extractArxivId', () => {
  it('returns null when the text has no id', () => {
    expect(extractArxivId('Heterogeneous Molecular Signatures of Human Odor Perception (Zanineli 2026)')).toBeNull();
  });
});

describe('resolveKeyPaperSeeds', () => {
  const TITLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2604.09758v1</id>
    <title>Heterogeneous Molecular Signatures of Human Odor Perception</title>
    <summary>Abstract text.</summary>
  </entry>
</feed>`;

  it('resolves a bare-title key_paper fact via injected title search to the right id', async () => {
    const db = openDb(':memory:');
    insertKeyPaperFact(db, 'Heterogeneous Molecular Signatures of Human Odor Perception (Zanineli 2026)');
    const fetchFn = vi.fn().mockResolvedValue(new Response(TITLE_FEED, { status: 200 }));
    const got = await resolveKeyPaperSeeds(db, { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(got).toEqual(['2604.09758']);
  });

  it('produces no seed when the title search result does not confidently match, and does not throw', async () => {
    const db = openDb(':memory:');
    insertKeyPaperFact(db, 'Heterogeneous Molecular Signatures of Human Odor Perception (Zanineli 2026)');
    const unrelatedFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00099v1</id>
    <title>An Unrelated Paper About Something Else</title>
    <summary>Abstract text.</summary>
  </entry>
</feed>`;
    const fetchFn = vi.fn().mockResolvedValue(new Response(unrelatedFeed, { status: 200 }));
    const got = await resolveKeyPaperSeeds(db, { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(got).toEqual([]);
  });

  it('skips key_paper facts that already contain an arXiv id, so they never hit the network', async () => {
    const db = openDb(':memory:');
    insertKeyPaperFact(db, 'Already Has An Id (arXiv:2604.09758)');
    const fetchFn = vi.fn();
    const got = await resolveKeyPaperSeeds(db, { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(got).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('recommend source', () => {
  // The verified Semantic Scholar shape (checked live against
  // GET /recommendations/v1/papers/forpaper/arXiv:2506.02373 on 2026-07-30):
  // {"recommendedPapers": [ {paperId, title, abstract, externalIds} ]}.
  // The paper objects are the array elements themselves. There is no `paper`
  // wrapper and no `data` key.
  const s2 = (recommendedPapers: unknown[]) =>
    new Response(JSON.stringify({ recommendedPapers }), { status: 200 });

  it('expands a seed into related candidates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      s2([
        {
          paperId: 'abc123',
          externalIds: { ArXiv: '2601.00004', DOI: '10.1000/x' },
          title: 'Related',
          abstract: 'Related abstract.',
        },
      ]),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('recommend');
    expect(got.errors).toEqual([]);
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]).toMatchObject({
      arxivId: '2601.00004',
      title: 'Related',
      abstract: 'Related abstract.',
      discoveredVia: 'recommend',
      sourceDetail: 'seed: 2508.09217',
    });
  });

  it('strips a version suffix from the arXiv id so it matches the seen_papers key', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(s2([{ externalIds: { ArXiv: '2601.00004v3' }, title: 'Versioned' }]));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates[0]?.arxivId).toBe('2601.00004');
  });

  // Verified live: many Semantic Scholar recommendations carry only DOI,
  // CorpusId, and PubMed. The pipeline is arXiv only, so those are dropped.
  // This is a legitimate quiet result, NOT a failure, and must report no error.
  it('drops a recommendation with no arXiv id and reports no error for it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      s2([
        { externalIds: { DOI: '10.1000/x', CorpusId: 1 }, title: 'Journal only' },
        { externalIds: { ArXiv: '2601.00005' }, title: 'On arXiv' },
      ]),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates.map((c) => c.arxivId)).toEqual(['2601.00005']);
    expect(got.errors).toEqual([]);
  });

  it('tolerates a missing abstract and a missing externalIds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(s2([{ externalIds: { ArXiv: '2601.00006' }, title: 'No abstract' }, { title: 'Nothing' }]));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]?.abstract).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  // Regression guard for the defect this task fixes. The old code read
  // rec.paper.externalIds.ArXiv, so it would have accepted this and rejected
  // the real shape above. Both assertions must hold together.
  it('rejects the legacy wrapped shape, which the endpoint never sends', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(s2([{ paper: { externalIds: { ArXiv: '2601.00007' }, title: 'Wrapped' } }]));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
  });

  it('reports a rate-limited seed instead of silently returning nothing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('all 1 Semantic Scholar seeds failed');
    expect(got.errors[0]).toContain('HTTP 429');
  });

  it('reports a partial seed failure and still returns what succeeded', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(s2([{ externalIds: { ArXiv: '2601.00008' }, title: 'Survived' }]));
    const src = createRecommendSource(['seed1', 'seed2'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got.candidates.map((c) => c.arxivId)).toEqual(['2601.00008']);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('1 of 2 Semantic Scholar seeds failed');
  });

  it('reports a network throw and unparseable JSON rather than swallowing them', async () => {
    const thrown = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const a = createRecommendSource(['s'], { fetchFn: thrown as unknown as typeof fetch, delayMs: 0 });
    expect((await a.fetch()).errors[0]).toContain('ECONNRESET');

    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const b = createRecommendSource(['s'], { fetchFn: badJson as unknown as typeof fetch, delayMs: 0 });
    expect((await b.fetch()).errors).toHaveLength(1);
  });

  it('makes no requests and reports no error when there are no seeds', async () => {
    const fetchFn = vi.fn();
    const src = createRecommendSource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual({ candidates: [], errors: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requests recommendations per seed via maxResultsPerSeed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(s2([]));
    const src = createRecommendSource(['2508.09217'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
      maxResultsPerSeed: 4,
    });
    await src.fetch();
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('limit=4');
  });
});
