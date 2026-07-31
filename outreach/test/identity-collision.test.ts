import { describe, expect, test } from 'vitest';
import {
  detectIdentityCollision,
  COLLISION_MIN_COLLABORATORS,
  COLLISION_MIN_INSTITUTIONS,
  COLLISION_CORROBORATING_INSTITUTIONS,
  type OntologyFact,
} from '../src/pipeline/research.js';

const collaboratorFacts = (n: number): OntologyFact[] =>
  Array.from({ length: n }, (_, i) => ({
    facet: 'academic' as const,
    key: 'collaborator',
    value: `Person ${i}`,
    sourceUrl: 'https://openalex.org/A1',
    confidence: 0.7,
    tier: 'A' as const,
  }));

const institutionFacts = (n: number): OntologyFact[] =>
  Array.from({ length: n }, (_, i) => ({
    facet: 'trajectory' as const,
    key: 'institution',
    value: `Institution ${i}`,
    sourceUrl: 'https://openalex.org/A1',
    confidence: 0.8,
    tier: 'A' as const,
  }));

describe('detectIdentityCollision', () => {
  test('a normal profile (counts like the legitimate pilot profiles) is not flagged', () => {
    // Legitimate profiles on file: 11, 23, 25, 16 total facts, well below the
    // collaborator/institution thresholds on their own.
    const facts = [...collaboratorFacts(8), ...institutionFacts(3)];
    const verdict = detectIdentityCollision(facts);
    expect(verdict.suspected).toBe(false);
    expect(verdict.reason).toBeUndefined();
  });

  test('a collision-shaped profile (counts like the Wenwen Zhang case) is flagged, with a reason naming the counts', () => {
    const facts = [...collaboratorFacts(176), ...institutionFacts(136)];
    const verdict = detectIdentityCollision(facts);
    expect(verdict.suspected).toBe(true);
    expect(verdict.reason).toBe('identity collision suspected (176 collaborators, 136 institutions)');
  });

  test('a boundary case just under both thresholds is not flagged', () => {
    const facts = [
      ...collaboratorFacts(COLLISION_MIN_COLLABORATORS - 1),
      ...institutionFacts(COLLISION_MIN_INSTITUTIONS - 1),
    ];
    const verdict = detectIdentityCollision(facts);
    expect(verdict.suspected).toBe(false);
  });

  // A long collaborator list on its own is productivity, not a merged identity.
  // Real case from a live run: Yuejiang Liu, 218 collaborators across only 4
  // institutions, is one person. Flagging them silently drops someone worth
  // contacting, so collaborators need institutional spread to corroborate.
  test('does NOT flag a prolific researcher at few institutions', () => {
    const facts = [...collaboratorFacts(COLLISION_MIN_COLLABORATORS + 50), ...institutionFacts(4)];
    expect(detectIdentityCollision(facts).suspected).toBe(false);
  });

  test('flags many collaborators when institutions also spread', () => {
    const facts = [
      ...collaboratorFacts(COLLISION_MIN_COLLABORATORS),
      ...institutionFacts(COLLISION_CORROBORATING_INSTITUTIONS),
    ];
    expect(detectIdentityCollision(facts).suspected).toBe(true);
  });

  test('flags on institutions alone, even with few collaborators', () => {
    const facts = institutionFacts(COLLISION_MIN_INSTITUTIONS);
    expect(detectIdentityCollision(facts).suspected).toBe(true);
  });

  test('dedupes case-insensitively before counting', () => {
    const facts: OntologyFact[] = Array.from({ length: COLLISION_MIN_COLLABORATORS }, () => ({
      facet: 'academic' as const,
      key: 'collaborator',
      value: 'Same Person',
      sourceUrl: 'https://openalex.org/A1',
      confidence: 0.7,
      tier: 'A' as const,
    }));
    expect(detectIdentityCollision(facts).suspected).toBe(false);
  });
});

// D6: this is a DELIBERATE blind spot, pinned so it cannot be mistaken for a
// bug or quietly "fixed" by lowering the thresholds. A two- or three-person
// merge (the common case for a common Chinese or Korean name) produces around
// 10 institutions and is NOT flagged. The calibration run showed the cost of
// catching it: Yuejiang Liu (218 collaborators, 4 institutions) and Zhiying Du
// (80 collaborators, 8 institutions) are single real researchers, and a
// threshold low enough to catch a 10-institution merge blocks them too.
// Blocking a real person is a silent drop, which is not a safe default.
// The defense for this population is the page-identity gate in research.ts
// (pageIsAboutPerson), not this detector.
describe('detectIdentityCollision known blind spot (D6)', () => {
  const profile = (institutions: number, collaborators: number): OntologyFact[] => [
    ...institutionFacts(institutions),
    ...collaboratorFacts(collaborators),
  ];

  test('a plausible two- or three-person merge (10 institutions) is NOT flagged, by design', () => {
    expect(detectIdentityCollision(profile(10, 60)).suspected).toBe(false);
  });

  test('a prolific single researcher is not flagged either (the reason the bar is high)', () => {
    expect(detectIdentityCollision(profile(4, 218)).suspected).toBe(false);
    expect(detectIdentityCollision(profile(8, 80)).suspected).toBe(false);
  });

  test('the gross merge it is calibrated for is still flagged', () => {
    expect(detectIdentityCollision(profile(165, 834)).suspected).toBe(true);
    expect(detectIdentityCollision(profile(21, 205)).suspected).toBe(true);
  });
});
