import { describe, expect, test } from 'vitest';
import { generateDraft, type DraftInput } from '../src/pipeline/draft.js';
import { DRAFT_SYSTEM } from '../src/llm/prompts.js';
import type { LLMClient } from '../src/llm/client.js';

const input: DraftInput = {
  recipient: { name: 'Bernhard Kerbl', affiliation: 'TU Wien', paperTitle: '3D Gaussian Splatting' },
  hooks: [{ selfValue: '3D Gaussian Splatting', personValue: '3D Gaussian Splatting', selfDetail: 'built a banana splat', personDetail: 'invented 3DGS', tier: 'A' }],
  intent: 'get direction on future olfaction work',
  senderName: 'Aditya Gupta',
  senderFacts: ['built a Gaussian splat of a banana'],
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
