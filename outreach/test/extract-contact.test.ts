import { describe, expect, test } from 'vitest';
import { extractContact, type ContactDeps, type WebPage } from '../src/pipeline/contacts.js';

// Orchestration basics (see reconcile.test.ts for age/reconciliation rules):
// tier 1 short-circuits a fresh paper; otherwise web is consulted; below 0.7 → null.

function makeDeps(pages: WebPage[], fetched: Record<string, string>, searchLog: string[] = []): ContactDeps {
  return {
    search: {
      async search(q: string) {
        searchLog.push(q);
        return pages;
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        return urls.map((url) => ({ url, title: '', content: fetched[url] ?? '' }));
      },
    },
  };
}

const PERSON = { name: 'Aditya Gupta', affiliation: 'Arizona State University' };

describe('extractContact', () => {
  test('returns a fresh tier-1 corresponding email without searching the web', async () => {
    const log: string[] = [];
    const result = await extractContact(
      makeDeps([], {}, log),
      PERSON,
      'Corresponding author: agupta@asu.edu',
      { paperAgeMonths: 2 },
    );
    expect(result).toEqual({ email: 'agupta@asu.edu', confidence: 0.95, source: 'pdf' });
    expect(log).toHaveLength(0);
  });

  test('falls back to web when the paper has no send-eligible email', async () => {
    const homepage = 'https://www.asu.edu/~agupta/';
    const deps = makeDeps(
      [{ url: homepage, title: 'Aditya Gupta', content: '' }],
      { [homepage]: 'contact: gupta3@asu.edu' },
    );
    const result = await extractContact(deps, PERSON, 'no emails here');
    expect(result).toEqual({ email: 'gupta3@asu.edu', confidence: 0.85, source: 'homepage' });
  });

  test('returns null when nothing reaches the 0.7 threshold', async () => {
    const page = 'https://somewhere.org/list';
    const deps = makeDeps([{ url: page, title: 'Attendees', content: '' }], { [page]: 'unrelated@other.org' });
    const result = await extractContact(deps, PERSON, null);
    expect(result).toBeNull();
  });

  test('includes name and affiliation in the search query', async () => {
    const log: string[] = [];
    await extractContact(makeDeps([], {}, log), PERSON, null);
    expect(log.some((q) => q.includes('Aditya Gupta') && q.includes('Arizona State University'))).toBe(true);
  });
});
