// Persona subsystem: build Aditya's self-ontology from documents + a short
// self-interview. Writes facts with person_id NULL. Spec: docs/spec-persona.md.
import type { LLMClient } from '../llm/client.js';
import { SELF_EXTRACT_SYSTEM, buildSelfExtractUser } from '../llm/prompts.js';
import { normalizeKey, splitHobbyFacts, type OntologyFact } from './research.js';

const SELF_SOURCE = 'self';
const DEFAULT_DOC_CONFIDENCE = 0.85; // first-person authoritative materials
const INTERVIEW_CONFIDENCE = 0.95; // self-reported

// P4: self-fact tiers are deterministic by facet, NOT taken from the model.
// These are Aditya's own curated facts, so the "dig-only" Tier C does not apply:
// his professional work is lead-with-it (A) and his openly-listed personal facts
// (hobbies, communities) are mention-if-natural (B). The intersection engine
// takes min(self, person), so the person side still enforces the creepiness
// boundary. This is what keeps a resume-listed hobby (chess) usable as a hook.
const SELF_FACET_TIER: Record<OntologyFact['facet'], 'A' | 'B' | 'C'> = {
  academic: 'A',
  trajectory: 'A',
  interest: 'B',
};

interface RawFact {
  facet?: string;
  key?: string;
  value?: string;
  confidence?: number;
  proposedTier?: string;
}

const VALID_FACETS = new Set<OntologyFact['facet']>(['academic', 'trajectory', 'interest']);
const isFacet = (v: unknown): v is OntologyFact['facet'] => VALID_FACETS.has(v as OntologyFact['facet']);

function parseFacts(text: string): RawFact[] | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? (parsed as RawFact[]) : null;
  } catch {
    return null;
  }
}

// P2: extract About-Aditya facts from one document. LLM/parse failure yields [].
export async function factsFromDocument(llm: LLMClient, docText: string, sourceLabel: string): Promise<OntologyFact[]> {
  let raw: RawFact[] | null;
  try {
    raw = parseFacts(await llm.complete(SELF_EXTRACT_SYSTEM, buildSelfExtractUser(sourceLabel, docText)));
  } catch {
    return [];
  }
  if (!raw) return [];
  const facts: OntologyFact[] = [];
  for (const rf of raw) {
    if (!isFacet(rf.facet) || !rf.key || !rf.value) continue;
    const confidence = Number.isFinite(rf.confidence) ? Math.max(0, Math.min(1, rf.confidence as number)) : DEFAULT_DOC_CONFIDENCE;
    facts.push({
      facet: rf.facet,
      key: normalizeKey(rf.facet, String(rf.key)),
      value: String(rf.value).trim(),
      sourceUrl: `${SELF_SOURCE}:${sourceLabel}`,
      confidence,
      tier: SELF_FACET_TIER[rf.facet],
    });
  }
  return facts;
}

export interface InterviewQuestion {
  id: string;
  facet: OntologyFact['facet'];
  key: string;
  tier: 'A' | 'B' | 'C';
  prompt: string;
}

// P3: fixed questions for the facets documents miss.
export const INTERVIEW_QUESTIONS: InterviewQuestion[] = [
  { id: 'role', facet: 'trajectory', key: 'role', tier: 'A', prompt: 'What is your current role / background in one line?' },
  { id: 'location', facet: 'trajectory', key: 'location', tier: 'B', prompt: 'Which places have you lived or studied in?' },
  { id: 'hobby', facet: 'interest', key: 'hobby', tier: 'B', prompt: 'What hobbies do you have (chess, climbing, music, ...)?' },
  { id: 'community', facet: 'interest', key: 'community', tier: 'B', prompt: 'What communities are you part of?' },
  { id: 'side_project', facet: 'interest', key: 'side_project', tier: 'B', prompt: 'Any notable side projects?' },
  { id: 'looking_for', facet: 'interest', key: 'writing', tier: 'B', prompt: 'What are you hoping to get from reaching out to researchers?' },
];

// P3: map an answer map to facts, skipping blanks.
export function interviewFacts(answers: Record<string, string>): OntologyFact[] {
  const facts: OntologyFact[] = [];
  for (const q of INTERVIEW_QUESTIONS) {
    const value = (answers[q.id] ?? '').trim();
    if (!value) continue;
    facts.push({ facet: q.facet, key: q.key, value, sourceUrl: `${SELF_SOURCE}:interview`, confidence: INTERVIEW_CONFIDENCE, tier: q.tier });
  }
  return facts;
}

export interface PersonaDeps {
  llm: LLMClient;
}

export interface PersonaInput {
  documents: { label: string; text: string }[];
  answers?: Record<string, string>;
}

// P5: extract from each document (failures skip that doc), add interview facts,
// split hobby lists (shared helper), dedupe exact (facet,key,value). Caller persists.
export async function buildSelfOntology(deps: PersonaDeps, input: PersonaInput): Promise<OntologyFact[]> {
  const all: OntologyFact[] = [];
  for (const doc of input.documents) {
    all.push(...(await factsFromDocument(deps.llm, doc.text, doc.label)));
  }
  all.push(...interviewFacts(input.answers ?? {}));

  const seen = new Set<string>();
  const deduped: OntologyFact[] = [];
  for (const f of splitHobbyFacts(all)) {
    const k = `${f.facet}|${f.key}|${f.value.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(f);
  }
  return deduped;
}
