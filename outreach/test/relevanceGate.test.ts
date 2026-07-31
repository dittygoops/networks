import { describe, expect, it, vi } from 'vitest';
import { bestTermMatch, gateCandidate, matchedTerms, scoreOverlap } from '../src/discovery/relevanceGate.js';
import type { Candidate } from '../src/discovery/types.js';
import type { LLMClient } from '../src/llm/client.js';

const TERMS = ['olfactory embedding space', 'principal odor map', 'gas sensor array'];
const GATE = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3, maxResumePerRun: 10, maxResumeAttempts: 3 };

const cand = (title: string, abstract = ''): Candidate => ({
  arxivId: '2601.00001',
  title,
  abstract,
  discoveredVia: 'saved_query',
  sourceDetail: 'query: olfactory embedding space',
});

const llmReturning = (text: string): LLMClient => ({ complete: vi.fn().mockResolvedValue(text) });

describe('scoreOverlap', () => {
  it('scores a full term match at 1', () => {
    expect(scoreOverlap(cand('Olfactory Embedding Space for Robots'), ['olfactory embedding space'])).toBe(1);
  });

  it('scores an unrelated paper at 0', () => {
    expect(scoreOverlap(cand('Distributed Consensus in Byzantine Networks'), TERMS)).toBe(0);
  });

  it('searches the abstract as well as the title', () => {
    expect(scoreOverlap(cand('A Study', 'we build a principal odor map'), TERMS)).toBeGreaterThan(0);
  });

  it('returns 0 when there are no terms', () => {
    expect(scoreOverlap(cand('Anything'), [])).toBe(0);
  });
});

describe('gateCandidate', () => {
  it('keeps a clear match without calling the LLM', async () => {
    const llm = llmReturning('{"score":0.1,"reason":"should not be called"}');
    const v = await gateCandidate(cand('Olfactory Embedding Space for Sensor Arrays'), TERMS, GATE, llm);
    expect(v.keep).toBe(true);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(v.reason).toContain('olfactory embedding space');
  });

  it('drops a clear miss without calling the LLM', async () => {
    const llm = llmReturning('{"score":0.9,"reason":"should not be called"}');
    const v = await gateCandidate(cand('Byzantine Consensus Protocols'), TERMS, GATE, llm);
    expect(v.keep).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(v.reason).toContain('below');
  });

  it('consults the LLM for a borderline score and honours its verdict', async () => {
    const llm = llmReturning('{"score":0.82,"reason":"matches sensor to POM mapping gap"}');
    const borderline = cand('Embedding Space Sensor Study', 'partial mention of gas sensor only');
    const raw = scoreOverlap(borderline, TERMS);
    expect(raw).toBeGreaterThan(GATE.threshold - GATE.borderlineBand);
    expect(raw).toBeLessThan(GATE.threshold + GATE.borderlineBand);
    const v = await gateCandidate(borderline, TERMS, GATE, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(v.keep).toBe(true);
    expect(v.score).toBe(0.82);
    expect(v.reason).toBe('matches sensor to POM mapping gap');
  });

  it('falls back to the deterministic score when the LLM output is unparseable', async () => {
    const llm = llmReturning('not json at all');
    const borderline = cand('Embedding Space Sensor Study', 'partial mention of gas sensor only');
    const v = await gateCandidate(borderline, TERMS, GATE, llm);
    expect(v.score).toBeCloseTo(scoreOverlap(borderline, TERMS), 5);
    expect(v.reason).toContain('judge unavailable');
  });

  it('uses the deterministic score when no LLM is supplied', async () => {
    const borderline = cand('Embedding Space Sensor Study', 'partial mention of gas sensor only');
    const v = await gateCandidate(borderline, TERMS, GATE);
    expect(v.score).toBeCloseTo(scoreOverlap(borderline, TERMS), 5);
  });

  it('names the term that actually drove a fractional-match keep, never an unrelated term', async () => {
    const wirelessSensor = cand('Sensor Networks and Array Design', 'routing in wireless sensor networks');
    const v = await gateCandidate(wirelessSensor, TERMS, GATE);
    expect(v.keep).toBe(true);
    expect(v.reason).not.toContain('olfactory');
    expect(v.reason).toContain('gas sensor array');
  });

  it('says "matches gap term" (not "partially") when the whole phrase appears verbatim', async () => {
    const exact = cand('Olfactory Embedding Space for Robots');
    const v = await gateCandidate(exact, TERMS, GATE);
    expect(v.keep).toBe(true);
    expect(v.reason).toContain('matches gap term:');
    expect(v.reason).not.toContain('partially');
    expect(v.reason).toContain('olfactory embedding space');
  });
});

describe('gateCandidate judge score range check', () => {
  it('falls back to the deterministic score when the judge returns a score above 1', async () => {
    const llm = llmReturning('{"score":42,"reason":"very relevant"}');
    const borderline = cand('Embedding Space Sensor Study', 'partial mention of gas sensor only');
    const raw = scoreOverlap(borderline, TERMS);
    const v = await gateCandidate(borderline, TERMS, GATE, llm);
    expect(v.score).toBeCloseTo(raw, 5);
    expect(v.score).not.toBe(42);
    expect(v.reason).toContain('judge unavailable');
  });

  it('falls back to the deterministic score when the judge returns a negative score', async () => {
    const llm = llmReturning('{"score":-5,"reason":"not relevant"}');
    const borderline = cand('Embedding Space Sensor Study', 'partial mention of gas sensor only');
    const raw = scoreOverlap(borderline, TERMS);
    const v = await gateCandidate(borderline, TERMS, GATE, llm);
    expect(v.score).toBeCloseTo(raw, 5);
    expect(v.score).not.toBe(-5);
    expect(v.reason).toContain('judge unavailable');
  });
});

// The exact case intersect.ts already fixed, verified against relevanceGate:
// "signatures" contains the raw substring "nature". intersect.ts learned this
// the hard way (it was the only hook two real people had). relevanceGate must
// not have to learn it again.
describe('relevanceGate word-boundary regression (the shared "signatures contains nature" bug)', () => {
  const ZANINELI = cand('Heterogeneous molecular signatures of human odor perception');

  it('does not match the gap term "nature" inside "signatures"', () => {
    const m = bestTermMatch(ZANINELI, ['nature']);
    expect(m.score).toBe(0);
    expect(m.term).toBe(null);
    expect(m.exact).toBe(false);
  });

  it('does not keep the candidate on that coincidence', async () => {
    const v = await gateCandidate(ZANINELI, ['nature'], GATE);
    expect(v.keep).toBe(false);
    expect(v.reason).not.toContain('matches gap term');
  });

  it('matchedTerms does not report the coincidence either', () => {
    expect(matchedTerms(ZANINELI, ['nature'])).toEqual([]);
  });

  it('still matches a term that really is present as whole words', () => {
    expect(bestTermMatch(ZANINELI, ['odor perception']).exact).toBe(true);
    expect(matchedTerms(ZANINELI, ['odor perception'])).toEqual(['odor perception']);
  });

  it('matches across punctuation, so a hyphenated title still scores', () => {
    expect(bestTermMatch(cand('Odor-perception at scale'), ['odor perception']).exact).toBe(true);
  });
});
