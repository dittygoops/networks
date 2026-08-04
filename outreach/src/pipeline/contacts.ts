// Contact extraction: tiered email discovery for a target person.
// Spec: docs/spec-profile-mining.md (D1 confidence table, D2 name-match rule).
import { parse } from 'tldts';

export type EmailSource = 'pdf' | 'homepage' | 'directory' | 'github_profile' | 'github_commit';

export interface EmailCandidate {
  email: string;
  source: EmailSource;
  correspondingMarker?: boolean;
}

export interface SelectedEmail {
  email: string;
  confidence: number;
  source: EmailSource;
}

export const CONFIDENCE_THRESHOLD = 0.7;

// D1 confidence table (name match required everywhere; noreply always discarded).
const SOURCE_CONFIDENCE: Record<EmailSource, number> = {
  pdf: 0.85, // 0.95 with corresponding-author marker
  homepage: 0.85,
  directory: 0.75,
  github_profile: 0.7,
  github_commit: 0.55,
};

// D1 age decay: a paper email reflects the author's institution at publication
// time. Decay 0.15 per full year beyond the first, floored at 0.5.
export function decayPaperConfidence(base: number, ageMonths: number): number {
  const steps = Math.max(0, Math.floor(ageMonths / 12) - 1);
  return Math.max(0.5, base - 0.15 * steps);
}

export function scoreCandidate(candidate: EmailCandidate, personName: string, paperAgeMonths = 0): number {
  const [localPart = '', domain = ''] = candidate.email.split('@');
  if (domain.endsWith('noreply.github.com')) return 0;
  if (!nameMatches(localPart, personName)) return 0;
  const base = candidate.source === 'pdf' && candidate.correspondingMarker ? 0.95 : SOURCE_CONFIDENCE[candidate.source];
  return candidate.source === 'pdf' ? decayPaperConfidence(base, paperAgeMonths) : base;
}

export function selectEmail(
  candidates: EmailCandidate[],
  personName: string,
  paperAgeMonths = 0,
): SelectedEmail | null {
  let best: SelectedEmail | null = null;
  for (const candidate of candidates) {
    const confidence = scoreCandidate(candidate, personName, paperAgeMonths);
    if (confidence < CONFIDENCE_THRESHOLD) continue;
    const isEdu = candidate.email.split('@')[1]?.endsWith('.edu') ?? false;
    const bestIsEdu = best?.email.split('@')[1]?.endsWith('.edu') ?? false;
    if (!best || confidence > best.confidence || (confidence === best.confidence && isEdu && !bestIsEdu)) {
      best = { email: candidate.email, confidence, source: candidate.source };
    }
  }
  return best;
}

