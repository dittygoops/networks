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

// 2026-08-04 incident: three real cold emails went to addresses belonging to
// nobody on the paper, because a bare surname counted as a strong match.
//   xuhuaping@buaa.edu.cn      accepted for "Ziheng Xu"      (authors: Ziheng Xu, Qingfeng Li, Xuefeng Liu, Chen Chen, Jianwei Niu)
//   huangbo@njust.edu.cn       accepted for "Xianliang Huang"(authors: Xianliang Huang, Chen Xiao, ...)
//   zhangyanghui@tongji.edu.cn accepted for "Xiyu Zhang"     (authors: Xiyu Zhang, Jingyu Zhuang, ...)
// Same class as daniel.lee@dlapiper.com, reached through the surname instead
// of the first name. A surname alone is distinctive for "Kerbl" and close to
// worthless for "Xu", "Zhang", "Huang" or "Li".
describe('nameMatches: a bare surname is not enough when the local part says more', () => {
  test.each([
    ['xuhuaping', 'Ziheng Xu'],
    ['huangbo', 'Xianliang Huang'],
    ['zhangyanghui', 'Xiyu Zhang'],
    ['lizhang', 'Xiyu Zhang'],
    ['wangwei', 'Ming Wang'],
    ['yangbaoquan', 'Hongkun Yang'],          // real: sent to Yang Baoquan
    ['lanyu', 'Sicheng Yu'],                  // real: sent to Lan Yu
    ['jawairia.khan', 'MD Wahiduzzaman Khan'],// real: sent to Jawairia Khan
  ])('rejects %s for %s', (local, name) => {
    expect(nameMatches(local, name)).toBe(false);
  });

  // The local part IS the surname: nothing contradicts, so it stays accepted.
  // The residue (local part minus the surname) echoes the target's own given
  // name, so the surname match stands. These are all real stored addresses.
  test.each([
    ['zhou', 'Junbao Zhou'],
    ['kerbl', 'Bernhard Kerbl'],
    ['xu', 'Ziheng Xu'],
    ['pedro.zanineli12', 'P. Zanineli'],      // hand-supplied by the owner
    ['latitia.laguzet', 'Laetitia Laguzet'],  // transliteration drift
    ['swdai', 'Si-Wei Dai'],                  // initials
    ['helbahja', 'Hamid El Bahja'],           // multi-token surname
  ])('still accepts %s for %s', (local, name) => {
    expect(nameMatches(local, name)).toBe(true);
  });

  // Surname plus first-name evidence is still a match, which is what keeps the
  // real recipients in the queue working.
  test.each([
    ['liulizhou', 'Lizhou Liu'],
    ['yinpeng', 'Peng Yin'],
    ['bernhard.kerbl', 'Bernhard Kerbl'],
    ['donggeonbae', 'Donggeon Bae'],
    ['huaiyuan.weng', 'Huaiyuan Weng'],
  ])('accepts %s for %s', (local, name) => {
    expect(nameMatches(local, name)).toBe(true);
  });
});

// A tokenized local part tells us where the name boundaries are, so a surname
// matching only the interior of a token is a syllable collision. Real case:
// l.zhang.16@bham.ac.uk was accepted for "Zhisheng Han" because h-a-n sits
// inside z-h-a-n-g. Romanized Chinese names collide this way constantly.
describe('nameMatches: a tokenized local part must name the person', () => {
  test.each([
    ['l.zhang.16', 'Zhisheng Han'],
    ['daniel.lee', 'Daniel Kepple'],
    ['mikel.martinez', 'Mikel M. Iparraguirre'],
    ['jawairia.khan', 'MD Wahiduzzaman Khan'],
  ])('rejects %s for %s', (local, name) => {
    expect(nameMatches(local, name)).toBe(false);
  });

  // Legitimate initials forms: the surname is a clean token, or there are no
  // separators at all so the token rule does not apply. All real addresses.
  test.each([
    ['n.kollias.v', 'Nikolaos Kollias'],
    ['yhudj', 'Yingdong Hu'],
    ['zzhongyj', 'Yingji Zhong'],
  ])('still accepts %s for %s', (local, name) => {
    expect(nameMatches(local, name)).toBe(true);
  });
});
