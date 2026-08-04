import { describe, expect, test, vi } from 'vitest';
import { processPaper, arxivAgeMonths, type OrchestrateDeps } from '../src/pipeline/orchestrate.js';
import { openDb, saveSelfFacts } from '../src/db/db.js';
import { EXTRACT_SYSTEM, INTERSECT_SYSTEM } from '../src/llm/prompts.js';
import { SelfOntologyMissingError } from '../src/pipeline/intersect.js';
import type { LLMClient } from '../src/llm/client.js';
import type { OntologyFact } from '../src/pipeline/research.js';

// Fresh arXiv id (YYMM 2606 = 2026-06, ~1 month before "now") so tier-1 wins.
const ARXIV_ID = '2606.00001';
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/${ARXIV_ID}v1</id>
    <title>A New Rendering Method</title>
    <summary>We render things.</summary>
    <author><name>Bernhard Kerbl</name></author>
    <author><name>Georgios Kopanas</name></author>
    <author><name>George Drettakis</name></author>
    <arxiv:primary_category term="cs.GR"/>
  </entry>
</feed>`;

const KERBL = {
  id: 'https://openalex.org/A1',
  display_name: 'Bernhard Kerbl',
  x_concepts: [{ display_name: 'Computer graphics' }],
  affiliations: [{ institution: { display_name: 'TU Wien', id: 'https://openalex.org/I1' }, years: [2025] }],
};
const WORK = { title: 'Rendering', authorships: [
  { author: { id: 'A1', display_name: 'Bernhard Kerbl' } },
  { author: { id: 'A2', display_name: 'Georgios Kopanas' } },
] };

const resp = (body: { text?: string; json?: unknown }): Response =>
  ({ ok: true, status: 200, text: async () => body.text ?? '', json: async () => body.json ?? {} }) as unknown as Response;

const routerFetch = (): typeof fetch =>
  (async (url: URL | string) => {
    const u = String(url);
    if (u.includes('export.arxiv.org')) return resp({ text: ATOM });
    if (u.includes('/authors')) return resp({ json: { results: [KERBL] } });
    if (u.includes('/works')) return resp({ json: { results: [WORK] } });
    if (u.includes('/institutions/')) return resp({ json: { homepage_url: 'https://tuwien.at' } });
    return resp({ json: {} });
  }) as unknown as typeof fetch;

// Fake LLM: empty facts on extract, canned intersection on intersect, else summary.
const llm = (intersections: string): LLMClient => ({
  async complete(system) {
    if (system === EXTRACT_SYSTEM) return '[]';
    if (system === INTERSECT_SYSTEM) return intersections;
    return 'A profile.';
  },
});

function deps(over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    db: openDb(':memory:'),
    search: { async search() { return []; } },
    fetcher: { async fetch() { return []; } },
    llm: llm(JSON.stringify([{ self: 's0', person: 'p0', strength: 0.9, rationale: 'both do 3DGS' }])),
    fetchFn: routerFetch(),
    getPaperText: async () => 'Corresponding author: bernhard.kerbl@tuwien.ac.at',
    ...over,
  };
}

describe('processPaper (orchestrator)', () => {
  test('runs the full chain: resolve, contact, mine, persist, intersect', async () => {
    const d = deps();
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);

    const r = await processPaper(d, ARXIV_ID);

    expect(r.target).toBe('Bernhard Kerbl');
    expect(r.resolved).toBe(true);
    expect(r.email).toEqual({ email: 'bernhard.kerbl@tuwien.ac.at', confidence: 0.95, source: 'pdf' });
    expect(r.factCount).toBeGreaterThan(0); // OpenAlex facts persisted
    expect(r.hooks).toHaveLength(1);
    expect(r.hooks[0]?.rationale).toBe('both do 3DGS');
    // person persisted with email
    const row = d.db.prepare('SELECT email, openalex_id FROM people WHERE id = ?').get(r.personId);
    expect(row).toMatchObject({ email: 'bernhard.kerbl@tuwien.ac.at', openalex_id: 'A1' });
  });

  test('an unresolved author costs nothing: no contact lookup, no PDF fetch, no person row', async () => {
    // OpenAlex returns a different person -> no name/coauthor match -> UNRESOLVED.
    const noMatch = (): typeof fetch =>
      (async (url: URL | string) => {
        const u = String(url);
        if (u.includes('export.arxiv.org')) return resp({ text: ATOM });
        if (u.includes('/authors')) return resp({ json: { results: [{ id: 'https://openalex.org/A9', display_name: 'Someone Else', affiliations: [] }] } });
        if (u.includes('/works')) return resp({ json: { results: [] } });
        return resp({ json: {} });
      }) as unknown as typeof fetch;
    const search = vi.fn(async () => []);
    const fetcher = vi.fn(async () => []);
    const getPaperText = vi.fn(async () => 'Corresponding author: bernhard.kerbl@tuwien.ac.at');
    const d = deps({ fetchFn: noMatch(), search: { search }, fetcher: { fetch: fetcher }, getPaperText });

    const r = await processPaper(d, ARXIV_ID);

    expect(r.resolved).toBe(false);
    expect(r.email).toBeNull();
    expect(r.personId).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(getPaperText).not.toHaveBeenCalled(); // the PDF fetch moves too
    expect(d.db.prepare('SELECT COUNT(*) n FROM people').get()).toEqual({ n: 0 });
  });

  test('a missing self ontology is a run error, not a silent no-hook verdict', async () => {
    const d = deps(); // no saveSelfFacts call: the self ontology is empty
    // Silently returning hooks: [] here would be read by the hook gate as
    // "this person is not interesting", terminating every paper in the run
    // at drafted_unsendable with nothing captured and nothing retryable.
    await expect(processPaper(d, ARXIV_ID)).rejects.toBeInstanceOf(SelfOntologyMissingError);
  });

  test('an OpenAlex transport failure is retryable, not a terminal identity verdict', async () => {
    const inner = routerFetch();
    const boom = (async (url: URL | string) => {
      if (String(url).includes('/authors')) throw new Error('429 Too Many Requests');
      return inner(url as never);
    }) as unknown as typeof fetch;
    const d = deps({ fetchFn: boom });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    // Degrading here would write drafted_unsendable/'identity unconfirmed',
    // which nothing ever revisits, so an outage would silently discard the day.
    await expect(processPaper(d, ARXIV_ID)).rejects.toThrow(/429/);
  });

  test('a genuine no-match still degrades quietly to unresolved', async () => {
    const inner = routerFetch();
    const empty = (async (url: URL | string) => {
      if (String(url).includes('/authors')) return resp({ json: { results: [] } });
      return inner(url as never);
    }) as unknown as typeof fetch;
    const d = deps({ fetchFn: empty });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    const r = await processPaper(d, ARXIV_ID);
    expect(r.resolved).toBe(false);
    expect(r.notes.join(' ')).toContain('identity unconfirmed');
  });

  test('a person whose email is already on record does not pay for another lookup', async () => {
    // Default deps() supplies a fresh, corresponding-marker PDF text, which
    // short-circuits tier-1 and never reaches the web tier at all -- that
    // would make this test pass for the wrong reason (tier-1 always skips
    // search, guard or no guard). Force tier-1 to miss so the FIRST call
    // genuinely pays for a web contact lookup, then prove the SECOND call
    // (same author, already on record) skips it.
    //
    // A bare call counter on `search` would also catch minePersonWeb's
    // unrelated personal-facts mining, which runs on every hook-passing
    // paper regardless of this guard (Task 7 only touches contact
    // extraction). Its queries never contain "email" or "github" (see
    // research.ts's minePersonalFacts), so filtering on those substrings
    // isolates extractWebContacts's own queries.
    const homepage = 'https://tuwien.at/~kerbl/';
    const queries: string[] = [];
    const search = vi.fn(async (q: string) => {
      queries.push(q);
      return [{ url: homepage, title: 'Bernhard Kerbl', content: '' }];
    });
    const fetcher = vi.fn(async (urls: string[]) =>
      urls.map((url) => ({ url, title: '', content: url === homepage ? 'contact: bernhard.kerbl@tuwien.ac.at' : '' })),
    );
    const d = deps({ search: { search }, fetcher: { fetch: fetcher }, getPaperText: async () => 'no emails here' });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);

    const first = await processPaper(d, ARXIV_ID); // first paper: pays for a web contact lookup
    expect(first.email?.email).toBe('bernhard.kerbl@tuwien.ac.at');
    expect(queries.some((q) => q.includes('email') || q.includes('github'))).toBe(true);
    queries.length = 0;

    await processPaper(d, ARXIV_ID); // same author, next paper: email already on record
    expect(queries.some((q) => q.includes('email') || q.includes('github'))).toBe(false);
  });

  test('a name-mismatched address is reported on the result, not silently dropped', async () => {
    // The whole point: "we found an address for the wrong person" must be
    // distinguishable downstream from "we found nothing". Tier-1 PDF text is
    // suppressed and an affiliation is present (KERBL's TU Wien) so this
    // actually reaches extractContactDetailed's web tier, not just the
    // on-record shortcut or a skipped lookup.
    const search = vi.fn(async () => [
      { url: 'https://tuwien.ac.at/staff', title: 'Staff', content: 'someoneelse@tuwien.ac.at' },
    ]);
    const d = deps({ search: { search }, fetcher: { fetch: async () => [] }, getPaperText: async () => null });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);

    const r = await processPaper(d, ARXIV_ID);

    // Confirms the fixture actually exercises the web-search path (the whole
    // point of the WARNING: a person with no affiliation never reaches it).
    expect(search).toHaveBeenCalled();
    expect(r.email).toBeNull();
    expect((r.rejectedEmails ?? []).map((x) => x.email)).toContain('someoneelse@tuwien.ac.at');
  });

  test('the on-record shortcut reports no rejections, because nothing was looked up', async () => {
    // Same setup as "a person whose email is already on record does not pay
    // for another lookup" above: minePersonWeb calls `search` on every
    // hook-passing paper for unrelated personal-fact mining, so a bare
    // "search not called" assertion would catch the wrong thing. Filter to
    // this feature's own queries (email / github), as that test does.
    const homepage = 'https://tuwien.at/~kerbl/';
    const queries: string[] = [];
    const search = vi.fn(async (q: string) => {
      queries.push(q);
      return [{ url: homepage, title: 'Bernhard Kerbl', content: '' }];
    });
    const fetcher = vi.fn(async (urls: string[]) =>
      urls.map((url) => ({ url, title: '', content: url === homepage ? 'contact: bernhard.kerbl@tuwien.ac.at' : '' })),
    );
    const d = deps({ search: { search }, fetcher: { fetch: fetcher }, getPaperText: async () => 'no emails here' });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);

    await processPaper(d, ARXIV_ID); // first pass: web tier runs, stores the address
    queries.length = 0;
    const r = await processPaper(d, ARXIV_ID); // same author, next paper: already on record

    expect(queries.some((q) => q.includes('email') || q.includes('github'))).toBe(false);
    expect(r.rejectedEmails ?? []).toEqual([]);
  });
});

describe('arxivAgeMonths', () => {
  test('computes months from the YYMM prefix', () => {
    expect(arxivAgeMonths('2308.04079', new Date('2026-07-15T00:00:00Z'))).toBe(35);
    expect(arxivAgeMonths('2606.00001', new Date('2026-07-15T00:00:00Z'))).toBe(1);
  });
});
