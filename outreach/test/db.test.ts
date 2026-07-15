import { describe, expect, test } from 'vitest';
import { openDb, upsertPerson, saveFacts, getFacts, getPerson } from '../src/db/db.js';
import type { OntologyFact } from '../src/pipeline/research.js';

// D11: thin SQLite data layer. Tests run against an in-memory database.

const fact = (partial: Partial<OntologyFact> = {}): OntologyFact => ({
  facet: 'academic', key: 'research_area', value: 'Computer graphics',
  sourceUrl: 'https://openalex.org/A1', confidence: 0.85, tier: 'A', ...partial,
});

describe('upsertPerson (D11 dedup)', () => {
  test('inserts a new person and returns its id', () => {
    const db = openDb(':memory:');
    const id = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1', affiliation: 'TU Wien' });
    expect(id).toBeGreaterThan(0);
    expect(getPerson(db, id)?.name).toBe('Bernhard Kerbl');
  });

  test('re-upserting the same openalex_id updates in place, not duplicates', () => {
    const db = openDb(':memory:');
    const first = upsertPerson(db, { name: 'B. Kerbl', openalexId: 'A1', affiliation: 'INRIA' });
    const second = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1', affiliation: 'TU Wien', profileSummary: 'Graphics researcher.' });
    expect(second).toBe(first); // same row
    const person = getPerson(db, first);
    expect(person?.affiliation).toBe('TU Wien'); // updated
    expect(person?.name).toBe('Bernhard Kerbl');
    expect(person?.profile_summary).toBe('Graphics researcher.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
  });

  test('a person without an openalex_id inserts fresh each time', () => {
    const db = openDb(':memory:');
    upsertPerson(db, { name: 'Anon One' });
    upsertPerson(db, { name: 'Anon Two' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 2 });
  });
});

describe('saveFacts / getFacts (D11 replace strategy)', () => {
  test('persists facts and reads them back mapped to the ontology shape', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
    saveFacts(db, pid, [fact(), fact({ facet: 'trajectory', key: 'institution', value: 'TU Wien', confidence: 0.9 })]);
    const facts = getFacts(db, pid);
    expect(facts).toHaveLength(2);
    const inst = facts.find((f) => f.key === 'institution');
    expect(inst).toMatchObject({ facet: 'trajectory', value: 'TU Wien', confidence: 0.9, tier: 'A' });
    expect(inst?.sourceUrl).toBe('https://openalex.org/A1');
  });

  test('re-saving replaces the person prior facts atomically (no stale rows)', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
    saveFacts(db, pid, [fact({ value: 'Old area' }), fact({ value: 'Another old' })]);
    saveFacts(db, pid, [fact({ value: 'Fresh area' })]);
    const facts = getFacts(db, pid);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe('Fresh area');
  });

  test('replacing one person facts leaves another person facts intact', () => {
    const db = openDb(':memory:');
    const a = upsertPerson(db, { name: 'Person A', openalexId: 'A1' });
    const b = upsertPerson(db, { name: 'Person B', openalexId: 'A2' });
    saveFacts(db, a, [fact({ value: 'A fact' })]);
    saveFacts(db, b, [fact({ value: 'B fact' })]);
    saveFacts(db, a, [fact({ value: 'A fact v2' })]);
    expect(getFacts(db, b)).toHaveLength(1);
    expect(getFacts(db, b)[0]?.value).toBe('B fact');
  });
});
