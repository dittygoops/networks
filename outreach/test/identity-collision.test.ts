import { describe, expect, test } from 'vitest';
import {
  detectIdentityCollision,
  COLLISION_MIN_COLLABORATORS,
  COLLISION_MIN_INSTITUTIONS,
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

  test('flags on collaborators alone, even with few institutions', () => {
    const facts = collaboratorFacts(COLLISION_MIN_COLLABORATORS);
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
