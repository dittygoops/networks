// Offline tests for the draft-quality judge core (src/eval/draftQuality.ts).
// No network: the LLMClient is injected as a fake. These cover the parts that
// must not drift silently: the prompt actually carries the stance tags the
// rubric grades on, a malformed reply is reported rather than defaulted, the
// deterministic form checks catch the real d68 duplicate-signoff defect, and
// every ablation genuinely damages the text it claims to damage.
import { describe, expect, it } from 'vitest';
import {
  ABLATIONS, applyAblation, buildJudgeUser, contentOf, formChecks, judgeDraft, parseVerdict,
  type JudgeContext,
} from '../src/eval/draftQuality.js';
import { SIGNATURE } from '../src/pipeline/draft.js';

const ctx = (over: Partial<JudgeContext> = {}): JudgeContext => ({
  shortId: 'd9',
  personName: 'Kordel K. France',
  affiliation: 'The University of Texas at Dallas',
  paperTitle: 'Olfactory Inertial Odometry',
  hooks: [{
    selfValue: 'olfactory embedding space',
    personValue: 'Olfaction',
    selfDetail: 'focusing on mapping sensor data to the Principal Odor Map (POM) space',
    selfStance: 'exploring',
  }],
  senderFacts: [{ text: '3D Gaussian Splatting: Trained reconstructions end-to-end', stance: 'done' }],
  subject: 'mapping sensor data to pom space',
  body: [
    'Hi Kordel,',
    "I read your paper on olfactory inertial odometry and have been digging into mapping sensor data to the Principal Odor Map (POM) space. I've worked with 3D Gaussian Splatting, but olfaction is new to me. Could you point me to any datasets that would help?",
    '',
    SIGNATURE,
  ].join('\n'),
  ...over,
});

const reply = (scores: number[], verdict = 'send'): string => JSON.stringify({
  hook_specificity: { score: scores[0], why: 'names the paper' },
  sender_grounding: { score: scores[1], why: 'names 3DGS' },
  stance_honesty: { score: scores[2], why: 'hedged' },
  ask_quality: { score: scores[3], why: 'one question' },
  form_discipline: { score: scores[4], why: 'tight' },
  verdict,
  worst_problem: 'none',
});

describe('buildJudgeUser', () => {
  it('carries the stance tags the honesty criterion grades on', () => {
    const user = buildJudgeUser(ctx());
    expect(user).toContain('him [exploring]');
    expect(user).toContain('[done] 3D Gaussian Splatting');
    expect(user).toContain('Kordel K. France');
    expect(user).toContain('Olfactory Inertial Odometry');
  });

  it('hides the canonical signature but keeps a stray inline sign-off visible', () => {
    expect(buildJudgeUser(ctx())).not.toContain('linkedin.com/in/aditya-gupta-asu');
    const d68 = ctx({ body: `Hi Mohamed, any pointers on where to start? Best, Aditya\n\n${SIGNATURE}` });
    expect(buildJudgeUser(d68)).toContain('Best, Aditya');
  });
});

describe('parseVerdict', () => {
  it('sums the five criteria and keeps the verdict', () => {
    const v = parseVerdict(reply([2, 2, 2, 1, 1]))!;
    expect(v.total).toBe(8);
    expect(v.verdict).toBe('send');
    expect(v.scores.ask_quality).toBe(1);
  });

  it('tolerates code fences and surrounding prose', () => {
    expect(parseVerdict('```json\n' + reply([1, 1, 1, 1, 1]) + '\n```')!.total).toBe(5);
    expect(parseVerdict('Here you go: ' + reply([0, 0, 0, 0, 0]))!.total).toBe(0);
  });

  it('returns null rather than defaulting when a criterion is missing or out of range', () => {
    expect(parseVerdict('{"hook_specificity":{"score":2}}')).toBeNull();
    const bad = JSON.parse(reply([2, 2, 2, 2, 2])) as Record<string, { score: number }>;
    bad['stance_honesty']!.score = 7;
    expect(parseVerdict(JSON.stringify(bad))).toBeNull();
    expect(parseVerdict('not json at all')).toBeNull();
  });
});

