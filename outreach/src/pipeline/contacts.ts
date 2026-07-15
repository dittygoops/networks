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
