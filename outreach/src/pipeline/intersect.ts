// Intersection engine (D6): score genuine overlaps between the self ontology and
// a person's ontology into ranked, tiered hooks. Spec: docs/spec-profile-mining.md.
import { factRows, saveIntersections, type DB, type StoredFact } from '../db/db.js';
import type { LLMClient } from '../llm/client.js';
import { INTERSECT_SYSTEM, buildIntersectUser } from '../llm/prompts.js';
import type { OntologyFact } from './research.js';

export class SelfOntologyMissingError extends Error {
  constructor() {
    super('No self ontology found. Run persona setup (or dev:seed-self) first.');
    this.name = 'SelfOntologyMissingError';
  }
}

export interface Intersection {
  selfFactId: number;
  personFactId: number;
  selfValue: string;
  personValue: string;
  selfDetail?: string;
  personDetail?: string;
  selfStance?: OntologyFact['stance']; // honesty: did Aditya do it, or is he exploring it?
  strength: number;
  tier: OntologyFact['tier'];
  rationale: string;
}

export interface IntersectDeps {
  llm: LLMClient;
}

const MIN_CONFIDENCE = 0.5; // facts below this never enter scoring (D6a)
const MIN_STRENGTH = 0.3; // intersections below this are discarded (D6)
const STRONG_HOOK = 0.5;
const MAX_INTERSECTIONS = 20;
const MAX_PER_SELF_FACT = 2; // a single self-fact should not spawn many near-duplicate hooks (D6)
const TIER_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

interface RawIntersection {
  self?: string;
  person?: string;
  strength?: number;
  rationale?: string;
}

export async function computeIntersections(
  db: DB,
  deps: IntersectDeps,
  personId: number,
): Promise<{ ranked: Intersection[]; noStrongHook: boolean }> {
  const self = factRows(db, null).filter((f) => f.confidence >= MIN_CONFIDENCE);
  if (self.length === 0) throw new SelfOntologyMissingError();

  const person = factRows(db, personId).filter((f) => f.confidence >= MIN_CONFIDENCE);
  if (person.length === 0) return { ranked: [], noStrongHook: true };

  // Deterministic entity matches (nuScenes == nuScenes) are reliable strong
  // hooks; the LLM pass adds conceptual overlaps between different entities.
  const raw = await callModel(deps.llm, self, person);
  const merged = mergeByPair([...entityMatches(self, person), ...mapIntersections(raw, self, person)]);
  const ranked = dedupe(merged);

  saveIntersections(db, personId, ranked.map((x) => ({
    selfFactId: x.selfFactId,
    personFactId: x.personFactId,
    strength: x.strength,
    tier: x.tier,
    rationale: x.rationale,
  })));

  return { ranked, noStrongHook: !ranked.some((x) => x.strength >= STRONG_HOOK) };
}

async function callModel(llm: LLMClient, self: StoredFact[], person: StoredFact[]): Promise<RawIntersection[]> {
  try {
    const text = await llm.complete(INTERSECT_SYSTEM, buildIntersectUser(self, person));
    const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? (parsed as RawIntersection[]) : [];
  } catch {
    return []; // model/parse failure yields no hooks rather than crashing
  }
}

const minTier = (a: OntologyFact['tier'], b: OntologyFact['tier']): OntologyFact['tier'] =>
  (TIER_RANK[a] ?? 2) >= (TIER_RANK[b] ?? 2) ? a : b;

const parseIndex = (ref: string | undefined, prefix: string, len: number): number | null => {
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) return null;
  const i = Number(ref.slice(prefix.length));
  return Number.isInteger(i) && i >= 0 && i < len ? i : null;
};

function mapIntersections(raw: RawIntersection[], self: StoredFact[], person: StoredFact[]): Intersection[] {
  const out: Intersection[] = [];
  for (const r of raw) {
    const si = parseIndex(r.self, 's', self.length);
    const pi = parseIndex(r.person, 'p', person.length);
    const strength = typeof r.strength === 'number' && Number.isFinite(r.strength) ? r.strength : 0;
    if (si === null || pi === null || strength < MIN_STRENGTH) continue;
    const s = self[si]!;
    const p = person[pi]!;
    out.push({
      selfFactId: s.id,
      personFactId: p.id,
      selfValue: s.value,
      personValue: p.value,
      selfDetail: s.detail,
      personDetail: p.detail,
      selfStance: s.stance,
      strength,
      tier: minTier(s.tier, p.tier),
      rationale: String(r.rationale ?? ''),
    });
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, MAX_INTERSECTIONS);
}

const normEntity = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Deterministic entity overlap: same normalized value (0.95), or one clearly
// contains the other (0.85), e.g. "gaussian splatting" in "3d gaussian splatting".
// This is the reliable core of intersection scoring, independent of the LLM.
function entityMatches(self: StoredFact[], person: StoredFact[]): Intersection[] {
  const out: Intersection[] = [];
  for (const s of self) {
    const ns = normEntity(s.value);
    if (ns.length < 3) continue;
    for (const p of person) {
      const np = normEntity(p.value);
      if (np.length < 3) continue;
      let strength = 0;
      if (ns === np) strength = 0.95;
      else if (Math.min(ns.length, np.length) >= 5 && (ns.includes(np) || np.includes(ns))) strength = 0.85;
      if (!strength) continue;
      out.push({
        selfFactId: s.id,
        personFactId: p.id,
        selfValue: s.value,
        personValue: p.value,
        selfDetail: s.detail,
        personDetail: p.detail,
        selfStance: s.stance,
        strength,
        tier: minTier(s.tier, p.tier),
        rationale: `both: ${p.value}`,
      });
    }
  }
  return out;
}

// Keep the strongest hook per (selfFactId, personFactId) pair across sources.
function mergeByPair(hooks: Intersection[]): Intersection[] {
  const best = new Map<string, Intersection>();
  for (const h of hooks) {
    const k = `${h.selfFactId}|${h.personFactId}`;
    const cur = best.get(k);
    if (!cur || h.strength > cur.strength) best.set(k, h);
  }
  return [...best.values()].sort((a, b) => b.strength - a.strength).slice(0, MAX_INTERSECTIONS);
}

// Cleans up near-duplicate hooks from a strength-descending list (D6): collapse exact
// rationale repeats, cap how many hooks one self-fact can spawn, then re-apply the
// global strength floor and top-20 cut. Input stays sorted, so keeping the first hit
// per group keeps the strongest.
function dedupe(ranked: Intersection[]): Intersection[] {
  const seenRationale = new Set<string>();
  const perSelfCount = new Map<number, number>();
  const kept: Intersection[] = [];
  for (const x of ranked) {
    if (seenRationale.has(x.rationale)) continue;
    const count = perSelfCount.get(x.selfFactId) ?? 0;
    if (count >= MAX_PER_SELF_FACT) continue;
    seenRationale.add(x.rationale);
    perSelfCount.set(x.selfFactId, count + 1);
    kept.push(x);
  }
  return kept.filter((x) => x.strength >= MIN_STRENGTH).slice(0, MAX_INTERSECTIONS);
}
