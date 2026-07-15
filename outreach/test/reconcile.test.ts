import { describe, expect, test } from 'vitest';
import { extractContact, type ContactDeps, type WebPage } from '../src/pipeline/contacts.js';

// D1a: fresh papers short-circuit; old papers also run web and reconcile,
// letting a current web email outrank a stale paper email.
// D1b: web tier fetches full page content for top non-aggregator results.

function makeDeps(opts: {
  searchResults?: WebPage[];
  fetched?: Record<string, string>; // url -> full content
  searchLog?: string[];
  fetchLog?: string[];
}): ContactDeps {
  return {
    search: {
      async search(q: string) {
        opts.searchLog?.push(q);
        return opts.searchResults ?? [];
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        opts.fetchLog?.push(...urls);
        return urls.map((url) => ({ url, title: '', content: opts.fetched?.[url] ?? '' }));
      },
    },
  };
}

const PERSON = { name: 'Bernhard Kerbl', affiliation: 'INRIA' };

describe('extractContact reconciliation (D1a/D1b)', () => {
  test('fresh paper with a good email short-circuits, no web calls', async () => {
    const searchLog: string[] = [];
    const deps = makeDeps({ searchLog });
    const result = await extractContact(deps, PERSON, 'Corresponding author: bernhard.kerbl@inria.fr', {
      paperAgeMonths: 3,
    });
    expect(result).toEqual({ email: 'bernhard.kerbl@inria.fr', confidence: 0.95, source: 'pdf' });
    expect(searchLog).toHaveLength(0);
  });

  test('old paper runs web and a fresh homepage email outranks the stale paper email', async () => {
    const homepage = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    const deps = makeDeps({
      searchResults: [{ url: homepage, title: 'Bernhard Kerbl', content: '' }],
      fetched: { [homepage]: 'Contact: kerbl@cg.tuwien.ac.at' },
    });
    // paper email decays 0.95 -> 0.65 at ~4 years; homepage stays 0.85
    const result = await extractContact(deps, PERSON, 'Corresponding author: bernhard.kerbl@inria.fr', {
      paperAgeMonths: 47,
    });
    expect(result).toEqual({ email: 'kerbl@cg.tuwien.ac.at', confidence: 0.85, source: 'homepage' });
  });

  test('web tier fetches full content of top non-aggregator pages, skipping aggregators', async () => {
    const fetchLog: string[] = [];
    const homepage = 'https://kordelfrance.ai';
    const deps = makeDeps({
      searchResults: [
        { url: 'https://rocketreach.co/x', title: 'Kordel France', content: '' },
        { url: homepage, title: 'Kordel France', content: '' },
      ],
      fetched: { [homepage]: 'reach me: kordel@utdallas.edu' },
      fetchLog,
    });
    const result = await extractContact(deps, { name: 'Kordel France', affiliation: 'UT Dallas' }, null, {});
    expect(fetchLog).toContain(homepage);
    expect(fetchLog).not.toContain('https://rocketreach.co/x');
    expect(result?.email).toBe('kordel@utdallas.edu');
  });

  test('returns null when neither source yields a name-matching email', async () => {
    const page = 'https://example.org/list';
    const deps = makeDeps({
      searchResults: [{ url: page, title: 'Attendees', content: '' }],
      fetched: { [page]: 'unrelated@example.org' },
    });
    const result = await extractContact(deps, PERSON, 'no email here', { paperAgeMonths: 60 });
    expect(result).toBeNull();
  });
});
