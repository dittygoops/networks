# Hook-First Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every paid Tavily call in `processPaper` happen only after the free identity and hook gates pass, so a discovery batch costs ~270 credits instead of ~1,000 without losing hook quality for the people we actually email.

**Architecture:** `processPaper` is reordered from `resolve → contact → mine → intersect` to `resolve → free facts → collision gate → intersect → hook gate → paid enrichment → contact`. `minePerson` is split into a free half (OpenAlex facts) and a paid half (web mining), so the paid half can run *after* the hook gate and enrich hooks for survivors only. `processCandidate`'s gates are reordered so the hook verdict stays observable.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 (synchronous), vitest, tsx. Spec: `docs/superpowers/specs/2026-08-02-hook-first-gating-design.md`.

## Global Constraints

- **ESM with explicit `.js` import extensions.** `import { x } from './foo.js'` even though the file is `foo.ts`. No exceptions.
- **Never delete `pageIsAboutPerson`, `buildDomainGate`, `urlSlugMatchesPerson`, `personNameInText`, `anchorAdmitsUrl`, `safeClassify`, or `extractFactsFromPage`.** An earlier spec draft proposed it and was wrong. `scripts/purge-contaminated-facts.ts:45,75,76` imports two of them, and `tsconfig.json` includes only `src/**` and `test/**`, so `npm run typecheck` will NOT catch breaking that script.
- **Never delete `test/mine-person.test.ts` or `test/page-identity.test.ts`.** They encode four production incidents.
- **`better-sqlite3` is synchronous.** No `await` on db calls.
- **Baseline: 46 files, 510 tests passing** on `main`. Confirm with `npx vitest run --reporter=dot` before starting.
- **If you are working in a git worktree, `git merge main` FIRST and re-measure.** Wave 1's worktrees were created from `204e3ee`, one commit behind `20e42c7` (the email-extraction fix), so they measured a 498-test baseline and ran without the 12 tests in `name-match.test.ts` and `web-extraction.test.ts`. A wrong baseline is survivable; missing a dependency task is not. Tasks 6-9 in particular REQUIRE Tasks 3, 4, and 5 to be present in your tree.
- `test/page-identity.test.ts` has **18** tests (an earlier draft of this plan said 17).
- **A regression test that cannot fail is worthless.** Every task's "verify it fails" step is mandatory; if the test passes before the implementation, the test is wrong.
- **Run the full suite before each commit**, not just the new test: `npx vitest run --reporter=dot 2>&1 | tail -5`.
- **Commit after every task.** No batching.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/pipeline/loop.ts` | `processCandidate` gate order | 1 |
| `src/pipeline/persist.ts` | empty-summary clobber fix | 2 |
| `src/pipeline/research.ts` | split `minePerson` into free/paid halves | 3 |
| `src/pipeline/orchestrate.ts` | error propagation, then the reorder | 4, 5, 6, 7 |
| `src/cli.ts` | `outreach add` exemption + draft predicate | 8 |
| `test/ordering.test.ts` (new) | shared-call-log ordering proof | 9 |

**Dependency order:** Tasks 1, 2, 3 are mutually independent. Tasks 4 and 5 are mutually independent. Task 6 requires 3, 4, 5. Tasks 7, 8, 9 require 6.

---

### Task 1: Reorder `processCandidate`'s gates so the hook verdict stays observable

**Why:** After Task 6, a hookless paper returns `email: null` because extraction never ran. `processCandidate` checks email (loop.ts:368) *before* hooks (loop.ts:373), so every no-hook paper would be recorded `no email resolved`, collapsing the `no grounded hook` bucket to zero. Both spec reviewers found this independently.

**Files:**
- Modify: `src/pipeline/loop.ts:368-377`
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `seen_papers.reason === 'no grounded hook'` for a candidate whose `OrchestrateResult` has `hooks: []`, `noStrongHook: true`, AND `email: null`. Task 9 relies on this.

- [ ] **Step 1: Write the failing test**

Add to `test/loop.test.ts`, inside `describe('runLoop discovery', ...)`:

```ts
  it('reports the hook failure, not the email failure, when a candidate has neither', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    // After hook-first gating, contact extraction never runs for a hookless
    // candidate, so email is null for a reason that is NOT "we looked and
    // failed". The hook gate must win, or the no-grounded-hook bucket
    // silently becomes unobservable.
    const neither = { ...resolvedResult('2601.00009', pid), email: null, hooks: [], noStrongHook: true };
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00009', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(neither),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.unsendable).toBe(1);
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00009') as { reason: string };
    expect(row.reason).toBe('no grounded hook');
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/loop.test.ts -t 'reports the hook failure'`
Expected: FAIL, received `'no email resolved'`.

- [ ] **Step 3: Swap the two gate blocks in `src/pipeline/loop.ts`**

Replace lines 368-377 (the `!result.email` block followed by the `noStrongHook` block) with the hook block first:

```ts
    if (result.noStrongHook || result.hooks.length === 0) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no grounded hook');
      summary.unsendable++;
      return;
    }
    // Checked AFTER the hook gate. Hook-first gating means contact extraction
    // does not run for a hookless candidate, so `email: null` there means "not
    // attempted", not "looked and failed". Checking email first would relabel
    // every no-hook paper 'no email resolved' and make the hook gate
    // unobservable in seen_papers.
    if (!result.email) {
      setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no email resolved');
      summary.unsendable++;
      return;
    }
