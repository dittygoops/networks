// Draft-quality eval set: the LLM-judge half of the evaluation.
// scripts/eval-trust-safety.ts answers "is this correctly addressed and does
// every hook trace to a real fact". It cannot answer "is this a good email",
// because that is a judgement, not a lookup. This script asks that question
// with a calibrated rubric judge (src/eval/draftQuality.ts).
//
// WHY THE LABELS ARE NOT ENOUGH, AND WHAT IS DONE ABOUT IT
//   56 drafts at status='sent' are positives: the owner approved each one over
//   iMessage. The 12 at status='skipped' are NOT clean negatives. Checked
//   against draft_events: d1 to d5 were skipped as "stale: predates the
//   hook-quality and contamination fixes", d3/d5 belong to a person later
//   approved as d20, d6 duplicates d7 which was approved, and d25/d26/d36/d39/
//   d44/d45 were skipped over iMessage with no reason recorded and all six
//   carry a wrong or malformed address. Exactly ONE skip is a recorded quality
//   judgement: d6, "regenerating: opening hook was vacuous".
//   So the labelled set is ~56 positives and 1 negative. A judge calibrated
//   only on positives cannot be validated, so this script also supports
//   --ablate: it damages one rubric property per copy of a real draft and
//   measures the paired score drop. If the judge cannot separate a draft from
//   its own damaged twin, the rubric is decoration and the run says so.
//
// WHAT THE CALIBRATION RUN FOUND (claude-haiku-4.5, temperature 0, 2026-08-04)
//   56 approved drafts: mean 7.68/10, range 4 to 10, no criterion saturated.
//   The judge would send 20 of the 56 the owner sent, so it is much stricter
//   than the owner; its complaint on the other 36 is almost always a generic
//   ask or a hook that names the paper without saying what is in it.
//   Separation of sent from skipped is AUC 0.585, i.e. near chance, which is
//   the CORRECT result: the skips were mostly duplicates and wrong addresses,
//   not bad prose (sent vs the six address-motivated skips is AUC 0.515).
//   Ablation: 56 of 56 damaged copies scored strictly lower, mean drop 3.0
//   points, and each ablation moved its own criterion most.
//
// READ ONLY. The database is opened with better-sqlite3 in readonly mode
// rather than through openDb(), because openDb applies schema.sql and runs
// migrations, which are writes. Nothing here writes, sends or queues anything.
//
// Usage:
//   npx tsx --env-file=.env scripts/eval-draft-quality.ts [--status sent] [--json]
//   npx tsx --env-file=.env scripts/eval-draft-quality.ts --status sent --ablate --ablate-n 20
//   npx tsx --env-file=.env scripts/eval-draft-quality.ts --status sent --ids d9,d68 --repeat 3
import Database from 'better-sqlite3';
import { createOpenRouterClient, type LLMClient } from '../src/llm/client.js';
import {
  ABLATIONS, CRITERIA, applyAblation, formChecks, judgeDraft,
  type Ablation, type Criterion, type JudgeContext, type Verdict,
} from '../src/eval/draftQuality.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const has = (name: string): boolean => args.includes(name);

const statuses = (flag('--status', 'awaiting_approval') as string).split(',').map((s) => s.trim());
const asJson = has('--json');
const ids = flag('--ids')?.split(',').map((s) => s.trim()) ?? null;
const limit = Number(flag('--limit', '0'));
const concurrency = Math.max(1, Number(flag('--concurrency', '4')));
const repeat = Math.max(1, Number(flag('--repeat', '1')));
const doAblate = has('--ablate');
const ablateN = Number(flag('--ablate-n', '20'));
// Calibrated, not guessed. Measured against the 56 owner-approved drafts with
// this judge: a floor of 4 fails 0 of them, 5 fails 2 (4%), 6 fails 6 (11%),
// 7 fails 12 (21%). 5 is the highest floor that stays under a 5% false-alarm
// rate on drafts the owner actually sent. Use --gate-min 6 for a stricter run.
const gateMin = Number(flag('--gate-min', '5'));
const dbPath = flag('--db', 'data/outreach.db') as string;
// Judge model. Deliberately NOT the model that wrote the drafts (deepseek-chat,
// the MODEL_CHEAP default), so the judge is not grading its own prose.
// Chosen by measurement, not by preference: on a 6-draft probe containing two
// known defects (d68's duplicate sign-off, d6's owner-recorded "vacuous opening
// hook"), run twice each at temperature 0:
//   openai/gpt-4.1-mini    stable (1/6 moved, spread 1) but scored d68 9/10 and
//                          never noticed the duplicate sign-off.
//   google/gemini-2.5-flash stable (1/6 moved, spread 1), caught d68, but rated
//                          d6 8 to 9 out of 10.
//   openai/gpt-5-mini      caught both, but 5/6 drafts moved between identical
//                          calls with a spread of 2 points, which is wider than
//                          the gate it would feed. Rejected on instability.
//   anthropic/claude-haiku-4.5  0/6 moved, caught d68 (form_discipline 0, lowest
//                          total), ranked the weak drafts last. Chosen.
const model = flag('--model', process.env.MODEL_JUDGE ?? 'anthropic/claude-haiku-4.5') as string;

