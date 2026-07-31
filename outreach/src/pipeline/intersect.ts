// Intersection engine (D6): score genuine overlaps between the self ontology and
// a person's ontology into ranked, tiered hooks. Spec: docs/spec-profile-mining.md.
import { factRows, saveIntersections, type DB, type StoredFact } from '../db/db.js';
import type { LLMClient } from '../llm/client.js';
import { INTERSECT_SYSTEM, buildIntersectUser } from '../llm/prompts.js';
import type { OntologyFact } from './research.js';
import { containsWholeWords, normalizeForMatch as normEntity } from '../text/match.js';

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
  personSourceUrl: string; // traces the hook to the underlying person fact; draft.ts uses this to detect a paper-only hook
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
  const candidates = [...entityMatches(self, person), ...mapIntersections(raw, self, person)].filter(isSpecificHook);
  const merged = mergeByPair(candidates);
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
      personSourceUrl: p.sourceUrl,
      strength,
      tier: minTier(s.tier, p.tier),
      rationale: String(r.rationale ?? ''),
    });
  }
  return out.sort((a, b) => b.strength - a.strength).slice(0, MAX_INTERSECTIONS);
}

// Entities that can never on their own constitute a hook: they are too broad or
// too common to be discriminating (everyone shares them, so they are not common
// ground). This is what let "both are involved in computer science" and "both
// have connections to institutions in the United States" through at 0.30 to
// 0.50 strength, above MIN_STRENGTH, even though neither says anything specific
// about the two people.
export const GENERIC_ENTITIES: readonly string[] = [
  // broad fields
  'computer science', 'artificial intelligence', 'machine learning', 'deep learning',
  'engineering', 'mathematics', 'science', 'technology', 'data science',
  // commodity tools every practitioner uses
  'claude', 'anthropic claude', 'chatgpt', 'gpt-4', 'gpt4', 'python', 'pytorch',
  'tensorflow', 'github', 'git', 'docker', 'linux', 'vs code', 'visual studio code',
  'jupyter', 'numpy', 'pandas',
  // geographic and organizational generics
  'united states', 'usa', 'china', 'europe', 'university', 'institute', 'laboratory',
  // Bare one-word nouns. OpenAlex research-area concepts are frequently a
  // single common word, and a single common word shared between two people is
  // not common ground: "both: Robot" and "both: Obstacle" are true and say
  // nothing. This list was drawn from the concepts actually observed on mined
  // profiles in the live database, so it is enumeration and it does NOT
  // generalize: a bare noun not listed here still gets through, which is why
  // the structural demotion below (single-token containment scores 0.60, not
  // 0.85) is the primary defense and this list is the secondary one. Terms
  // central to the project's actual domain (olfaction, odor, olfactory) are
  // deliberately absent: for this target population they ARE discriminating,
  // and removing them would have deleted the only hook three real people had.
  'robot', 'robotics', 'obstacle', 'sensor', 'sensors', 'simulation',
  'algorithm', 'optimization', 'network', 'networks', 'model', 'models',
  'system', 'systems', 'data', 'software', 'hardware', 'computation',
  'computing', 'internet', 'cloud', 'database', 'statistics', 'physics',
  'chemistry', 'biology', 'medicine', 'psychology', 'economics', 'education',
  'management', 'nature',
];

const GENERIC_SET = new Set(GENERIC_ENTITIES.map(normEntity));

// Is this entity, taken as a whole, too generic to ever be a hook by itself?
// Matches the WHOLE normalized entity, not a substring: "machine learning" is
// generic, but "physics-informed machine learning" and "GitHub Actions runner
// autoscaling" are specific overlaps that merely contain a generic word, and
// must NOT be filtered. Only an entity that IS, in its entirety, one of the
// generic terms gets caught here.
export const isGenericEntity = (value: string): boolean => GENERIC_SET.has(normEntity(value));

// Drop any hook whose matched entity is generic on either side: sharing a
// broad field, a country, or a commodity tool is not common ground and must
// never open a cold email, no matter how the LLM scored it.
const isSpecificHook = (h: Intersection): boolean =>
  !isGenericEntity(h.selfValue) && !isGenericEntity(h.personValue);

// containsWholeWords and the entity normalizer now live in src/text/match.ts,
// shared with discovery/relevanceGate.ts. They diverged once and that cost a
// live bad hook on two real people; one implementation is the fix.

const CONTAINMENT_MIN_LEN = 5; // the shorter side must carry some information
const EXACT_STRENGTH = 0.95;
const CONTAINMENT_STRENGTH = 0.85;
// A single shared TOKEN is a much weaker signal than a shared phrase, but it
// is not always noise: an OpenAlex research area of "olfaction" against a self
// fact about olfaction research is the actual reason for the outreach, and in
// the live database that shape was the ONLY hook three real people had. So it
// is demoted rather than deleted: below every phrase-level match, above
// STRONG_HOOK so it can still carry a draft when it is genuinely all there is.
// The complementary defense is GENERIC_ENTITIES above, which removes the bare
// nouns ("Robot", "Obstacle") that make this shape vacuous.
const SINGLE_TOKEN_CONTAINMENT_STRENGTH = 0.6;

const tokenCount = (s: string): number => (s ? s.split(' ').length : 0);

// Deterministic entity overlap: same normalized value (0.95), one phrase
// containing another at word boundaries (0.85), or one bare token contained in
// the other (0.60). This is the reliable core of intersection scoring,
// independent of the LLM.
function entityMatches(self: StoredFact[], person: StoredFact[]): Intersection[] {
  const out: Intersection[] = [];
  for (const s of self) {
    const ns = normEntity(s.value);
    if (ns.length < 3) continue;
    for (const p of person) {
      const np = normEntity(p.value);
      if (np.length < 3) continue;
      let strength = 0;
      if (ns === np) {
        strength = EXACT_STRENGTH;
      } else if (
        Math.min(ns.length, np.length) >= CONTAINMENT_MIN_LEN &&
        (containsWholeWords(ns, np) || containsWholeWords(np, ns))
      ) {
        const shorterTokens = ns.length <= np.length ? tokenCount(ns) : tokenCount(np);
        strength = shorterTokens >= 2 ? CONTAINMENT_STRENGTH : SINGLE_TOKEN_CONTAINMENT_STRENGTH;
      }
      if (!strength) continue;
      out.push({
        selfFactId: s.id,
        personFactId: p.id,
        selfValue: s.value,
        personValue: p.value,
        selfDetail: s.detail,
        personDetail: p.detail,
        selfStance: s.stance,
        personSourceUrl: p.sourceUrl,
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
  return [...best.values()].sort(rankHook).slice(0, MAX_INTERSECTIONS);
}

// Strength ranks first, descending; tier only breaks ties (equal strength).
// A strong, specific match is more valuable than a weak one, regardless of
// which source produced it, so strength must dominate the ordering: this is
// what makes a 0.95 exact-entity match (e.g. hierarchical mixture of experts,
// capped at tier B because it came from a paper) outrank a 0.30 to 0.50
// vacuous match that happens to be tier A (e.g. "both in computer science").
// Tier only decides between hooks that scored the same, where the
// better-evidenced (lower TIER_RANK) source should lead.
function rankHook(a: Intersection, b: Intersection): number {
  const strengthDiff = b.strength - a.strength;
  if (strengthDiff !== 0) return strengthDiff;
  return (TIER_RANK[a.tier] ?? 2) - (TIER_RANK[b.tier] ?? 2);
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
