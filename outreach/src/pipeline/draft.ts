// Draft generation (DR1-DR5): turn hooks + profile + intent into a short,
// casual-but-polite outreach email. No send. Spec: docs/spec-draft.md.
import type { LLMClient } from '../llm/client.js';
import { DRAFT_SYSTEM, buildDraftUser, type DraftPromptInput } from '../llm/prompts.js';

export type DraftInput = DraftPromptInput;

export interface Draft {
  subject: string;
  body: string;
  grounded: boolean;
  wordCount: number;
  notes: string[];
}

const MAX_WORDS = 160; // hard flag ceiling; the prompt aims for < 120
const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;
// Replace em/en dashes with a comma (Aditya's hard no-em-dash rule).
const stripDashes = (s: string): string => s.replace(/\s*[—–]\s*/g, ', ');
// Stems (first 5 chars of each >=5-char word), so "olfactory" and "olfaction"
// both reduce to "olfac" and the grounding check tolerates natural paraphrase.
const stems = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
const shares = (bodyStems: Set<string>, text: string): boolean => {
  for (const t of stems(text)) if (bodyStems.has(t)) return true;
  return false;
};

export async function generateDraft(llm: LLMClient, input: DraftInput): Promise<Draft> {
  const notes: string[] = [];
  let raw: string;
  try {
    raw = await llm.complete(DRAFT_SYSTEM, buildDraftUser(input));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { subject: '', body: '', grounded: false, wordCount: 0, notes: [`draft LLM call failed: ${msg}`] };
  }

  const parsed = parseDraft(raw);
  if (!parsed) {
    return { subject: '', body: '', grounded: false, wordCount: 0, notes: ['could not parse draft (bad JSON)'] };
  }

  // Enforce the no-em-dash rule deterministically: the model ignores the prompt
  // instruction often, so replace em/en dashes with a comma.
  const subject = stripDashes(parsed.subject);
  const body = stripDashes(parsed.body);
  const wc = wordCount(body);
  if (wc > MAX_WORDS) notes.push(`body is long (${wc} words)`);

  // DR4 grounding: the body should share a specific term with the recipient's
  // side (hook entities/details or the paper title) AND with Aditya's side.
  const bs = stems(body);
  const recipientGrounded =
    input.hooks.some((h) => shares(bs, h.personValue) || shares(bs, h.personDetail ?? '')) ||
    shares(bs, input.recipient.paperTitle ?? '');
  const senderGrounded =
    input.hooks.some((h) => shares(bs, h.selfValue) || shares(bs, h.selfDetail ?? '')) ||
    (input.senderFacts ?? []).some((f) => shares(bs, f));
  const grounded = recipientGrounded && senderGrounded;
  if (!grounded) notes.push('draft may be ungrounded (missing a specific recipient or sender reference)');

  return { subject, body, grounded, wordCount: wc, notes };
}

function parseDraft(text: string): { subject: string; body: string } | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const obj = JSON.parse(cleaned) as { subject?: unknown; body?: unknown };
    if (typeof obj.subject !== 'string' || typeof obj.body !== 'string') return null;
    return { subject: obj.subject, body: obj.body };
  } catch {
    return null;
  }
}
