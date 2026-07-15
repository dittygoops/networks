import { describe, expect, test } from 'vitest';
import { extractPaperEmailCandidates } from '../src/pipeline/contacts.js';

// Tier 1: pull email candidates out of paper text (PDF already converted to
// text by unpdf). Marker rule: an email is a corresponding-author candidate if
// the word "corresponding" appears within 120 characters of it.

describe('extractPaperEmailCandidates', () => {
  test('finds a plain email and tags it as pdf source', () => {
    const candidates = extractPaperEmailCandidates('Contact: agupta@asu.edu for questions.');
    expect(candidates).toEqual([
      { email: 'agupta@asu.edu', source: 'pdf', correspondingMarker: false },
    ]);
  });

  test('expands brace groups into individual candidates', () => {
    const candidates = extractPaperEmailCandidates('Emails: {agupta,jsmith}@asu.edu');
    expect(candidates.map((c) => c.email)).toEqual(['agupta@asu.edu', 'jsmith@asu.edu']);
  });

  test('marks emails near the word "corresponding"', () => {
    const filler = 'x'.repeat(150);
    const text = `Corresponding author: agupta@asu.edu. ${filler} Other: jsmith@mit.edu`;
    const candidates = extractPaperEmailCandidates(text);
    expect(candidates.find((c) => c.email === 'agupta@asu.edu')?.correspondingMarker).toBe(true);
    expect(candidates.find((c) => c.email === 'jsmith@mit.edu')?.correspondingMarker).toBe(false);
  });

  test('dedupes repeated emails, keeping the marker if any occurrence has one', () => {
    const text = 'agupta@asu.edu ... later: corresponding author agupta@asu.edu';
    const candidates = extractPaperEmailCandidates(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.correspondingMarker).toBe(true);
  });

  test('returns empty array for text with no emails', () => {
    expect(extractPaperEmailCandidates('No contact information here.')).toEqual([]);
  });
});
