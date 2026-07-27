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
  // Two searches, not three: the github query was removed because the D5b gate
  // admits only institution-domain pages, so its results were always discarded.
  test('includes deterministic OpenAlex facts and runs the 2 personal searches', async () => {
    const searchLog: string[] = [];
    const { client } = makeLLM(() => '[]');
    const deps = makeDeps({ llm: client, searchResults: [], fetched: {}, searchLog });

    const { facts, profileSummary } = await minePerson(deps, resolution, raw);

    expect(searchLog).toHaveLength(2);
    expect(searchLog.some((q) => q.includes('github'))).toBe(false);
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

  test('rejects a different CAS institute sharing only the "cas" label (D5b domain gate, live case: Hanbo Bi)', async () => {
    // Live bug: english.qdio.cas.cn (Qingdao Institute of Oceanology, the real
    // anchor) and english.ie.cas.cn (Institute of Electronics) both reduce to
    // the label "cas" under naive label matching, so Hanbo Bi's profile picked
    // up 17 facts about Arctic sea ice from an entirely different institute.
    const hanboBi: AuthorResolution = {
      author: { ...candidate, displayName: 'Hanbo Bi', homepageUrls: ['https://english.qdio.cas.cn/'] },
      signals: ['coauthor'],
    };
    const contaminated = 'https://english.ie.cas.cn/about/people/hanbo-bi';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([{ facet: 'academic', key: 'research_area', value: 'Arctic sea ice variability', confidence: 0.8, proposedTier: 'A' }]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: contaminated, title: 'Hanbo Bi', content: 'Hanbo Bi studies Arctic sea ice variability.' }],
      fetched: { [contaminated]: 'Hanbo Bi studies Arctic sea ice variability.' },
    });

    const { facts } = await minePerson(deps, hanboBi, { ...raw, id: 'https://openalex.org/A_HANBO', display_name: 'Hanbo Bi' });

    expect(calls.extract).toHaveLength(0); // gated out before the LLM ever sees it
    expect(facts.some((f) => f.sourceUrl === contaminated)).toBe(false);
  });

  test('rejects a different Oxford college sharing only the "ox" label (D5b domain gate, live case: Robin Karlsson)', async () => {
    // Live bug: balliol.ox.ac.uk (Balliol College) and maths.ox.ac.uk (Oxford
    // Maths) both reduce to the label "ox", so Robin Karlsson's profile picked
    // up 23 facts about Black Holes / AdS-CFT / conformal bootstrap from a
    // completely different Oxford department.
    const robinKarlsson: AuthorResolution = {
      author: { ...candidate, displayName: 'Robin Karlsson', homepageUrls: ['https://balliol.ox.ac.uk/'] },
      signals: ['coauthor'],
    };
    const contaminated = 'https://maths.ox.ac.uk/people/robin-karlsson';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([{ facet: 'academic', key: 'research_area', value: 'AdS/CFT', confidence: 0.8, proposedTier: 'A' }]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: contaminated, title: 'Robin Karlsson', content: 'Robin Karlsson works on Black Holes and AdS/CFT.' }],
      fetched: { [contaminated]: 'Robin Karlsson works on Black Holes and AdS/CFT.' },
    });

    const { facts } = await minePerson(deps, robinKarlsson, { ...raw, id: 'https://openalex.org/A_ROBIN', display_name: 'Robin Karlsson' });

    expect(calls.extract).toHaveLength(0);
    expect(facts.some((f) => f.sourceUrl === contaminated)).toBe(false);
  });

  test('rejects a colleague page on the SAME on-domain site (D5b person-page gate, live case: Nicolai Plintz / Jan Delcker)', async () => {
    // Live bug: the domain gate passes (same host as the anchor), but the page
    // is a team profile for a different person, Dr. Jan Delcker. Nicolai
    // Plintz's profile picked up 10 facts, including Jan Delcker's title and
    // research areas, from this exact URL.
    const nicolaiPlintz: AuthorResolution = {
      author: { ...candidate, displayName: 'Nicolai Plintz', homepageUrls: ['https://www.bwl.uni-mannheim.de/ifenthaler/'] },
      signals: ['coauthor'],
    };
    const colleaguePage = 'https://www.bwl.uni-mannheim.de/en/ifenthaler/team/dr-jan-delcker';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([{ facet: 'trajectory', key: 'role', value: 'Research Associate', confidence: 0.8, proposedTier: 'A' }]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: colleaguePage, title: 'Dr. Jan Delcker - Team - Chair of Ifenthaler', content: '' }],
      fetched: { [colleaguePage]: 'Dr. Jan Delcker\nResearch Associate, Chair of Learning, Design and Technology.' },
    });

    const { facts } = await minePerson(deps, nicolaiPlintz, { ...raw, id: 'https://openalex.org/A_PLINTZ', display_name: 'Nicolai Plintz' });

    expect(calls.extract).toHaveLength(0); // same-domain, but not about the target: rejected
    expect(facts.some((f) => f.sourceUrl === colleaguePage)).toBe(false);
  });

  test('rejects a colleague page on the SAME on-domain site (D5b person-page gate, live case: Arvind Murari Vepa / Aravinth Ruppa)', async () => {
    // Live bug: same host as the anchor, but the page is about a different
    // student, Aravinth Ruppa. Arvind Murari Vepa's profile picked up 7 facts,
    // including "Undergraduate Student" and Economics research areas, from
    // this exact URL.
    const arvindVepa: AuthorResolution = {
      author: { ...candidate, displayName: 'Arvind Murari Vepa', homepageUrls: ['https://chianglab.healthsciences.ucla.edu/'] },
      signals: ['coauthor'],
    };
    const colleaguePage = 'https://chianglab.healthsciences.ucla.edu/people/aravinth-ruppa';
    const { client, calls } = makeLLM(() =>
      JSON.stringify([{ facet: 'trajectory', key: 'role', value: 'Undergraduate Student', confidence: 0.8, proposedTier: 'A' }]),
    );
    const deps = makeDeps({
      llm: client,
      searchResults: [{ url: colleaguePage, title: 'Aravinth Ruppa | Chiang Lab', content: '' }],
      fetched: { [colleaguePage]: 'Aravinth Ruppa\nUndergraduate Student, Economics.' },
    });

    const { facts } = await minePerson(deps, arvindVepa, { ...raw, id: 'https://openalex.org/A_VEPA', display_name: 'Arvind Murari Vepa' });

    expect(calls.extract).toHaveLength(0);
    expect(facts.some((f) => f.sourceUrl === colleaguePage)).toBe(false);
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
