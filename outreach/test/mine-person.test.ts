import { describe, expect, test } from 'vitest';
import {
  minePerson,
  type AuthorResolution,
  type MineDeps,
  type OpenAlexCandidate,
} from '../src/pipeline/research.js';
import type { OpenAlexAuthorRaw } from '../src/openalex/client.js';
import type { LLMClient } from '../src/llm/client.js';
import { EXTRACT_SYSTEM } from '../src/llm/prompts.js';
import type { PageFetcher, SearchClient, WebPage } from '../src/pipeline/contacts.js';

const raw: OpenAlexAuthorRaw = {
  id: 'https://openalex.org/A5001',
  display_name: 'Bernhard Kerbl',
  affiliations: [{ institution: { display_name: 'TU Wien' }, years: [2024, 2025] }],
};

const candidate: OpenAlexCandidate = {
  id: 'A5001',
  displayName: 'Bernhard Kerbl',
  concepts: ['Computer graphics'],
  affiliations: ['TU Wien'],
  coauthors: ['Georgios Kopanas'],
  workTitles: ['3D Gaussian Splatting'],
  externalIds: [],
  homepageUrls: ['https://www.cg.tuwien.ac.at/staff/BernhardKerbl'],
};

const resolution: AuthorResolution = { author: candidate, signals: ['coauthor'] };

// Fake LLM that branches on the system prompt (extract vs summary) and records
// how many times extraction ran (to assert retry / gating behavior).
function makeLLM(extract: (user: string) => string, summary = 'A short profile.') {
  const calls = { extract: [] as string[], summary: 0 };
  const client: LLMClient = {
    async complete(system, user) {
      if (system === EXTRACT_SYSTEM) {
        calls.extract.push(user);
        return extract(user);
      }
      calls.summary++;
      return summary;
    },
  };
  return { client, calls };
}

function makeDeps(opts: {
  llm: LLMClient;
  searchResults: WebPage[];
  fetched: Record<string, string>;
  searchLog?: string[];
}): MineDeps {
  const search: SearchClient = {
    async search(q: string) {
      opts.searchLog?.push(q);
      return opts.searchResults;
    },
  };
  const fetcher: PageFetcher = {
    async fetch(urls: string[]) {
      return urls.map((url) => ({ url, title: '', content: opts.fetched[url] ?? '' }));
    },
  };
  return { search, fetcher, llm: opts.llm };
}

describe('minePerson (D4/D5b/D6a)', () => {
  test('includes deterministic OpenAlex facts and runs the 3 personal searches', async () => {
    const searchLog: string[] = [];
    const { client } = makeLLM(() => '[]');
    const deps = makeDeps({ llm: client, searchResults: [], fetched: {}, searchLog });

    const { facts, profileSummary } = await minePerson(deps, resolution, raw);

    expect(searchLog).toHaveLength(3);
    expect(facts.some((f) => f.facet === 'trajectory' && f.key === 'institution' && f.value === 'TU Wien')).toBe(true);
    expect(profileSummary).toBe('A short profile.');
  });

  test('clamps an LLM-proposed tier A on a blog page down to B (D3 cap)', async () => {
    const blog = 'https://www.cg.tuwien.ac.at/blog/gaussian-splatting';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([
        { facet: 'interest', key: 'writing', value: 'Writes about Gaussian splatting', confidence: 0.8, proposedTier: 'A' },
      ]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: blog, title: 'Bernhard Kerbl', content: '' }],
      fetched: { [blog]: 'I love writing about Gaussian splatting.' },
    });

    const { facts } = await minePerson(deps, resolution, raw);

    const mined = facts.find((f) => f.sourceUrl === blog && f.key === 'writing');
    expect(calls.extract).toHaveLength(1);
    expect(mined).toBeDefined();
    expect(mined!.tier).toBe('B'); // proposed A, clamped to blog cap B
    expect(mined!.facet).toBe('interest');
  });

  test('drops an off-domain homonym page before calling the LLM (D5b gate)', async () => {
    const homonym = 'https://kerbl-law.example.com/about';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([{ facet: 'trajectory', key: 'role', value: 'Attorney', confidence: 0.8, proposedTier: 'A' }]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: homonym, title: 'Bernhard Kerbl', content: '' }],
      fetched: { [homonym]: 'Bernhard Kerbl, attorney at law.' },
    });

    const { facts } = await minePerson(deps, resolution, raw);

    expect(calls.extract).toHaveLength(0); // gated out, never sent to the LLM
    expect(facts.some((f) => f.sourceUrl === homonym)).toBe(false);
  });

  test('allows a page on the institution academic domain when the anchor is its marketing domain', async () => {
    // Live case: TU Wien's OpenAlex homepage is tuwien.at, but Kerbl's real
    // staff page is on cg.tuwien.ac.at. Same institution, different registrable
    // domain; the gate must match on the institution label, not the full domain.
    const anchoredByMarketingDomain: AuthorResolution = {
      author: { ...candidate, homepageUrls: ['https://www.tuwien.at'] },
      signals: ['coauthor'],
    };
    const staffPage = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([{ facet: 'interest', key: 'community', value: 'Vienna graphics group', confidence: 0.7, proposedTier: 'B' }]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: staffPage, title: 'Bernhard Kerbl', content: '' }],
      fetched: { [staffPage]: 'Bernhard Kerbl, TU Wien.' },
    });

    const { facts } = await minePerson(deps, anchoredByMarketingDomain, raw);

    expect(calls.extract).toHaveLength(1); // not gated out
    expect(facts.some((f) => f.sourceUrl === staffPage)).toBe(true);
  });

  test('splits a recipient hobby list into individual facts (shared with persona)', async () => {
    const page = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    const { client } = makeLLM(() =>
      JSON.stringify([{ facet: 'interest', key: 'hobby', value: 'chess, hiking', confidence: 0.7, proposedTier: 'B' }]),
    );
    const deps = makeDeps({ llm: client, searchResults: [{ url: page, title: 'Bernhard Kerbl', content: '' }], fetched: { [page]: 'bio' } });
    const { facts } = await minePerson(deps, resolution, raw);
    const hobbies = facts.filter((f) => f.key === 'hobby');
    expect(hobbies.map((f) => f.value).sort()).toEqual(['chess', 'hiking']);
    expect(hobbies.every((f) => f.tier === 'B')).toBe(true);
  });

  test('retries once on JSON parse failure then skips the page without crashing', async () => {
    const talk = 'https://www.cg.tuwien.ac.at/talks/kerbl';
    const { client, calls } = makeLLM(() => 'not json at all {');
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: talk, title: 'Bernhard Kerbl talk', content: '' }],
      fetched: { [talk]: 'A talk by Bernhard Kerbl.' },
    });

    const { facts, profileSummary } = await minePerson(deps, resolution, raw);

    expect(calls.extract).toHaveLength(2); // original + one retry
    expect(facts.some((f) => f.sourceUrl === talk)).toBe(false);
    expect(profileSummary).toBe('A short profile.'); // run did not crash
  });
});
