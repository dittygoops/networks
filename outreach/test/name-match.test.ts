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

  // BUG B (was: "matches full first name alone", asserting true). A first
  // name alone is NOT sufficient: it let daniel.lee@dlapiper.com (a law firm)
  // match "Daniel Kepple", and a cold email was actually sent to that address.
  // This test used to encode the bug; it now encodes the fix. Surname alone,
  // initial+surname, and surname+initial (below) still work.
  test('rejects a first-name-only match with no surname signal', () => {
    expect(nameMatches('aditya', 'Aditya Gupta')).toBe(false);
  });

  // Verified live: nameMatches('daniel.lee', 'Daniel Kepple') was true before
  // the fix (the actual bug that sent a real email to the wrong company).
  test('rejects a first name paired with an unrelated surname', () => {
    expect(nameMatches('daniel.lee', 'Daniel Kepple')).toBe(false);
    expect(nameMatches('daniel.smith', 'Daniel Kepple')).toBe(false);
  });

  test('still matches initial + surname and surname + initial for that pair', () => {
    expect(nameMatches('d.kepple', 'Daniel Kepple')).toBe(true);
    expect(nameMatches('kepple', 'Daniel Kepple')).toBe(true);
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

  // Draft d25: same shape as the Daniel Kepple incident, caught before it
  // could send. First name matches, surname does not.
  test('rejects a first name paired with an unrelated surname (draft d25 shape)', () => {
    expect(nameMatches('jiaruizhao', 'Jiarui Meng')).toBe(false);
  });

  // The six legitimate cases from the audit, verified one by one against the
  // fixed rule. See the comment above nameMatches for which pass and why.
  describe('legitimate addresses that must still resolve', () => {
    test('surname alone: a.sajan for Akshay Sajan', () => {
      expect(nameMatches('a.sajan', 'Akshay Sajan')).toBe(true);
    });

    test('middle name corroborating first name: felipe.nunes for Felipe Nunes Carbone de Prado', () => {
      expect(nameMatches('felipe.nunes', 'Felipe Nunes Carbone de Prado')).toBe(true);
    });

    test('one half of a hyphenated surname: joachim.bona for Joachim Bona-Pellissier', () => {
      expect(nameMatches('joachim.bona', 'Joachim Bona-Pellissier')).toBe(true);
    });
  });

  // These three are, by design, rejected. Each local part carries only the
  // first name (plus noise that is not a name signal), and the fix requires a
  // second independent name signal before accepting a first name. The cost of
  // rejecting is a missed contact (paper marked unsendable, D10); the cost of
  // accepting would be an email to a stranger. See the comment above
  // nameMatches for the reasoning on each.
  describe('unresolvable without more signal, rejected on purpose', () => {
    test('Spanish second surname collapsed to a bare initial: mikel.martinez for Mikel M. Iparraguirre', () => {
      // The name data only has "M." (an initial); nothing tells us it stands
      // for "Martinez". Matching on a bare initial is exactly the weak signal
      // this fix removes.
      expect(nameMatches('mikel.martinez', 'Mikel M. Iparraguirre')).toBe(false);
    });

    test('given name plus digits, no surname signal: hail96 for Hail Song', () => {
      expect(nameMatches('hail96', 'Hail Song')).toBe(false);
    });

    test('given name plus student number, no surname signal: eszra22001 for Eszra Forenita Sigalingging', () => {
      expect(nameMatches('eszra22001', 'Eszra Forenita Sigalingging')).toBe(false);
    });
  });
});
