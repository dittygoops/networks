import { describe, expect, test } from 'vitest';
import { openDb, upsertPerson, saveFacts, saveSelfFacts } from '../src/db/db.js';
import { computeIntersections, isGenericEntity, SelfOntologyMissingError } from '../src/pipeline/intersect.js';
import type { LLMClient } from '../src/llm/client.js';
import type { OntologyFact } from '../src/pipeline/research.js';

const fact = (p: Partial<OntologyFact>): OntologyFact => ({
  facet: 'academic', key: 'research_area', value: 'x', sourceUrl: 's', confidence: 0.85, tier: 'A', ...p,
});

// A fake LLM that returns a fixed intersections JSON, ignoring the prompt.
const fakeLLM = (json: string): LLMClient => ({ async complete() { return json; } });

// Distinct, non-overlapping entities, so these seeds exercise ONLY the LLM
// mapping/dedupe logic; the deterministic entity match is tested separately.
function seed(db: ReturnType<typeof openDb>) {
  saveSelfFacts(db, [
    fact({ key: 'method', value: 'Alpha' }), // s0
    fact({ key: 'research_area', value: 'Beta', tier: 'B' }), // s1
  ]);
  const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
  saveFacts(db, pid, [
    fact({ key: 'method', value: 'Gamma' }), // p0
    fact({ key: 'interest', facet: 'interest', value: 'hiking', tier: 'C', confidence: 0.6 }), // p1
  ]);
  return pid;
}

describe('computeIntersections (D6)', () => {
  test('throws SelfOntologyMissingError when no self facts exist', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'X', openalexId: 'A1' });
    saveFacts(db, pid, [fact({})]);
    await expect(computeIntersections(db, { llm: fakeLLM('[]') }, pid)).rejects.toBeInstanceOf(SelfOntologyMissingError);
  });

  test('maps indices to facts, sets tier=min, filters <0.3, stores and returns ranked', async () => {
    const db = openDb(':memory:');
    const pid = seed(db);
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.95, rationale: 'both work on 3DGS' },
      { self: 's1', person: 'p1', strength: 0.2, rationale: 'weak' }, // dropped (<0.3)
    ]));
    const { ranked, noStrongHook } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ strength: 0.95, tier: 'A', rationale: 'both work on 3DGS' });
    expect(noStrongHook).toBe(false);
    // persisted
    expect(db.prepare('SELECT COUNT(*) AS n FROM intersections WHERE person_id = ?').get(pid)).toEqual({ n: 1 });
  });

  test('exact entity match produces a strong hook even when the LLM returns nothing', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'method', value: '3D Gaussian Splatting' })]);
    const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
    saveFacts(db, pid, [fact({ key: 'method', value: '3D Gaussian Splatting' })]);
    const { ranked, noStrongHook } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    const exact = ranked.find((x) => x.personValue === '3D Gaussian Splatting');
    expect(exact?.strength).toBeGreaterThanOrEqual(0.9);
    expect(noStrongHook).toBe(false);
  });

  test('carries detail through so the draft can cite specifics', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'dataset', value: 'nuScenes', detail: 'measured recall' })]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A3' });
    saveFacts(db, pid, [fact({ key: 'dataset', value: 'nuScenes', detail: 'trained a detector on it' })]);
    const { ranked } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    const hit = ranked.find((x) => x.personValue === 'nuScenes');
    expect(hit?.selfDetail).toBe('measured recall');
    expect(hit?.personDetail).toBe('trained a detector on it');
  });

  test('noStrongHook is true when nothing scores >= 0.5', async () => {
    const db = openDb(':memory:');
    const pid = seed(db);
    const llm = fakeLLM(JSON.stringify([{ self: 's0', person: 'p1', strength: 0.4, rationale: 'meh' }]));
    const { ranked, noStrongHook } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(1);
    expect(noStrongHook).toBe(true);
  });

  test('ignores out-of-range indices from the model', async () => {
    const db = openDb(':memory:');
    const pid = seed(db);
    const llm = fakeLLM(JSON.stringify([{ self: 's9', person: 'p0', strength: 0.9, rationale: 'hallucinated index' }]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(0);
  });

  test('recomputing replaces prior intersections (not accumulate)', async () => {
    const db = openDb(':memory:');
    const pid = seed(db);
    const llm = fakeLLM(JSON.stringify([{ self: 's0', person: 'p0', strength: 0.9, rationale: 'a' }]));
    await computeIntersections(db, { llm }, pid);
    await computeIntersections(db, { llm }, pid);
    expect(db.prepare('SELECT COUNT(*) AS n FROM intersections WHERE person_id = ?').get(pid)).toEqual({ n: 1 });
  });
});

