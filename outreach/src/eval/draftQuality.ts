// Draft-quality LLM judge (the half of the eval that eval-trust-safety.ts does
// not cover). Trust & Safety asks "is this correctly addressed and grounded in a
// real fact"; this asks "is this a GOOD cold email".
//
// Everything here is pure: no database, no network, no process exit. The judge
// takes an injectable LLMClient so it can be exercised offline with a fake.
// scripts/eval-draft-quality.ts owns the DB reading, the CLI and the gate.
//
// The rubric is derived from two sources, not invented:
//   1. DRAFT_SYSTEM in src/llm/prompts.ts, which is the owner's own written
//      specification of the email he wants (structure, banned phrases, the
//      [done]/[exploring] honesty rule, the word budget).
//   2. The shape of the approved drafts, clearest in d9 (Kordel France): names
//      the specific paper, states what the sender is actually doing, admits the
//      gap ("olfaction is new to me"), asks ONE answerable question, no
//      flattery, no overclaiming.
import type { LLMClient } from '../llm/client.js';
import { SIGNATURE } from '../pipeline/draft.js';

export interface JudgeHook {
  selfValue: string;
  personValue: string;
  selfDetail?: string;
  personDetail?: string;
  selfStance?: 'done' | 'exploring';
}

export interface JudgeContext {
  shortId: string;
  personName: string;
  affiliation?: string | null;
  paperTitle?: string | null;
  hooks: JudgeHook[];
  senderFacts: { text: string; stance?: 'done' | 'exploring' }[];
  subject: string;
  body: string;
}

export const CRITERIA = [
  'hook_specificity',
  'sender_grounding',
  'stance_honesty',
  'ask_quality',
  'form_discipline',
] as const;
export type Criterion = (typeof CRITERIA)[number];

export interface Verdict {
  scores: Record<Criterion, number>;
  why: Record<Criterion, string>;
  total: number; // 0 to 10
  verdict: 'send' | 'revise';
  worstProblem: string;
}

