import { describe, expect, test } from 'vitest';
import { extractContact, type ContactDeps, type WebPage } from '../src/pipeline/contacts.js';

// D5a: paper context enriches pass-1 queries (affiliation + area terms) and,
// when no disambiguating context exists at all, web emails are capped below the
// send threshold (→ manual queue) so a common-name homonym is never emailed.

function deps(config: {
  byQuery?: (q: string) => WebPage[];
  pages?: WebPage[];
  searchLog?: string[];
}): ContactDeps {
  return {
    search: {
      async search(q: string) {
        config.searchLog?.push(q);
        return config.byQuery ? config.byQuery(q) : (config.pages ?? []);
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        return urls.map((url) => ({ url, title: '', content: '' }));
      },
    },
  };
}

describe('D5a paper-context enrichment', () => {
  test('pass-1 query includes the affiliation hint', async () => {
    const searchLog: string[] = [];
    await extractContact(deps({ searchLog }), { name: 'Jonathan Barron' }, null, {
      paperContext: { affiliationHint: 'Google' },
    });
    expect(searchLog.some((q) => q.includes('Jonathan Barron') && q.includes('Google'))).toBe(true);
  });

  test('area terms are NOT put in the query (they over-anchor to the paper)', async () => {
    const searchLog: string[] = [];
    await extractContact(deps({ searchLog }), { name: 'Bernhard Kerbl' }, null, {
      paperContext: { affiliationHint: 'INRIA', areaTerms: ['gaussian splatting'] },
    });
    expect(searchLog.every((q) => !q.includes('gaussian'))).toBe(true);
  });

  test('a homepage email is trusted when context is present', async () => {
    const page: WebPage = { url: 'https://jonbarron.info', title: 'Jonathan Barron', content: 'jbarron@google.com' };
    const result = await extractContact(deps({ pages: [page] }), { name: 'Jonathan Barron' }, null, {
      paperContext: { affiliationHint: 'Google' },
    });
    expect(result).toEqual({ email: 'jbarron@google.com', confidence: 0.85, source: 'homepage' });
  });
});

describe('D5a conservative guard (no disambiguating context)', () => {
  test('caps web emails below threshold when no affiliation and no area terms', async () => {
    const page: WebPage = { url: 'https://honors.umaine.edu/x', title: 'Jonathan Barron', content: 'jbarron@maine.edu' };
    // Same page/email that would otherwise score 0.85 homepage; with zero
    // context it must not clear 0.7, so extraction returns null (→ manual).
    const result = await extractContact(deps({ pages: [page] }), { name: 'Jonathan Barron' }, null, {});
    expect(result).toBeNull();
  });

  test('the guard does not affect paper (tier-1) emails', async () => {
    // A fresh paper email is unaffected by the web-context guard.
    const result = await extractContact(deps({}), { name: 'Jonathan Barron' }, 'corresponding author jbarron@google.com', {
      paperAgeMonths: 2,
    });
    expect(result?.email).toBe('jbarron@google.com');
  });
});
