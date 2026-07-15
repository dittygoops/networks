import { describe, expect, test } from 'vitest';
import { normalizeAuthor, currentAffiliation, type OpenAlexAuthorRaw } from '../src/openalex/client.js';

// The client normalizes raw OpenAlex JSON into OpenAlexCandidate and derives
// the CURRENT affiliation from time-stamped affiliations (most recent year).

const rawAuthor: OpenAlexAuthorRaw = {
  id: 'https://openalex.org/A5031044431',
  display_name: 'Bernhard Kerbl',
  x_concepts: [{ display_name: 'Computer graphics' }, { display_name: 'Rendering' }],
  affiliations: [
    { institution: { display_name: 'Institut national (INRIA)' }, years: [2023, 2024] },
    { institution: { display_name: 'TU Wien' }, years: [2020, 2021, 2022, 2023, 2024, 2025] },
  ],
};

const rawWorks = [
  {
    title: 'Fast Explicit 3D Reconstructions',
    ids: { doi: 'https://doi.org/10.1/x' },
    authorships: [
      { author: { id: 'A5031044431', display_name: 'Bernhard Kerbl' } },
      { author: { id: 'A_franke', display_name: 'Linus Franke' } },
    ],
  },
];

describe('normalizeAuthor', () => {
  test('maps raw fields into an OpenAlexCandidate', () => {
    const c = normalizeAuthor(rawAuthor, rawWorks);
    expect(c.id).toBe('A5031044431'); // bare id, not the URL
    expect(c.displayName).toBe('Bernhard Kerbl');
    expect(c.concepts).toEqual(['Computer graphics', 'Rendering']);
    expect(c.affiliations).toContain('TU Wien');
    expect(c.coauthors).toContain('Linus Franke');
    expect(c.coauthors).not.toContain('Bernhard Kerbl'); // the author themselves is excluded
    expect(c.workTitles).toContain('Fast Explicit 3D Reconstructions');
    expect(c.externalIds).toContain('https://doi.org/10.1/x');
  });
});

describe('currentAffiliation', () => {
  test('returns the affiliation with the most recent year', () => {
    expect(currentAffiliation(rawAuthor)).toBe('TU Wien');
  });

  test('returns null when there are no affiliations', () => {
    expect(currentAffiliation({ ...rawAuthor, affiliations: [] })).toBeNull();
  });
});
