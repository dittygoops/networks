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

export function extractPaperEmailCandidates(text: string): EmailCandidate[] {
  const byEmail = new Map<string, EmailCandidate>();
  for (const match of text.matchAll(EMAIL_RE)) {
    const [, localGroup = '', domain = ''] = match;
    const window = text.slice(Math.max(0, match.index - MARKER_WINDOW), match.index + match[0].length + MARKER_WINDOW);
    const marker = /corresponding/i.test(window);
    const locals = localGroup.startsWith('{')
      ? localGroup.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : [localGroup];
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
      const email = match[0].toLowerCase();
      if (email.startsWith('{')) continue; // brace groups are a paper-text thing
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

const hostMatches = (hostname: string, hosts: string[]): boolean =>
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

export interface ExtractOptions {
  paperAgeMonths?: number;
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

  const webCandidates = await extractWebContacts(deps, person);
  return selectEmail([...paperCandidates, ...webCandidates], person.name, paperAgeMonths);
}

// D1c: two passes. Pass 1 is a plain name (+ paper affiliation) search. If it
// yields no confident email, pass 2 derives the current institution domain from
// pass-1's homepages and re-queries, so a mover's current email is found with
// no human-supplied affiliation.
async function extractWebContacts(deps: ContactDeps, person: TargetPerson): Promise<EmailCandidate[]> {
  const affiliation = person.affiliation ?? '';
  const pass1 = await runWebPass(deps, person, [
    `"${person.name}" ${affiliation} email`.trim(),
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

// D2: after lowercasing and stripping digits/punctuation, the local part must
// contain (a) the full last name, (b) the full first name, or (c) an initials
// pattern (first initial + last name, or first name + last initial).
export function nameMatches(localPart: string, fullName: string): boolean {
  const local = lettersOnly(localPart);
  const tokens = fullName.trim().split(/\s+/).map(lettersOnly).filter(Boolean);
  if (local.length === 0 || tokens.length === 0) return false;
  const first = tokens[0]!;
  const last = tokens[tokens.length - 1]!;
  const patterns = [last, first, first[0]! + last, first + last[0]!];
  return patterns.some((p) => p.length > 1 && local.includes(p));
}
