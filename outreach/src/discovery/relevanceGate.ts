// Two stage gate. Stage 1 is deterministic term overlap against the research
// gap terms. Only borderline scores reach the LLM judge, so clear keeps and
// clear drops cost nothing. Reasons are quoted from real terms, never invented.
import type { LLMClient } from '../llm/client.js';
import type { GateConfig } from './config.js';
import type { Candidate } from './types.js';

export interface GateVerdict {
  keep: boolean;
  score: number;
  reason: string;
}

function haystack(c: Candidate): string {
  return `${c.title} ${c.abstract ?? ''}`.toLowerCase();
}

// Fraction of gap terms present in the title or abstract, weighted so that a
// single strong multi-word match already scores well.
export function scoreOverlap(c: Candidate, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = haystack(c);
  let best = 0;
  let hits = 0;
  for (const term of terms) {
    const t = term.toLowerCase().trim();
    if (!t) continue;
    if (hay.includes(t)) {
      hits++;
      best = Math.max(best, 1);
      continue;
    }
    const words = t.split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) continue;
    const matched = words.filter((w) => hay.includes(w)).length;
    best = Math.max(best, matched / words.length);
  }
  if (hits > 0) return 1;
  return Math.min(1, best);
}

export function matchedTerms(c: Candidate, terms: string[]): string[] {
  const hay = haystack(c);
  return terms.filter((t) => t.trim() && hay.includes(t.toLowerCase().trim()));
}

const JUDGE_SYSTEM = [
  "You judge whether a paper is relevant to a researcher's stated open research gaps.",
  'Reply with JSON only: {"score": <0..1>, "reason": "<one short sentence>"}.',
  'Ground the reason in the supplied gap terms. Never invent facts about the paper or the researcher.',
].join(' ');

interface JudgeReply {
  score?: number;
  reason?: string;
}

export async function gateCandidate(
  c: Candidate,
  terms: string[],
  gate: GateConfig,
  llm?: LLMClient,
): Promise<GateVerdict> {
  const raw = scoreOverlap(c, terms);
  const low = gate.threshold - gate.borderlineBand;
  const high = gate.threshold + gate.borderlineBand;

  if (raw >= high) {
    const hit = matchedTerms(c, terms);
    return {
      keep: true,
      score: raw,
      reason: `matches gap term: ${hit.length ? hit.join(', ') : terms[0]}`,
    };
  }
  if (raw <= low) {
    return { keep: false, score: raw, reason: `overlap ${raw.toFixed(2)} below threshold ${gate.threshold}` };
  }

  if (!llm) return { keep: raw >= gate.threshold, score: raw, reason: `borderline ${raw.toFixed(2)}, no judge configured` };

  const user = [
    `Research gaps: ${terms.join('; ')}`,
    `Paper title: ${c.title}`,
    `Paper abstract: ${c.abstract ?? '(none)'}`,
  ].join('\n');

  try {
    const text = await llm.complete(JUDGE_SYSTEM, user);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const parsed = JSON.parse(match[0]) as JudgeReply;
    if (typeof parsed.score !== 'number' || Number.isNaN(parsed.score)) throw new Error('no score');
    return {
      keep: parsed.score >= gate.threshold,
      score: parsed.score,
      reason: parsed.reason?.trim() || `judge scored ${parsed.score.toFixed(2)}`,
    };
  } catch {
    return { keep: raw >= gate.threshold, score: raw, reason: `borderline ${raw.toFixed(2)}, judge unavailable` };
  }
}
