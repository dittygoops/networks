import { describe, expect, it } from 'vitest';
import {
  containsWholeWords,
  contentTokens,
  normalizeForMatch,
  occursInSource,
  personNameInText,
} from '../src/text/match.js';

describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeForMatch('Hierarchical Mixture-of-Experts!')).toBe('hierarchical mixture of experts');
  });

  it('folds accents so a European name matches its unaccented spelling', () => {
    expect(normalizeForMatch('Szczesniak')).toBe(normalizeForMatch('Szczęśniak'));
  });
});

describe('containsWholeWords', () => {
  it('matches a contiguous token run', () => {
    expect(containsWholeWords('3d gaussian splatting', 'gaussian splatting')).toBe(true);
  });

  it('does NOT match a raw substring inside a word (the live "signatures contains nature" bug)', () => {
    expect(containsWholeWords('heterogeneous molecular signatures of human odor perception', 'nature')).toBe(false);
  });

  it('does not match a non-contiguous token run', () => {
    expect(containsWholeWords('gaussian blur and image splatting', 'gaussian splatting')).toBe(false);
  });

  it('returns false when the needle is longer than the haystack', () => {
    expect(containsWholeWords('nature', 'nature methods journal')).toBe(false);
  });

  it('returns false for an empty needle', () => {
    expect(containsWholeWords('anything at all', '')).toBe(false);
  });
});

// The five cases in this block were verified by executing the OLD code and
// each returned the WRONG answer (except the last, which was already right and
// must stay right). They are the regression contract for D1.
describe('personNameInText: the five verified D1 cases', () => {
  it('rejects a bare "publications" heading for a short surname (was true via nameMatches)', () => {
    expect(personNameInText('publications', 'Wei Li')).toBe(false);
  });

  it('rejects a "Publications..." heading for Wei Li', () => {
    expect(personNameInText('Publications and preprints', 'Wei Li')).toBe(false);
  });

  it('rejects an institute heading for Jun He (was true: "he" inside "chemistry" era)', () => {
    expect(personNameInText('The Institute of Chemistry', 'Jun He')).toBe(false);
  });

  it('rejects a /publications/index URL slug for Wei Li', () => {
    expect(personNameInText('publications index', 'Wei Li')).toBe(false);
  });

  it('still rejects "Publications" for a Western name (unchanged behavior)', () => {
    expect(personNameInText('Publications', 'Kordel France')).toBe(false);
  });
});

// The other half of the contract: the tightened rule must NOT quietly drop
// every East Asian researcher. These are the renderings real profile pages use.
describe('personNameInText: East Asian and short-surname renderings that must still match', () => {
  const yes = (text: string, name: string) => expect(personNameInText(text, name)).toBe(true);

  it('accepts surname-first with a comma', () => yes('Li, Wei', 'Wei Li'));
  it('accepts an all-caps surname', () => yes('Wei LI', 'Wei Li'));
  it('accepts a first initial', () => yes('W. Li', 'Wei Li'));
  it('accepts a title prefix and a page suffix', () => yes('Prof. Wei Li | Homepage', 'Wei Li'));
  it('accepts a middle name between the given name and the surname', () => yes('Wei Chen Zhang', 'Wei Zhang'));
  it('accepts an identical given name and surname', () => yes('Xu Xu', 'Xu Xu'));
  it('accepts surname-first with a comma for a repeated name', () => yes('Xu, Xu', 'Xu Xu'));
  it('accepts a hyphenated Korean given name', () => yes('Jae-Hyun Kim', 'Jae-Hyun Kim'));
  it('accepts a family-name-first Vietnamese rendering', () => yes('Nguyen Van A', 'Nguyen Van A'));
  it('accepts an accented surname against its unaccented target', () =>
    yes('Dominik Szczesniak', 'Dominik Szczęśniak'));
  it('accepts an unaccented surname against its accented target', () =>
    yes('Dominik Szczęśniak', 'Dominik Szczesniak'));
  it('accepts a CJK name against a CJK heading', () => yes('李伟 - 主页', '李伟'));
  it('accepts a name carrying a middle initial the target lacks', () => yes('Kordel France', 'Kordel K. France'));
});

