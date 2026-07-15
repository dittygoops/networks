import { describe, expect, test } from 'vitest';
import { collectInstitutionDomains, type WebPage } from '../src/pipeline/contacts.js';

// D-domain: reduce found homepage/directory pages to unique registrable
// institution domains (public-suffix aware), excluding aggregators and generic
// hosts, keeping top 2 by input order.

const page = (url: string, title = 'x'): WebPage => ({ url, title, content: '' });

describe('collectInstitutionDomains (D-domain)', () => {
  test('reduces multi-label academic hosts to registrable domain', () => {
    const domains = collectInstitutionDomains(
      [page('https://www.cg.tuwien.ac.at/staff/BernhardKerbl', 'Bernhard Kerbl')],
      'Bernhard Kerbl',
    );
    expect(domains).toEqual(['tuwien.ac.at']);
  });

  test('handles .ku.dk style hosts', () => {
    const domains = collectInstitutionDomains(
      [page('https://di.ku.dk/english/staff/x', 'Bernhard Kerbl')],
      'Bernhard Kerbl',
    );
    expect(domains).toEqual(['ku.dk']);
  });

  test('excludes aggregator domains', () => {
    const domains = collectInstitutionDomains(
      [page('https://www.researchgate.net/profile/Bernhard-Kerbl', 'Bernhard Kerbl')],
      'Bernhard Kerbl',
    );
    expect(domains).toEqual([]);
  });

  test('excludes generic hosting domains', () => {
    const domains = collectInstitutionDomains(
      [page('https://someone.github.io/', 'Bernhard Kerbl'), page('https://sites.google.com/x', 'Bernhard Kerbl')],
      'Bernhard Kerbl',
    );
    expect(domains).toEqual([]);
  });

  test('dedupes and keeps only the top 2 by order', () => {
    const domains = collectInstitutionDomains(
      [
        page('https://cs.stanford.edu/~a', 'Bernhard Kerbl'),
        page('https://cs.stanford.edu/~b', 'Bernhard Kerbl'),
        page('https://mit.edu/~c', 'Bernhard Kerbl'),
        page('https://cmu.edu/~d', 'Bernhard Kerbl'),
      ],
      'Bernhard Kerbl',
    );
    expect(domains).toEqual(['stanford.edu', 'mit.edu']);
  });

  test('ignores github pages (handled by a different tier)', () => {
    const domains = collectInstitutionDomains([page('https://github.com/KerblB', 'x')], 'Bernhard Kerbl');
    expect(domains).toEqual([]);
  });
});