// --- load the drafts (read only) -----------------------------------------

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const placeholders = statuses.map(() => '?').join(',');
const rows = db.prepare(`
  SELECT dr.short_id, dr.status, dr.paper_title, dr.draft_input_json,
         p.name, p.affiliation, rv.subject, rv.body
  FROM drafts dr
  JOIN people p ON p.id = dr.person_id
  LEFT JOIN revisions rv ON rv.id = dr.sendable_revision_id
  WHERE dr.status IN (${placeholders})
  ORDER BY dr.id`).all(...statuses) as {
    short_id: string; status: string; paper_title: string | null; draft_input_json: string;
    name: string; affiliation: string | null; subject: string | null; body: string | null;
  }[];
db.close();

// The hooks come from drafts.draft_input_json, the input frozen at generation
// time, NOT from the intersections table: a persona rebuild cascaded on
// ontology_facts and emptied intersections for 15 of the sent drafts, so the
// live table disagrees with what the drafter actually saw.
const contexts: JudgeContext[] = [];
for (const r of rows) {
  if (!r.body) continue;
  let input: { hooks?: JudgeContext['hooks']; senderFacts?: JudgeContext['senderFacts']; recipient?: { paperTitle?: string } } = {};
  try { input = JSON.parse(r.draft_input_json ?? '{}'); } catch { /* leave empty */ }
  contexts.push({
    shortId: r.short_id,
    personName: r.name,
    affiliation: r.affiliation,
    paperTitle: r.paper_title ?? input.recipient?.paperTitle ?? null,
    hooks: input.hooks ?? [],
    senderFacts: input.senderFacts ?? [],
    subject: r.subject ?? '',
    body: r.body,
  });
}

let selected = ids ? contexts.filter((c) => ids.includes(c.shortId)) : contexts;
if (limit > 0) selected = selected.slice(0, limit);
if (selected.length === 0) {
  console.error(`no drafts found for status ${statuses.join(',')}${ids ? ` and ids ${ids.join(',')}` : ''}`);
  process.exit(2);
}

// --- run the judge --------------------------------------------------------

let calls = 0;
const llm: LLMClient = createOpenRouterClient({ model, temperature: 0 });
const counting: LLMClient = { complete: (s, u) => { calls++; return llm.complete(s, u); } };

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

type Scored = { ctx: JudgeContext; verdict: Verdict | null; error?: string };

