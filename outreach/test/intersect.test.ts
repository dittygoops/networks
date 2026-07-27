import { describe, expect, test } from 'vitest';
import { openDb, upsertPerson, saveFacts, saveSelfFacts } from '../src/db/db.js';
import { computeIntersections, SelfOntologyMissingError } from '../src/pipeline/intersect.js';
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