// Scoring is 0/1/2 per criterion with named anchors rather than a free 1-to-10
// scale, because a free scale is what produces "everything is an 8". The
// anchors are written so that the ordinary competent draft scores 1, not 2.
export const JUDGE_SYSTEM = [
  'You grade ONE cold outreach email written by a masters student (Aditya) to a',
  'researcher. You are given the facts the writer was allowed to use, so you can',
  'check the email against them. Be a strict grader.',
  '',
  // Added after the first calibration run, which is reported alongside the
  // second. Without this block the judge scored sender_grounding 0 on eight
  // approved drafts with the reason "3D Gaussian Splatting has no connection to
  // olfaction". That is false about this sender: his notes
  // (Research Gap - Volumetric Olfactory Capture) name augmenting a 3DGS scene
  // with a chemical concentration attribute as "the most novel architecture
  // direction". The judge was working from a wrong premise, not a strict one.
  'CONTEXT ABOUT THE SENDER (from his own research notes, treat this as true):',
  'Aditya is running ONE program, not two. He has done 3D reconstruction work',
  '(3D Gaussian Splatting, COLMAP, nuScenes, lidar detection) and is carrying',
  'that machinery into olfaction: reconstructing a continuous 4D smell field',
  'from a fixed array of e-nose sensors, using physics (advection-diffusion,',
  'PINNs) as the regulariser, and augmenting a 3D Gaussian Splatting scene with',
  'a chemical concentration attribute. So a reconstruction or 3DGS credential IS',
  'relevant to an olfaction or PINN recipient: it is the machinery he is',
  'carrying over. Grade whether the EMAIL draws that connection for the reader,',
  'not whether the two fields sound related to you.',
  '',
  'Before scoring, do these three reads. They are where graders slip.',
  '  a. Quote the first sentence after the greeting. Decide whose work it is',
  '     about: the recipient or the sender. An email that opens on the sender',
  '     has no hook, however specific its topic.',
  '  b. List every claim the email makes about the recipient and about the',
  '     sender, and check each one against the given material.',
  '  c. Look for a stray sign-off ("Best, Aditya") inside the message text, a',
  '     leftover [done] or [exploring] tag, or a repeated sentence.',
  '',
  'Score five criteria. Each is 0, 1 or 2. Use the anchors literally.',
  '',
  '1. hook_specificity: does the opening name something specific about THIS',
  '   recipient, and is it the actual shared thing?',
  '   0 = generic opener (their "work", a broad field, "your research is',
  '       interesting"), or the email never says anything specific about them.',
  '   1 = names their paper or its title words, but says nothing specific about',
  '       what is in it. Also 1 at most when the opening sentence is about the',
  '       sender and the recipient only appears later.',
  '   2 = names a specific method, result, problem or design choice from their',
  '       work, and it is genuinely the overlap with the sender.',
  '',
  '2. sender_grounding: is there ONE concrete thing the sender has actually done,',
  '   and is it relevant to the recipient?',
  '   0 = no concrete sender fact, or a fact that does not appear in the allowed',
  '       facts, or a commodity credential (used ChatGPT, knows Python).',
  '   1 = a real fact but vague or unrelated to the recipient ("worked on 3D',
  '       Gaussian Splatting and multi-agent systems" with no connection drawn).',
  '   2 = a specific, real, completed thing, tied to why the recipient would care.',
  '',
  '3. stance_honesty: no overclaiming, no invented history. Facts marked',
  '   [exploring] are things the sender is only considering and MUST be phrased',
  '   as considering ("I have been digging into", "I am hoping to explore").',
  '   0 = claims to have built, run, published or solved something that is only',
  '       [exploring], or invents prior contact, a meeting, a paper, a lab, a',
  '       result, or a recipient fact that is not in the given material.',
  '   1 = borderline: hedged but could be read as a completed-work claim, or a',
  '       recipient detail that stretches beyond what was given.',
  '   2 = every claim traces to a given fact with the right stance.',
  '',
  '4. ask_quality: exactly ONE low-friction question the recipient can answer in',
  '   a few lines.',
  '   0 = no question, several questions, or a heavy ask (a call, a meeting, a',
  '       position, "review my work", "collaborate").',
  '   1 = one question but generic: it could be sent to anyone in the field',
  '       ("any pointers on where to start", "what are the biggest gaps").',
  '   2 = one question that only this recipient is well placed to answer,',
  '       tied to the specific thing named in the hook.',
  '',
  '5. form_discipline: length, tone and cleanliness.',
  '   0 = flattery or a banned phrase ("I hope this email finds you well", "I am',
  '       reaching out", "I have been following your work", "pick your brain",',
  '       empty superlatives), or clear padding, or a broken artifact such as a',
  '       duplicated sign-off or a leftover tag.',
  '   1 = acceptable but loose: filler clauses, a stiff sentence, or noticeably',
  '       over the 120 word budget for the message content.',
  '   2 = tight, casual but polite, nothing that could be cut without losing',
  '       information.',
  '',
  'A fixed closing block ("Best, / Aditya Gupta / MS Student ... / two links")',
  'is appended by code AFTER the text you are shown, and is not shown to you.',
  'So the message text must NOT end with a sign-off of its own: if it does',
  '("... where to start. Best, Aditya"), the sent email signs off twice and',
  'form_discipline is 0.',
  '',
  'Calibration: 1 is the ordinary competent case. Reserve 2 for the anchor as',
  'written. A draft that is fine but unremarkable should total roughly 5 to 7.',
  'Do not inflate to be kind.',
  '',
  'verdict: "send" if the owner could send this as it stands, "revise" if any',
  'criterion is 0 or the email would embarrass the sender.',
  '',
  'Return ONLY JSON, no prose and no code fences:',
  '{"hook_specificity":{"score":0,"why":"..."},"sender_grounding":{"score":0,"why":"..."},',
  ' "stance_honesty":{"score":0,"why":"..."},"ask_quality":{"score":0,"why":"..."},',
  ' "form_discipline":{"score":0,"why":"..."},"verdict":"send","worst_problem":"..."}',
  'Each "why" is at most 20 words and quotes the deciding phrase.',
].join('\n');

// The email text as sent, minus the fixed signature block. Used for the word
// budget and for the ablation edits, which must not touch the boilerplate.
export function contentOf(body: string): string {
  const idx = body.indexOf(SIGNATURE);
  return (idx === -1 ? body : body.slice(0, idx)).trimEnd();
}

