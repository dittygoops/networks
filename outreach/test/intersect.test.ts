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

function seed(db: ReturnType<typeof openDb>) {
  saveSelfFacts(db, [
    fact({ key: 'method', value: '3D Gaussian Splatting' }), // s0
    fact({ key: 'research_area', value: 'nuScenes evaluation', tier: 'B' }), // s1
  ]);
  const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
  saveFacts(db, pid, [
    fact({ key: 'method', value: '3D Gaussian Splatting' }), // p0
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
function seedFanout(db: ReturnType<typeof openDb>) {
  saveSelfFacts(db, [
    fact({ key: 'research_area', value: 'neural rendering' }), // s0
    fact({ key: 'method', value: '3D Gaussian Splatting' }), // s1
  ]);
  const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A2' });
  saveFacts(db, pid, [
    fact({ key: 'research_area', value: 'neural rendering' }), // p0
    fact({ key: 'research_area', value: 'novel view synthesis' }), // p1
    fact({ key: 'research_area', value: 'radiance fields' }), // p2
    fact({ key: 'method', value: '3D Gaussian Splatting' }), // p3
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
