import { describe, expect, test } from 'vitest';
import { factsFromOpenAlex, type OntologyFact, type OpenAlexCandidate } from '../src/pipeline/research.js';
import type { OpenAlexAuthorRaw } from '../src/openalex/client.js';

// D6a: OpenAlex facts are deterministic (no LLM). Confidence and tier are
// assigned by code from the source class (openalex => tier A).

const raw: OpenAlexAuthorRaw = {
  id: 'https://openalex.org/A5001',
  display_name: 'Bernhard Kerbl',
  x_concepts: [{ display_name: 'Computer graphics' }],
  affiliations: [
    { institution: { display_name: 'TU Wien' }, years: [2020, 2021, 2022, 2023, 2024, 2025] },
    { institution: { display_name: 'Inria' }, years: [2023, 2024] },
  ],
};

const candidate: OpenAlexCandidate = {
  id: 'A5001',
  displayName: 'Bernhard Kerbl',
  concepts: ['Computer graphics', 'Rendering'],
  affiliations: ['TU Wien', 'Inria'],
  coauthors: ['Georgios Kopanas', 'Thomas Leimkuhler'],
  workTitles: ['3D Gaussian Splatting'],
  externalIds: [],
  venues: ['ACM Transactions on Graphics'],
};

const find = (facts: OntologyFact[], facet: string, key: string, value: string) =>
  facts.find((f) => f.facet === facet && f.key === key && f.value === value);

describe('factsFromOpenAlex (D6a deterministic)', () => {
  const facts = factsFromOpenAlex(candidate, raw);

  test('current affiliation is trajectory/institution, conf 0.9, tier A', () => {
    const f = find(facts, 'trajectory', 'institution', 'TU Wien');
    expect(f).toBeDefined();
    expect(f!.confidence).toBe(0.9);
    expect(f!.tier).toBe('A');
    expect(f!.sourceUrl).toBe('https://openalex.org/A5001');
  });

  test('prior affiliation is trajectory/institution, conf 0.8, tier A', () => {
    const f = find(facts, 'trajectory', 'institution', 'Inria');
    expect(f).toBeDefined();
    expect(f!.confidence).toBe(0.8);
    expect(f!.tier).toBe('A');
  });

  test('concepts are academic/research_area, conf 0.85, tier A', () => {
    const f = find(facts, 'academic', 'research_area', 'Rendering');
    expect(f).toBeDefined();
    expect(f!.confidence).toBe(0.85);
    expect(f!.tier).toBe('A');
  });

  test('venues are academic/venue, conf 0.8, tier A', () => {
    const f = find(facts, 'academic', 'venue', 'ACM Transactions on Graphics');
    expect(f).toBeDefined();
    expect(f!.confidence).toBe(0.8);
    expect(f!.tier).toBe('A');
  });

  test('co-authors are academic/collaborator, conf 0.7, tier A', () => {
    const f = find(facts, 'academic', 'collaborator', 'Georgios Kopanas');
    expect(f).toBeDefined();
    expect(f!.confidence).toBe(0.7);
    expect(f!.tier).toBe('A');
  });
});
