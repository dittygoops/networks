import { describe, expect, test } from 'vitest';
import { generateDraft, type DraftInput } from '../src/pipeline/draft.js';
import { DRAFT_SYSTEM } from '../src/llm/prompts.js';
import type { LLMClient } from '../src/llm/client.js';

const input: DraftInput = {
  recipient: { name: 'Bernhard Kerbl', affiliation: 'TU Wien', paperTitle: '3D Gaussian Splatting' },
  hooks: [{ selfValue: '3D Gaussian Splatting', personValue: '3D Gaussian Splatting', selfDetail: 'built a banana splat', personDetail: 'invented 3DGS', selfStance: 'done', tier: 'A' }],
  intent: 'get direction on future olfaction work',
  senderName: 'Aditya Gupta',
  senderFacts: [{ text: 'built a Gaussian splat of a banana', stance: 'done' }],
};

const llm = (reply: string): LLMClient => ({ async complete(system) { return system === DRAFT_SYSTEM ? reply : ''; } });

describe('generateDraft (DR3-DR5)', () => {
  test('parses the JSON draft and reports it grounded when it cites both sides', async () => {
    const body = 'Hi Bernhard,\n\nSaw you work on 3D Gaussian Splatting. I built a banana splat with it and hit reflection issues. Any pointers?\n\nBest,\nAditya';
    const draft = await generateDraft(llm(JSON.stringify({ subject: 'quick question on 3dgs', body })), input);
    expect(draft.subject).toBe('quick question on 3dgs');
    expect(draft.body).toContain('banana');
    expect(draft.grounded).toBe(true); // mentions "3D Gaussian Splatting" (recipient) and "banana splat" is self... uses selfValue token
    expect(draft.wordCount).toBeGreaterThan(0);
  });

  test('flags ungrounded when the body omits the recipient or sender specifics', async () => {
    const body = 'Hi Bernhard,\n\nI am a student interested in graphics generally. Can we talk?\n\nBest,\nAditya';
    const draft = await generateDraft(llm(JSON.stringify({ subject: 'hello', body })), input);
    expect(draft.grounded).toBe(false);
    expect(draft.notes.join(' ')).toMatch(/ground/i);
  });

  test('flags an over-long body', async () => {
    const body = 'Hi Bernhard, ' + 'word '.repeat(170) + '3D Gaussian Splatting banana Best Aditya';
    const draft = await generateDraft(llm(JSON.stringify({ subject: 's', body })), input);
    expect(draft.notes.join(' ')).toMatch(/long|word/i);
  });

  test('strips em and en dashes from the draft (hard style rule the model may ignore)', async () => {
    const body = 'Hi Bernhard,\n\nYour 3D Gaussian Splatting work caught my eye—I built a banana splat. Any pointers?\n\nBest,\nAditya';
    const draft = await generateDraft(llm(JSON.stringify({ subject: 'a—b', body })), input);
    expect(draft.body).not.toMatch(/[—–]/);
    expect(draft.subject).not.toMatch(/[—–]/);
    expect(draft.body).toContain('caught my eye, I built');
  });

  test('does not throw on unparseable model output', async () => {
    const draft = await generateDraft(llm('not json at all'), input);
    expect(draft.body).toBe('');
    expect(draft.grounded).toBe(false);
    expect(draft.notes.join(' ')).toMatch(/parse/i);
  });
});

import { describe as describeStance, it as itStance, expect as expectStance } from 'vitest';
import { generateDraft as genStance } from '../src/pipeline/draft.js';

describeStance('stance-tag stripping', () => {
  itStance('removes [done]/[exploring] the model echoes into the body', async () => {
    const llm = { complete: async () => JSON.stringify({
      subject: 'quick question on olfaction',
      body: 'I built a multi-agent system [done] and explored odor mapping [exploring] with olfaction sensors.',
    }) };
    const d = await genStance(llm as never, {
      recipient: { name: 'X', paperTitle: 'Olfaction paper' },
      hooks: [{ selfValue: 'multi-agent system', personValue: 'olfaction', tier: 'A' }],
      intent: 'connect', senderName: 'Aditya',
    });
    expectStance(d.body).not.toContain('[done]');
    expectStance(d.body).not.toContain('[exploring]');
    expectStance(d.body).toContain('multi-agent system');
  });
});

import { describe as descSig, it as itSig, expect as expectSig } from 'vitest';
import { generateDraft as genSig, SIGNATURE } from '../src/pipeline/draft.js';

describe('signature handling', () => {
  const mkLlm = (body: string) => ({ complete: async () => JSON.stringify({ subject: 's', body }) });
  const input = {
    recipient: { name: 'X', paperTitle: 'Olfaction paper' },
    hooks: [{ selfValue: 'multi-agent system', personValue: 'olfaction', tier: 'A' as const }],
    intent: 'connect', senderName: 'Aditya',
  };

  itSig('appends the canonical signature', async () => {
    const d = await genSig(mkLlm('I work on multi-agent systems and olfaction.') as never, input);
    expectSig(d.body.endsWith(SIGNATURE)).toBe(true);
    expectSig(d.body).toContain('MS Student, Computer Science, Arizona State University');
    expectSig(d.body).toContain('github.com/dittygoops');
  });

  itSig('does not double up when the model still signs off', async () => {
    const d = await genSig(mkLlm('I work on multi-agent systems and olfaction.\n\nBest,\nAditya') as never, input);
    expectSig(d.body.match(/Best,/g)?.length).toBe(1);
    expectSig(d.body.endsWith(SIGNATURE)).toBe(true);
  });

  itSig('word count excludes the signature', async () => {
    const d = await genSig(mkLlm('I work on multi-agent systems and olfaction.') as never, input);
    expectSig(d.wordCount).toBeLessThan(12);
  });
});

