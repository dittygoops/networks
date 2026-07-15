import { describe, expect, test } from 'vitest';
import { classifyWebPage, type WebPage } from '../src/pipeline/contacts.js';

// D1b: aggregator hosts are never homepages, even when the person's name is in
// the URL/title. They rank below real homepages and directory pages.

const page = (url: string, title = 'x'): WebPage => ({ url, title, content: '' });

describe('classifyWebPage aggregator handling (D1b)', () => {
  test.each([
    'https://rocketreach.co/kordel-france-email_70687072',
    'https://www.researchgate.net/profile/Kordel-France',
    'https://tu-wien.academia.edu/BernhardKerbl',
    'https://scholar.google.com/citations?user=abc',
    'https://dl.acm.org/profile/99660951699',
    'https://kitcaster.com/kordel-k-france',
  ])('classifies %s as aggregator', (url) => {
    expect(classifyWebPage(page(url, 'Kordel France'), 'Kordel France')).toBe('aggregator');
  });

  test('a real personal homepage is still a homepage', () => {
    expect(classifyWebPage(page('https://kordelfrance.ai', 'Kordel France'), 'Kordel France')).toBe('homepage');
  });

  test('a university staff page is still a homepage', () => {
    expect(classifyWebPage(page('https://www.cg.tuwien.ac.at/staff/BernhardKerbl', 'Bernhard Kerbl'), 'Bernhard Kerbl')).toBe('homepage');
  });

  test('github is still github_profile', () => {
    expect(classifyWebPage(page('https://github.com/KordelFranceTech', 'x'), 'Kordel France')).toBe('github_profile');
  });
});