describe('personNameInText: concatenated slug forms', () => {
  const yes = (text: string, name: string) => expect(personNameInText(text, name)).toBe(true);

  it('accepts firstInitial+surname', () => yes('wli', 'Wei Li'));
  it('accepts first+surname', () => yes('weili', 'Wei Li'));
  it('accepts surname+first', () => yes('liwei', 'Wei Li'));
  it('accepts a hyphenated slug', () => yes('li-wei', 'Wei Li'));
  it('accepts a camelCase slug', () => yes('BernhardKerbl', 'Bernhard Kerbl'));
  it('accepts all-given-initials+surname', () => yes('jhkim', 'Jae-Hyun Kim'));
  it('accepts a surname-first concatenated slug', () => yes('staff/hejun', 'Jun He'));
});

describe('personNameInText: rejections that matter', () => {
  const no = (text: string, name: string) => expect(personNameInText(text, name)).toBe(false);

  it("rejects a colleague's name (the Jan Delcker production incident)", () => no('Dr. Jan Delcker', 'Wei Li'));
  it('rejects an unrelated topic heading (the Arctic sea ice production incident)', () =>
    no('Arctic sea ice variability in the Barents Sea', 'Wei Li'));
  it('rejects a bare institution page for a two-letter surname', () =>
    no('Home | Institute of Chemistry, CAS', 'Jun He'));
  it('rejects an incidental English "He" with no adjacent given name', () =>
    no('He was appointed in June to lead the group', 'Jun He'));
  it('rejects a two-person listing where the surname and a foreign given name are merely near each other', () =>
    no('Hao He and Jun Wang', 'Jun He'));
  it('rejects a lab listing that names only the surname', () => no('Publications of the Ye group', 'Ming Ye'));
  it('rejects a given-name-only slug (surname is required)', () => no('~kordel', 'Kordel France'));
  it('rejects a CJK institution heading for a CJK name', () =>
    no('化学研究所', '李伟'));
  it('rejects a one-token target name (no surname to corroborate)', () => no('Madonna', 'Madonna'));
  it('rejects empty text', () => no('', 'Wei Li'));
});

describe('occursInSource', () => {
  const ABSTRACT =
    'We present a Hierarchical Mixture-of-Experts (HMoE) router for vision-language-action ' +
    'models, evaluated on the nuScenes benchmark using 3D Gaussian Splatting priors.';

  it('accepts a value whose tokens all appear in the source', () => {
    expect(occursInSource('hierarchical mixture of experts', ABSTRACT)).toBe(true);
  });

  it('accepts a hyphenated source spelling of a spaced value', () => {
    expect(occursInSource('vision language action model', ABSTRACT)).toBe(true);
  });

  it('accepts a plural/singular difference', () => {
    expect(occursInSource('vision-language-action models', ABSTRACT)).toBe(true);
  });

  it('accepts an acronym that literally appears', () => {
    expect(occursInSource('HMoE', ABSTRACT)).toBe(true);
  });

  it('rejects a value that does not occur (an injected or hallucinated claim)', () => {
    expect(occursInSource('Arctic sea ice', ABSTRACT)).toBe(false);
    expect(occursInSource('reinforcement learning', ABSTRACT)).toBe(false);
  });

  it('rejects a sentence-shaped injected claim about a third party', () => {
    expect(occursInSource('Aditya Gupta is a longtime collaborator of the author', ABSTRACT)).toBe(false);
  });

  it('rejects an empty or stopword-only value rather than vacuously accepting it', () => {
    expect(occursInSource('', ABSTRACT)).toBe(false);
    expect(occursInSource('the of and', ABSTRACT)).toBe(false);
  });

  it('contentTokens drops stopwords and singularizes', () => {
    expect(contentTokens('the Mixture of Experts models')).toEqual(['mixture', 'expert', 'model']);
  });
});