export function buildJudgeUser(ctx: JudgeContext): string {
  const hooks = ctx.hooks.map((h, i) =>
    `  ${i + 1}. shared: ${h.selfValue === h.personValue ? h.selfValue : `${h.selfValue} / ${h.personValue}`}` +
    (h.personDetail ? `\n     them: ${h.personDetail}` : '') +
    (h.selfDetail ? `\n     him [${h.selfStance ?? 'exploring'}]: ${h.selfDetail}` : `\n     him [${h.selfStance ?? 'exploring'}]`),
  );
  const facts = ctx.senderFacts.map((f) => `  - [${f.stance ?? 'done'}] ${f.text}`);
  return [
    `Recipient: ${ctx.personName}${ctx.affiliation ? ` (${ctx.affiliation})` : ''}`,
    ctx.paperTitle ? `Their paper: ${ctx.paperTitle}` : '',
    '',
    hooks.length ? `Shared hooks the writer was given ([done] = he did it, [exploring] = he is only considering it):\n${hooks.join('\n')}` : 'Shared hooks the writer was given: (none)',
    '',
    facts.length ? `Other facts about Aditya the writer was allowed to use:\n${facts.join('\n')}` : '',
    '',
    'THE EMAIL',
    `Subject: ${ctx.subject}`,
    'Message text (the fixed closing block is appended after this and is not shown):',
    // Show the content only. Showing the canonical signature made one judge
    // model report it as a duplicate sign-off on every draft, a systematic
    // false positive. The inline stray sign-off that IS a real defect (d68)
    // lives inside the content, so it survives this trim.
    contentOf(ctx.body),
  ].filter((l) => l !== '').join('\n');
}

function coerceScore(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 0 && r <= 2 ? r : null;
}

// Parses the judge reply. Returns null rather than a default score when the
// reply is unusable: a silent 0 or a silent 5 would both be a lie about what
// the model said, and the caller reports parse failures separately.
export function parseVerdict(raw: string): Verdict | null {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scores = {} as Record<Criterion, number>;
  const why = {} as Record<Criterion, string>;
  for (const c of CRITERIA) {
    const cell = obj[c] as { score?: unknown; why?: unknown } | undefined;
    if (!cell || typeof cell !== 'object') return null;
    const s = coerceScore(cell.score);
    if (s === null) return null;
    scores[c] = s;
    why[c] = typeof cell.why === 'string' ? cell.why : '';
  }
  const total = CRITERIA.reduce((sum, c) => sum + scores[c], 0);
  const v = obj['verdict'];
  return {
    scores,
    why,
    total,
    verdict: v === 'send' ? 'send' : 'revise',
    worstProblem: typeof obj['worst_problem'] === 'string' ? obj['worst_problem'] : '',
  };
}

export type JudgeResult = { ok: true; verdict: Verdict } | { ok: false; error: string; raw?: string };

