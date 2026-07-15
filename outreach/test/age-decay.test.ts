import { describe, expect, test } from 'vitest';
import { decayPaperConfidence } from '../src/pipeline/contacts.js';

// D1 age decay: paper-PDF confidence decays 0.15 per full year beyond the
// first, floored at 0.5. confidence = base - 0.15 * max(0, floor(months/12) - 1).

describe('decayPaperConfidence (D1)', () => {
  test('no decay under 12 months', () => {
    expect(decayPaperConfidence(0.95, 3)).toBe(0.95);
    expect(decayPaperConfidence(0.95, 11)).toBe(0.95);
  });

  test('no decay in the first-to-second year (under 24 months)', () => {
    expect(decayPaperConfidence(0.95, 12)).toBe(0.95);
    expect(decayPaperConfidence(0.95, 23)).toBe(0.95);
  });

  test('one decay step at 2 to 3 years', () => {
    expect(decayPaperConfidence(0.95, 24)).toBeCloseTo(0.8, 5);
    expect(decayPaperConfidence(0.95, 35)).toBeCloseTo(0.8, 5);
  });

  test('two decay steps at 3 to 4 years', () => {
    expect(decayPaperConfidence(0.95, 36)).toBeCloseTo(0.65, 5);
  });

  test('floors at 0.5 for very old papers', () => {
    expect(decayPaperConfidence(0.95, 120)).toBe(0.5);
    expect(decayPaperConfidence(0.85, 120)).toBe(0.5);
  });

  test('applies to the lower base (0.85) too', () => {
    expect(decayPaperConfidence(0.85, 24)).toBeCloseTo(0.7, 5);
  });
});
