import { describe, expect, test } from 'vitest';
import { extractContact, type ContactDeps, type WebPage } from '../src/pipeline/contacts.js';

// D1c: when pass 1 finds the homepage but no email (obfuscated), pass 2 derives
// the institution domain from that homepage and re-queries to find the email,
// fully automatically (no human-supplied affiliation).

function deps(config: {
  byQuery: (q: string) => WebPage[];
  fetched?: Record<string, string>;
  searchLog?: string[];
}): ContactDeps {
  return {
    search: {
      async search(q: string) {
        config.searchLog?.push(q);
        return config.byQuery(q);
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        return urls.map((url) => ({ url, title: '', content: config.fetched?.[url] ?? '' }));
      },
    },
  };
}

const KERBL = { name: 'Bernhard Kerbl' }; // NO affiliation supplied

describe('automated affiliation-discovery second pass (D1c)', () => {
  test('finds current email via a domain-scoped second query', async () => {
    const homepage = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    const inst = 'https://informatics.tuwien.ac.at/people/bernhard-kerbl';
    const searchLog: string[] = [];
    const d = deps({
      searchLog,
      byQuery(q) {
        // Pass 1: name search finds the homepage, but no email anywhere on it.
        if (!q.includes('tuwien.ac.at')) return [{ url: homepage, title: 'Bernhard Kerbl', content: '' }];
        // Pass 2: domain-scoped query surfaces the institutional directory page.
        return [{ url: inst, title: 'Bernhard Kerbl', content: 'email: bernhard.kerbl@tuwien.ac.at' }];
      },
      fetched: { [homepage]: 'contact form only, no address' },
    });
    const result = await extractContact(d, KERBL, null);
    expect(result?.email).toBe('bernhard.kerbl@tuwien.ac.at');
    expect(searchLog.some((q) => q.includes('tuwien.ac.at'))).toBe(true);
  });

  test('does NOT run a second pass when pass 1 already found a confident email', async () => {
    const homepage = 'https://kordelfrance.ai';
    const searchLog: string[] = [];
    const d = deps({
      searchLog,
      byQuery: () => [{ url: homepage, title: 'Kordel France', content: 'kordel@utdallas.edu' }],
    });
    const result = await extractContact(d, { name: 'Kordel France' }, null);
    expect(result?.email).toBe('kordel@utdallas.edu');
    // only the two pass-1 queries, no domain-scoped pass-2 query
    expect(searchLog.every((q) => !q.includes('utdallas.edu'))).toBe(true);
  });

  test('still returns null when no pass finds a name-matching email', async () => {
    const d = deps({
      byQuery: () => [{ url: 'https://cs.example.edu/people', title: 'Directory', content: 'info@example.edu' }],
      fetched: { 'https://cs.example.edu/people': 'no personal email here' },
    });
    const result = await extractContact(d, KERBL, null);
    expect(result).toBeNull();
  });
});