```

- [ ] **Step 4: Run the new test and the full suite**

Run: `npx vitest run test/loop.test.ts -t 'reports the hook failure'` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → 511 tests passing.

The existing test `'marks a relevant paper unsendable when no email resolves'` (test/loop.test.ts:78) must still pass: its fixture has `hooks: [{tier:'A'}]` and `noStrongHook: false`, so it clears the hook gate and still reaches the email gate.

- [ ] **Step 5: Mutate to prove the test can fail**

Swap the two blocks back, run the new test, confirm RED, then restore and confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/loop.ts test/loop.test.ts
git commit -m "Check the hook gate before the email gate in processCandidate"
```

---

### Task 2: Stop an empty profile summary from overwriting a good one

**Why:** `minePerson` returns `profileSummary: ''` when the summary LLM call throws (research.ts:527-532). `upsertPerson` uses `coalesce(?, profile_summary)` (db.ts:105), and `''` is not NULL, so it overwrites. Task 6 makes re-mining more frequent, which makes this fire more often.

**Files:**
- Modify: `src/pipeline/persist.ts:18`
- Test: `test/persist.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Create or append to `test/persist.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { openDb, getPerson } from '../src/db/db.js';
import { persistPerson } from '../src/pipeline/persist.js';
import type { AuthorResolution, OntologyFact } from '../src/pipeline/research.js';
import type { OpenAlexAuthorRaw } from '../src/openalex/client.js';

const resolution = {
  author: { id: 'https://openalex.org/A1', displayName: 'Ada Lovelace', homepageUrls: [] },
} as unknown as AuthorResolution;
const raw = { last_known_institutions: [] } as unknown as OpenAlexAuthorRaw;

