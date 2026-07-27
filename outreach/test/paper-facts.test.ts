import { describe, expect, test } from 'vitest';
import { extractPaperFacts, isPaperSourceUrl, paperSourceUrl } from '../src/pipeline/research.js';
import { PAPER_EXTRACT_SYSTEM } from '../src/llm/prompts.js';
import type { LLMClient } from '../src/llm/client.js';

// HiMoE-VLA shape: the concrete failing case from the live run. The paper
// matches the user's research gap exactly, but the author's mined profile
// facts (bare OpenAlex concepts) are too coarse to match it. This fixture is
// what the paper itself should still be able to say about its author.
const HIMOE_CTX = {
  arxivId: '2512.05693',
  title: 'HiMoE-VLA: Hierarchical Mixture-of-Experts for Generalist Vision-Language-Action Models',
  abstract:
    'We propose HiMoE-VLA, a hierarchical mixture of experts architecture for generalist ' +
    'vision language action models. Our method routes robot manipulation tasks through ' +
    'specialized experts and is trained on a large multi-task dataset.',
  authorName: 'Zhiying Du',
};

const llmOf = (reply: string): LLMClient => ({
  async complete(system) {
    return system === PAPER_EXTRACT_SYSTEM ? reply : '';
  },
});

describe('extractPaperFacts', () => {
  test('returns specific entities from a title+abstract fixture, all tier B or lower, stance done, arXiv source_url', async () => {
    const raw = JSON.stringify([
      { facet: 'academic', key: 'method', value: 'hierarchical mixture of experts', detail: 'routes robot manipulation tasks through specialized experts', confidence: 0.7 },
      { facet: 'academic', key: 'method', value: 'vision language action model', confidence: 0.6 },
      { facet: 'academic', key: 'task', value: 'robot manipulation', confidence: 0.6 },
    ]);
    const facts = await extractPaperFacts(llmOf(raw), HIMOE_CTX);

    expect(facts.length).toBe(3);
    expect(facts.map((f) => f.value)).toEqual(
      expect.arrayContaining(['hierarchical mixture of experts', 'vision language action model', 'robot manipulation']),
    );
    // No vague, unmatchable entities like "machine learning" or "AI" slipped in.
    expect(facts.some((f) => /^(machine learning|ai|artificial intelligence)$/i.test(f.value))).toBe(false);

    for (const f of facts) {
      expect(['B', 'C']).toContain(f.tier); // capped at B, never A
      expect(f.stance).toBe('done');
      expect(f.sourceUrl).toBe(paperSourceUrl(HIMOE_CTX.arxivId));
      expect(f.sourceUrl).toBe('https://arxiv.org/abs/2512.05693');
    }
  });

  test('ignores a proposedTier the model tries to send: still never A', async () => {
    // Even if a future prompt tweak lets the model suggest a tier, the code
    // must not honor an 'A' claim from a single title+abstract.
    const raw = JSON.stringify([
      { facet: 'academic', key: 'method', value: 'hierarchical mixture of experts', confidence: 0.9, proposedTier: 'A' },
    ]);
    const facts = await extractPaperFacts(llmOf(raw), HIMOE_CTX);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.tier).toBe('B');
  });

  test('returns [] and does not throw on unparseable model output', async () => {
    const facts = await extractPaperFacts(llmOf('not json at all, sorry'), HIMOE_CTX);
    expect(facts).toEqual([]);
  });

  test('returns [] and does not throw when the LLM call itself rejects', async () => {
    const failing: LLMClient = { async complete() { throw new Error('network down'); } };
    const facts = await extractPaperFacts(failing, HIMOE_CTX);
    expect(facts).toEqual([]);
  });

  test('drops facts missing a required field rather than crashing', async () => {
    const raw = JSON.stringify([
      { facet: 'academic', value: 'no key here' }, // missing key
      { facet: 'bogus', key: 'method', value: 'x' }, // invalid facet
      { facet: 'academic', key: 'method' }, // missing value
      { facet: 'academic', key: 'method', value: 'hierarchical mixture of experts' },
    ]);
    const facts = await extractPaperFacts(llmOf(raw), HIMOE_CTX);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe('hierarchical mixture of experts');
  });
});

describe('isPaperSourceUrl', () => {
  test('recognizes an arXiv abs URL as paper-sourced', () => {
    expect(isPaperSourceUrl('https://arxiv.org/abs/2512.05693')).toBe(true);
  });

  test('rejects OpenAlex and web-page source URLs', () => {
    expect(isPaperSourceUrl('https://openalex.org/A123')).toBe(false);
    expect(isPaperSourceUrl('https://example.edu/~someone')).toBe(false);
    expect(isPaperSourceUrl(undefined)).toBe(false);
  });
});
