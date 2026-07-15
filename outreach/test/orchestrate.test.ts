import { describe, expect, test } from 'vitest';
import { processPaper, arxivAgeMonths, type OrchestrateDeps } from '../src/pipeline/orchestrate.js';
import { openDb, saveSelfFacts } from '../src/db/db.js';
import { EXTRACT_SYSTEM, INTERSECT_SYSTEM } from '../src/llm/prompts.js';
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

  test('degrades when the author cannot be resolved: contact only, no ontology', async () => {
    // OpenAlex returns a different person -> no name/coauthor match -> UNRESOLVED.
    const noMatch = (): typeof fetch =>
      (async (url: URL | string) => {
        const u = String(url);
        if (u.includes('export.arxiv.org')) return resp({ text: ATOM });
        if (u.includes('/authors')) return resp({ json: { results: [{ id: 'https://openalex.org/A9', display_name: 'Someone Else', affiliations: [] }] } });
        if (u.includes('/works')) return resp({ json: { results: [] } });
        return resp({ json: {} });
      }) as unknown as typeof fetch;
    const d = deps({ fetchFn: noMatch() });

    const r = await processPaper(d, ARXIV_ID);

    expect(r.resolved).toBe(false);
    expect(r.email?.email).toBe('bernhard.kerbl@tuwien.ac.at'); // still found from the paper
    expect(r.factCount).toBe(0);
    expect(r.notes.join(' ')).toContain('identity unconfirmed');
  });

  test('does not crash when no self ontology is seeded (skips intersections)', async () => {
    const d = deps(); // db has no self facts
    const r = await processPaper(d, ARXIV_ID);
    expect(r.resolved).toBe(true);
    expect(r.hooks).toHaveLength(0);
    expect(r.notes.join(' ')).toContain('no self ontology');
  });
});

describe('arxivAgeMonths', () => {
  test('computes months from the YYMM prefix', () => {
    expect(arxivAgeMonths('2308.04079', new Date('2026-07-15T00:00:00Z'))).toBe(35);
    expect(arxivAgeMonths('2606.00001', new Date('2026-07-15T00:00:00Z'))).toBe(1);
  });
});