// Seed one self fact against several person facts so a single self-fact can spawn
// many near-duplicate hooks (the noise D6 dedupe removes).
// Distinct entities (no deterministic matches) so these tests exercise only the
// LLM-driven dedupe/cap logic.
function seedFanout(db: ReturnType<typeof openDb>) {
  saveSelfFacts(db, [
    fact({ key: 'research_area', value: 'SelfAreaOne' }), // s0
    fact({ key: 'method', value: 'SelfMethodTwo' }), // s1
  ]);
  const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A2' });
  saveFacts(db, pid, [
    fact({ key: 'research_area', value: 'PersonAlpha' }), // p0
    fact({ key: 'research_area', value: 'PersonBravo' }), // p1
    fact({ key: 'research_area', value: 'PersonCharlie' }), // p2
    fact({ key: 'method', value: 'PersonDelta' }), // p3
  ]);
  return pid;
}

describe('computeIntersections dedupe (D6)', () => {
  test('caps at 2 intersections per selfFactId, keeping the strongest', async () => {
    const db = openDb(':memory:');
    const pid = seedFanout(db);
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.8, rationale: 'both in neural rendering' },
      { self: 's0', person: 'p1', strength: 0.7, rationale: 'both in view synthesis' },
      { self: 's0', person: 'p2', strength: 0.6, rationale: 'both in radiance fields' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((x) => x.strength)).toEqual([0.8, 0.7]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM intersections WHERE person_id = ?').get(pid)).toEqual({ n: 2 });
  });

  test('collapses exact-duplicate rationales into one, keeping the highest strength', async () => {
    const db = openDb(':memory:');
    const pid = seedFanout(db);
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.6, rationale: 'both are in neural rendering and computer graphics' },
      { self: 's1', person: 'p3', strength: 0.8, rationale: 'both are in neural rendering and computer graphics' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ strength: 0.8, rationale: 'both are in neural rendering and computer graphics' });
  });

  test('leaves a diverse set unchanged', async () => {
    const db = openDb(':memory:');
    const pid = seedFanout(db);
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.9, rationale: 'neural rendering overlap' },
      { self: 's1', person: 'p3', strength: 0.8, rationale: '3DGS overlap' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(2);
    expect(ranked.map((x) => x.strength)).toEqual([0.9, 0.8]);
  });

  test('noStrongHook reflects the deduped set', async () => {
    const db = openDb(':memory:');
    const pid = seedFanout(db);
    // The only >=0.5 hook is an exact-rationale duplicate of a weaker one; after
    // dedupe the strongest survives, so noStrongHook stays false.
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.6, rationale: 'same subfield' },
      { self: 's1', person: 'p3', strength: 0.4, rationale: 'same subfield' },
    ]));
    const { ranked, noStrongHook } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ strength: 0.6 });
    expect(noStrongHook).toBe(false);
  });
});

