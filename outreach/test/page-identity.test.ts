import { describe, expect, it } from 'vitest';
import { pageIsAboutPerson, urlSlugMatchesPerson } from '../src/pipeline/research.js';
import type { WebPage } from '../src/pipeline/contacts.js';

const page = (over: Partial<WebPage> = {}): WebPage => ({
  url: 'https://chem.example.edu/publications/index.html',
  title: 'Publications',
  content: 'Publications\n\nA long list of papers from the group.',
  ...over,
});

// Every expectation in this block was VERIFIED against the old code and the
// old code returned the opposite (except the Kordel France case, which was
// already correct and must stay correct).
describe('pageIsAboutPerson: the verified short-surname no-op (D1)', () => {
  it('rejects a Publications page for Wei Li (old code: true, "publications" contains "li")', () => {
    expect(pageIsAboutPerson(page(), 'Wei Li')).toBe(false);
  });

  it('rejects an institute page for Jun He (old code: true)', () => {
    expect(
      pageIsAboutPerson(
        page({
          url: 'https://english.ie.cas.cn/about/',
          title: 'About us',
          content: 'The Institute of Chemistry\n\nFounded in 1956.',
        }),
        'Jun He',
      ),
    ).toBe(false);
  });

  it('rejects the same Publications page for a Western name (unchanged)', () => {
    expect(pageIsAboutPerson(page(), 'Kordel France')).toBe(false);
  });

  it('rejects a colleague profile on the same institution domain (the Jan Delcker incident)', () => {
    expect(
      pageIsAboutPerson(
        page({
          url: 'https://chem.example.edu/staff/dr-jan-delcker',
          title: 'Dr. Jan Delcker',
          content: 'Dr. Jan Delcker\n\nSenior researcher.',
        }),
        'Wei Li',
      ),
    ).toBe(false);
  });

  it('rejects an unrelated research page on an admitted domain (the Arctic sea ice incident)', () => {
    expect(
      pageIsAboutPerson(
        page({
          url: 'https://chem.example.edu/research/climate',
          title: 'Arctic sea ice variability',
          content: 'Arctic sea ice variability\n\nWe study the Barents Sea.',
        }),
        'Wei Li',
      ),
    ).toBe(false);
  });
});

describe('pageIsAboutPerson: pages that must still be admitted', () => {
  it('accepts a surname-first heading', () => {
    expect(
      pageIsAboutPerson(page({ title: 'Home', content: 'Li, Wei\n\nAssociate Professor.' }), 'Wei Li'),
    ).toBe(true);
  });

  it('accepts a first-initial heading', () => {
    expect(
      pageIsAboutPerson(page({ title: 'Home', content: 'W. Li\n\nAssociate Professor.' }), 'Wei Li'),
    ).toBe(true);
  });

  it('accepts identity carried by the URL slug when the heading is generic', () => {
    expect(
      pageIsAboutPerson(
        page({
          url: 'https://chem.example.edu/people/wli/publications',
          title: 'Publications',
          content: 'Publications\n\nA long list of papers.',
        }),
        'Wei Li',
      ),
    ).toBe(true);
  });

  it('accepts identity carried by the page title when the heading is a CJK banner', () => {
    expect(
      pageIsAboutPerson(
        page({
          url: 'https://chem.example.edu/people/12345',
          title: 'Wei Li - Faculty - Institute of Chemistry',
          content: '化学研究所\n\n个人主页',
        }),
        'Wei Li',
      ),
    ).toBe(true);
  });

  it('accepts a GitHub profile page by classification', () => {
    expect(
      pageIsAboutPerson(
        page({ url: 'https://github.com/someuser', title: 'someuser', content: 'Repos' }),
        'Wei Li',
      ),
    ).toBe(true);
  });

  it('does not crash on a malformed URL', () => {
    expect(pageIsAboutPerson(page({ url: 'not a url', content: 'Li, Wei' }), 'Wei Li')).toBe(true);
  });
});

describe('urlSlugMatchesPerson (D1)', () => {
  it('rejects a /publications/index path for Wei Li (old code: true)', () => {
    expect(urlSlugMatchesPerson('https://x.edu/publications/index', 'Wei Li')).toBe(false);
  });

  it('accepts a profile slug on a non-terminal segment', () => {
    expect(urlSlugMatchesPerson('https://x.edu/profile/liviaq/publications', 'Livia Q. Marlowe')).toBe(false);
    expect(urlSlugMatchesPerson('https://x.edu/profile/lmarlowe/publications', 'Livia Q. Marlowe')).toBe(true);
  });

  it('accepts a camelCase profile slug', () => {
    expect(urlSlugMatchesPerson('https://x.edu/BernhardKerbl/', 'Bernhard Kerbl')).toBe(true);
  });

  it('accepts a firstInitial+surname slug for a short surname', () => {
    expect(urlSlugMatchesPerson('https://x.edu/~wli/', 'Wei Li')).toBe(true);
  });

  it("rejects a colleague's slug", () => {
    expect(urlSlugMatchesPerson('https://x.edu/staff/dr-jan-delcker', 'Wei Li')).toBe(false);
  });

  it('returns null (cannot evaluate) for a bare domain root', () => {
    expect(urlSlugMatchesPerson('https://x.edu/', 'Wei Li')).toBe(null);
  });

  it('returns null for an unparseable URL', () => {
    expect(urlSlugMatchesPerson('not a url', 'Wei Li')).toBe(null);
  });
});
