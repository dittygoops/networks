import { describe, expect, test } from 'vitest';
import { resolveAndExtractContact, type IntakeDeps } from '../src/pipeline/intake.js';
import type { WebPage } from '../src/pipeline/contacts.js';
import type { FetchFn } from '../src/openalex/client.js';

// Task A: current affiliation (from OpenAlex) takes precedence over the paper's
// (possibly stale) affiliation in the web-search query and the D5a guard.

// Canned OpenAlex JSON for a resolvable "mover": the paper says INRIA, but the
// author's most recent affiliation year is TU Wien.
function moverFetchFn(): FetchFn {
  const author = {
    id: 'https://openalex.org/A1',
    display_name: 'Bernhard Kerbl',
    x_concepts: [{ display_name: 'Computer graphics' }],
    affiliations: [
      { institution: { display_name: 'Institut national (INRIA)' }, years: [2021, 2022] },
      { institution: { display_name: 'TU Wien' }, years: [2023, 2024, 2025] },
    ],
  };
  const works = [
    {
      title: 'Gaussian Splatting',
      ids: { doi: 'https://doi.org/10.1/x' },
      authorships: [
        { author: { id: 'A1', display_name: 'Bernhard Kerbl' } },
        { author: { id: 'A2', display_name: 'Georgios Kopanas' } },
      ],
    },
  ];
  return (async (input: Parameters<FetchFn>[0]) => {
    const url = String(input instanceof URL ? input : typeof input === "string" ? input : input.url);
    const body = url.includes('/authors') ? { results: [author] } : { results: works };
    return { json: async () => body } as Response;
  }) as FetchFn;
}

// Canned OpenAlex JSON that yields no corroborating candidate (name does not
// match), so resolveAuthor returns UNRESOLVED.
function unresolvedFetchFn(): FetchFn {
  const author = {
    id: 'https://openalex.org/A9',
    display_name: 'Someone Else',
    x_concepts: [],
    affiliations: [{ institution: { display_name: 'Nowhere University' }, years: [2025] }],
  };
  return (async (input: Parameters<FetchFn>[0]) => {
    const url = String(input instanceof URL ? input : typeof input === "string" ? input : input.url);
    const body = url.includes('/authors') ? { results: [author] } : { results: [] };
    return { json: async () => body } as Response;
  }) as FetchFn;
}

function makeDeps(opts: {
  fetchFn: FetchFn;
  searchResults?: WebPage[];
  fetched?: Record<string, string>;
  searchLog?: string[];
}): IntakeDeps {
  return {
    fetchFn: opts.fetchFn,
    search: {
      async search(q: string) {
        opts.searchLog?.push(q);
        return opts.searchResults ?? [];
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        return urls.map((url) => ({ url, title: '', content: opts.fetched?.[url] ?? '' }));
      },
    },
  };
}

const PERSON = { name: 'Bernhard Kerbl', affiliation: 'INRIA' };

describe('resolveAndExtractContact (Task A)', () => {
  test('mover: web query uses the OpenAlex current affiliation, not the paper affiliation', async () => {
    const searchLog: string[] = [];
    const deps = makeDeps({ fetchFn: moverFetchFn(), searchLog });
    await resolveAndExtractContact(
      deps,
      PERSON,
      { affiliationHint: 'INRIA', coauthors: ['Georgios Kopanas'] },
      { paperText: 'no email here', paperAgeMonths: 48 },
    );
    const affiliationQuery = searchLog.find((q) => q.includes('email'));
    expect(affiliationQuery).toContain('TU Wien');
    expect(affiliationQuery).not.toContain('INRIA');
  });

  test('UNRESOLVED: falls back to the paper affiliation', async () => {
    const searchLog: string[] = [];
    const deps = makeDeps({ fetchFn: unresolvedFetchFn(), searchLog });
    await resolveAndExtractContact(
      deps,
      PERSON,
      { affiliationHint: 'INRIA', coauthors: ['Georgios Kopanas'] },
      { paperText: 'no email here', paperAgeMonths: 48 },
    );
    const affiliationQuery = searchLog.find((q) => q.includes('email'));
    expect(affiliationQuery).toContain('INRIA');
    expect(affiliationQuery).not.toContain('TU Wien');
  });

  test('mover: returns the current-institution email discovered via the sharpened query', async () => {
    const homepage = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    const deps = makeDeps({
      fetchFn: moverFetchFn(),
      searchResults: [{ url: homepage, title: 'Bernhard Kerbl', content: '' }],
      fetched: { [homepage]: 'Contact: kerbl@cg.tuwien.ac.at' },
    });
    const result = await resolveAndExtractContact(
      deps,
      PERSON,
      { affiliationHint: 'INRIA', coauthors: ['Georgios Kopanas'] },
      { paperText: 'Corresponding author: bernhard.kerbl@inria.fr', paperAgeMonths: 48 },
    );
    expect(result).toEqual({ email: 'kerbl@cg.tuwien.ac.at', confidence: 0.85, source: 'homepage' });
  });
});