const MARKER_WINDOW = 120;
// Plain emails plus brace groups ({a,b}@domain), common in paper headers.
const EMAIL_RE = /(\{[^}]+\}|[a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

// BUG A: the local-part character class has no left boundary, and a page like
// "<b>Email</b>a.sajan@vu.nl" flattens (tags stripped, no space inserted) to
// "Emaila.sajan@vu.nl": one unbroken run of letters and dots with nothing
// between the UI label and the real address. A boundary/lookbehind on the
// match start cannot fix this, since there is genuinely no non-letter
// character before "Email" either; the label and the address are the same
// kind of character glued together. Confirmed live: people rows for Akshay
// Sajan and Qian Hu both carry a stored address with a leading "email".
// The fix is a small dictionary strip: if a matched local part starts with a
// known directory-page label word AND something real remains after it,
// remove the label. Deliberately narrow (no bare "mail", which is a
// plausible prefix of a real local part like "mailer") and deliberately a
// no-op when the label IS the whole local part (kept as "email@x.edu" for a
// generic inbox, matching prior behavior for that case).
const GLUED_LOCAL_LABELS = ['email', 'e-mail', 'mailto', 'contact'];

function stripGluedLabel(local: string): string {
  const lower = local.toLowerCase();
  for (const label of GLUED_LOCAL_LABELS) {
    if (lower.startsWith(label) && local.length > label.length) {
      return local.slice(label.length);
    }
  }
  return local;
}

export function extractPaperEmailCandidates(text: string): EmailCandidate[] {
  const byEmail = new Map<string, EmailCandidate>();
  for (const match of text.matchAll(EMAIL_RE)) {
    const [, localGroup = '', domain = ''] = match;
    const window = text.slice(Math.max(0, match.index - MARKER_WINDOW), match.index + match[0].length + MARKER_WINDOW);
    const marker = /corresponding/i.test(window);
    const locals = localGroup.startsWith('{')
      ? localGroup.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : [stripGluedLabel(localGroup)];
    for (const local of locals) {
      const email = `${local}@${domain}`.toLowerCase();
      const existing = byEmail.get(email);
      byEmail.set(email, {
        email,
        source: 'pdf',
        correspondingMarker: marker || existing?.correspondingMarker || false,
      });
    }
  }
  return [...byEmail.values()];
}

export interface WebPage {
  url: string;
  title: string;
  content: string;
}

export interface SearchClient {
  search(query: string): Promise<WebPage[]>;
}

export type WebPageClass = 'homepage' | 'directory' | 'github_profile' | 'aggregator';

// D1b: profile aggregators masquerade as homepages (name in URL/title) but
// never expose a usable email; treat them as a distinct, deprioritized class.
const AGGREGATOR_HOSTS = [
  'rocketreach.co', 'researchgate.net', 'academia.edu', 'scholar.google.com',
  'dl.acm.org', 'kitcaster.com', 'semanticscholar.org', 'dblp.org', 'orcid.org',
  'linkedin.com', 'applykite.com',
];

export function classifyWebPage(page: WebPage, personName: string): WebPageClass {
  const hostname = new URL(page.url).hostname.replace(/^www\./, '');
  if (hostname.endsWith('github.com')) return 'github_profile';
  if (AGGREGATOR_HOSTS.some((h) => hostname === h || hostname.endsWith('.' + h))) return 'aggregator';
  const haystack = lettersOnly(page.url + ' ' + page.title);
  const tokens = personName.trim().split(/\s+/).map(lettersOnly).filter(Boolean);
  const first = tokens[0] ?? '';
  const last = tokens[tokens.length - 1] ?? '';
  const namePatterns = [first + last, last, first[0] + last].filter((p) => p.length > 2);
  return namePatterns.some((p) => haystack.includes(p)) ? 'homepage' : 'directory';
}

// "agupta [at] asu [dot] edu" → "agupta@asu.edu" (bracketed forms only; bare
// " at " is too ambiguous to rewrite).
const deobfuscate = (content: string): string =>
  content
    .replace(/\s*[[(]\s*at\s*[)\]]\s*/gi, '@')
    .replace(/\s*[[(]\s*dot\s*[)\]]\s*/gi, '.');

export function extractWebEmailCandidates(pages: WebPage[], personName: string): EmailCandidate[] {
  const byEmail = new Map<string, EmailCandidate>();
  for (const page of pages) {
    const cls = classifyWebPage(page, personName);
    if (cls === 'aggregator') continue; // never a usable email source
    const source: EmailSource = cls;
    for (const match of deobfuscate(page.content).matchAll(EMAIL_RE)) {
      const [, localGroup = '', domain = ''] = match;
      if (localGroup.startsWith('{')) continue; // brace groups are a paper-text thing
      const email = `${stripGluedLabel(localGroup)}@${domain}`.toLowerCase();
      const existing = byEmail.get(email);
      if (existing && SOURCE_CONFIDENCE[existing.source] >= SOURCE_CONFIDENCE[source]) continue;
      byEmail.set(email, { email, source, correspondingMarker: false });
    }
  }
  return [...byEmail.values()];
}

// Generic hosting/personal domains that don't identify an institution.
const GENERIC_HOSTS = [
  'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com',
  'github.io', 'sites.google.com', 'googleusercontent.com', 'wordpress.com',
  'medium.com', 'substack.com', 'notion.site', 'wixsite.com',
];

// True if hostname equals or is a subdomain of any host in the list.
export const hostMatches = (hostname: string, hosts: string[]): boolean =>
  hosts.some((h) => hostname === h || hostname.endsWith('.' + h));

// D-domain: reduce found homepage/directory pages to unique registrable
// institution domains, excluding aggregators and generic hosts. Top 2 by order.
// Exclusion is by full hostname (sites.google.com is generic, but a bare
// google.com is a real institution and stays).
export function collectInstitutionDomains(pages: WebPage[], personName: string): string[] {
  const domains: string[] = [];
  for (const page of pages) {
    const cls = classifyWebPage(page, personName);
    if (cls !== 'homepage' && cls !== 'directory') continue;
    const { hostname, domain } = parse(page.url);
    if (!hostname || !domain) continue;
    if (hostMatches(hostname, GENERIC_HOSTS) || hostMatches(hostname, AGGREGATOR_HOSTS)) continue;
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains.slice(0, 2);
}

export interface PageFetcher {
  fetch(urls: string[]): Promise<WebPage[]>;
}

export interface ContactDeps {
  search: SearchClient;
  fetcher: PageFetcher;
}

export interface TargetPerson {
  name: string;
  affiliation?: string | null;
}

// D5a: context intake always has, used to disambiguate common names.
export interface PaperContext {
  affiliationHint?: string | null;
  areaTerms?: string[];
  coauthors?: string[]; // reserved for D5b (Step B) corroboration
  title?: string | null;
  arxivId?: string | null;
}

export interface ExtractOptions {
  paperAgeMonths?: number;
  paperContext?: PaperContext;
  // Task A: the author's CURRENT affiliation (resolved via OpenAlex upstream).
  // When present it takes precedence over paperContext.affiliationHint /
  // person.affiliation for both the web query and the D5a guard, so a mover's
  // current institution drives discovery instead of the paper's stale one.
  currentAffiliation?: string;
}

const FRESH_PAPER_MONTHS = 12;
const MAX_FETCH_PAGES = 3;

// D1a/D1b: paper text first, but web is consulted unless the paper is fresh and
// already confident. Web tier fetches full page content for the top
// non-aggregator results (search snippets rarely contain emails). All
// candidates are reconciled by decayed D1 score; null below 0.7 (caller owns
// the needs_manual_lookup transition, D10).
export async function extractContact(
  deps: ContactDeps,
  person: TargetPerson,
  paperText: string | null,
  options: ExtractOptions = {},
): Promise<SelectedEmail | null> {
  const paperAgeMonths = options.paperAgeMonths ?? 0;
  const paperCandidates = paperText ? extractPaperEmailCandidates(paperText) : [];

  const paperPick = selectEmail(paperCandidates, person.name, paperAgeMonths);
  if (paperPick && paperAgeMonths < FRESH_PAPER_MONTHS) return paperPick;

  const affiliation = options.currentAffiliation ?? options.paperContext?.affiliationHint ?? person.affiliation ?? '';

  // D5a guard: affiliation is the disambiguator. Without it, a common name
  // can't be safely resolved from the web, so web emails route to manual.
  const webCandidates = affiliation.length > 0 ? await extractWebContacts(deps, person, affiliation) : [];

  return selectEmail([...paperCandidates, ...webCandidates], person.name, paperAgeMonths);
}

// D1c: two passes. Pass 1 is a plain name (+ paper affiliation) search. If it
// yields no confident email, pass 2 derives the current institution domain from
// pass-1's homepages and re-queries, so a mover's current email is found with
// no human-supplied affiliation.
async function extractWebContacts(
  deps: ContactDeps,
  person: TargetPerson,
  affiliation: string,
): Promise<EmailCandidate[]> {
  const pass1 = await runWebPass(deps, person, [
    `"${person.name}" ${affiliation} email`.replace(/\s+/g, ' ').trim(),
    `"${person.name}" github`,
  ]);

  const hasConfident = pass1.candidates.some((c) => scoreCandidate(c, person.name) >= CONFIDENCE_THRESHOLD);
  if (hasConfident) return pass1.candidates;

  const domains = collectInstitutionDomains(pass1.ranked, person.name);
  if (domains.length === 0) return pass1.candidates;

  const pass2 = await runWebPass(deps, person, domains.map((d) => `"${person.name}" ${d}`));
  return [...pass1.candidates, ...pass2.candidates];
}

async function runWebPass(
  deps: ContactDeps,
  person: TargetPerson,
  queries: string[],
): Promise<{ candidates: EmailCandidate[]; ranked: WebPage[] }> {
  const seen = new Set<string>();
  const ranked: WebPage[] = [];
  for (const query of queries) {
    for (const page of await deps.search.search(query)) {
      if (seen.has(page.url) || classifyWebPage(page, person.name) === 'aggregator') continue;
      seen.add(page.url);
      ranked.push(page);
    }
  }
  // Scan both the search snippets and the fetched full page content: some staff
  // pages carry the email in the snippet but obfuscate it out of the rendered
  // body (and vice versa). Fetched content inherits its page's class via URL.
  const fetched = await deps.fetcher.fetch(ranked.slice(0, MAX_FETCH_PAGES).map((p) => p.url));
  return { candidates: extractWebEmailCandidates([...ranked, ...fetched], person.name), ranked };
}

const lettersOnly = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

// D2 (revised): after lowercasing and stripping digits/punctuation, the local
// part must contain either
//   (a) the full surname alone, or an initials combo built from it (first
//       initial + surname, surname + first initial, first name + surname
//       initial), all of which are distinctive enough on their own, or
//   (b) the full first name PLUS a second, independent name signal (the
//       surname or a middle name, in full) both present in the local part.
//
// A bare first name is deliberately NOT in list (a) any more. It used to be,
// and that was a real production bug: nameMatches('daniel.lee', 'Daniel
// Kepple') returned true because "daniel.lee" contains "daniel", with no
// check that "lee" has anything to do with "Kepple". A cold email was
// actually sent to daniel.lee@dlapiper.com, a law firm, for an olfaction
// researcher. First names are common and carry little identifying signal by
// themselves; requiring a second signal (surname or middle name) fixes that
// without giving up the legitimate "firstname.lastname" shape, since in that
// shape the surname is present too and still satisfies (b).
//
// Hyphenated surnames ("Bona-Pellissier") are often abbreviated in email
// addresses to just one half ("joachim.bona"), so each half is also accepted
// as a stand-alone surname candidate under (a).
//
// This is a precision fix on a path that sends irreversible email (D1), so it
// deliberately leans toward rejecting an uncertain address. Known accepted
// misses from this tightening: a bare initial standing in for an unwritten
// surname (e.g. "Mikel M. Iparraguirre" where the source name has no way to
// know "M." means "Martinez"), and a first name plus non-name noise like
// digits or a student number (e.g. "hail96", "eszra22001") with no surname in
// the local part at all. Both are unresolvable from the name text alone, and
// the cost of rejecting them is a missed contact (the pipeline already
// handles that gracefully, D10), not a wrong one.
export function nameMatches(localPart: string, fullName: string): boolean {
  const local = lettersOnly(localPart);
  const rawTokens = fullName.trim().split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map(lettersOnly);
  const validIdx = tokens.map((t, i) => (t.length > 0 ? i : -1)).filter((i) => i >= 0);
  if (local.length === 0 || validIdx.length === 0) return false;

  const firstIdx = validIdx[0]!;
  const lastIdx = validIdx[validIdx.length - 1]!;
  const first = tokens[firstIdx]!;
  const last = tokens[lastIdx]!;
  const middles = validIdx.slice(1, -1).map((i) => tokens[i]!);

  const hyphenHalves = (rawTokens[lastIdx] ?? '')
    .split('-')
    .map(lettersOnly)
    .filter((p) => p.length > 1);
  const surnameCandidates = hyphenHalves.length > 1 ? [last, ...hyphenHalves] : [last];

  // A bare surname counts ONLY when the local part is exactly that surname.
  //
  // It used to count as a substring, and on 2026-08-04 that sent three real
  // cold emails to people who did not write the paper: xuhuaping@buaa.edu.cn
  // matched "Ziheng Xu", huangbo@njust.edu.cn matched "Xianliang Huang", and
  // zhangyanghui@tongji.edu.cn matched "Xiyu Zhang". None of the three
  // recipients appears anywhere in their paper's author list. This is the
  // daniel.lee@dlapiper.com failure reached through the surname instead of the
  // first name: a surname is distinctive for "Kerbl" and close to worthless
  // for "Xu", "Zhang", "Huang" or "Li", where it names millions of people.
  //
  // "zhou@njit.edu" for Junbao Zhou stays a match: nothing in the local part
  // contradicts the identification. "xuhuaping" does contradict it, because
  // the surrounding letters spell a different person's given name.
  // What decides it is the RESIDUE: the local part with the surname removed.
  // If the leftover letters echo the target's own given name, the surname
  // match stands. If they spell somebody else's given name, it does not.
  //   xu|huaping     residue "huaping" vs first "ziheng"    -> different person
  //   huang|bo       residue "bo"      vs first "xianliang" -> different person
  //   zhang|yanghui  residue "yanghui" vs first "xiyu"      -> different person
  //   zanineli|pedro residue "pedro"   vs first "p"         -> same person
  //   laguzet|latitia residue "latitia" vs first "laetitia" -> same person (transliteration)
  //   dai|sw         residue "sw"      vs first "siwei"     -> same person (initials)
  const residueEchoesFirstName = (s: string): boolean => {
    const residue = local.replace(s, '');
    if (residue.length === 0) return true; // the local part IS the surname
    if (first.length === 0) return false;
    // One shared leading letter is deliberately loose: it admits initials
    // ("sw" for Si-Wei) and transliteration drift ("latitia" for Laetitia)
    // while still rejecting a wholly different given name, which is the only
    // case that has ever produced a wrong-person send.
    return residue[0] === first[0] || first.startsWith(residue) || residue.startsWith(first);
  };
  if (surnameCandidates.some((s) => s.length > 1 && local.includes(s) && residueEchoesFirstName(s))) return true;

  const strongPatterns = surnameCandidates.flatMap((s) => [
    first[0]! + s,
    s + first[0]!,
    first + s[0]!,
  ]);
  if (strongPatterns.some((p) => p.length > 1 && local.includes(p))) return true;

  if (first.length > 1 && local.includes(first)) {
    const corroborators = [...surnameCandidates, ...middles].filter((t) => t.length > 1);
    if (corroborators.some((t) => local.includes(t))) return true;
  }

  return false;
}
