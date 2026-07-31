// Shared token-level text matching. Three subsystems used to carry three
// different, silently diverging matchers for the same question ("does this
// short string really occur in that longer one?"), and two of them were wrong
// in production:
//   - intersect.ts matched "Nature" inside "...Signatures..." and produced the
//     only hook two real people had.
//   - relevanceGate.ts still had that identical bug, writing "matches gap
//     term: nature" into seen_papers.reason.
//   - research.ts reused contacts.ts's email-local-part matcher on free-text
//     page headings, so any page passed the identity gate for a short surname.
// Every matcher here is pure, deterministic, and tokenized. Nothing in this
// file may fall back to raw substring containment.

// Fold accents (NFD then drop combining marks) so "Szczesniak" and
// "Szczesniak" with diacritics compare equal, then lowercase. Non-Latin
// scripts (CJK) pass through untouched, which callers must handle explicitly.
const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Canonical comparison form for entity values: accent-folded, lowercased,
// non-alphanumerics collapsed to single spaces, trimmed.
export function normalizeForMatch(s: string): string {
  return fold(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Whole-word containment: true when `needle`'s tokens appear as a CONTIGUOUS
// run inside `haystack`'s tokens, at word boundaries. Both sides must already
// be normalized (normalizeForMatch). Plain substring containment is wrong
// here: the normalized string "heterogeneous molecular signatures of human
// odor perception" CONTAINS the raw substring "nature" (inside "signatures"),
// which produced a live bad hook built entirely on a spelling coincidence.
export function containsWholeWords(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const h = haystack.split(' ').filter(Boolean);
  const n = needle.split(' ').filter(Boolean);
  if (n.length === 0 || n.length > h.length) return false;
  for (let i = 0; i <= h.length - n.length; i++) {
    if (n.every((tok, j) => h[i + j] === tok)) return true;
  }
  return false;
}

// Tokenize free text into lowercase letter runs, splitting camelCase first so
// a URL slug like "BernhardKerbl" yields ["bernhard", "kerbl"].
function textTokens(s: string): string[] {
  const spaced = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  return fold(spaced).split(/[^a-z]+/).filter(Boolean);
}

// A one-letter surname carries no identity information at all.
const MIN_SURNAME_LEN = 2;

// PERSON-IDENTITY MATCHING (D1).
//
// This is deliberately NOT contacts.ts's `nameMatches`. That function is
// correct for what it does: an email local part is ENTIRELY the name, so
// substring containment ("agupta" contains "gupta") is the right test there,
// and it stays untouched. A free-text heading or a URL slug is a different
// problem: it is mostly not the name. Reusing the local-part matcher there
// made the page-identity gate a no-op for short surnames, verified by
// execution: nameMatches('publications', 'Wei Li') returns TRUE, because
// "publications" contains "li". For Li, He, Xu, Wu, Ye, and An, that means
// ANY page on the right domain passed the gate, which is exactly the
// production incident the gate was added to fix.
//
// The rule here:
//   1. The SURNAME must appear as a COMPLETE TOKEN. No substrings.
//   2. It must be CORROBORATED by the given name, either as a complete token
//      or as a single-letter initial token, and that corroboration must be
//      NEAR the surname (within 2 tokens, or 1 token when the surname is two
//      letters or fewer, which is what keeps "Hao He and Jun Wang" from
//      matching "Jun He").
//   3. OR a single token equals a concatenated name form: first+last,
//      last+first, firstInitial+last, last+firstInitial, allGivenInitials+last,
//      last+allGivenInitials. This is what accepts "wli", "weili", "liwei",
//      and "jhkim" as profile slugs without accepting "publications".
//
// AVOIDING THE OPPOSITE FAILURE (silently dropping East Asian researchers),
// which would be its own quiet fabrication-adjacent bug because it would just
// stop mining a large share of the target population without saying so:
//   - Token order is not assumed. "Li, Wei", "Wei LI", "W. Li", and "Li W"
//     all match, because corroboration is proximity-based, not positional.
//   - Middle names and middle initials do not break the match (window of 2).
//   - A repeated given name and surname ("Xu Xu") matches; the surname token
//     and the corroborating token are allowed to be the same word at
//     different positions.
//   - Family-name-first renderings whose LAST token is a single letter
//     ("Nguyen Van A") fall back to treating the longest token as the surname
//     rather than rejecting outright.
//   - Accents are folded, so a Vietnamese or Polish surname matches its
//     unaccented spelling in either direction.
//   - A CJK target name (no Latin letters after folding) is matched by direct
//     substring, since CJK has no whitespace tokens and a full 2 to 4
//     character given+family name is already a strong signal.
//   - A Latin target name against a purely CJK heading cannot be evaluated and
//     returns false HERE, but the caller (pageIsAboutPerson) checks three
//     independent surfaces (heading, page title, URL slug), and Chinese
//     institutional pages carry the pinyin name in the title or slug. That is
//     the designed recovery path, not an accident.
export function personNameInText(text: string, personName: string): boolean {
  const name = personName.trim();
  if (!name || !text) return false;

  // Non-Latin (CJK) target name: substring is the only available test.
  if (!/[a-z]/.test(fold(name))) return text.includes(name);

  const nameToks = textTokens(name);
  if (nameToks.length < 2) return false; // a single-token name has nothing to corroborate

  let surnameIdx = nameToks.length - 1;
  if (nameToks[surnameIdx]!.length < MIN_SURNAME_LEN) {
    // Family-name-first orderings can end in a one-letter given name.
    nameToks.forEach((t, i) => {
      if (t.length > nameToks[surnameIdx]!.length) surnameIdx = i;
    });
  }
  const last = nameToks[surnameIdx]!;
  if (last.length < MIN_SURNAME_LEN) return false;

  const given = nameToks.filter((_, i) => i !== surnameIdx);
  if (given.length === 0) return false;
  const first = given[0]!;

  const toks = textTokens(text);
  if (toks.length === 0) return false;

  const initials = given.map((g) => g[0]!).join('');
  const joined = new Set([
    first + last,
    last + first,
    first[0]! + last,
    last + first[0]!,
    initials + last,
    last + initials,
  ]);
  if (toks.some((t) => joined.has(t))) return true;

  const window = last.length <= 2 ? 1 : 2;
  const corroborates = (t: string): boolean =>
    given.includes(t) || (t.length === 1 && given.some((g) => g[0] === t));

  return toks.some(
    (t, i) =>
      t === last &&
      toks.some((u, j) => j !== i && Math.abs(j - i) <= window && corroborates(u)),
  );
}

// SOURCE-OCCURRENCE CHECK (D2).
//
// Words that carry no identifying content, so requiring them to occur would
// reject legitimate rewordings rather than catch anything.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'for', 'and', 'or', 'in', 'on', 'to', 'with',
  'by', 'from', 'via', 'using', 'used', 'their', 'our', 'its',
]);

// Crude singularization so "models" in a fact value matches "model" in an
// abstract. Deliberately not a stemmer: a stemmer would conflate too much and
// this check is a safety gate, not a search ranker.
const singular = (t: string): string =>
  t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t;

// The content tokens of a fact value: folded, singularized, stopwords removed.
export function contentTokens(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular)
    .filter((t) => !STOPWORDS.has(t));
}

// True when EVERY content token of `value` occurs as a token in `source`.
// Token-set membership, not contiguity, so a hyphenated or reordered spelling
// in the source still counts ("vision-language-action models" grounds the
// value "vision language action model"). An empty or stopword-only value
// returns false: a fact with no content cannot be grounded, and vacuously
// accepting it would be the exact failure mode this gate exists to stop.
export function occursInSource(value: string, source: string): boolean {
  const toks = contentTokens(value);
  if (toks.length === 0) return false;
  const src = new Set(
    fold(source).split(/[^a-z0-9]+/).filter(Boolean).map(singular),
  );
  return toks.every((t) => src.has(t));
}
