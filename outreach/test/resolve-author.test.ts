import { describe, expect, test } from 'vitest';
import { resolveAuthor, type OpenAlexCandidate } from '../src/pipeline/research.js';
import type { PaperContext } from '../src/pipeline/contacts.js';

// D5b: name prefilter, then corroborate against paper context.
// Strong: a work co-author matches a paper co-author (last name >= 4 chars),
// or a work title matches, or the arXiv id matches. Weak: concept overlap +
// affiliation match. Accept with >=1 strong or >=2 weak; else UNRESOLVED.

const cand = (partial: Partial<OpenAlexCandidate> & { id: string; displayName: string }): OpenAlexCandidate => ({
  concepts: [],
  affiliations: [],
  coauthors: [],
  workTitles: [],
  externalIds: [],
  ...partial,
});

// NeRF paper context (real Jonathan T. Barron case)
const NERF: PaperContext = {
  coauthors: ['Ben Mildenhall', 'Pratul Srinivasan', 'Matthew Tancik', 'Ravi Ramamoorthi', 'Ren Ng'],
  title: 'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
  arxivId: '2003.08934',
  areaTerms: ['computer vision', 'neural rendering'],
  affiliationHint: 'Google',
};

describe('resolveAuthor name prefilter (D5b)', () => {
  test('drops candidates whose name does not match the target (collaborators)', () => {
    const candidates = [
      cand({ id: 'A_poole', displayName: 'Ben Poole', coauthors: ['Ben Mildenhall'] }),
      cand({ id: 'A_barron', displayName: 'Jonathan T. Barron', coauthors: ['Ben Mildenhall', 'Matthew Tancik'] }),
    ];
    const result = resolveAuthor(candidates, 'Jonathan Barron', NERF);
    expect(result?.author.id).toBe('A_barron');
  });
});

describe('resolveAuthor corroboration (D5b)', () => {
  test('strong signal: co-author full-name match resolves the author', () => {
    const candidates = [cand({ id: 'A1', displayName: 'Jonathan T. Barron', coauthors: ['Matthew Tancik', 'someone else'] })];
    const result = resolveAuthor(candidates, 'Jonathan Barron', NERF);
    expect(result?.author.id).toBe('A1');
    expect(result?.signals).toContain('coauthor');
  });

  test('strong signal: arXiv id match resolves the author', () => {
    const candidates = [cand({ id: 'A1', displayName: 'Jonathan Barron', externalIds: ['arXiv:2003.08934'] })];
    expect(resolveAuthor(candidates, 'Jonathan Barron', NERF)?.author.id).toBe('A1');
  });

  test('rejects the homonym: name matches but no corroborating signal', () => {
    const candidates = [
      cand({ id: 'A_finance', displayName: 'Jonathan Barron Baskin', concepts: ['Finance'], affiliations: ['Wall Street'] }),
      cand({ id: 'A_poet', displayName: 'Jonathan N. Barron', concepts: ['Poetry'], affiliations: ['Some College'] }),
    ];
    expect(resolveAuthor(candidates, 'Jonathan Barron', NERF)).toBeNull();
  });

  test('short co-author tokens do not count (the "Ng" trap)', () => {
    // "Ren Ng" -> last name "Ng" is < 4 chars, must not corroborate on its own.
    const candidates = [cand({ id: 'A1', displayName: 'Jonathan Barron', coauthors: ['Ng', 'Ng Ng'] })];
    expect(resolveAuthor(candidates, 'Jonathan Barron', NERF)).toBeNull();
  });

  test('two weak signals (concept overlap + affiliation) resolve when no strong signal', () => {
    const candidates = [
      cand({ id: 'A1', displayName: 'Jonathan Barron', concepts: ['Computer Vision'], affiliations: ['Google Research'] }),
    ];
    const result = resolveAuthor(candidates, 'Jonathan Barron', NERF);
    expect(result?.author.id).toBe('A1');
    expect(result?.signals).toEqual(expect.arrayContaining(['concept', 'affiliation']));
  });

  test('a single weak signal is not enough', () => {
    const candidates = [cand({ id: 'A1', displayName: 'Jonathan Barron', concepts: ['Computer Vision'], affiliations: ['Nowhere'] })];
    expect(resolveAuthor(candidates, 'Jonathan Barron', NERF)).toBeNull();
  });

  test('returns null on empty candidate list', () => {
    expect(resolveAuthor([], 'Jonathan Barron', NERF)).toBeNull();
  });

  test('picks the strongest candidate when several name-match', () => {
    const candidates = [
      cand({ id: 'weak', displayName: 'Jonathan Barron', concepts: ['Computer Vision'], affiliations: ['Google'] }),
      cand({ id: 'strong', displayName: 'Jonathan T. Barron', coauthors: ['Ravi Ramamoorthi'] }),
    ];
    expect(resolveAuthor(candidates, 'Jonathan Barron', NERF)?.author.id).toBe('strong');
  });
});