describe('judgeDraft with an injected fake client', () => {
  it('scores without any network access', async () => {
    const fake = { complete: async () => reply([2, 2, 2, 2, 1]) };
    const r = await judgeDraft(fake, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict.total).toBe(9);
  });

  it('reports an unparseable reply instead of inventing a score', async () => {
    const r = await judgeDraft({ complete: async () => 'I think it is pretty good!' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unparseable/);
  });

  it('reports a client failure instead of throwing', async () => {
    const r = await judgeDraft({ complete: async () => { throw new Error('402 payment required'); } }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('402');
  });
});

describe('deterministic form checks', () => {
  it('excludes the appended signature from the word budget', () => {
    expect(contentOf(ctx().body)).not.toContain('linkedin.com');
    expect(formChecks(ctx().body).words).toBeLessThan(70);
  });

  it('catches the d68 inline duplicate sign-off that the drafter stripper misses', () => {
    // Real defect: an inline "... where to start. Best, Aditya" survives
    // stripTrailingSignoff (which requires a newline) and the canonical block
    // is then appended under it, so the sent email signs off twice.
    const d68 = ctx({ body: `Hi Mohamed, I saw your work on AEGIR. Any pointers on where to start? Best, Aditya\n\n${SIGNATURE}` });
    expect(formChecks(d68.body).duplicateSignoff).toBe(true);
    expect(formChecks(ctx().body).duplicateSignoff).toBe(false);
  });

  it('flags banned phrases, em dashes and question count', () => {
    const bad = ctx({ body: `Hi X, I hope this email finds you well, your work is groundbreaking, truly. Thoughts? Ideas?\n\n${SIGNATURE}` });
    const f = formChecks(bad.body);
    expect(f.banned).toContain('hope this email finds you well');
    expect(f.questionCount).toBe(2);
    expect(formChecks(ctx({ body: `Hi X, a, b, c.\n\n${SIGNATURE}` }).body).emDash).toBe(false);
    expect(formChecks(ctx({ body: `Hi X, a, b, c.\n\n${SIGNATURE}` }).body).banned).toEqual([]);
  });
});

describe('ablations', () => {
  const donor = ctx({
    shortId: 'd43', personName: 'Renbiao Jin',
    body: `Hi Renbiao,\nI trained 3D Gaussian Splatting reconstructions end-to-end and diagnosed failure modes in dynamic scenes. Any pointers?\n\n${SIGNATURE}`,
  });

  it('keeps the greeting and the fixed signature intact', () => {
    for (const kind of ABLATIONS) {
      const out = applyAblation(kind, ctx(), donor);
      if (!out) continue;
      expect(out.body.startsWith('Hi Kordel,')).toBe(true);
      expect(out.body.endsWith(SIGNATURE)).toBe(true);
    }
  });

  it('generic-hook removes the specific opening', () => {
    const out = applyAblation('generic-hook', ctx())!;
    expect(out.body).toContain('came across your work and found it really interesting');
    expect(out.body).not.toContain('olfactory inertial odometry');
  });

  it('swapped-hook opens on the donor draft, not this recipient', () => {
    const out = applyAblation('swapped-hook', ctx(), donor)!;
    expect(out.body).toContain('diagnosed failure modes in dynamic scenes');
    expect(out.body).not.toContain('I read your paper on olfactory inertial odometry');
  });

  it('generic-ask replaces the concrete question with a meeting request', () => {
    const out = applyAblation('generic-ask', ctx())!;
    expect(out.body).toContain('open to a quick call');
    expect(out.body).not.toContain('Could you point me to any datasets');
  });

  it('overclaim turns an [exploring] hedge into a completed-work claim', () => {
    const out = applyAblation('overclaim', ctx())!;
    expect(out.body).toContain('and built mapping sensor data');
    expect(out.body).not.toContain('have been digging into');
  });

  it('overclaim returns null when there is no hedge to damage', () => {
    expect(applyAblation('overclaim', ctx({ body: `Hi Kordel,\nGreat paper. Thoughts?\n\n${SIGNATURE}` }))).toBeNull();
  });

  it('flattery injects the phrases the rubric bans', () => {
    const out = applyAblation('flattery', ctx())!;
    expect(formChecks(out.body).banned.length).toBeGreaterThan(1);
  });
});