async function scoreAll(list: JudgeContext[]): Promise<Scored[]> {
  return pool(list, concurrency, async (ctx) => {
    const r = await judgeDraft(counting, ctx);
    return r.ok ? { ctx, verdict: r.verdict } : { ctx, verdict: null, error: r.error };
  });
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (x: number, d = 2): string => x.toFixed(d);

const scored = await scoreAll(selected);

// Repeat runs measure judge stability: temperature 0 is not determinism, and a
// rubric whose own score moves by 2 points between identical calls cannot
// support a gate at 1-point granularity.
const repeats: Scored[][] = [];
for (let i = 1; i < repeat; i++) repeats.push(await scoreAll(selected));

const ok = scored.filter((s): s is Scored & { verdict: Verdict } => s.verdict !== null);
const parseFails = scored.filter((s) => s.verdict === null);

// --- ablations ------------------------------------------------------------

type AblationRow = {
  shortId: string; kind: Ablation; base: number; ablated: number; delta: number;
  // Per-criterion deltas: a total that drops proves the judge noticed the
  // damage, but only the per-criterion split shows it noticed the RIGHT thing,
  // i.e. that the five criteria are not one latent "goodness" score wearing a
  // rubric. generic-hook should move hook_specificity, overclaim should move
  // stance_honesty, and so on.
  criterionDelta: Record<Criterion, number>;
};
const ablationRows: AblationRow[] = [];
const ablationSkips: Record<string, number> = {};

if (doAblate) {
  // Deterministic subsample: every k-th draft, so a rerun ablates the same set.
  const stride = Math.max(1, Math.floor(ok.length / Math.max(1, ablateN)));
  const subjects = ok.filter((_, i) => i % stride === 0).slice(0, ablateN);
  const jobs: { base: Scored & { verdict: Verdict }; kind: Ablation; ctx: JudgeContext }[] = [];
  for (const s of subjects) {
    for (const kind of ABLATIONS) {
      // The swap donor is a different draft (a different person and paper), so
      // a swapped hook is grounded in someone else's work, not this recipient's.
      const donorIdx = (ok.indexOf(s) + Math.floor(ok.length / 2)) % ok.length;
      const donor = ok[donorIdx]!.ctx;
      const mutated = applyAblation(kind, s.ctx, donor);
      if (!mutated) { ablationSkips[kind] = (ablationSkips[kind] ?? 0) + 1; continue; }
      jobs.push({ base: s, kind, ctx: mutated });
    }
  }
  const results = await pool(jobs, concurrency, async (j) => ({ j, r: await judgeDraft(counting, j.ctx) }));
  for (const { j, r } of results) {
    if (!r.ok) { ablationSkips[`${j.kind} (judge error)`] = (ablationSkips[`${j.kind} (judge error)`] ?? 0) + 1; continue; }
    ablationRows.push({
      shortId: j.base.ctx.shortId, kind: j.kind,
      base: j.base.verdict.total, ablated: r.verdict.total, delta: j.base.verdict.total - r.verdict.total,
      criterionDelta: Object.fromEntries(
        CRITERIA.map((c) => [c, j.base.verdict.scores[c] - r.verdict.scores[c]]),
      ) as Record<Criterion, number>,
    });
  }
}

// --- gate -----------------------------------------------------------------
// Two conditions, both derived from what the rubric claims to measure:
//   - stance_honesty 0 is a hard fail on its own. Claiming completed work that
//     was only ever a research direction is the failure this project's whole
//     [done]/[exploring] machinery exists to prevent.
//   - total below --gate-min is a fail, at a floor picked from the measured
//     distribution over the approved drafts (see the flag's comment).
const gateFails = ok.filter((s) => s.verdict.scores.stance_honesty === 0 || s.verdict.total < gateMin);
const exitCode = gateFails.length === 0 && parseFails.length === 0 ? 0 : 1;

// --- report ---------------------------------------------------------------

const perCriterion = Object.fromEntries(
  CRITERIA.map((c) => [c, mean(ok.map((s) => s.verdict.scores[c]))]),
) as Record<Criterion, number>;

if (asJson) {
  console.log(JSON.stringify({
    model, statuses, drafts: selected.length, calls,
    scored: ok.map((s) => ({
      shortId: s.ctx.shortId, total: s.verdict.total, verdict: s.verdict.verdict,
      scores: s.verdict.scores, why: s.verdict.why, worstProblem: s.verdict.worstProblem,
      form: formChecks(s.ctx.body),
    })),
    parseFails: parseFails.map((s) => ({ shortId: s.ctx.shortId, error: s.error })),
    perCriterion,
    ablations: ablationRows,
    ablationSkips,
    repeats: repeats.map((run) => run.map((s) => ({ shortId: s.ctx.shortId, total: s.verdict?.total ?? null }))),
    gate: { min: gateMin, fails: gateFails.map((s) => s.ctx.shortId), pass: exitCode === 0 },
  }, null, 2));
  process.exit(exitCode);
}

console.log(`\nDraft-quality eval  (status='${statuses.join(',')}', judge=${model})`);
console.log(`  drafts judged : ${ok.length}${parseFails.length ? ` (${parseFails.length} unparseable)` : ''}`);
console.log(`  LLM calls     : ${calls}`);
console.log(`\n  mean total    : ${fmt(mean(ok.map((s) => s.verdict.total)))} / 10`);
for (const c of CRITERIA) console.log(`    ${c.padEnd(18)} ${fmt(perCriterion[c])} / 2`);
const hist = new Map<number, number>();
for (const s of ok) hist.set(s.verdict.total, (hist.get(s.verdict.total) ?? 0) + 1);
console.log('\n  total distribution:');
for (let t = 0; t <= 10; t++) {
  const n = hist.get(t) ?? 0;
  if (n) console.log(`    ${String(t).padStart(2)} | ${'#'.repeat(n)} ${n}`);
}
console.log(`\n  verdict send  : ${ok.filter((s) => s.verdict.verdict === 'send').length} / ${ok.length}`);

console.log('\n  per draft:');
for (const s of [...ok].sort((a, b) => a.verdict.total - b.verdict.total)) {
  const f = formChecks(s.ctx.body);
  const flags = [
    f.overBudget ? `${f.words}w` : '',
    f.banned.length ? 'banned' : '',
    f.emDash ? 'emdash' : '',
    f.duplicateSignoff ? 'dupsig' : '',
    f.questionCount !== 1 ? `${f.questionCount}q` : '',
  ].filter(Boolean).join(',');
  console.log(
    `    ${s.ctx.shortId.padEnd(4)} ${String(s.verdict.total).padStart(2)}/10 ` +
    `[${CRITERIA.map((c) => s.verdict.scores[c]).join('')}] ${s.verdict.verdict.padEnd(6)} ` +
    `${flags.padEnd(16)} ${s.verdict.worstProblem.slice(0, 70)}`);
}
console.log(`    (bracket order: ${CRITERIA.join(', ')})`);

for (const s of parseFails) console.log(`    ${s.ctx.shortId.padEnd(4)} PARSE FAIL: ${s.error}`);

if (repeat > 1) {
  console.log(`\n  stability over ${repeat} runs at temperature 0:`);
  let moved = 0; let maxSpread = 0;
  for (const s of ok) {
    const totals = [s.verdict.total, ...repeats.map((run) => run.find((x) => x.ctx.shortId === s.ctx.shortId)?.verdict?.total ?? NaN)]
      .filter((n) => Number.isFinite(n));
    const spread = Math.max(...totals) - Math.min(...totals);
    if (spread > 0) moved++;
    maxSpread = Math.max(maxSpread, spread);
    if (spread > 0) console.log(`    ${s.ctx.shortId.padEnd(4)} totals ${totals.join(',')}`);
  }
  console.log(`    ${moved}/${ok.length} drafts moved, max spread ${maxSpread} points`);
}

if (doAblate) {
  console.log('\n  ABLATION (paired: the same draft, one rubric property damaged)');
  for (const kind of ABLATIONS) {
    const rowsK = ablationRows.filter((r) => r.kind === kind);
    if (!rowsK.length) { console.log(`    ${kind.padEnd(13)} no applicable drafts`); continue; }
    const drops = rowsK.filter((r) => r.delta > 0).length;
    const ties = rowsK.filter((r) => r.delta === 0).length;
    const rises = rowsK.filter((r) => r.delta < 0).length;
    console.log(
      `    ${kind.padEnd(13)} n=${String(rowsK.length).padStart(2)}  mean delta ${fmt(mean(rowsK.map((r) => r.delta)))}  ` +
      `dropped ${drops}, tied ${ties}, rose ${rises}  ` +
      `(base ${fmt(mean(rowsK.map((r) => r.base)))} -> ${fmt(mean(rowsK.map((r) => r.ablated)))})`);
    console.log(`      by criterion: ${CRITERIA.map((c) => `${c.split('_')[0]} ${fmt(mean(rowsK.map((r) => r.criterionDelta[c])), 1)}`).join('  ')}`);
  }
  const skipped = Object.entries(ablationSkips);
  if (skipped.length) console.log(`    not applicable / errored: ${skipped.map(([k, v]) => `${k} x${v}`).join(', ')}`);
  const all = ablationRows;
  console.log(`    overall: ${all.filter((r) => r.delta > 0).length}/${all.length} damaged copies scored strictly lower, mean drop ${fmt(mean(all.map((r) => r.delta)))}`);
}

console.log(`\n  GATE (stance_honesty > 0 and total >= ${gateMin}): ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
for (const s of gateFails) console.log(`    [FAIL] ${s.ctx.shortId} ${s.verdict.total}/10 ${s.verdict.worstProblem}`);
console.log('');
process.exit(exitCode);
