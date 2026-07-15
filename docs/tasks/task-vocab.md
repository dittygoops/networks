# Task: Make the fact vocabulary real (reconcile + enforce) and canonicalize OpenAlex concept values

> Context: `docs/spec-profile-mining.md` (D6a, D-vocabulary note under Data Model,
> D11 fact dedup key `(person_id, facet, key, value)`). The vocabulary is currently
> decorative: the prompt says "prefer keys from that vocabulary" but nothing enforces
> it, and drift already happens (code emits `academic/collaborator` which isn't in the
> documented list; the LLM emitted `academic/project`, also off-list). Because `key`
> and `value` are part of the dedup identity, inconsistent keys and near-synonym
> values weaken dedup and produce redundant facts/hooks.

## Goal
1. Reconcile the vocabulary with reality and make it enforced, not decorative.
2. Canonicalize redundant OpenAlex concept VALUES so near-synonyms collapse.

## Deliverables
1. **Reconcile the vocabulary** (spec + prompt + code agree on one canonical set):
   - Add `collaborator` to the academic list (the code emits it).
   - Decide `project`: either add `project` to academic, or map it to an existing key
     (`key_paper` / `side_project`). Pick one, apply consistently, note it in the spec.
   - Update the D-vocabulary note in `docs/spec-profile-mining.md` and the vocabulary
     lines in `src/llm/prompts.ts` (EXTRACT_SYSTEM) to match.
2. **Add and USE a `FACT_VOCABULARY` constant** in `src/pipeline/research.ts` (per-facet
   key arrays), plus a `normalizeKey(facet, key)` helper: lowercase + snake_case, and map
   common variants to the canonical key (e.g. `methods`->`method`, `projects`->`project`,
   `research area`->`research_area`). Unknown keys pass through snake-cased (do not drop).
   Apply `normalizeKey` when ingesting LLM-extracted facts in `minePersonalFacts`.
3. **Canonicalize OpenAlex concept values** in `factsFromOpenAlex`: dedupe near-identical
   `research_area` concepts so the three "graphics" variants ("Computer graphics (images)",
   "Rendering (computer graphics)", "Computer Graphics") no longer create three separate
   facts. At minimum dedupe case-insensitively after stripping parenthetical qualifiers;
   keep it simple and fully tested. Do the same idea for any facet where OpenAlex yields
   obvious synonyms.

## Boundaries (avoid merge conflicts)
- You OWN: `docs/spec-profile-mining.md`, `src/llm/prompts.ts`, `src/pipeline/research.ts`,
  and your own test files under `test/`.
- Do NOT edit `src/pipeline/intersect.ts`, `src/pipeline/contacts.ts`, `src/db/db.ts`, or
  `src/openalex/client.ts` (import from them only).
- Add no new dependencies. Do NOT stage or commit `package-lock.json` (use `git add` on
  specific files, never `git add -A` / `git add .`).

## Testing (offline, TDD)
- Follow the superpowers test-driven-development skill: failing test first, then code.
- No network. Existing tests use fakes (see `test/mine-person.test.ts`,
  `test/openalex-facts.test.ts`). Required cases: `normalizeKey` maps variants to canonical
  and passes unknowns through; a fact whose LLM key is a known variant dedupes with the
  canonical form; `factsFromOpenAlex` collapses the three "graphics" concept variants.
- After `npm install`, `npx vitest run` (ALL pass) and `npm run typecheck` must pass.

## Style
No em dashes anywhere. Match existing `research.ts` style. Commit on the current worktree
branch (end message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`); do NOT
push or merge. Report files changed, test count, typecheck status, and your branch name.
