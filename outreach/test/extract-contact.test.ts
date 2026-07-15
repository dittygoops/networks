import { describe, expect, test } from 'vitest';
import { extractContact, type SearchClient, type WebPage } from '../src/pipeline/contacts.js';

// Orchestration: tier 1 (paper text) short-circuits web search; tier 2/3 run
// only when the paper yields nothing send-eligible; below 0.7 overall → null.

const fakeSearch = (results: WebPage[], log: string[] = []): SearchClient => ({
  async search(query: string) {
    log.push(query);
    return results;
  },
});

const PERSON = { name: 'Aditya Gupta', affiliation: 'Arizona State University' };

describe('extractContact', () => {
  test('returns a tier-1 corresponding email without searching the web', async () => {
    const log: string[] = [];
    const result = await extractContact(
      { search: fakeSearch([], log) },
      PERSON,
      'Corresponding author: agupta@asu.edu',
    );
    expect(result).toEqual({ email: 'agupta@asu.edu', confidence: 0.95, source: 'pdf' });
    expect(log).toHaveLength(0);
  });

  test('falls back to web search when the paper has no send-eligible email', async () => {
    const pages: WebPage[] = [
      { url: 'https://www.asu.edu/~agupta/', title: 'Aditya Gupta', content: 'contact: gupta3@asu.edu' },
    ];
    const result = await extractContact({ search: fakeSearch(pages) }, PERSON, 'no emails here');
    expect(result).toEqual({ email: 'gupta3@asu.edu', confidence: 0.85, source: 'homepage' });
  });

  test('returns null when nothing reaches the 0.7 threshold', async () => {
    const pages: WebPage[] = [
      { url: 'https://somewhere.org/list', title: 'Attendees', content: 'unrelated@other.org' },
    ];
    const result = await extractContact({ search: fakeSearch(pages) }, PERSON, null);
    expect(result).toBeNull();
  });

  test('includes name and affiliation in the search query', async () => {
    const log: string[] = [];
    await extractContact({ search: fakeSearch([], log) }, PERSON, null);
    expect(log.some((q) => q.includes('Aditya Gupta') && q.includes('Arizona State University'))).toBe(true);
  });
});
