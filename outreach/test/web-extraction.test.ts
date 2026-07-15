import { describe, expect, test } from 'vitest';
import {
  classifyWebPage,
  extractWebEmailCandidates,
  type WebPage,
} from '../src/pipeline/contacts.js';

// Tier 2/3: classify search-result pages (homepage vs directory vs github),
// then pull email candidates out of their content, including bracket-obfuscated
// forms like "agupta [at] asu [dot] edu".

const page = (url: string, title: string, content: string): WebPage => ({ url, title, content });

describe('classifyWebPage', () => {
  test('a page whose URL or title carries the person name is a homepage', () => {
    expect(classifyWebPage(page('https://www.asu.edu/~agupta/', 'Aditya Gupta', ''), 'Aditya Gupta')).toBe('homepage');
    expect(classifyWebPage(page('https://adityagupta.io', 'Home', ''), 'Aditya Gupta')).toBe('homepage');
  });

  test('a github.com page classifies as github_profile', () => {
    expect(classifyWebPage(page('https://github.com/agupta', 'agupta (Aditya Gupta)', ''), 'Aditya Gupta')).toBe('github_profile');
  });

  test('an institutional page without the person name is a directory', () => {
    expect(classifyWebPage(page('https://cs.asu.edu/people', 'Faculty Directory', ''), 'Aditya Gupta')).toBe('directory');
  });
});

describe('extractWebEmailCandidates', () => {
  test('extracts plain emails with the source of their page class', () => {
    const pages = [page('https://www.asu.edu/~agupta/', 'Aditya Gupta', 'Reach me at agupta@asu.edu')];
    expect(extractWebEmailCandidates(pages, 'Aditya Gupta')).toEqual([
      { email: 'agupta@asu.edu', source: 'homepage', correspondingMarker: false },
    ]);
  });

  test('deobfuscates bracketed at/dot forms', () => {
    const pages = [page('https://www.asu.edu/~agupta/', 'Aditya Gupta', 'email: agupta [at] asu [dot] edu')];
    expect(extractWebEmailCandidates(pages, 'Aditya Gupta')[0]?.email).toBe('agupta@asu.edu');
  });

  test('dedupes across pages, keeping the higher-confidence source class', () => {
    const pages = [
      page('https://cs.asu.edu/people', 'Faculty Directory', 'agupta@asu.edu'),
      page('https://www.asu.edu/~agupta/', 'Aditya Gupta', 'agupta@asu.edu'),
    ];
    const candidates = extractWebEmailCandidates(pages, 'Aditya Gupta');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('homepage');
  });
});
