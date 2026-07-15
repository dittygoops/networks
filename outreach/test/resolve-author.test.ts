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

  test('co-author match requires the same surname AND first initial (common-surname guard)', () => {
    // Paper co-author "Ravi Ramamoorthi". A homonym whose only overlap is a
    // different-first-initial "X. Ramamoorthi" should NOT strong-match, and a
    // co-author whose FIRST name merely equals a paper surname must not match.
    const wrongInitial = cand({ id: 'A_bad', displayName: 'Jonathan Barron', coauthors: ['Sanjay Ramamoorthi'] });
    expect(resolveAuthor([wrongInitial], 'Jonathan Barron', NERF)).toBeNull();

    const rightInitial = cand({ id: 'A_ok', displayName: 'Jonathan Barron', coauthors: ['Ravi Ramamoorthi'] });
    expect(resolveAuthor([rightInitial], 'Jonathan Barron', NERF)?.author.id).toBe('A_ok');
  });

  test('a paper surname matching a candidate co-author FIRST name does not corroborate', () => {
    // Paper co-author "Matthew Tancik"; a candidate co-author literally named
    // "Tancik Somebody" (Tancik as first name) must not count.
    const c = cand({ id: 'A1', displayName: 'Jonathan Barron', coauthors: ['Tancik Nobody'] });
    expect(resolveAuthor([c], 'Jonathan Barron', NERF)).toBeNull();
  });

  test('short acronym affiliation (MIT) still fires the weak affiliation signal', () => {
    const ctx: PaperContext = { affiliationHint: 'MIT', areaTerms: ['computer vision'] };
    const c = cand({
      id: 'A1',
      displayName: 'Jane Smith',
      concepts: ['Computer Vision'],
      affiliations: ['Massachusetts Institute of Technology'],
    });
    const result = resolveAuthor([c], 'Jane Smith', ctx);
    expect(result?.author.id).toBe('A1');
    expect(result?.signals).toEqual(expect.arrayContaining(['concept', 'affiliation']));
  });

  test('an empty-normalizing work title does not produce a spurious title match', () => {
    const ctx: PaperContext = { title: 'A Real Paper Title', areaTerms: ['x'] };
    // Work title normalizes to empty (punctuation only); must not match.
    const c = cand({ id: 'A1', displayName: 'Jane Smith', workTitles: ['???', '...'] });
    expect(resolveAuthor([c], 'Jane Smith', ctx)).toBeNull();
  });

  test('picks the strongest candidate when several name-match', () => {
    const candidates = [
      cand({ id: 'weak', displayName: 'Jonathan Barron', concepts: ['Computer Vision'], affiliations: ['Google'] }),
      cand({ id: 'strong', displayName: 'Jonathan T. Barron', coauthors: ['Ravi Ramamoorthi'] }),
    ];
    expect(resolveAuthor(candidates, 'Jonathan Barron', NERF)?.author.id).toBe('strong');
  });
});