describe('persistPerson', () => {
  test('an empty summary from a failed LLM call does not overwrite a stored one', () => {
    const db = openDb(':memory:');
    const id = persistPerson(db, resolution, raw, { facts: [] as OntologyFact[], profileSummary: 'A good summary.' });
    // Second mine: the summary LLM call threw, so minePerson returned ''.
    persistPerson(db, resolution, raw, { facts: [] as OntologyFact[], profileSummary: '' });
    expect(getPerson(db, id)?.profile_summary).toBe('A good summary.');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/persist.test.ts`
Expected: FAIL, received `''`.

- [ ] **Step 3: Fix `src/pipeline/persist.ts`**

Change line 18 from `profileSummary: mineResult.profileSummary,` to:

```ts
    // '' is what minePerson returns when the summary LLM call throws, and
    // coalesce('', profile_summary) is '', so passing it through would erase a
    // good stored summary on every failed re-mine.
    profileSummary: mineResult.profileSummary || null,
```

Then widen `persistPerson`'s parameter type so `null` is accepted by `upsertPerson` (it already accepts `string | null | undefined` via `PersonInput`); no signature change is needed.

- [ ] **Step 4: Run the test and the full suite**

Run: `npx vitest run test/persist.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → all passing.

- [ ] **Step 5: Mutate to prove the test can fail**

Revert to `mineResult.profileSummary`, confirm RED, restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/persist.ts test/persist.test.ts
git commit -m "Stop an empty profile summary from erasing a stored one"
```

---

### Task 3: Split `minePerson` into a free half and a paid half

**Why:** Task 6 needs to run OpenAlex fact-gathering before the hook gate and web mining after it. Today both live inside one `minePerson` call (research.ts:507-535).

**Files:**
- Modify: `src/pipeline/research.ts:507-535`
- Test: `test/mine-person.test.ts` (add cases; change none)

**Interfaces:**
- Consumes: nothing.
- Produces, all exported from `src/pipeline/research.ts`:
  - `minePersonFree(deps: { llm: LLMClient }, resolution: AuthorResolution, raw: OpenAlexAuthorRaw): Promise<{ facts: OntologyFact[]; profileSummary: string }>` — OpenAlex facts + hobby split + summary. Makes NO Tavily call.
  - `minePersonWeb(deps: MineDeps, resolution: AuthorResolution, raw: OpenAlexAuthorRaw, freeFacts: OntologyFact[]): Promise<{ facts: OntologyFact[]; profileSummary: string }>` — appends web-mined facts to `freeFacts`, re-splits, recomputes the summary over the combined set. Returns the COMBINED facts, not just the new ones.
  - `minePerson` keeps its existing signature and behavior, now implemented as `minePersonFree` then `minePersonWeb`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mine-person.test.ts`:

```ts
describe('minePerson split halves', () => {
  test('minePersonFree makes no Tavily call and still returns OpenAlex facts', async () => {
    const search = vi.fn();
    const fetcher = vi.fn();
    const r = await minePersonFree({ llm: fakeLlm() }, resolutionFixture(), rawFixture());
    expect(search).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.facts.every((f) => f.sourceUrl.includes('openalex'))).toBe(true);
  });

  test('minePersonWeb returns the free facts plus the web facts, not only the new ones', async () => {
    const free = await minePersonFree({ llm: fakeLlm() }, resolutionFixture(), rawFixture());
    const combined = await minePersonWeb(webDeps(), resolutionFixture(), rawFixture(), free.facts);
    expect(combined.facts.length).toBeGreaterThanOrEqual(free.facts.length);
    for (const f of free.facts) {
      expect(combined.facts).toContainEqual(f);
    }
  });
});
```

Build `resolutionFixture()`, `rawFixture()`, `fakeLlm()`, and `webDeps()` from the fixtures already present at the top of `test/mine-person.test.ts` — reuse them rather than inventing new shapes. Add `minePersonFree` and `minePersonWeb` to that file's import from `../src/pipeline/research.js`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/mine-person.test.ts`
Expected: FAIL, `minePersonFree is not a function`.

- [ ] **Step 3: Implement the split in `src/pipeline/research.ts`**

Replace the body of `minePerson` (lines 507-535) with three functions:

```ts
// The free half: OpenAlex-derived facts only. Makes no Tavily call, so it is
// safe to run before the hook gate on every candidate (see the hook-first
// gating spec). Kept separate from minePersonWeb so paid mining can be
// deferred until we know the person is worth emailing.
export async function minePersonFree(
  deps: { llm: LLMClient },
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const facts = splitHobbyFacts(factsFromOpenAlex(resolution.author, raw));
  return { facts, profileSummary: await summarize(deps.llm, resolution.author.displayName, facts) };
}

// The paid half: Tavily searches + extracts, domain-gated and tier-clamped.
// Takes the free facts and RETURNS THE COMBINED SET (callers persist the
// return value wholesale). A web failure degrades to the free facts.
export async function minePersonWeb(
  deps: MineDeps,
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
  freeFacts: OntologyFact[],
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const facts = [...freeFacts];
  try {
    await minePersonalFacts(deps, resolution.author, raw, facts);
  } catch {
    // Tavily/LLM failure: keep the free facts, skip personal facets.
  }
  const finalFacts = splitHobbyFacts(facts);
  return { facts: finalFacts, profileSummary: await summarize(deps.llm, resolution.author.displayName, finalFacts) };
}

export async function minePerson(
  deps: MineDeps,
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
): Promise<{ facts: OntologyFact[]; profileSummary: string }> {
  const free = await minePersonFree(deps, resolution, raw);
  return minePersonWeb(deps, resolution, raw, free.facts);
}
```

Add the shared summary helper immediately above them, preserving the existing best-effort semantics:

```ts
// Best-effort: an LLM failure must not lose the mined facts. Returns '' on
// failure; persistPerson converts that to NULL so it cannot erase a stored
// summary.
async function summarize(llm: LLMClient, name: string, facts: OntologyFact[]): Promise<string> {
  try {
    return (await llm.complete(SUMMARY_SYSTEM, buildSummaryUser(name, facts))).trim();
  } catch {
    return '';
  }
}
```

Note `minePerson` now calls the summary LLM twice. That is acceptable because after Task 6 nothing calls `minePerson` on the hot path; it survives only for the smoke scripts and existing tests.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/mine-person.test.ts` → all PASS, including the 10 pre-existing tests unchanged.
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → all passing.
Run: `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/research.ts test/mine-person.test.ts
git commit -m "Split minePerson into free (OpenAlex) and paid (web) halves"
```

---

### Task 4: Make a missing self-ontology a run error, not a silent no-hook

**Why:** `computeIntersections` throws `SelfOntologyMissingError`; orchestrate.ts:162-164 catches it and leaves `hooks = []`. After Task 6 that is indistinguishable from "no hook", so an empty self ontology would terminate EVERY paper in the run at `drafted_unsendable` with nothing captured and nothing retryable. `CLAUDE.md` documents how easily this state is reached (`persona` uses `replaceSelfFacts`; `intersections` cascades on `ontology_facts`).

**Files:**
- Modify: `src/pipeline/orchestrate.ts:158-165`
- Test: `test/orchestrate.test.ts:105-111` (rewrite)

**Interfaces:**
- Consumes: nothing.
- Produces: `processPaper` rejects with `SelfOntologyMissingError` when the self ontology is empty. Task 6 relies on this so the hook gate can treat `hooks: []` as a genuine no-hook.

- [ ] **Step 1: Rewrite the existing test**

Replace the test at `test/orchestrate.test.ts:105-111` ("no self ontology seeded"). The old test asserted silent degradation; the new one asserts propagation:

```ts
  test('a missing self ontology is a run error, not a silent no-hook verdict', async () => {
    const d = deps(); // no saveSelfFacts call: the self ontology is empty
    // Silently returning hooks: [] here would be read by the hook gate as
    // "this person is not interesting", terminating every paper in the run
    // at drafted_unsendable with nothing captured and nothing retryable.
    await expect(processPaper(d, '2308.04079')).rejects.toBeInstanceOf(SelfOntologyMissingError);
  });
```

Add `SelfOntologyMissingError` to the imports from `../src/pipeline/intersect.js` in that test file.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/orchestrate.test.ts -t 'missing self ontology'`
Expected: FAIL, the promise resolves instead of rejecting.

- [ ] **Step 3: Re-throw in `src/pipeline/orchestrate.ts`**

Replace the try/catch at lines 158-165 with:

```ts
    // Deliberately NOT caught. An empty self ontology yields hooks: [], which
    // the hook gate cannot distinguish from a genuinely uninteresting person,
    // so swallowing it would terminate every paper in the run with nothing
    // captured and nothing retryable. Let it reach processCandidate's catch
    // (loop.ts:433), which records a retryable error.
    const r = await computeIntersections(deps.db, { llm: deps.llm }, personId);
    hooks = r.ranked;
    noStrongHook = r.noStrongHook;
```

Remove the now-unused `SelfOntologyMissingError` import from orchestrate.ts if nothing else references it.

- [ ] **Step 4: Run the test and full suite**

Run: `npx vitest run test/orchestrate.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`

- [ ] **Step 5: Mutate to prove the test can fail**

Restore the catch, confirm RED, remove it again, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/orchestrate.ts test/orchestrate.test.ts
git commit -m "Propagate SelfOntologyMissingError instead of degrading to no-hook"
```

---

### Task 5: Distinguish an OpenAlex outage from a genuine no-match

**Why:** orchestrate.ts:77-86 catches EVERY exception from `fetchAuthorCandidates` (429, DNS, JSON parse) and degrades to the same `identity unconfirmed` note as a real no-match. After Task 6 that verdict is terminal and unrecoverable: `getResumable`/`getExhausted` (seenLedger.ts:98,114) filter `status = 'discovered'`, `filterUnseen` (:29-41) drops anything already in `seen_papers`, and `strandedReport` (:190) does not even print those rows. A 429 storm would permanently discard a day of candidates. This project has already been bitten by arXiv 429s.

**Files:**
- Modify: `src/pipeline/orchestrate.ts:73-87`
- Test: `test/orchestrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `processPaper` rejects when the OpenAlex HTTP call throws; it still resolves with `resolved: false` when OpenAlex returns a well-formed empty candidate list.

- [ ] **Step 1: Write the failing tests**

Append to `describe('processPaper (orchestrator)', ...)` in `test/orchestrate.test.ts`:

```ts
  test('an OpenAlex transport failure is retryable, not a terminal identity verdict', async () => {
    const boom = (async (u: string) => {
      if (String(u).includes('/authors')) throw new Error('429 Too Many Requests');
      return routerFetch()(u as never);
    }) as unknown as typeof fetch;
    const d = deps({ fetchFn: boom as never });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    // Degrading here would write drafted_unsendable/'identity unconfirmed',
    // which nothing ever revisits, so an outage would silently discard the day.
    await expect(processPaper(d, '2308.04079')).rejects.toThrow(/429/);
  });

  test('a genuine no-match still degrades quietly to unresolved', async () => {
    const empty = (async (u: string) => {
      if (String(u).includes('/authors')) return resp({ json: { results: [] } });
      return routerFetch()(u as never);
    }) as unknown as typeof fetch;
    const d = deps({ fetchFn: empty as never });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    const r = await processPaper(d, '2308.04079');
    expect(r.resolved).toBe(false);
    expect(r.notes.join(' ')).toContain('identity unconfirmed');
  });
```

- [ ] **Step 2: Run and confirm the first fails**

Run: `npx vitest run test/orchestrate.test.ts -t 'transport failure'`
Expected: FAIL, resolves instead of rejecting.

- [ ] **Step 3: Narrow the catch in `src/pipeline/orchestrate.ts`**

Replace lines 73-87 with:

```ts
  // Resolve identity via OpenAlex. A transport failure (429, DNS, parse) is
  // NOT the same as "this author does not exist": under hook-first gating the
  // unresolved verdict is terminal and nothing ever revisits it, so an outage
  // must surface as a retryable error rather than silently discarding the
  // candidate. Only a well-formed empty/no-match result degrades.
  let resolution = null as Awaited<ReturnType<typeof resolveAuthor>>;
  let raw: OpenAlexAuthorRaw | undefined;
  let currentAff: string | undefined;
  const fetched = await fetchAuthorCandidates(target.name, { fetchFn });
  resolution = resolveAuthor(fetched.map((f) => f.candidate), target.name, ctx);
  if (resolution) {
    raw = fetched.find((f) => f.candidate.id === resolution!.author.id)?.raw;
    if (raw) currentAff = currentAffiliation(raw) ?? undefined;
  }
  if (!resolution) notes.push('identity unconfirmed (UNRESOLVED)');
```

- [ ] **Step 4: Run both tests and the full suite**

Run: `npx vitest run test/orchestrate.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`

- [ ] **Step 5: Mutate to prove the first test can fail**

Wrap the `fetchAuthorCandidates` call back in a `try { } catch { }`, confirm RED, restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/orchestrate.ts test/orchestrate.test.ts
git commit -m "Re-throw OpenAlex transport failures instead of marking identity unconfirmed"
```

---

### Task 6: Reorder `processPaper` so paid calls run only after the hook gate

**Why:** This is the change the whole plan exists for. 95 no-hook, 72 unresolved, and 18 collision papers currently pay for contact extraction and web mining before anything checks whether they are worth emailing.

**Requires:** Tasks 3, 4, 5.

**Files:**
- Modify: `src/pipeline/orchestrate.ts:65-189` (the whole `processPaper` body)
- Test: `test/orchestrate.test.ts:85-103` (rewrite)

**Interfaces:**
- Consumes: `minePersonFree`, `minePersonWeb` (Task 3); non-degrading intersect (Task 4) and resolve (Task 5).
- Produces: `processPaper(deps, arxivId, opts?: ProcessPaperOptions)` where
  `export interface ProcessPaperOptions { alwaysExtractContact?: boolean }`.
  Default `false`. Task 8 passes `true`.

- [ ] **Step 1: Rewrite the "contact only" test to encode the new behavior**

Replace `test/orchestrate.test.ts:85-103` (`'degrades when the author cannot be resolved: contact only, no ontology'`):

```ts
  test('an unresolved author costs nothing: no contact lookup, no PDF fetch, no person row', async () => {
    const empty = (async (u: string) => {
      if (String(u).includes('/authors')) return resp({ json: { results: [] } });
      return routerFetch()(u as never);
    }) as unknown as typeof fetch;
    const search = vi.fn(async () => []);
    const fetcher = vi.fn(async () => []);
    const getPaperText = vi.fn(async () => 'Corresponding author: bernhard.kerbl@tuwien.ac.at');
    const d = deps({ fetchFn: empty as never, search: { search }, fetcher: { fetch: fetcher }, getPaperText });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);

    const r = await processPaper(d, '2308.04079');

    expect(r.resolved).toBe(false);
    expect(r.email).toBeNull();
    expect(r.personId).toBeNull();
    expect(search).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(getPaperText).not.toHaveBeenCalled(); // the PDF fetch moves too
    expect(d.db.prepare('SELECT COUNT(*) n FROM people').get()).toEqual({ n: 0 });
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/orchestrate.test.ts -t 'unresolved author costs nothing'`
Expected: FAIL, `search` was called and a person row exists.

- [ ] **Step 3: Rewrite `processPaper`**

Replace the body from line 65 through the `return` with this order. Keep every existing helper call; only the sequence and the gates change.

```ts
export interface ProcessPaperOptions {
  // `outreach add` is one deliberate human invocation, not a 184-paper batch,
  // so its contact lookup is worth the credits even when the author does not
  // resolve or does not hook. The loop never sets this.
  alwaysExtractContact?: boolean;
}

export async function processPaper(
  deps: OrchestrateDeps,
  arxivId: string,
  opts: ProcessPaperOptions = {},
): Promise<OrchestrateResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const notes: string[] = [];

  const paper = await fetchArxivPaper(arxivId, { fetchFn });
  const target = selectTargetAuthor(paper);
  const ctx = buildPaperContext(paper, target);

  let personId: number | null = null;
  let factCount = 0;
  let hooks: Intersection[] = [];
  let noStrongHook = true;
  let profileSummary: string | undefined;
  let identityCollisionReason: string | undefined;
  let email: SelectedEmail | null = null;

  // Contact extraction, factored out so the two exits below can reuse it.
  const runContactExtraction = async (aff: string | undefined): Promise<void> => {
    const paperText = deps.getPaperText ? await deps.getPaperText(arxivId) : await defaultPaperText(arxivId, fetchFn);
    email = await extractContact({ search: deps.search, fetcher: deps.fetcher }, { name: target.name }, paperText, {
      paperContext: ctx,
      currentAffiliation: aff,
      paperAgeMonths: arxivAgeMonths(arxivId),
    });
  };

  const result = (): OrchestrateResult => ({
    arxivId: paper.arxivId, target: target.name, paperTitle: paper.title, profileSummary,
    resolved: !!resolution, email, personId, factCount, hooks, noStrongHook, notes, identityCollisionReason,
  });

  // --- Step 2: identity (free). See Task 5 for why this no longer catches. ---
  const fetched = await fetchAuthorCandidates(target.name, { fetchFn });
  const resolution = resolveAuthor(fetched.map((f) => f.candidate), target.name, ctx);
  const raw = resolution ? fetched.find((f) => f.candidate.id === resolution.author.id)?.raw : undefined;
  const currentAff = raw ? currentAffiliation(raw) ?? undefined : undefined;

  if (!resolution || !raw) {
    notes.push('identity unconfirmed (UNRESOLVED)');
    if (opts.alwaysExtractContact) await runContactExtraction(currentAff);
    return result();
  }

  // --- Step 3: free facts + collision gate ---
  resolution.author.homepageUrls = await fetchIdentityAnchors(raw, { fetchFn }).catch(() => []);
  const free = await minePersonFree({ llm: deps.llm }, resolution, raw);
  personId = persistPerson(deps.db, resolution, raw, free);
  factCount = free.facts.length;
  profileSummary = free.profileSummary;

  // Deliberately runs on the OpenAlex facts ONLY, exactly as before. Feeding
  // it paper-derived facts would change verdicts (arXiv-sourced
  // academic/collaborator rows exist) and is out of scope.
  const collision = detectIdentityCollision(free.facts);
  if (collision.suspected) {
    identityCollisionReason = collision.reason;
    notes.push(collision.reason!);
    // A person flagged on this run must not keep hook rows from an earlier
    // run when they were not flagged: nothing else will clear them, because
    // saveIntersections' DELETE+INSERT no longer runs for them.
    clearIntersections(deps.db, personId);
    if (opts.alwaysExtractContact) await runContactExtraction(currentAff);
    return result();
  }

  // --- Step 4: paper facts + hook gate (still free of Tavily) ---
  factCount += await addPaperFacts(deps, personId, paper, target.name);
  ({ ranked: hooks, noStrongHook } = await computeIntersections(deps.db, { llm: deps.llm }, personId));

  if (noStrongHook || hooks.length === 0) {
    if (opts.alwaysExtractContact) await runContactExtraction(currentAff);
    return result(); // zero paid calls on the loop path
  }

  // --- Step 5: paid enrichment, survivors only ---
  const enriched = await minePersonWeb({ search: deps.search, fetcher: deps.fetcher, llm: deps.llm }, resolution, raw, free.facts);
  persistPerson(deps.db, resolution, raw, enriched);
  factCount = enriched.facts.length;
  profileSummary = enriched.profileSummary;
  // Recompute so a web-mined fact can become the lead hook. Measured case:
  // person 58's top hook (tier A, 0.9, 'olfaction') came from a CSHL page and
  // outranked their best arXiv hook.
  ({ ranked: hooks, noStrongHook } = await computeIntersections(deps.db, { llm: deps.llm }, personId));

  // --- Step 6: contact, survivors only ---
  await runContactExtraction(currentAff);
  if (email) {
    upsertPerson(deps.db, {
      name: target.name, openalexId: resolution.author.id,
      email: email.email, emailConfidence: email.confidence, emailSource: email.source,
    });
  }
  return result();
}
```

Extract the existing paper-fact block (current lines 125-147) verbatim into a helper `addPaperFacts(deps, personId, paper, authorName): Promise<number>` returning the count of newly saved facts, keeping its `try/catch` and its `existingKeys` de-duplication exactly as written.

Add to `src/db/db.ts`:

```ts
// Used when a person is flagged as an identity collision after previously
// producing hooks: saveIntersections' DELETE+INSERT will not run for them
// again, so the stale rows would survive forever.
export function clearIntersections(db: DB, personId: number): void {
  db.prepare('DELETE FROM intersections WHERE person_id = ?').run(personId);
}
```

Import `clearIntersections`, `minePersonFree`, and `minePersonWeb` in orchestrate.ts. Remove the now-unused `minePerson` and `getFacts`/`saveFacts` imports only if `addPaperFacts` no longer needs them (it does need both, so keep them).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/orchestrate.test.ts` → all PASS.
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → all passing.
Run: `npm run typecheck`.

The existing full-chain test (`test/orchestrate.test.ts:68-83`) is the regression that proves the `upsertPerson(email)` write survived the move. If it fails, the email write was dropped; fix that, do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/orchestrate.ts src/db/db.ts test/orchestrate.test.ts
git commit -m "Run contact extraction and web mining only after the hook gate"
```

---

### Task 7: Skip contact extraction when an address is already on record

**Why:** A repeat author with `people.email` already stored still pays for a full `extractContact` on their next hook-passing paper. This is the cheapest remaining saving and costs nothing to add.

**Requires:** Task 6.

**Files:**
- Modify: `src/pipeline/orchestrate.ts` (inside `runContactExtraction`)
- Test: `test/orchestrate.test.ts`

**Interfaces:**
- Consumes: `runContactExtraction` and `personId` from Task 6.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

```ts
  test('a person whose email is already on record does not pay for another lookup', async () => {
    const search = vi.fn(async () => []);
    const d = deps({ search: { search } });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    await processPaper(d, '2308.04079');              // first paper: pays
    const callsAfterFirst = search.mock.calls.length;
    search.mockClear();
    await processPaper(d, '2308.04079');              // same author again
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(search).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/orchestrate.test.ts -t 'already on record'`
Expected: FAIL, `search` called again.

- [ ] **Step 3: Add the guard**

At the top of `runContactExtraction` in `src/pipeline/orchestrate.ts`:

```ts
    // A repeat author already has an address; re-paying to rediscover it is
    // pure waste. `email` stays null here, which is correct: the caller reads
    // people.email, and processCandidate's gate ordering (loop.ts) puts the
    // hook check first so a null email never masks a hook verdict.
    if (personId != null) {
      const known = getPerson(deps.db, personId);
      if (known?.email) {
        email = { email: known.email, confidence: 1, source: 'on_record' } as SelectedEmail;
        return;
      }
    }
```

Import `getPerson` from `../db/db.js`. Confirm `PersonRow` includes `email` (db.ts:121 selects it) and widen `SelectedEmail['source']` to include `'on_record'` if that type is a union.

- [ ] **Step 4: Run the tests and full suite**

Run: `npx vitest run test/orchestrate.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/orchestrate.ts test/orchestrate.test.ts
git commit -m "Reuse a stored email instead of paying to rediscover it"
```

---

### Task 8: Keep `outreach add` useful and fix its draft predicate

**Why:** `outreach add` is the remedy `cmdStranded` points operators at (cli.ts:184-185) and its whole output is the contact report. After Task 6 it would print `email: not found (manual queue)` for a lookup that never ran, which reports a non-result as a result. Separately its draft predicate (cli.ts:296) checks neither `noStrongHook` nor `identityCollisionReason`, so it disagrees with the loop.

**Requires:** Task 6.

**Files:**
- Modify: `src/cli.ts:278-281`, `src/cli.ts:296`
- Test: manual verification (this path has no test harness; do not build one here)

**Interfaces:**
- Consumes: `ProcessPaperOptions` from Task 6.
- Produces: nothing.

- [ ] **Step 1: Pass the exemption**

Change the `processPaper` call at `src/cli.ts:278`:

```ts
  const r = await processPaper(
    { db, search: tavily, fetcher: tavily, llm: createOpenRouterClient() },
    arg,
    // One deliberate human invocation, not a batch: look up the address even
    // when the author does not resolve or does not hook, because printing
    // "not found" for a lookup that never ran would be a false report.
    { alwaysExtractContact: true },
  );
```

- [ ] **Step 2: Align the draft predicate**

Change `src/cli.ts:296` from `if (r.resolved && r.hooks.length > 0 && r.personId != null) {` to:

```ts
  // Matches the loop's gate (loop.ts): a weak hook or a suspected identity
  // collision must not produce a draft here either.
  if (r.resolved && r.personId != null && !r.noStrongHook && r.hooks.length > 0 && !r.identityCollisionReason) {
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck`
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`

- [ ] **Step 4: Verify by demonstration**

Run `npx tsx --env-file=.env src/cli.ts add 2308.04079` against a resolvable paper and confirm the `email:` line reports a real lookup. Paste the output into the commit message body. Do NOT approve or send anything.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "Exempt outreach add from the identity gate and align its draft predicate"
```

---

### Task 9: Prove the ordering with a shared call log

**Why:** The spec's verification step. Counting calls per-seam is not enough; the claim is that paid calls happen *after* the intersect LLM call, which needs one ordered log across all seams.

**Requires:** Task 6.

**Files:**
- Create: `test/ordering.test.ts`

**Interfaces:**
- Consumes: `processPaper` (Task 6), `INTERSECT_SYSTEM` from `../src/llm/prompts.js`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from 'vitest';
import { openDb, saveSelfFacts } from '../src/db/db.js';
import { processPaper, type OrchestrateDeps } from '../src/pipeline/orchestrate.js';
import { INTERSECT_SYSTEM, EXTRACT_SYSTEM } from '../src/llm/prompts.js';
import type { OntologyFact } from '../src/pipeline/research.js';

// ONE ordered log across every seam. Per-seam counters cannot express "paid
// calls happened after the intersect call"; there is no direct seam on
// computeIntersections or extractContact, so ordering is inferred from this.
function loggedDeps(log: string[], over: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    // A FRESH in-memory DB per case is required, not an optimisation to remove:
    // computeIntersections reads ALL accumulated facts for a person, so a
    // shared fixture would let "no hook -> zero paid calls" pass for the wrong
    // reason.
    db: openDb(':memory:'),
    search: { async search(q) { log.push(`search:${q}`); return []; } },
    fetcher: { async fetch(u) { log.push(`fetch:${u.length}`); return []; } },
    llm: { async complete(system) {
      log.push(system === INTERSECT_SYSTEM ? 'llm:intersect' : system === EXTRACT_SYSTEM ? 'llm:extract' : 'llm:summary');
      return system === INTERSECT_SYSTEM ? '[]' : system === EXTRACT_SYSTEM ? '[]' : 'A profile.';
    } },
    getPaperText: async () => { log.push('pdf'); return null; },
    ...over,
  } as OrchestrateDeps;
}

const PAID = (e: string) => e.startsWith('search:') || e.startsWith('fetch:') || e === 'pdf';

describe('hook-first ordering', () => {
  test('a candidate with no hook triggers zero paid calls', async () => {
    const log: string[] = [];
    const d = loggedDeps(log);
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: 'Byzantine Consensus', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    await processPaper(d, '2308.04079');           // llm returns [] hooks
    expect(log.filter(PAID)).toEqual([]);
  });

  test('when a hook exists, every paid call comes after the intersect call', async () => {
    const log: string[] = [];
    const d = loggedDeps(log, {
      llm: { async complete(system) {
        log.push(system === INTERSECT_SYSTEM ? 'llm:intersect' : system === EXTRACT_SYSTEM ? 'llm:extract' : 'llm:summary');
        if (system === INTERSECT_SYSTEM) return JSON.stringify([{ self: 's0', person: 'p0', strength: 0.9, rationale: 'both do 3DGS' }]);
        return system === EXTRACT_SYSTEM ? '[]' : 'A profile.';
      } },
    });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    await processPaper(d, '2308.04079');
    const firstIntersect = log.indexOf('llm:intersect');
    const firstPaid = log.findIndex(PAID);
    expect(firstIntersect).toBeGreaterThanOrEqual(0);
    expect(firstPaid).toBeGreaterThan(firstIntersect);
  });
});
```

If `processPaper` needs network fixtures for arXiv/OpenAlex, reuse the `routerFetch()` helper from `test/orchestrate.test.ts` by exporting it into a shared `test/helpers/fixtures.ts` rather than duplicating it.

- [ ] **Step 2: Run and confirm both pass**

Run: `npx vitest run test/ordering.test.ts`

- [ ] **Step 3: Mutate to prove both can fail**

In `src/pipeline/orchestrate.ts`, temporarily move the `await runContactExtraction(currentAff)` call back above the hook gate. Run: both tests must go RED. Restore, confirm GREEN. **This step is mandatory** and is the only thing that distinguishes these tests from decoration.

- [ ] **Step 4: Commit**

```bash
git add test/ordering.test.ts test/helpers/fixtures.ts
git commit -m "Prove paid calls happen only after the hook gate"
```

---

### Task 10: Demonstrate the cost drop against the live API

**Why:** Project rule: verification by demonstration, not assertion. Passing tests have agreed with wrong code in this repo before.

**Requires:** Tasks 1-9 merged.

**Files:** none (measurement only)

> **The Tavily usage endpoint is NOT real-time.** Measured 2026-08-02: a live
> `POST /search` that returned real results left `account.plan_usage` unchanged
> at 255 for at least five minutes. A before/after read around a single run
> therefore proves nothing, and reporting a delta from it would be reporting a
> number that does not mean what it looks like. Use the DB exit-path
> measurement in Step 4 as the primary evidence, and treat the credit delta as
> a next-day confirmation.

- [ ] **Step 1: Record the starting usage**

```bash
curl -s -H "Authorization: Bearer $TAVILY_API_KEY" https://api.tavily.com/usage
```

- [ ] **Step 2: Run one real cycle**

```bash
cd outreach && npx tsx --env-file=.env src/cli.ts loop
```

- [ ] **Step 3: Record the ending usage and report the delta**

Re-run the curl. Report credits consumed, papers seen, and credits per paper. Expected on the order of 1-2 per seen paper versus the measured 5.4.

If the monthly quota is exhausted, WAIT for the reset rather than skipping this step, and say so plainly. Do not report a number you did not measure.

- [ ] **Step 4: Report the terminal-status distribution**

```bash
sqlite3 -header -column outreach/data/outreach.db \
  "SELECT reason, COUNT(*) n FROM seen_papers WHERE status='drafted_unsendable' GROUP BY reason ORDER BY n DESC LIMIT 6;"
```

Confirm `no grounded hook` still appears and did not collapse to zero (that would mean Task 1 regressed).

---

## Self-Review

**Spec coverage.** Change 1 → Tasks 5, 6 (steps 2-6 of the spec's ordering), 7. Change 2 → Task 1. Change 3 → Task 2. Collision `DELETE` → Task 6. `outreach add` → Task 8. Verification 1 → Task 9. Verification 2 → Task 1. Verification 3 → Task 10. Test dispositions → Tasks 4, 6 (rewrites) and the Global Constraints (do-not-delete list). No spec section is unimplemented.

**Placeholders.** None: every code step carries the actual code. Task 8 has no automated test because that CLI path has no harness, and building one is explicitly out of scope rather than deferred vaguely; it gets a manual demonstration step instead.

**Type consistency.** `minePersonFree` / `minePersonWeb` return `{ facts, profileSummary }` in Task 3 and are consumed with those names in Task 6. `ProcessPaperOptions.alwaysExtractContact` is defined in Task 6 and used in Task 8. `clearIntersections(db, personId)` is defined and used in Task 6. `getPerson(...)?.email` in Task 7 matches `PersonRow` as selected at db.ts:121.

**Known risk to watch during implementation:** Task 7 introduces `source: 'on_record'`. If `SelectedEmail['source']` is a closed union consumed by `selectEmail`'s scoring or by the draft ledger, widening it may ripple. If it does, prefer storing the reuse flag outside `SelectedEmail` over loosening the type to `string`.