// The diagnosed problem, reproduced directly: an author's mined profile facts
// are bare OpenAlex concepts, too generic to match a specific self fact, so no
// hook is possible from the profile alone. A paper-derived fact for the exact
// entity closes that gap. HiMoE-VLA shape (see docs in the requirements): the
// self fact "hierarchical mixture of experts" is what the paper itself is
// about.
describe('computeIntersections with paper-derived facts (paper-fact hook gap)', () => {
  const paperFact = (over: Partial<OntologyFact> = {}): OntologyFact => ({
    facet: 'academic',
    key: 'method',
    value: 'hierarchical mixture of experts',
    stance: 'done',
    sourceUrl: 'https://arxiv.org/abs/2512.05693',
    confidence: 0.7,
    tier: 'B',
    ...over,
  });

  test('generic profile facts alone yield no hooks; adding the paper-derived fact yields one', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'method', value: 'hierarchical mixture of experts' })]); // s0, tier A
    const pid = upsertPerson(db, { name: 'Zhiying Du', openalexId: 'A_HIMOE' });
    // Bare OpenAlex concepts: too generic to match anything specific.
    saveFacts(db, pid, [
      fact({ key: 'research_area', value: 'Artificial intelligence' }),
      fact({ key: 'research_area', value: 'Computer vision' }),
      fact({ key: 'research_area', value: 'Computer science' }),
    ]);

    const before = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(before.ranked).toHaveLength(0);
    expect(before.noStrongHook).toBe(true);

    // Now the paper contributes its own fact about the author.
    saveFacts(db, pid, [paperFact()]);
    const after = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(after.ranked.length).toBeGreaterThan(0);
    const hook = after.ranked.find((x) => x.personValue === 'hierarchical mixture of experts');
    expect(hook).toBeDefined();
    expect(hook?.tier).toBe('B'); // min(self A, person B) = B
    expect(after.noStrongHook).toBe(false);
  });

  test('a profile-derived tier A hook still outranks a paper-derived tier B hook', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({ key: 'method', value: 'hierarchical mixture of experts' }), // s0, tier A
      fact({ key: 'research_area', value: 'olfaction' }), // s1, tier A
    ]);
    const pid = upsertPerson(db, { name: 'Zhiying Du', openalexId: 'A_HIMOE2' });
    saveFacts(db, pid, [
      // Profile-derived, tier A, exact entity match: a real, well-evidenced hook.
      fact({ key: 'research_area', value: 'olfaction' }),
      // Paper-derived, tier B, also an exact entity match (same strength).
      paperFact(),
    ]);

    const { ranked } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    const aIndex = ranked.findIndex((x) => x.personValue === 'olfaction');
    const bIndex = ranked.findIndex((x) => x.personValue === 'hierarchical mixture of experts');
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThanOrEqual(0);
    expect(ranked[aIndex]?.tier).toBe('A');
    expect(ranked[bIndex]?.tier).toBe('B');
    expect(aIndex).toBeLessThan(bIndex); // tier A hook ranks ahead despite equal strength
  });
});

// The diagnosed live-run failure: raw substring containment matched the
// normalized self value "heterogeneous molecular signatures of human odor
// perception" against the person value "Nature" because "nature" is a raw
// substring of "signatures". That spelling coincidence was the ONLY hook for
// two real people (Yitong Zhu, Zhuo Li), so their draft would have opened on
// a fabricated shared interest. Word-boundary matching must not find "nature"
// inside "signatures".
describe('entityMatches word-boundary regression (D6, live bad case)', () => {
  test('"Nature" does not match inside "...Signatures of Human Odor Perception..."', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({
        key: 'key_paper',
        value: 'Heterogeneous Molecular Signatures of Human Odor Perception (Zanineli 2026)',
      }),
    ]);
    const pid = upsertPerson(db, { name: 'Yitong Zhu', openalexId: 'A_ZANINELI' });
    saveFacts(db, pid, [fact({ key: 'venue', value: 'Nature' })]);

    const { ranked, noStrongHook } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);

    expect(ranked.some((x) => x.personValue === 'Nature')).toBe(false);
    expect(ranked).toHaveLength(0);
    expect(noStrongHook).toBe(true);
  });
});

describe('isGenericEntity', () => {
  test('flags broad fields, commodity tools, and geographic/organizational generics', () => {
    expect(isGenericEntity('computer science')).toBe(true);
    expect(isGenericEntity('Computer Science')).toBe(true); // case-insensitive
    expect(isGenericEntity('Anthropic Claude')).toBe(true);
    expect(isGenericEntity('United States')).toBe(true);
    expect(isGenericEntity('Python')).toBe(true);
  });

  test('does not flag specific entities', () => {
    expect(isGenericEntity('hierarchical mixture of experts')).toBe(false);
    expect(isGenericEntity('nuScenes')).toBe(false);
    expect(isGenericEntity('3D Gaussian Splatting')).toBe(false);
    expect(isGenericEntity('physics-informed machine learning')).toBe(false);
  });

  test('matches the whole entity, not a substring: a specific entity that merely contains a generic word survives', () => {
    // Contains "machine learning" but is a specific, narrower subfield.
    expect(isGenericEntity('physics-informed machine learning')).toBe(false);
    // Contains "GitHub" but is a specific project/topic, not the bare tool.
    expect(isGenericEntity('GitHub Actions runner autoscaling')).toBe(false);
  });
});

