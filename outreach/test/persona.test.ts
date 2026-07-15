import { describe, expect, test } from 'vitest';
import { openDb, replaceSelfFacts, factRows } from '../src/db/db.js';
import { factsFromDocument, interviewFacts, buildSelfOntology, INTERVIEW_QUESTIONS } from '../src/pipeline/persona.js';
import { SELF_EXTRACT_SYSTEM } from '../src/llm/prompts.js';
import type { LLMClient } from '../src/llm/client.js';
import type { OntologyFact } from '../src/pipeline/research.js';

const self = (p: Partial<OntologyFact>): OntologyFact => ({
  facet: 'academic', key: 'method', value: 'x', sourceUrl: 'self', confidence: 0.9, tier: 'A', ...p,
});

// Fake LLM returning fixed JSON for the extraction system prompt.
const fakeLLM = (json: string): LLMClient => ({
  async complete(system) {
    if (system === SELF_EXTRACT_SYSTEM) return json;
    return '';
  },
});

describe('replaceSelfFacts (P1)', () => {
  test('replaces all self facts atomically, leaving person facts untouched', () => {
    const db = openDb(':memory:');
    const pid = db.prepare("INSERT INTO people (name) VALUES ('X')").run().lastInsertRowid as number;
    db.prepare("INSERT INTO ontology_facts (person_id, facet, key, value, confidence, usability_tier) VALUES (?, 'academic','k','v',0.8,'A')").run(pid);
    replaceSelfFacts(db, [self({ value: 'first' })]);
    replaceSelfFacts(db, [self({ value: 'second' }), self({ key: 'dataset', value: 'nuScenes' })]);
    const selfFacts = factRows(db, null);
    expect(selfFacts).toHaveLength(2); // replaced, not accumulated
    expect(selfFacts.map((f) => f.value).sort()).toEqual(['nuScenes', 'second']);
    expect(factRows(db, pid)).toHaveLength(1); // person facts intact
  });

  test('replacing self facts cascades away intersections that referenced them', () => {
    const db = openDb(':memory:');
    replaceSelfFacts(db, [self({ value: 'first' })]);
    const selfId = factRows(db, null)[0]!.id;
    const pid = db.prepare("INSERT INTO people (name) VALUES ('P')").run().lastInsertRowid as number;
    const pfid = db.prepare("INSERT INTO ontology_facts (person_id, facet, key, value, confidence, usability_tier) VALUES (?, 'academic','k','v',0.8,'A')").run(pid).lastInsertRowid as number;
    db.prepare('INSERT INTO intersections (person_id, self_fact_id, person_fact_id, strength, tier, rationale) VALUES (?, ?, ?, 0.9, ?, ?)').run(pid, selfId, pfid, 'A', 'r');
    expect(() => replaceSelfFacts(db, [self({ value: 'rebuilt' })])).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM intersections').get()).toEqual({ n: 0 });
  });
});

describe('factsFromDocument (P2)', () => {
  test('extracts About-Aditya facts, normalizes keys, defaults confidence, caps interest tier at B', async () => {
    const llm = fakeLLM(JSON.stringify([
      { facet: 'academic', key: 'methods', value: '3D Gaussian Splatting', proposedTier: 'A' }, // key variant, no confidence
      { facet: 'interest', key: 'hobby', value: 'chess', proposedTier: 'A' }, // interest proposed A -> capped B
    ]));
    const facts = await factsFromDocument(llm, 'banana project text', 'banana-project');
    const method = facts.find((f) => f.value === '3D Gaussian Splatting');
    expect(method?.key).toBe('method'); // normalized from 'methods'
    expect(method?.confidence).toBe(0.85); // default for authoritative self docs
    expect(method?.tier).toBe('A');
    expect(facts.find((f) => f.value === 'chess')?.tier).toBe('B'); // interest capped at B
  });

  test('does not crash when the model returns unparseable output', async () => {
    const facts = await factsFromDocument(fakeLLM('not json'), 'text', 'label');
    expect(facts).toEqual([]);
  });

  test('captures the entity value and the detail context separately', async () => {
    const facts = await factsFromDocument(
      fakeLLM(JSON.stringify([{ facet: 'academic', key: 'dataset', value: 'nuScenes', detail: 'measured recall against ground truth', proposedTier: 'A' }])),
      'eval', 'eval',
    );
    expect(facts[0]).toMatchObject({ value: 'nuScenes', detail: 'measured recall against ground truth' });
  });

  test('a self interest fact is tier B even when the model proposes C (resume hobbies are shareable)', async () => {
    const facts = await factsFromDocument(fakeLLM(JSON.stringify([
      { facet: 'interest', key: 'hobby', value: 'chess', proposedTier: 'C' },
    ])), 'resume', 'resume');
    expect(facts[0]?.tier).toBe('B');
  });
});

describe('buildSelfOntology hobby splitting', () => {
  test('splits a comma-separated hobby list into one Tier-B fact each', async () => {
    const llm = fakeLLM(JSON.stringify([
      { facet: 'interest', key: 'hobby', value: 'Chess, Football, Running', proposedTier: 'B' },
    ]));
    const facts = await buildSelfOntology({ llm }, { documents: [{ label: 'resume', text: 't' }] });
    const hobbies = facts.filter((f) => f.key === 'hobby');
    expect(hobbies.map((f) => f.value).sort()).toEqual(['Chess', 'Football', 'Running']);
    expect(hobbies.every((f) => f.tier === 'B')).toBe(true);
  });
});

describe('interviewFacts (P3)', () => {
  test('maps answers to facts using the question metadata; skips blanks', () => {
    const answers = Object.fromEntries(INTERVIEW_QUESTIONS.map((q) => [q.id, '']));
    const hobbyQ = INTERVIEW_QUESTIONS.find((q) => q.facet === 'interest' && q.key === 'hobby')!;
    answers[hobbyQ.id] = 'chess';
    const facts = interviewFacts(answers);
    expect(facts).toHaveLength(1); // only the answered one
    expect(facts[0]).toMatchObject({ facet: 'interest', key: 'hobby', value: 'chess', confidence: 0.95 });
  });
});

describe('buildSelfOntology (P5)', () => {
  test('combines document + interview facts and dedupes exact repeats', async () => {
    const llm = fakeLLM(JSON.stringify([{ facet: 'academic', key: 'method', value: '3DGS', confidence: 0.9, proposedTier: 'A' }]));
    const roleQ = INTERVIEW_QUESTIONS.find((q) => q.key === 'role')!;
    const facts = await buildSelfOntology(
      { llm },
      { documents: [{ label: 'a', text: 't' }, { label: 'b', text: 't2' }], answers: { [roleQ.id]: 'PhD-track researcher' } },
    );
    // two docs return the same fact -> deduped to 1; plus the one interview fact
    expect(facts.filter((f) => f.value === '3DGS')).toHaveLength(1);
    expect(facts.some((f) => f.value === 'PhD-track researcher')).toBe(true);
  });
});
