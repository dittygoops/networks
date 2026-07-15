import { describe, expect, test } from 'vitest';
import { nameMatches } from '../src/pipeline/contacts.js';

// D2: an email local part matches a person if, after lowercasing and stripping
// digits/punctuation, it contains (a) the full last name, (b) the full first
// name, or (c) an initials pattern (first initial + last name, or first name +
// last initial).

describe('nameMatches (D2)', () => {
  test('matches first initial + last name', () => {
    expect(nameMatches('agupta', 'Aditya Gupta')).toBe(true);
  });

  test('matches first name + last initial with punctuation', () => {
    expect(nameMatches('aditya.g', 'Aditya Gupta')).toBe(true);
  });

  test('matches full last name with trailing digits', () => {
    expect(nameMatches('gupta3', 'Aditya Gupta')).toBe(true);
  });

  test('matches full first name alone', () => {
    expect(nameMatches('aditya', 'Aditya Gupta')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(nameMatches('AGupta', 'Aditya Gupta')).toBe(true);
  });

  test('handles apostrophes in names', () => {
    expect(nameMatches('lobrien', "Liam O'Brien")).toBe(true);
  });

  test('uses first and last token of multi-part names', () => {
    expect(nameMatches('wzhang', 'Wei Chen Zhang')).toBe(true);
  });

  test('rejects an unrelated lab address', () => {
    expect(nameMatches('avsim.lab', 'Aditya Gupta')).toBe(false);
  });

  test('rejects a different person', () => {
    expect(nameMatches('jsmith', 'Aditya Gupta')).toBe(false);
  });

  test('rejects generic role addresses', () => {
    expect(nameMatches('admin', 'Aditya Gupta')).toBe(false);
  });
});
