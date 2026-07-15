// Contact extraction: tiered email discovery for a target person.
// Spec: docs/spec-profile-mining.md (D1 confidence table, D2 name-match rule).

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

export function scoreCandidate(candidate: EmailCandidate, personName: string): number {
  const [localPart = '', domain = ''] = candidate.email.split('@');
  if (domain.endsWith('noreply.github.com')) return 0;
  if (!nameMatches(localPart, personName)) return 0;
  if (candidate.source === 'pdf' && candidate.correspondingMarker) return 0.95;
  return SOURCE_CONFIDENCE[candidate.source];
}

export function selectEmail(candidates: EmailCandidate[], personName: string): SelectedEmail | null {
  let best: SelectedEmail | null = null;
  for (const candidate of candidates) {
    const confidence = scoreCandidate(candidate, personName);
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

export type WebPageClass = 'homepage' | 'directory' | 'github_profile';

export function classifyWebPage(page: WebPage, personName: string): WebPageClass {
  if (new URL(page.url).hostname.endsWith('github.com')) return 'github_profile';
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
    const source = classifyWebPage(page, personName);
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

export interface ContactDeps {
  search: SearchClient;
}

export interface TargetPerson {
  name: string;
  affiliation?: string | null;
}

// Tiered extraction: paper text first; web search only if the paper yields
// nothing send-eligible. Returns null below the 0.7 threshold (D1); the caller
// owns the needs_manual_lookup transition (D10).
export async function extractContact(
  deps: ContactDeps,
  person: TargetPerson,
  paperText: string | null,
): Promise<SelectedEmail | null> {
  if (paperText) {
    const tier1 = selectEmail(extractPaperEmailCandidates(paperText), person.name);
    if (tier1) return tier1;
  }
  const affiliation = person.affiliation ?? '';
  const queries = [
    `"${person.name}" ${affiliation} email`.trim(),
    `"${person.name}" github`,
  ];
  const pages: WebPage[] = [];
  for (const query of queries) {
    pages.push(...(await deps.search.search(query)));
  }
  return selectEmail(extractWebEmailCandidates(pages, person.name), person.name);
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
