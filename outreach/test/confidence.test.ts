import { describe, expect, test } from 'vitest';
import { scoreCandidate, selectEmail } from '../src/pipeline/contacts.js';
import type { EmailCandidate } from '../src/pipeline/contacts.js';

// D1: deterministic confidence table; threshold 0.7; ties prefer .edu.

const NAME = 'Aditya Gupta';
const cand = (email: string, source: EmailCandidate['source'], correspondingMarker = false): EmailCandidate => ({
  email,
  source,
  correspondingMarker,
});

describe('scoreCandidate (D1)', () => {
  test('PDF email with corresponding-author marker and name match scores 0.95', () => {
    expect(scoreCandidate(cand('agupta@asu.edu', 'pdf', true), NAME)).toBe(0.95);
  });

  test('PDF email with name match but no marker scores 0.85', () => {
    expect(scoreCandidate(cand('agupta@asu.edu', 'pdf'), NAME)).toBe(0.85);
  });

  test('homepage email scores 0.85', () => {
    expect(scoreCandidate(cand('gupta3@asu.edu', 'homepage'), NAME)).toBe(0.85);
  });

  test('directory listing scores 0.75', () => {
    expect(scoreCandidate(cand('agupta@asu.edu', 'directory'), NAME)).toBe(0.75);
  });

  test('GitHub profile email scores 0.70', () => {
    expect(scoreCandidate(cand('aditya.g@gmail.com', 'github_profile'), NAME)).toBe(0.7);
  });

  test('GitHub commit email scores 0.55', () => {
    expect(scoreCandidate(cand('agupta@gmail.com', 'github_commit'), NAME)).toBe(0.55);
  });

  test('GitHub noreply addresses score 0 regardless of name match', () => {
    expect(scoreCandidate(cand('1234+agupta@users.noreply.github.com', 'github_commit'), NAME)).toBe(0);
  });

  test('any source without a name match scores 0', () => {
    expect(scoreCandidate(cand('avsim.lab@asu.edu', 'pdf', true), NAME)).toBe(0);
  });
});

describe('selectEmail (D1 threshold + tie-break)', () => {
  test('picks the highest-confidence candidate at or above 0.7', () => {
    const result = selectEmail(
      [cand('agupta@gmail.com', 'github_commit'), cand('agupta@asu.edu', 'pdf', true)],
      NAME,
    );
    expect(result).toEqual({ email: 'agupta@asu.edu', confidence: 0.95, source: 'pdf' });
  });

  test('returns null when the best candidate is below 0.7', () => {
    expect(selectEmail([cand('agupta@gmail.com', 'github_commit')], NAME)).toBeNull();
  });

  test('returns null for an empty candidate list', () => {
    expect(selectEmail([], NAME)).toBeNull();
  });

  test('breaks confidence ties in favor of .edu domains', () => {
    const result = selectEmail(
      [cand('agupta@gmail.com', 'pdf'), cand('gupta3@asu.edu', 'homepage')],
      NAME,
    );
    expect(result?.email).toBe('gupta3@asu.edu');
  });
});
