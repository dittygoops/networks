import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { deriveGapQueries } from '../src/discovery/gapSeeds.js';

function seedFact(db: ReturnType<typeof openDb>, key: string, value: string, stance: string) {
  db.prepare(
    `INSERT INTO ontology_facts (person_id, facet, key, value, detail, stance, confidence, usability_tier)
     VALUES (NULL, 'academic', ?, ?, NULL, ?, 0.9, 'A')`,
  ).run(key, value, stance);
}

describe('deriveGapQueries', () => {
  it('uses only exploring facts, never done facts', () => {
    const db = openDb(':memory:');
    seedFact(db, 'research_area', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', '3D Gaussian Splatting', 'done');
    expect(deriveGapQueries(db)).toEqual(['olfactory embedding space']);
  });

  it('emits one query per fact so unrelated threads never blend', () => {
    const db = openDb(':memory:');
    seedFact(db, 'research_area', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', 'Mirror-3DGS', 'exploring');
    const queries = deriveGapQueries(db);
    expect(queries).toEqual(['olfactory embedding space', 'Mirror-3DGS']);
    expect(queries.some((q) => q.includes('olfactory') && q.includes('3DGS'))).toBe(false);
  });

  it('dedups repeated values and ignores blank ones', () => {
    const db = openDb(':memory:');
    seedFact(db, 'research_area', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', '   ', 'exploring');
    expect(deriveGapQueries(db)).toEqual(['olfactory embedding space']);
  });

  it('returns an empty list when no gaps are recorded', () => {
    expect(deriveGapQueries(openDb(':memory:'))).toEqual([]);
  });
});