export async function judgeDraft(llm: LLMClient, ctx: JudgeContext): Promise<JudgeResult> {
  let raw: string;
  try {
    raw = await llm.complete(JUDGE_SYSTEM, buildJudgeUser(ctx));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const verdict = parseVerdict(raw);
  return verdict ? { ok: true, verdict } : { ok: false, error: 'unparseable judge reply', raw: raw.slice(0, 300) };
}

// --- deterministic form checks -------------------------------------------
// Independent of the judge, so a rubric that drifts can be caught by a signal
// that cannot drift. Reported alongside, never fed into the judge prompt.

export const BANNED_PHRASES = [
  'hope this email finds you well',
  'i am reaching out',
  "i'm reaching out",
  'pick your brain',
  'i have been following your work',
  "i've been following your work",
  'groundbreaking',
];

export interface FormChecks {
  words: number;
  overBudget: boolean; // the prompt's own budget is under 120 words
  questionCount: number;
  banned: string[];
  emDash: boolean;
  duplicateSignoff: boolean;
}

export function formChecks(body: string): FormChecks {
  const content = contentOf(body);
  const lower = content.toLowerCase();
  return {
    words: content.split(/\s+/).filter(Boolean).length,
    overBudget: content.split(/\s+/).filter(Boolean).length > 120,
    questionCount: (content.match(/\?/g) ?? []).length,
    banned: BANNED_PHRASES.filter((p) => lower.includes(p)),
    emDash: /[—–]/.test(content),
    // The drafter strips a trailing sign-off only when it starts on its own
    // line, so an inline "... where to start. Best, Aditya" survives and the
    // canonical block is then appended under it (this really happened, d68).
    duplicateSignoff: /\b(best|thanks|cheers|regards|sincerely)\s*,\s*aditya\b/i.test(content),
  };
}

// --- ablations ------------------------------------------------------------
// A judge calibrated only on approved drafts cannot be validated: with no clean
// negatives in the labelled data, "it scores every real draft highly" is
// indistinguishable from "it rates everything highly". These transforms
// manufacture negatives from the positives by damaging exactly one property the
// rubric claims to measure, so the paired score drop is the discrimination
// evidence. They are deterministic string edits, not model rewrites, so they
// are reproducible and cost nothing.

export const ABLATIONS = ['generic-hook', 'swapped-hook', 'generic-ask', 'overclaim', 'flattery'] as const;
export type Ablation = (typeof ABLATIONS)[number];

const GREETING = /^(\s*Hi [^\n,]{1,40},)\s*/;

// Splits the content into the "Hi X," greeting and the rest.
function splitGreeting(content: string): { greeting: string; rest: string } {
  const m = GREETING.exec(content);
  if (!m) return { greeting: '', rest: content };
  return { greeting: m[1]!, rest: content.slice(m[0].length) };
}

// First sentence of the message text after the greeting.
function firstSentence(rest: string): string | null {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(rest.trim());
  return m ? m[0].trim() : null;
}

const OVERCLAIM_RULES: [RegExp, string][] = [
  [/I(?:'ve| have|’ve) been digging into/gi, 'I built'],
  [/I(?:'ve| have|’ve) been thinking about using/gi, 'I have already used'],
  [/I(?:'ve| have|’ve) been thinking about/gi, 'I have already built'],
  [/I(?:'ve| have|’ve) been exploring/gi, 'I have already built'],
  [/I(?:'m| am|’m) considering using/gi, 'I have already deployed'],
  [/I(?:'m| am|’m) exploring/gi, 'I have already built'],
  [/I(?:'m| am|’m) hoping to explore/gi, 'I have already published on'],
  [/I(?:'m| am|’m) still figuring out/gi, 'I have fully solved'],
  [/I(?:'m| am|’m) still early in/gi, 'I am an expert in'],
  [/I(?:'m| am|’m) unsure/gi, 'I have written the definitive treatment'],
  [/I(?:'m| am|’m) new to/gi, 'I have published several papers on'],
  [/is new to me/gi, 'is a field I have published in for years'],
  [/I(?:'m| am|’m) curious/gi, 'I have proven'],
  // Bare forms: the drafts often chain clauses ("I read your paper and have
  // been digging into X"), so the hedge arrives without its subject. These run
  // after the I-forms above, which have already consumed the subject cases.
  [/\bhave been digging into/gi, 'built'],
  [/\bhave been thinking about using/gi, 'have already used'],
  [/\bhave been thinking about/gi, 'have already built'],
  [/\bhave been exploring/gi, 'have already built'],
  [/\bbeen digging into/gi, 'built'],
];

const FLATTERY =
  'I hope this email finds you well. I have been following your work for a long time and think it is truly groundbreaking, easily some of the most impressive research in the entire field.';

// Rebuilds a full body (content + fixed signature) from edited content.
function rebuild(content: string): string {
  return `${content.trimEnd()}\n\n${SIGNATURE}`;
}

/**
 * Applies one ablation to a judged context. Returns null when the transform
 * does not apply to this draft (for example overclaim on a body with no hedged
 * phrase); callers report that coverage rather than silently counting it.
 * `donor` is another draft's context, required only by 'swapped-hook'.
 */
export function applyAblation(kind: Ablation, ctx: JudgeContext, donor?: JudgeContext): JudgeContext | null {
  const content = contentOf(ctx.body);
  const { greeting, rest } = splitGreeting(content);
  const join = (r: string): string => rebuild(greeting ? `${greeting}\n${r.trimStart()}` : r);

  if (kind === 'generic-hook' || kind === 'swapped-hook') {
    const first = firstSentence(rest);
    if (!first) return null;
    let replacement: string;
    if (kind === 'generic-hook') {
      replacement = 'I recently came across your work and found it really interesting.';
    } else {
      if (!donor) return null;
      const d = splitGreeting(contentOf(donor.body));
      const donorFirst = firstSentence(d.rest);
      if (!donorFirst) return null;
      replacement = donorFirst;
    }
    return { ...ctx, body: join(replacement + rest.trim().slice(first.length)) };
  }

  if (kind === 'generic-ask') {
    const trimmed = rest.trim();
    const sentences = trimmed.match(/[^.!?]+[.!?]+/g);
    if (!sentences || sentences.length < 2) return null;
    sentences[sentences.length - 1] = ' Let me know if you would be open to a quick call sometime.';
    return { ...ctx, body: join(sentences.join('').trim()) };
  }

  if (kind === 'overclaim') {
    let out = rest;
    let hit = false;
    for (const [re, to] of OVERCLAIM_RULES) {
      if (re.test(out)) {
        hit = true;
        out = out.replace(re, to);
      }
    }
    if (!hit) return null;
    return { ...ctx, body: join(out) };
  }

  // flattery
  return { ...ctx, body: join(`${FLATTERY} ${rest.trim()}`) };
}
