import { describe, expect, test } from 'vitest';
import { resolveAndExtractContact } from '../src/pipeline/intake.js';
import { minePerson, type AuthorResolution, type MineDeps, type OpenAlexCandidate } from '../src/pipeline/research.js';
import type { OpenAlexAuthorRaw } from '../src/openalex/client.js';
import type { PaperContext } from '../src/pipeline/contacts.js';

// External-call resilience: a failing OpenAlex or LLM call must degrade, never
// crash the pipeline (D10 "return a result or null, never crash").

const okJson = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const httpError = (status: number): Response => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

describe('intake resilience', () => {
  test('a fresh paper email still resolves when OpenAlex returns an HTTP error', async () => {
    const deps = {
      search: { async search() { return []; } },
      fetcher: { async fetch() { return []; } },
      fetchFn: (async () => httpError(429)) as typeof fetch,
    };
    const result = await resolveAndExtractContact(
      deps,
      { name: 'Jane Smith' },
      { affiliationHint: 'MIT' },
      { paperText: 'Corresponding author: jsmith@mit.edu', paperAgeMonths: 2 },
    );
    expect(result).toEqual({ email: 'jsmith@mit.edu', confidence: 0.95, source: 'pdf' });
  });

  test('does not throw when OpenAlex returns a non-JSON body', async () => {
    const deps = {
      search: { async search() { return []; } },
      fetcher: { async fetch() { return []; } },
      fetchFn: (async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }) as unknown as Response) as typeof fetch,
    };
    await expect(
      resolveAndExtractContact(deps, { name: 'Jane Smith' }, { affiliationHint: 'MIT' }, {
        paperText: 'Corresponding author: jsmith@mit.edu',
        paperAgeMonths: 2,
      }),
    ).resolves.toEqual({ email: 'jsmith@mit.edu', confidence: 0.95, source: 'pdf' });
  });
});

describe('minePerson resilience', () => {
  const raw: OpenAlexAuthorRaw = {
    id: 'https://openalex.org/A1',
    display_name: 'Jane Smith',
    affiliations: [{ institution: { display_name: 'MIT' }, years: [2024] }],
  };
  const candidate: OpenAlexCandidate = {
    id: 'A1', displayName: 'Jane Smith', concepts: ['Robotics'], affiliations: ['MIT'],
    coauthors: [], workTitles: [], externalIds: [], homepageUrls: ['https://mit.edu'],
  };
  const resolution: AuthorResolution = { author: candidate, signals: ['concept'] };
  const ctx: PaperContext = { affiliationHint: 'MIT' };

  test('returns OpenAlex facts even when the LLM throws on every call', async () => {
    const page = 'https://www.mit.edu/~jsmith';
    const deps: MineDeps = {
      search: { async search() { return [{ url: page, title: 'Jane Smith', content: '' }]; } },
      fetcher: { async fetch(urls) { return urls.map((url) => ({ url, title: '', content: 'bio' })); } },
      llm: { async complete() { throw new Error('LLM 502'); } },
    };
    const { facts, profileSummary } = await minePerson(deps, resolution, raw, ctx);
    expect(facts.some((f) => f.facet === 'trajectory' && f.value === 'MIT')).toBe(true);
    expect(typeof profileSummary).toBe('string'); // did not crash
  });

  test('returns OpenAlex facts even when the search provider throws', async () => {
    const deps: MineDeps = {
      search: { async search() { throw new Error('Tavily down'); } },
      fetcher: { async fetch() { return []; } },
      llm: { async complete() { return 'A profile.'; } },
    };
    const { facts } = await minePerson(deps, resolution, raw, ctx);
    expect(facts.some((f) => f.value === 'MIT')).toBe(true);
  });
});