describe('computeIntersections drops generic-entity hooks (D6 genericness filter)', () => {
  test('an LLM-proposed intersection is dropped when the person-side matched entity is generic', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'tool', facet: 'interest', value: 'Anthropic Claude' })]); // s0
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A9' });
    saveFacts(db, pid, [fact({ key: 'research_area', value: 'Computer science' })]); // p0
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.3, rationale: 'Both are involved in computer science.' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(0);
  });

  test('an LLM-proposed intersection is dropped when the self-side matched entity is generic, even if the person side is specific', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'tool', facet: 'interest', value: 'Python' })]); // s0
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A10' });
    saveFacts(db, pid, [fact({ key: 'method', value: 'nuScenes' })]); // p0
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.4, rationale: 'Both use common tooling.' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(0);
  });

  test('an exact entity match is still dropped when the shared value is itself generic (deterministic path, not just the LLM path)', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'research_area', value: 'Machine learning' })]); // s0
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A11' });
    saveFacts(db, pid, [fact({ key: 'research_area', value: 'Machine learning' })]); // p0, would otherwise be a 0.95 exact match
    const { ranked } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(ranked).toHaveLength(0);
  });
});

describe('mergeByPair sorts by strength first, tier only as a tiebreaker', () => {
  test('a 0.95 tier B hook ranks ahead of a 0.50 tier A hook', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({ key: 'method', value: 'WeakMatchSelf', tier: 'A' }), // s0
      fact({ key: 'method', value: 'StrongMatchSelf', tier: 'B' }), // s1
    ]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A12' });
    saveFacts(db, pid, [
      fact({ key: 'method', value: 'WeakMatchPerson', tier: 'A' }), // p0
      fact({ key: 'method', value: 'StrongMatchPerson', tier: 'B' }), // p1
    ]);
    const llm = fakeLLM(JSON.stringify([
      { self: 's0', person: 'p0', strength: 0.5, rationale: 'weak tier A match' },
      { self: 's1', person: 'p1', strength: 0.95, rationale: 'strong tier B match' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({ strength: 0.95, tier: 'B' });
    expect(ranked[1]).toMatchObject({ strength: 0.5, tier: 'A' });
  });

  test('given equal strength, the tier A hook ranks first', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({ key: 'method', value: 'TierASelf', tier: 'A' }), // s0
      fact({ key: 'method', value: 'TierBSelf', tier: 'B' }), // s1
    ]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A13' });
    saveFacts(db, pid, [
      fact({ key: 'method', value: 'TierAPerson', tier: 'A' }), // p0
      fact({ key: 'method', value: 'TierBPerson', tier: 'B' }), // p1
    ]);
    const llm = fakeLLM(JSON.stringify([
      { self: 's1', person: 'p1', strength: 0.7, rationale: 'tier B match' },
      { self: 's0', person: 'p0', strength: 0.7, rationale: 'tier A match' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toMatchObject({ strength: 0.7, tier: 'A' });
    expect(ranked[1]).toMatchObject({ strength: 0.7, tier: 'B' });
  });
});

// The diagnosed live-run failure, reproduced end to end: the engine chose three
// hooks for a real draft, and the weakest, most vacuous one ("I used Claude" /
// "both in computer science") opened the email instead of the excellent exact
// method match (hierarchical mixture of experts). The genericness filter must
// drop both vacuous hooks, and strength-first sorting must put the MoE hook
// first among whatever survives.
describe('regression: the real bad-draft case (vacuous hooks dropped, MoE hook leads)', () => {
  test('surviving ranked list leads with hierarchical mixture of experts; neither vacuous hook survives', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({ key: 'method', value: 'hierarchical mixture of experts', stance: 'exploring' }), // s0, exact entity match -> [B]
      fact({ key: 'institution', facet: 'trajectory', value: 'Arizona State University', stance: 'done' }), // s1
      fact({ key: 'tool', facet: 'interest', value: 'Anthropic Claude', stance: 'done' }), // s2
    ]);
    const pid = upsertPerson(db, { name: 'Author', openalexId: 'A_REGRESSION' });
    saveFacts(db, pid, [
      fact({ key: 'method', value: 'Hierarchical Mixture-of-Experts' }), // p0, exact entity match (case-insensitive) -> [B]
      fact({ key: 'institution', value: 'United States' }), // p1, generic geography, would be [A]
      fact({ key: 'research_area', value: 'Computer science' }), // p2, generic field, would be [A]
    ]);
    const llm = fakeLLM(JSON.stringify([
      { self: 's1', person: 'p1', strength: 0.5, rationale: 'Both have connections to institutions in the United States.' },
      { self: 's2', person: 'p2', strength: 0.3, rationale: 'Both are involved in computer science.' },
    ]));

    const { ranked } = await computeIntersections(db, { llm }, pid);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ personValue: 'Hierarchical Mixture-of-Experts', strength: 0.95 });
    expect(ranked.some((x) => x.personValue === 'United States')).toBe(false);
    expect(ranked.some((x) => x.personValue === 'Computer science')).toBe(false);
  });
});

