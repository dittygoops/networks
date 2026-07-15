import { describe, expect, test } from 'vitest';
import {
  FACT_VOCABULARY,
  normalizeKey,
  factsFromOpenAlex,
  minePerson,
  type AuthorResolution,
  type MineDeps,
  type OntologyFact,
  type OpenAlexCandidate,
} from '../src/pipeline/research.js';
import type { OpenAlexAuthorRaw } from '../src/openalex/client.js';
import type { LLMClient } from '../src/llm/client.js';
import { EXTRACT_SYSTEM } from '../src/llm/prompts.js';
import type { PageFetcher, SearchClient, WebPage } from '../src/pipeline/contacts.js';

describe('FACT_VOCABULARY', () => {
  test('academic list includes collaborator and project (reconciled with code)', () => {
    expect(FACT_VOCABULARY.academic).toContain('collaborator');
    expect(FACT_VOCABULARY.academic).toContain('project');
    expect(FACT_VOCABULARY.academic).toContain('research_area');
  });

  test('has an array of keys for every facet', () => {
    expect(Array.isArray(FACT_VOCABULARY.academic)).toBe(true);
    expect(Array.isArray(FACT_VOCABULARY.trajectory)).toBe(true);
    expect(Array.isArray(FACT_VOCABULARY.interest)).toBe(true);
  });
});

describe('normalizeKey', () => {
  test('maps known variants to their canonical key', () => {
    expect(normalizeKey('academic', 'methods')).toBe('method');
    expect(normalizeKey('academic', 'projects')).toBe('project');
    expect(normalizeKey('academic', 'research area')).toBe('research_area');
  });

  test('lowercases and snake_cases an already-canonical key spelled loosely', () => {
    expect(normalizeKey('academic', 'Research Area')).toBe('research_area');
    expect(normalizeKey('academic', 'research-area')).toBe('research_area');
  });

  test('passes unknown keys through snake-cased, never dropping them', () => {
    expect(normalizeKey('interest', 'Favorite Sport')).toBe('favorite_sport');
    expect(normalizeKey('academic', 'grant number')).toBe('grant_number');
  });
});

// -- shared fixtures for the mining tests --------------------------------------

const raw: OpenAlexAuthorRaw = {
  id: 'https://openalex.org/A5001',
  display_name: 'Bernhard Kerbl',
  affiliations: [{ institution: { display_name: 'TU Wien' }, years: [2024, 2025] }],
};

const candidate: OpenAlexCandidate = {
  id: 'A5001',
  displayName: 'Bernhard Kerbl',
  concepts: ['Computer graphics (images)', 'Rendering (computer graphics)', 'Computer Graphics'],
  affiliations: ['TU Wien'],
  coauthors: ['Georgios Kopanas'],
  workTitles: ['3D Gaussian Splatting'],
  externalIds: [],
  homepageUrls: ['https://www.cg.tuwien.ac.at/staff/BernhardKerbl'],
};

const resolution: AuthorResolution = { author: candidate, signals: ['coauthor'] };

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

function makeDeps(opts: { llm: LLMClient; searchResults: WebPage[]; fetched: Record<string, string> }): MineDeps {
  const search: SearchClient = {
    async search() {
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

describe('factsFromOpenAlex canonicalizes research_area concepts', () => {
  test('collapses the "Computer graphics" case/qualifier variants (no 3 separate facts)', () => {
    const facts = factsFromOpenAlex(candidate, raw);
    const areas = facts.filter((f) => f.facet === 'academic' && f.key === 'research_area');
    // "Computer graphics (images)" and "Computer Graphics" collapse to one;
    // "Rendering (computer graphics)" stays as a genuinely distinct concept.
    expect(areas).toHaveLength(2);
    const graphics = areas.filter((f) => f.value.toLowerCase().replace(/\([^)]*\)/g, '').trim() === 'computer graphics');
    expect(graphics).toHaveLength(1);
  });
});

describe('minePersonalFacts normalizes LLM-extracted keys', () => {
  test('a fact whose LLM key is a known variant dedupes with the canonical form', async () => {
    const page = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    // OpenAlex already emits academic/method-ish keys? No; here the LLM emits the
    // variant "methods" which must normalize to "method".
    const { client } = makeLLM(() =>
      JSON.stringify([
        { facet: 'academic', key: 'methods', value: 'Gaussian splatting', confidence: 0.8, proposedTier: 'A' },
      ]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: page, title: 'Bernhard Kerbl', content: '' }],
      fetched: { [page]: 'Bernhard Kerbl works on Gaussian splatting.' },
    });

    const { facts } = await minePerson(deps, resolution, raw);
    const mined = facts.find((f: OntologyFact) => f.sourceUrl === page && f.value === 'Gaussian splatting');
    expect(mined).toBeDefined();
    expect(mined!.key).toBe('method');
  });
});
