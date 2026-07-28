import { describe, expect, test } from 'vitest';
import { openDb, saveSelfFacts } from '../src/db/db.js';
import { buildSenderFacts } from '../src/pipeline/credibility.js';
import type { OntologyFact } from '../src/pipeline/research.js';

const fact = (over: Partial<OntologyFact>): OntologyFact => ({
  facet: 'academic',
  key: 'method',
  value: 'Something',
  sourceUrl: 'self:resume',
  confidence: 0.9,
  tier: 'A',
  ...over,
});

function dbWith(facts: OntologyFact[]) {
  const db = openDb(':memory:');
  saveSelfFacts(db, facts);
  return db;
}

describe('buildSenderFacts', () => {
  // The drafter must never present a research direction Aditya is still
  // exploring as work he has finished.
  test('excludes exploring facts, so nothing unfinished is claimed as done', () => {
    const db = dbWith([
      fact({ value: 'nuScenes', stance: 'done' }),
      fact({ value: 'hierarchical mixture of experts', stance: 'exploring' }),
    ]);
    const got = buildSenderFacts(db);
    expect(got.map((f) => f.text)).toEqual(['nuScenes']);
  });

  test('puts facts carrying a detail first, since a bare entity name earns nothing', () => {
    const db = dbWith([
      fact({ value: 'Bare Entity', stance: 'done' }),
      fact({ value: 'nuScenes', detail: 'Benchmarked a lidar clustering detector', stance: 'done' }),
    ]);
    expect(buildSenderFacts(db)[0]?.text).toBe('nuScenes: Benchmarked a lidar clustering detector');
  });

  test('only academic facts qualify as credentials', () => {
    const db = dbWith([
      fact({ facet: 'interest', key: 'hobby', value: 'Chess', stance: 'done' }),
      fact({ value: 'nuScenes', stance: 'done' }),
    ]);
    expect(buildSenderFacts(db).map((f) => f.text)).toEqual(['nuScenes']);
  });

  test('respects the limit', () => {
    const db = dbWith(Array.from({ length: 20 }, (_, i) => fact({ value: `Thing ${i}`, stance: 'done' })));
    expect(buildSenderFacts(db, 3)).toHaveLength(3);
  });

  test('returns an empty list rather than throwing when no self ontology exists', () => {
    expect(buildSenderFacts(openDb(':memory:'))).toEqual([]);
  });
});
