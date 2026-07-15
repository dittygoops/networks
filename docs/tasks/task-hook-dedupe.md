# Task: Dedupe redundant intersections so the ranked hooks read cleanly

> Context: `docs/spec-profile-mining.md` (D6). The intersection engine currently emits
> near-duplicate hooks: on a live Kerbl run, one self-fact ("Neural rendering and novel
> view synthesis") matched three near-synonym person research_area facts, producing three
> separate 0.80 "both are in neural rendering and computer graphics" intersections. The top
> hook is correct and ranks first, but the list is noisy. Reduce that noise in the
> intersection layer only.

## Goal
Post-process the mapped intersections in `computeIntersections` so a person does not get
several near-identical hooks, while preserving the strongest genuine ones.

## Deliverables (all in `src/pipeline/intersect.ts`)
Add a dedupe step after `mapIntersections` and before storage/return:
1. **Drop exact-duplicate rationales**, keeping the highest strength.
2. **Cap per self-fact**: at most 2 intersections may share the same `selfFactId` (a single
   thing I've done should not spawn five hooks); keep the strongest by strength.
3. Global **top 20** and the existing `strength >= 0.3` filter still apply, after dedupe.
4. `noStrongHook` is computed from the deduped set.
Keep the ranking stable (sort by strength descending). Do not change the LLM prompt or the
scoring; this is purely output cleanup.

## Boundaries (avoid merge conflicts)
- You OWN: `src/pipeline/intersect.ts` and its test file `test/intersect.test.ts`.
- Do NOT edit `src/pipeline/research.ts`, `src/llm/prompts.ts`, `src/db/db.ts`, or
  `src/pipeline/contacts.ts` (import from them only).
- Add no new dependencies. Do NOT stage or commit `package-lock.json` (use `git add` on
  specific files, never `git add -A` / `git add .`).

## Testing (offline, TDD)
- Follow the superpowers test-driven-development skill: failing test first, then code.
- No network. The existing `test/intersect.test.ts` uses a fake LLM returning canned JSON.
  Required cases: three intersections sharing one selfFactId collapse to at most 2 (strongest
  kept); two intersections with identical rationale collapse to one; a diverse set is
  unchanged; `noStrongHook` reflects the deduped set.
- After `npm install`, `npx vitest run` (ALL pass) and `npm run typecheck` must pass.

## Style
No em dashes anywhere. Match existing `intersect.ts` style. Commit on the current worktree
branch (end message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`); do NOT
push or merge. Report files changed, test count, typecheck status, and your branch name.