// D4: an OpenAlex research-area concept is frequently ONE common word, and the
// containment rule awarded it 0.85, above STRONG_HOOK, so "both: Robot" could
// deterministically become the line a real email opens on. Two changes:
// single-token containment now scores 0.60 (structural, generalizes), and
// bare broad nouns joined GENERIC_ENTITIES (lexical, does not generalize).
describe('entityMatches single-token containment (D4)', () => {
  test('a bare generic noun contained in a longer self value is dropped entirely', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'project', value: 'Obstacle Detection Evaluation Pipeline' })]);
    const pid = upsertPerson(db, { name: 'Yanbaihui Liu', openalexId: 'A_OBSTACLE' });
    saveFacts(db, pid, [fact({ key: 'research_area', value: 'Obstacle' })]);

    const { ranked, noStrongHook } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(ranked.some((x) => x.personValue === 'Obstacle')).toBe(false);
    expect(noStrongHook).toBe(true);
  });

  test('"Robot" against "robot manipulation" no longer produces a deterministic 0.85 hook', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'research_area', value: 'robot manipulation' })]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A_ROBOT' });
    saveFacts(db, pid, [fact({ key: 'research_area', value: 'Robot' })]);

    const { ranked } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(ranked.some((x) => x.personValue === 'Robot')).toBe(false);
  });

  // The live-data counterweight. Six of the seven containment hooks in the
  // last snapshot with hooks were this shape, and for three people it was the
  // ONLY hook. A rule that deletes them trades a false-accept problem for a
  // silent recall collapse on exactly the population Aditya is writing to.
  test('a specific single-token research area still produces a usable hook, at reduced strength', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({
        key: 'research_area',
        value: 'just looking to connect and get more direction for future olfaction / smell research',
      }),
    ]);
    const pid = upsertPerson(db, { name: 'Gary Tom', openalexId: 'A_OLF' });
    saveFacts(db, pid, [fact({ key: 'research_area', value: 'olfaction' })]);

    const { ranked, noStrongHook } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    const hook = ranked.find((x) => x.personValue === 'olfaction');
    expect(hook).toBeDefined();
    expect(hook?.strength).toBe(0.6);
    expect(noStrongHook).toBe(false); // still above STRONG_HOOK, still draftable
  });

  test('a multi-token containment keeps its 0.85, and outranks a single-token one', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({ key: 'method', value: 'gaussian splatting' }),
      fact({ key: 'research_area', value: 'olfaction research' }),
    ]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A_MIX' });
    saveFacts(db, pid, [
      fact({ key: 'method', value: '3D gaussian splatting for dynamic scenes' }),
      fact({ key: 'research_area', value: 'olfaction' }),
    ]);

    const { ranked } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    const multi = ranked.find((x) => x.selfValue === 'gaussian splatting');
    const single = ranked.find((x) => x.personValue === 'olfaction');
    expect(multi?.strength).toBe(0.85);
    expect(single?.strength).toBe(0.6);
    expect(ranked.indexOf(multi!)).toBeLessThan(ranked.indexOf(single!));
  });

  test('exact equality is untouched at 0.95 even for a single token', async () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [fact({ key: 'research_area', value: 'olfaction' })]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A_EXACT' });
    saveFacts(db, pid, [fact({ key: 'research_area', value: 'Olfaction' })]);

    const { ranked } = await computeIntersections(db, { llm: fakeLLM('[]') }, pid);
    expect(ranked[0]?.strength).toBe(0.95);
  });
});

