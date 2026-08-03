// Proves the core claim of the hook-first gating plan: every paid call
// (Tavily search, page fetch, arXiv PDF fetch) happens strictly AFTER the
// intersect LLM call, and a hookless candidate makes zero paid calls at all.
//
// Per-seam call counters (e.g. `expect(search).not.toHaveBeenCalled()`)
// cannot express "happened after X" -- they can only express "happened" or
// "did not happen". So every injectable seam here appends to ONE shared,
// ordered log instead of its own counter, and the assertions read positions
// in that single timeline.
//
// Fixtures (ATOM/KERBL/WORK/routerFetch/ARXIV_ID) are duplicated from
// test/orchestrate.test.ts rather than extracted into a shared helpers file.
// The duplication is ~20 lines and this is the only other consumer; hoisting
// it into test/helpers/fixtures.ts would touch orchestrate.test.ts (which
// carries the load-bearing full-chain regression test) for no benefit beyond
// tidiness. Not worth the risk.
import { describe, expect, test } from 'vitest';
import { openDb, saveSelfFacts } from '../src/db/db.js';
import { processPaper, type OrchestrateDeps } from '../src/pipeline/orchestrate.js';
import { EXTRACT_SYSTEM, INTERSECT_SYSTEM } from '../src/llm/prompts.js';
import type { LLMClient } from '../src/llm/client.js';
import type { OntologyFact } from '../src/pipeline/research.js';

// Real fixture id used across this codebase's orchestrator tests (YYMM 2606 =
// 2026-06, chosen so the paper is "recent" relative to the fake clock and
// tier-1/PDF-age logic behaves as it would on a real fresh paper). The plan
// document's snippet used '2308.04079', which is NOT wired to any fixture in
// this repo; using it here would 404 against the real arXiv endpoint if the
// fetchFn override were ever missed.
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

// Builds an OrchestrateDeps whose every injectable seam (Tavily search,
// Tavily page fetch, arXiv PDF text, and the LLM) appends to ONE shared,
// ordered `log` array, tagged so paid calls are identifiable.
//
// A FRESH in-memory DB per test case is required here, NOT an optimisation to
// remove later: computeIntersections reads ALL accumulated facts for a
// person, so sharing one DB across cases would let "no hook -> zero paid
// calls" pass for the wrong reason (facts leaking in from a prior case could
// suppress or manufacture a hook independent of what this test seeds).
function loggedDeps(log: string[], intersectResponse: string): OrchestrateDeps {
  const llm: LLMClient = {
    async complete(system: string) {
      if (system === INTERSECT_SYSTEM) {
        log.push('llm:intersect');
        return intersectResponse;
      }
      if (system === EXTRACT_SYSTEM) {
        log.push('llm:extract');
        return '[]';
      }
      log.push('llm:summary');
      return 'A profile.';
    },
  };
  return {
    db: openDb(':memory:'),
    search: {
      async search(q: string) {
        log.push(`search:${q}`);
        return [];
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        log.push(`fetch:${urls.length}`);
        return [];
      },
    },
    llm,
    fetchFn: routerFetch(),
    getPaperText: async () => {
      log.push('pdf');
      return null;
    },
  };
}

// The three paid seams under test: Tavily search, Tavily page fetch, arXiv
// PDF fetch. Everything else (OpenAlex HTTP via fetchFn, every LLM call) is
// free.
const isPaid = (entry: string): boolean =>
  entry.startsWith('search:') || entry.startsWith('fetch:') || entry === 'pdf';

describe('hook-first ordering (shared call log)', () => {
  test('a candidate with no hook triggers zero paid calls', async () => {
    const log: string[] = [];
    const d = loggedDeps(log, '[]'); // intersect LLM returns no intersections -> no hook
    saveSelfFacts(d.db, [
      { facet: 'academic', key: 'method', value: 'Byzantine Consensus', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact,
    ]);

    const r = await processPaper(d, ARXIV_ID);

    expect(r.hooks).toEqual([]);
    expect(r.noStrongHook).toBe(true);
    expect(log.filter(isPaid)).toEqual([]);
  });

  test('when a hook exists, every paid call happens after the intersect call', async () => {
    const log: string[] = [];
    const d = loggedDeps(
      log,
      JSON.stringify([{ self: 's0', person: 'p0', strength: 0.9, rationale: 'both do 3DGS' }]),
    );
    saveSelfFacts(d.db, [
      { facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact,
    ]);

    const r = await processPaper(d, ARXIV_ID);

    expect(r.hooks.length).toBeGreaterThan(0);
    // Sanity: paid calls actually happened in this run (mining + contact
    // extraction both fire for a hook-passing candidate), otherwise the
    // ordering assertion below would pass vacuously.
    expect(log.some(isPaid)).toBe(true);

    const firstIntersect = log.indexOf('llm:intersect');
    const firstPaid = log.findIndex(isPaid);
    expect(firstIntersect).toBeGreaterThanOrEqual(0);
    expect(firstPaid).toBeGreaterThan(firstIntersect);
  });
});
