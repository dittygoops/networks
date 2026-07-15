import { describe, expect, test } from 'vitest';
import { openDb, getFacts, getPerson } from '../src/db/db.js';
import { persistPerson } from '../src/pipeline/persist.js';
import type { AuthorResolution, OntologyFact } from '../src/pipeline/research.js';
import type { OpenAlexAuthorRaw } from '../src/openalex/client.js';

// D11: persistPerson maps a resolve+mine result into the store (upsert person +
// replace facts), using the OpenAlex current affiliation. Pure over the store.

const raw: OpenAlexAuthorRaw = {
  id: 'https://openalex.org/A1',
  display_name: 'Bernhard Kerbl',
  affiliations: [
    { institution: { display_name: 'INRIA' }, years: [2023] },
    { institution: { display_name: 'TU Wien' }, years: [2025] },
  ],
};
const resolution: AuthorResolution = {
  author: {
    id: 'A1', displayName: 'Bernhard Kerbl', concepts: [], affiliations: [], coauthors: [],
    workTitles: [], externalIds: [], homepageUrls: ['https://www.cg.tuwien.ac.at/staff/BernhardKerbl'],
  },
  signals: ['coauthor'],
};
const facts: OntologyFact[] = [
  { facet: 'academic', key: 'research_area', value: 'Computer graphics', sourceUrl: 'https://openalex.org/A1', confidence: 0.85, tier: 'A' },
];

describe('persistPerson (D11)', () => {
  test('upserts the person with current affiliation + summary and saves facts', () => {
    const db = openDb(':memory:');
    const id = persistPerson(db, resolution, raw, { facts, profileSummary: 'Graphics researcher.' });
    const person = getPerson(db, id);
    expect(person?.name).toBe('Bernhard Kerbl');
    expect(person?.openalex_id).toBe('A1');
    expect(person?.affiliation).toBe('TU Wien'); // most recent year
    expect(person?.profile_summary).toBe('Graphics researcher.');
    expect(getFacts(db, id)).toHaveLength(1);
  });

  test('re-persisting the same author dedupes the person and accumulates facts', () => {
    const db = openDb(':memory:');
    persistPerson(db, resolution, raw, { facts, profileSummary: 'v1' });
    const id2 = persistPerson(db, resolution, raw, {
      facts: [...facts, { facet: 'trajectory', key: 'institution', value: 'TU Wien', sourceUrl: 'x', confidence: 0.9, tier: 'A' }],
      profileSummary: 'v2',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
    expect(getPerson(db, id2)?.profile_summary).toBe('v2');
    expect(getFacts(db, id2)).toHaveLength(2); // original (deduped) + the new institution fact
  });
});