describe('isGenericEntity bare broad nouns (D4)', () => {
  test('flags bare one-word OpenAlex concepts that say nothing about a person', () => {
    expect(isGenericEntity('Robot')).toBe(true);
    expect(isGenericEntity('Obstacle')).toBe(true);
    expect(isGenericEntity('Sensor')).toBe(true);
    expect(isGenericEntity('Chemistry')).toBe(true);
  });

  test('does not flag the domain terms this project is actually about', () => {
    expect(isGenericEntity('olfaction')).toBe(false);
    expect(isGenericEntity('odor')).toBe(false);
    expect(isGenericEntity('olfactory perception')).toBe(false);
  });

  test('still matches the whole value only: a compound containing a bare noun survives', () => {
    expect(isGenericEntity('robot manipulation')).toBe(false);
    expect(isGenericEntity('robotic olfaction')).toBe(false);
    expect(isGenericEntity('obstacle detection evaluation pipeline')).toBe(false);
    expect(isGenericEntity('gas sensor array')).toBe(false);
  });
});

// D5: rankHook makes strength dominate, so an unclamped model number decides
// which hook opens a real email. relevanceGate already treats an out-of-range
// judge score as malformed; this path now matches it.
describe('mapIntersections rejects out-of-range model strengths (D5)', () => {
  const setup = () => {
    const db = openDb(':memory:');
    saveSelfFacts(db, [
      fact({ key: 'method', value: 'hierarchical mixture of experts' }), // s0
      fact({ key: 'method', value: 'learned embedding alignment' }), // s1
    ]);
    const pid = upsertPerson(db, { name: 'P', openalexId: 'A_CLAMP' });
    saveFacts(db, pid, [
      fact({ key: 'method', value: 'Hierarchical Mixture-of-Experts' }), // p0, exact 0.95
      fact({ key: 'method', value: 'graph convolutional networks' }), // p1
    ]);
    return { db, pid };
  };

  test('a strength above 1 is discarded, and the real 0.95 hook still leads', async () => {
    const { db, pid } = setup();
    const llm = fakeLLM(JSON.stringify([
      { self: 's1', person: 'p1', strength: 5, rationale: 'trust me' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked.some((x) => x.strength > 1)).toBe(false);
    expect(ranked.some((x) => x.rationale === 'trust me')).toBe(false);
    expect(ranked[0]?.strength).toBe(0.95);
  });

  test('a negative strength is discarded', async () => {
    const { db, pid } = setup();
    const llm = fakeLLM(JSON.stringify([
      { self: 's1', person: 'p1', strength: -3, rationale: 'negative' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked.some((x) => x.rationale === 'negative')).toBe(false);
  });

  test('a non-numeric or missing strength is discarded, not defaulted to 0 and kept', async () => {
    const { db, pid } = setup();
    const llm = fakeLLM(JSON.stringify([
      { self: 's1', person: 'p1', strength: 'very high', rationale: 'stringly typed' },
      { self: 's1', person: 'p1', rationale: 'no strength at all' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked.some((x) => x.rationale === 'stringly typed')).toBe(false);
    expect(ranked.some((x) => x.rationale === 'no strength at all')).toBe(false);
  });

  test('a strength of exactly 1 is still accepted', async () => {
    const { db, pid } = setup();
    const llm = fakeLLM(JSON.stringify([
      { self: 's1', person: 'p1', strength: 1, rationale: 'boundary' },
    ]));
    const { ranked } = await computeIntersections(db, { llm }, pid);
    expect(ranked.some((x) => x.rationale === 'boundary')).toBe(true);
  });
});