// Requirement 4: drafts whose ONLY hooks are paper-derived must not collapse
// into a generic "I read your paper" opener that merely restates the title.
import { describe as descPaper, it as itPaper, expect as expectPaper } from 'vitest';
import { generateDraft as genPaper } from '../src/pipeline/draft.js';

describe('paper-derived hook specificity check', () => {
  const mkLlm = (subject: string, body: string) => ({ complete: async () => JSON.stringify({ subject, body }) });
  // Title deliberately shares no 5+ char word stem with the hook's entity/detail
  // or with Aditya's fact, so a body that only quotes the title (the generic
  // "I read your paper <title>" pattern) cannot accidentally satisfy the
  // specific-entity check by coincidence.
  const paperOnlyInput: DraftInput = {
    recipient: {
      name: 'Zhiying Du',
      paperTitle: 'HiMoE-VLA: Toward Scalable Learning At Web Scale',
    },
    hooks: [{
      selfValue: 'hierarchical mixture of experts',
      personValue: 'hierarchical mixture of experts',
      selfDetail: 'built a routing layer for a multi-task model',
      personDetail: 'routes robot manipulation tasks through specialized experts',
      selfStance: 'done',
      tier: 'B',
      personSourceUrl: 'https://arxiv.org/abs/2512.05693',
    }],
    intent: 'get direction on MoE routing',
    senderName: 'Aditya Gupta',
    senderFacts: [{ text: 'built a routing layer for a multi-task model', stance: 'done' }],
  };

  itPaper('is NOT grounded when the body merely restates the paper title', async () => {
    const body = 'Hi Zhiying,\n\nI read your paper HiMoE-VLA: Toward Scalable Learning At Web Scale and found it ' +
      'interesting. I also work in machine learning broadly and would love any pointers on your research ' +
      'direction.\n\nBest,\nAditya';
    const d = await genPaper(mkLlm('quick question', body) as never, paperOnlyInput);
    expectPaper(d.grounded).toBe(false);
    expectPaper(d.notes.join(' ')).toMatch(/paper-derived hooks only/i);
  });

  itPaper('IS grounded when the body cites a specific method from the paper', async () => {
    const body = 'Hi Zhiying,\n\nSaw your hierarchical mixture of experts routing for robot manipulation tasks, ' +
      'really clever way to specialize experts. I built a routing layer for a multi-task model myself and hit ' +
      'load-balancing issues. Any pointers?\n\nBest,\nAditya';
    const d = await genPaper(mkLlm('quick question', body) as never, paperOnlyInput);
    expectPaper(d.grounded).toBe(true);
    expectPaper(d.notes.join(' ')).not.toMatch(/paper-derived hooks only/i);
  });

  itPaper('does not fire the paper-only check when a profile-derived hook is also present', async () => {
    const mixedInput: DraftInput = {
      ...paperOnlyInput,
      hooks: [
        ...paperOnlyInput.hooks,
        { selfValue: 'olfaction', personValue: 'olfaction', tier: 'A' }, // no personSourceUrl: profile-derived
      ],
    };
    const body = 'Hi Zhiying,\n\nSaw your work on olfaction. I built a routing layer for a multi-task model. Any pointers?\n\nBest,\nAditya';
    const d = await genPaper(mkLlm('quick question', body) as never, mixedInput);
    expectPaper(d.notes.join(' ')).not.toMatch(/paper-derived hooks only/i);
  });
});

// d68 went out to Mohamed Shawky Sabae with TWO sign-offs: the model ended its
// single-paragraph body "...where to start. Best, Aditya" and the canonical
// block was appended underneath. stripTrailingSignoff required a newline before
// the sign-off, so an inline one survived. Found by the draft-quality judge
// after the email had already been sent.
describe('stripTrailingSignoff handles an inline sign-off', () => {
  // generateDraft appends the canonical SIGNATURE, which itself starts "Best,".
  // So the property is EXACTLY ONE sign-off, not zero.
  const signoffs = (body: string) => (body.match(/^\s*Best,\s*$/gm) ?? []).length;

  test('strips a sign-off that follows a sentence on the same line', async () => {
    const body = 'Hi Mohamed, I saw your work on AEGIR. I was curious if you had any pointers on where to start. Best, Aditya';
    const d = await generateDraft(llm(JSON.stringify({ subject: 's', body })), input);
    expect(d.body).not.toMatch(/where to start\. Best, Aditya/);
    expect(signoffs(d.body)).toBe(1);
  });

  test('does NOT eat a sentence that merely ends with the word best', async () => {
    const body = 'Hi Ada, I read your paper. I am trying to work out which approach is best.';
    const d = await generateDraft(llm(JSON.stringify({ subject: 's', body })), input);
    expect(d.body).toMatch(/which approach is best\./);
  });

  test('still strips the newline-separated form it always handled', async () => {
    const body = 'Hi Ada, I read your paper on X.\n\nBest,\nAditya';
    const d = await generateDraft(llm(JSON.stringify({ subject: 's', body })), input);
    expect(signoffs(d.body)).toBe(1);
  });
});
