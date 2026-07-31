# Discovery Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a broken discovery source distinguishable from a quiet day, and make `--dry-run` a rehearsal that arms nothing.

**Architecture:** Discovery sources stop signalling failure by throwing (or by silently swallowing) and instead return `{ candidates, errors }`. `discoverAll` folds those errors into the run summary that is texted to Aditya. Separately, `outreach loop --dry-run` stops persisting anything a later real run will act on.

**Related specs:** `docs/spec-candidate-stranding.md` (dry-run rules as they exist today, CS7.5; the `discovered` resting state and its reader, CS1), `docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`.

## Global Constraints

- **No em dashes.** The character U+2014 must not appear in any file content, comment, commit message, or generated text. Use commas, colons, periods, or parentheses. This is hook-enforced and it will reject the commit.
- Every source import uses an explicit `.js` extension.
- better-sqlite3 is **synchronous**. Never `await` a statement.
- **No test may touch the network.** Every test injects `fetchFn`. The one live request permitted for this work was already made during planning (see D1 below); do not repeat it.
- tsconfig has `noUncheckedIndexedAccess`. Indexed reads need `?? fallback`, a `!`, or an explicit `undefined` check.
- **arXiv has IP-blocked this project before.** The process-wide `arxivGate` chain in `arxivQuery.ts` (module-level `arxivChain` and `lastArxivRequestAt`) must survive every refactor here untouched. Task 1 changes only the return value around it, never the gate itself, and `test/savedQuerySource.test.ts`'s "paces requests process wide" test is the regression guard. Do not move the gate, do not make it per-source, do not parallelise terms.
- A dry run must send nothing, text nothing, and after Task 4 must also **arm** nothing.
- Run `npm test` and `npm run typecheck` from `outreach/`.
- Commit after every task.

---

## Decisions this plan makes

### D1. The Semantic Scholar response shape, verified

Verified on 2026-07-30 with exactly one live request:

```
GET https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:2506.02373?fields=title,abstract,externalIds&limit=2
```

Actual response:

```json
{"recommendedPapers": [
  {"paperId": "68ba9dbc...", "externalIds": {"DOI": "10.1088/1748-3190/ae76a2", "CorpusId": 288933527, "PubMed": "42229505"},
   "title": "Bees in clutter: observing flight strategies...", "abstract": "Insects have long served..."},
  {"paperId": "83f2a1ed...", "externalIds": {"DOI": "10.1108/ir-10-2025-0387", "CorpusId": ...}, "...": "..."}
]}
```

The array elements **are** the paper objects. There is no `paper` wrapper and no `data` key. `recommend.ts:126` reads `rec.paper?.externalIds?.ArXiv`, which is `undefined` for every element, so `if (!arxivId) continue` fires on every recommendation and the source has returned `[]` every single day since it was written.

Two further facts from the same probe, both of which the implementation must respect:

1. `externalIds` is present but frequently has **no `ArXiv` key at all** (both probed papers had only DOI, CorpusId, PubMed). This is expected and correct: the recommend source exists partly to reach Science, Nature, Chemical Senses and bioRxiv work, and the pipeline is arXiv only, so those get dropped. **A low or zero yield with no fetch failures is therefore a legitimate quiet day and must not be reported as an error.** Only a failed request is an error.
2. `abstract` can be absent or null.

**Failure-reporting decision for `recommend`: return a typed result carrying errors, not throw.** See D2, which unifies the two.

### D2. Failure reporting: change `DiscoverySource.fetch` to return `{ candidates, errors }`

**Chosen.** `DiscoverySource.fetch(): Promise<SourceResult>` where `SourceResult = { candidates: Candidate[]; errors: string[] }`. Sources no longer throw for expected upstream failures at all; `queryArxivFeed`'s total-wipeout `throw` is replaced by an entry in `errors`. `discoverAll` prefixes each with the source name and folds it into `DiscoveryResult.errors`, which `runLoop` already pushes into `summary.errors`, which is already in the texted line.

**Why not the narrower mechanisms.** The two rejected options were an optional `drainWarnings?(): string[]` member on `DiscoverySource` (which no existing test double would have had to implement, so a smaller diff), and a per-source warning sink callback. Both were rejected for the same reason: they leave **two** failure channels, throw for total and drain for partial. That asymmetry between two ways of failing is precisely defect D4, and it is what let D1 hide for the life of the project. Adding a second asymmetry to fix the first one repeats the mistake in a new place. One mechanism, one channel, one place to look.

The `Promise.allSettled` rejection branch in `discoverAll` **stays**, demoted to a backstop for an unexpected throw (a bug in a source), and gains a comment saying so.

**Blast radius, measured, not estimated.** Grepped `.fetch()` callers and `DiscoverySource` implementers across `src/` and `test/`:

| File | Change |
|---|---|
| `src/discovery/types.ts` | Add `SourceResult`, change `DiscoverySource.fetch` return type |
| `src/discovery/sources/arxivQuery.ts` | `queryArxivFeed` returns `SourceResult`, stops throwing |
| `src/discovery/sources/savedQuery.ts` | Return type flows through; drop the D5 alias |
| `src/discovery/sources/authorWatch.ts` | Same |
| `src/discovery/sources/recommend.ts` | Rewritten fetch (D1); `resolveKeyPaperSeeds` reads `.candidates` |
| `src/discovery/index.ts` | Fold `r.value.errors` |
| `src/pipeline/loop.ts` | **No change.** It only calls `discoverAll`, whose signature is unchanged. |
| `src/cli.ts` | **No change.** It only constructs sources and passes them to `runLoop`. |
| `test/savedQuerySource.test.ts` | 8 `src.fetch()` assertion sites, 2 of them `rejects.toThrow` |
| `test/otherSources.test.ts` | 5 `src.fetch()` assertion sites, 1 of them `rejects.toThrow`, plus the 2 wrong-shape S2 tests |
| `test/discovery.test.ts` | 1 inline `src` helper |
| `test/loop.test.ts` | 1 inline `source` helper, one line |
| `test/stranding.test.ts` | 1 inline `source` helper, one line |

That is 6 source files and 5 test files. It is a real breaking interface change and it is worth it: the alternative leaves the run summary structurally unable to say "24 of 25 queries were rate limited".

**Summary-line volume.** There are now 25 configured queries. If each failed term produced its own error string, one bad arXiv day would push 25 lines into a message sent to a phone. So each source returns **exactly one** headline string summarising its failures, with the first failure quoted for diagnosis, and the per-term detail continues to go to `console.warn` where the launchd log keeps it. The headline distinguishes total from partial in its first word, so `recommend: all 12 Semantic Scholar seeds failed (...)` cannot be misread as a quiet day and `saved_query: 9 of 25 arXiv all queries failed (...)` cannot be misread as a healthy run.

### D3. What a dry run may persist

**The rule: a dry run may persist observation, never obligation.**

- **Observation** is anything that only records what the system saw or concluded: the `seen_papers` row itself, the relevance score, the terminal verdicts the pipeline genuinely reached (filtered, no email, no hook, prior thread), and the people and facts `processPaper` upserts. These are true regardless of dry-run mode and are idempotent.
- **Obligation** is anything a later real run will act on: a `seen_papers` row at `queued_for_message` (which the next real run's flush drains and texts, where a `y` sends a real irreversible email) and a `drafts` row at `awaiting_approval` (which `priorThreads` matches, permanently blocking that person from every future candidate until someone replies `dX n`, and which the abandonment sweep cannot retire because dry runs deliberately do not consume attempts).

Two concrete changes implement it, both in `loop.ts`:

1. **A dry run does not draft.** `processCandidate` stops immediately before `generateDraft`/`persistDraft`, after every terminal verdict has been evaluated, and records `discovered` with reason `dry run: sendable, draft deferred to a real run`. This removes the `awaiting_approval` obligation at the source, and it removes the draft-generation LLM spend from the rehearsal.
2. **A dry run never writes `queued_for_message`.** The `dryRun` branch in `emit` writes `discovered` instead, and it is checked **before** the per-run cap branch, because the cap branch also writes `queued_for_message` and would otherwise arm a real run whenever a dry run went over budget.

**Why `discovered` is the right resting state and why no new status or column is needed.** `discovered` already means "recorded, not yet resolved", and it already has exactly one reader: `resumeStranded`, which runs at the front of every run, is bounded by `max_resume_per_run` (10) and `max_resume_attempts` (3), and is reported in `summary.resumed` and by `outreach stranded`. So a dry run leaves the ledger in a state indistinguishable from "the loop saw this and has not processed it yet", which is exactly true. The next real run picks it up through the resume path and does the real work: real drafting, real prior-thread re-check, real messaging. Nothing is lost, and nothing is armed.

This is why the plan adds **no `dry_run` column and no new status literal.** The prompt anticipated needing a guarded `ALTER TABLE ADD COLUMN` (SQLite cannot alter a `CHECK`, and `openDb` applies `schema.sql` with `CREATE TABLE IF NOT EXISTS` so an edited `CHECK` never reaches the live file). A flag would be needed only if a dry run left a state that had to be told apart from a normal one. Under this rule it does not: it leaves no state a real run would not also have left before doing the work. Zero schema change, zero migration risk. The valid `seen_papers.status` values remain exactly the seven that exist today.

**Consequences, stated honestly:**

- A dry run that finds 50 sendable candidates parks 50 rows at `discovered`, and real runs drain them 10 per run over 5 days. That backlog is bounded, visible in `summary.resumed`, and listed by `outreach stranded`. Before this change those 50 rows would have been texted on the next real run, which is the defect.
- A dry run still calls `processPaper`, so it still spends Tavily, OpenAlex, and extraction budget, and still writes people and facts into the production database. That is deliberate: without it a dry run answers nothing beyond "did discovery return rows", and the facts it writes are true, idempotent upserts. A cheaper `--dry-run=discovery-only` mode is explicitly out of scope.
- Under dry run the per-run message cap is not simulated, so `summary.wouldMessage` is the raw count of candidates that reached the message point and may exceed `max_messages_per_run`. The summary line says `would message N`, not `messaged N`, so this cannot be misread.
- `resolveSendableDraft` is **not** changed. Its dry-run behaviour (write the status, skip the `decide`) was settled by `docs/spec-candidate-stranding.md` CS7.5 and correction C4, and its writes are observation under the rule above: a superseded draft really is superseded, an ungrounded draft really is ungrounded. Changing it is out of scope for this plan.
- `handleReply` and `retryApprovedUnsent` are owned by a different plan and are not touched here.

**Live-database state, measured read-only on 2026-07-30 against `outreach/data/outreach.db`:**

| Query | Result |
|---|---|
| `seen_papers` total | 122 |
| by status | 82 `drafted_unsendable`, 21 `filtered_low_relevance`, 13 `queued_for_message`, 5 `messaged`, 1 `discovered` |
| rows with `reason LIKE '%dry run%'` | **0** |
| `queued_for_message` reasons | 13 x `deferred by max_messages_per_run`, 0 x `dry run, not messaged` |
| `drafts` by status | 13 `awaiting_approval`, 5 `sent`, 6 `skipped` |
| `awaiting_approval` drafts with no `seen_papers` pointer | 0 |
| the one `discovered` row | `2301.09852`, `attempts` 1, no draft, reason `attempt 1 failed: Invalid URL` |

**There are no dry-run artifacts in the live database.** All 13 `queued_for_message` rows and all 13 `awaiting_approval` drafts come from real runs that hit the per-run cap, which is the intended deferral path. So **no remediation script is needed and none should be written on speculation.** Task 5 re-measures before merge, because the database changes daily, and states the remedy only if the count is non-zero.

### D4. The misleading shared-contract comment

`recommend.ts:13` claims pacing and isolation are both shared with `arxivQuery.ts`. After Task 1 and Task 2 that becomes true rather than false, because both report failure the same way. The comment is rewritten to say what is actually shared (`sleep` and the pacing intent) and what is deliberately not (`arxivGate`, which is an arXiv-endpoint gate and must not be applied to Semantic Scholar, a different host with a different rate limit).

### D5. The empty option aliases

`RecommendOptions`, `SavedQueryOptions`, and `AuthorWatchOptions` are all empty aliases of `ArxivQueryOptions`. `SavedQueryOptions` and `AuthorWatchOptions` are deleted; those factories take `ArxivQueryOptions` directly, which is what they mean. `RecommendOptions` becomes a real, distinct interface with `maxResultsPerSeed` instead of `maxResults`, because "recommendations requested per seed paper" and "arXiv results per query" are different units and the alias actively misled. Verified safe: nothing outside these three files imports any of the three names, and `cli.ts` calls `createRecommendSource(seeds)` with no options at all.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `outreach/src/discovery/types.ts` (modify) | Add `SourceResult`; change `DiscoverySource.fetch` |
| `outreach/src/discovery/sources/arxivQuery.ts` (modify) | Partial and total failure both reported (D2); gate untouched |
| `outreach/src/discovery/sources/savedQuery.ts` (modify) | Drop alias (D5) |
| `outreach/src/discovery/sources/authorWatch.ts` (modify) | Drop alias (D5) |
| `outreach/src/discovery/sources/recommend.ts` (modify) | Correct S2 shape (D1), report failures (D2), fix comment (D4), real options type (D5) |
| `outreach/src/discovery/index.ts` (modify) | Fold source-reported errors (D2) |
| `outreach/src/pipeline/loop.ts` (modify) | Dry run arms nothing (D3) |
| `outreach/test/savedQuerySource.test.ts` (modify) | New return shape, partial-failure coverage |
| `outreach/test/otherSources.test.ts` (modify) | New return shape, **corrected S2 shape** |
| `outreach/test/discovery.test.ts` (modify) | New return shape, error folding |
| `outreach/test/loop.test.ts` (modify) | Source double, dry-run arming tests |
| `outreach/test/stranding.test.ts` (modify) | Source double only |

---

### Task 1: Sources report failures instead of throwing or swallowing

**Files:**
- Modify: `outreach/src/discovery/types.ts`
- Modify: `outreach/src/discovery/sources/arxivQuery.ts`
- Modify: `outreach/src/discovery/sources/savedQuery.ts`
- Modify: `outreach/src/discovery/sources/authorWatch.ts`
- Test: `outreach/test/savedQuerySource.test.ts`

**Interfaces:**
- Produces: `SourceResult { candidates: Candidate[]; errors: string[] }`
- Changes: `DiscoverySource.fetch(): Promise<SourceResult>`; `queryArxivFeed(...): Promise<SourceResult>` and it no longer throws
- Removes: `SavedQueryOptions`, `AuthorWatchOptions`

- [ ] **Step 1: Rewrite the failing tests**

In `outreach/test/savedQuerySource.test.ts`, replace the whole `describe('savedQuery source')` block and the whole `describe('savedQuery total failure reporting')` block with the following. Leave `describe('parseSearchFeed')` and the `FEED`/`EMPTY` constants exactly as they are.

Two of these are rewrites of tests that asserted the old throwing contract (`rejects.toThrow('all 3 arXiv all queries failed')`). That is a **change of contract, not a weakening**: the same condition is still detected, still carries the same message text, and still reaches `summary.errors` through `discoverAll`. What changes is that it now arrives alongside any candidates the surviving queries did return, instead of discarding them, and that the partial case is detected at all. The new `it('reports a partial failure...')` test is the one that fails against today's code no matter how it is written, because today there is no channel for it to assert on.

```typescript
describe('savedQuery source', () => {
  it('parses entries into candidates tagged with the originating query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(FEED, { status: 200 }));
    const src = createSavedQuerySource(['olfactory embedding'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('saved_query');
    expect(got.errors).toEqual([]);
    expect(got.candidates).toHaveLength(2);
    expect(got.candidates[0]).toMatchObject({
      arxivId: '2601.00001',
      title: 'Olfactory Embeddings for Sensor Arrays',
      discoveredVia: 'saved_query',
      sourceDetail: 'query: olfactory embedding',
    });
    expect(got.candidates[0]!.abstract).toContain('odor space');
  });

  it('handles an empty feed without throwing and reports no error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(EMPTY, { status: 200 }));
    const src = createSavedQuerySource(['nothing'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual({ candidates: [], errors: [] });
  });

  it('skips a query that errors and still returns results from the others', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(FEED, { status: 200 }));
    const src = createSavedQuerySource(['bad', 'good'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toHaveLength(2);
    for (const candidate of got.candidates) {
      expect(candidate.sourceDetail).toBe('query: good');
    }
  });

  it('makes no requests when there are no queries', async () => {
    const fetchFn = vi.fn();
    const src = createSavedQuerySource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual({ candidates: [], errors: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('paces requests process wide, so two sources run concurrently do not burst', async () => {
    const delayMs = 40;
    const callTimes: number[] = [];
    const fetchFn = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      return new Response(EMPTY, { status: 200 });
    });

    const sourceA = createSavedQuerySource(['term a1', 'term a2'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs,
    });
    const sourceB = createSavedQuerySource(['term b1', 'term b2'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs,
    });

    await Promise.all([sourceA.fetch(), sourceB.fetch()]);

    expect(callTimes).toHaveLength(4);
    for (let i = 1; i < callTimes.length; i++) {
      const gap = callTimes[i]! - callTimes[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(delayMs - 10);
    }
  });
});
```

```typescript
// D2. Partial failure is now the LIKELY failure mode, not the exotic one:
// there are 25 configured queries, so "9 of them were rate limited" is a
// normal bad day and it used to reach console.warn and nowhere else. The run
// then reported success with a near-empty candidate list.
describe('savedQuery failure reporting', () => {
  const FEED_OK = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>http://arxiv.org/abs/2601.00009v1</id><title>Fine</title><summary>ok</summary></entry>
</feed>`;

  it('reports a total wipeout as an error rather than an empty quiet day', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createSavedQuerySource(['a', 'b', 'c'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('all 3 arXiv all queries failed');
    expect(got.errors[0]).toContain('HTTP 429');
  });

  it('reports a partial failure and still returns what succeeded', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(FEED_OK, { status: 200 }));
    const src = createSavedQuerySource(['bad1', 'bad2', 'good'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got.candidates).toHaveLength(1);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('2 of 3 arXiv all queries failed');
  });

  it('reports a network throw the same way as a bad status', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const src = createSavedQuerySource(['a'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('ECONNRESET');
  });

  it('collapses many failures into one summary line, so the texted summary stays readable', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const terms = Array.from({ length: 25 }, (_, i) => `term ${i}`);
    const src = createSavedQuerySource(terms, { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('all 25 arXiv all queries failed');
  });

  it('an empty query list is not a failure', async () => {
    const fetchFn = vi.fn();
    const src = createSavedQuerySource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual({ candidates: [], errors: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd outreach && npx vitest run test/savedQuerySource.test.ts`
Expected: FAIL. The shape tests fail because `fetch()` resolves to an array, not `{ candidates, errors }`; the wipeout test fails because `fetch()` rejects instead of resolving; the partial-failure test fails because nothing reports partial failure.

- [ ] **Step 3: Add `SourceResult` to the discovery types**

In `outreach/src/discovery/types.ts`, replace the `DiscoverySource` block at the bottom of the file:

```typescript
// What one source returns for one run. `errors` is how a source says
// "something upstream refused me", so a run that returned few or no candidates
// because arXiv or Semantic Scholar was refusing can never be mistaken for a
// quiet day in the summary the approver is texted. Sources report expected
// upstream failures here and do not throw; discoverAll still isolates a throw,
// but only as a backstop for a bug.
export interface SourceResult {
  candidates: Candidate[];
  errors: string[];
}

// One discovery source.
export interface DiscoverySource {
  readonly name: DiscoveredVia;
  fetch(): Promise<SourceResult>;
}
```

- [ ] **Step 4: Rewrite `queryArxivFeed`'s failure reporting**

In `outreach/src/discovery/sources/arxivQuery.ts`, change the import line and the `queryArxivFeed` function. **Do not touch `arxivGate`, `arxivChain`, `lastArxivRequestAt`, `sleep`, or `parseSearchFeed`.**

Import line becomes:

```typescript
import type { Candidate, DiscoveredVia, SourceResult } from '../types.js';
```

Replace the whole `queryArxivFeed` function with:

```typescript
export async function queryArxivFeed(
  prefix: 'all' | 'au' | 'ti',
  terms: string[],
  via: DiscoveredVia,
  label: (term: string) => string,
  opts: ArxivQueryOptions = {},
): Promise<SourceResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxResults = opts.maxResults ?? 20;
  const delayMs = opts.delayMs ?? 3000;

  const candidates: Candidate[] = [];
  const failures: string[] = [];

  for (const term of terms) {
    await arxivGate(delayMs);
    try {
      const url =
        `http://export.arxiv.org/api/query?search_query=${prefix}:${encodeURIComponent(`"${term}"`)}` +
        `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
      const res = await fetchFn(url);
      if (!res.ok) {
        // One bad term must not sink the rest, but it must not vanish either.
        failures.push(`${term}: HTTP ${res.status}`);
        console.warn(`arXiv query failed for ${JSON.stringify(term)}: HTTP ${res.status}`);
        continue;
      }
      for (const e of parseSearchFeed(await res.text())) {
        candidates.push({
          arxivId: e.arxivId,
          title: e.title,
          abstract: e.abstract,
          discoveredVia: via,
          sourceDetail: label(term),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${term}: ${msg}`);
      console.warn(`arXiv query failed for ${JSON.stringify(term)}: ${msg}`);
    }
  }

  if (failures.length === 0) return { candidates, errors: [] };

  // Both a total wipeout and a partial one have to reach the run summary. A
  // wipeout is indistinguishable from a quiet day if we stay silent, and
  // "seen 0" reads as "no new papers" when arXiv is actually refusing us. A
  // partial failure is the same silent degradation one notch down, and with 25
  // configured queries it is the LIKELY shape, not the exotic one: 9 of 10
  // terms returning 429 used to report success with a near-empty list.
  //
  // One line, not one per term, because this string is texted to a phone
  // through discoverAll and summary.errors. The per-term detail is already in
  // the console.warn calls above, which launchd keeps in the run log.
  const total = failures.length === terms.length;
  const headline = total
    ? `all ${terms.length} arXiv ${prefix} queries failed (${failures[0] ?? 'unknown'})`
    : `${failures.length} of ${terms.length} arXiv ${prefix} queries failed (${failures[0] ?? 'unknown'})`;
  return { candidates, errors: [headline] };
}
```

Note: the `terms.length > 0` guard the old total-wipeout check needed is gone because it is now unreachable. With zero terms the loop never runs, `failures` is empty, and the function returned at the `failures.length === 0` line above.

- [ ] **Step 5: Drop the empty aliases (D5)**

In `outreach/src/discovery/sources/savedQuery.ts`, delete the `SavedQueryOptions` line and use `ArxivQueryOptions` directly:

```typescript
// Saved-query source: runs each derived or configured query against arXiv.
import type { DiscoverySource } from '../types.js';
import { queryArxivFeed, type ArxivQueryOptions } from './arxivQuery.js';

export function createSavedQuerySource(queries: string[], opts: ArxivQueryOptions = {}): DiscoverySource {
  return {
    name: 'saved_query',
    fetch: () => queryArxivFeed('all', queries, 'saved_query', (q) => `query: ${q}`, opts),
  };
}
```

In `outreach/src/discovery/sources/authorWatch.ts`, delete the `AuthorWatchOptions` line and change the signature. Leave `deriveWatchAuthors` and its comment untouched:

```typescript
export function createAuthorWatchSource(authors: string[], opts: ArxivQueryOptions = {}): DiscoverySource {
  return {
    name: 'author_watch',
    fetch: () => queryArxivFeed('au', authors, 'author_watch', (a) => `author: ${a}`, { maxResults: 10, ...opts }),
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd outreach && npx vitest run test/savedQuerySource.test.ts`
Expected: 12 passed. `npm run typecheck` will still fail at this point, because `recommend.ts`, `index.ts`, and the other test files have not been updated yet. That is expected and is resolved by Tasks 2 and 3; do not chase it here.

- [ ] **Step 7: Commit**

```bash
git add outreach/src/discovery/types.ts outreach/src/discovery/sources/arxivQuery.ts \
        outreach/src/discovery/sources/savedQuery.ts outreach/src/discovery/sources/authorWatch.ts \
        outreach/test/savedQuerySource.test.ts
git commit -m "Report partial arXiv query failures, not just total wipeouts

Sources now return {candidates, errors} instead of signalling failure by
throwing. With 25 configured queries a partial failure is the likely mode,
and it previously reached console.warn and nothing else, so the run reported
success with a near-empty candidate list. Both cases now reach the run
summary that gets texted, as one line per source so the message stays
readable. The process-wide arxivGate pacing is unchanged."
```

---

### Task 2: Fix the Semantic Scholar response shape and its failure reporting

**Files:**
- Modify: `outreach/src/discovery/sources/recommend.ts`
- Test: `outreach/test/otherSources.test.ts`

**Interfaces:**
- Changes: `RecommendOptions` becomes a real interface with `maxResultsPerSeed`
- Changes: `createRecommendSource(...).fetch()` returns `SourceResult`
- Changes: `resolveKeyPaperSeeds` reads `.candidates` from `queryArxivFeed`

**Context:** this is the critical defect. The source has returned zero every day since it was written, and `discoverAll` recorded no error because the promise resolved. See D1 above for the verified response shape and for why a low arXiv yield is legitimate.

- [ ] **Step 1: Rewrite the failing tests**

In `outreach/test/otherSources.test.ts`:

**(a)** In `describe('authorWatch source')`, update the three tests to the new return shape. The third is a contract change, not a weakening, for the reason given in Task 1 Step 1:

```typescript
describe('authorWatch source', () => {
  it('tags candidates with the author that surfaced them', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(FEED, { status: 200 }));
    const src = createAuthorWatchSource(['Akshay Sajan'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('author_watch');
    expect(got.errors).toEqual([]);
    expect(got.candidates[0]).toMatchObject({
      arxivId: '2601.00003',
      discoveredVia: 'author_watch',
      sourceDetail: 'author: Akshay Sajan',
    });
  });

  it('skips an author whose request fails but still returns the others, and reports it', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(FEED, { status: 200 }));
    const src = createAuthorWatchSource(['Broken', 'Working'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]?.sourceDetail).toBe('author: Working');
    expect(got.errors[0]).toContain('1 of 2 arXiv au queries failed');
  });

  // A silent wipeout reads as "no new papers" when arXiv is actually refusing
  // us, so total failure has to surface rather than return an empty list.
  it('reports an error when every author request fails, so the run reports it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createAuthorWatchSource(['A', 'B'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
    expect(got.errors[0]).toContain('all 2 arXiv au queries failed');
  });
});
```

**(b)** Replace the entire `describe('recommend source')` block at the bottom of the file with the following.

**These two existing tests are deleted, and deleting them is the fix, not a weakening.** Both fed the source `{ data: [{ paper: {...} }] }`. That shape does not exist: the endpoint returns `{ recommendedPapers: [ {...} ] }` with the paper objects as the array elements, verified live on 2026-07-30 (D1). The tests passed because the implementation read the same wrong key the fixture wrote, so the two agreed with each other and disagreed with reality. A test that pins a fixture to a shape the server never sends is not coverage; it is what allowed a source to return zero for the life of the project without a single failing test. The replacements use the verified shape, and the `rejects the legacy wrapped shape` test below exists so the old bug cannot silently return.

```typescript
describe('recommend source', () => {
  // The verified Semantic Scholar shape (checked live against
  // GET /recommendations/v1/papers/forpaper/arXiv:2506.02373 on 2026-07-30):
  // {"recommendedPapers": [ {paperId, title, abstract, externalIds} ]}.
  // The paper objects are the array elements themselves. There is no `paper`
  // wrapper and no `data` key.
  const s2 = (recommendedPapers: unknown[]) =>
    new Response(JSON.stringify({ recommendedPapers }), { status: 200 });

  it('expands a seed into related candidates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      s2([
        {
          paperId: 'abc123',
          externalIds: { ArXiv: '2601.00004', DOI: '10.1000/x' },
          title: 'Related',
          abstract: 'Related abstract.',
        },
      ]),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('recommend');
    expect(got.errors).toEqual([]);
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]).toMatchObject({
      arxivId: '2601.00004',
      title: 'Related',
      abstract: 'Related abstract.',
      discoveredVia: 'recommend',
      sourceDetail: 'seed: 2508.09217',
    });
  });

  it('strips a version suffix from the arXiv id so it matches the seen_papers key', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(s2([{ externalIds: { ArXiv: '2601.00004v3' }, title: 'Versioned' }]));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates[0]?.arxivId).toBe('2601.00004');
  });

  // Verified live: many Semantic Scholar recommendations carry only DOI,
  // CorpusId, and PubMed. The pipeline is arXiv only, so those are dropped.
  // This is a legitimate quiet result, NOT a failure, and must report no error.
  it('drops a recommendation with no arXiv id and reports no error for it', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      s2([
        { externalIds: { DOI: '10.1000/x', CorpusId: 1 }, title: 'Journal only' },
        { externalIds: { ArXiv: '2601.00005' }, title: 'On arXiv' },
      ]),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates.map((c) => c.arxivId)).toEqual(['2601.00005']);
    expect(got.errors).toEqual([]);
  });

  it('tolerates a missing abstract and a missing externalIds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(s2([{ externalIds: { ArXiv: '2601.00006' }, title: 'No abstract' }, { title: 'Nothing' }]));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0]?.abstract).toBeUndefined();
    expect(got.errors).toEqual([]);
  });

  // Regression guard for the defect this task fixes. The old code read
  // rec.paper.externalIds.ArXiv, so it would have accepted this and rejected
  // the real shape above. Both assertions must hold together.
  it('rejects the legacy wrapped shape, which the endpoint never sends', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(s2([{ paper: { externalIds: { ArXiv: '2601.00007' }, title: 'Wrapped' } }]));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
  });

  it('reports a rate-limited seed instead of silently returning nothing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(got.candidates).toEqual([]);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('all 1 Semantic Scholar seeds failed');
    expect(got.errors[0]).toContain('HTTP 429');
  });

  it('reports a partial seed failure and still returns what succeeded', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(s2([{ externalIds: { ArXiv: '2601.00008' }, title: 'Survived' }]));
    const src = createRecommendSource(['seed1', 'seed2'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
    });
    const got = await src.fetch();
    expect(got.candidates.map((c) => c.arxivId)).toEqual(['2601.00008']);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('1 of 2 Semantic Scholar seeds failed');
  });

  it('reports a network throw and unparseable JSON rather than swallowing them', async () => {
    const thrown = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const a = createRecommendSource(['s'], { fetchFn: thrown as unknown as typeof fetch, delayMs: 0 });
    expect((await a.fetch()).errors[0]).toContain('ECONNRESET');

    const badJson = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const b = createRecommendSource(['s'], { fetchFn: badJson as unknown as typeof fetch, delayMs: 0 });
    expect((await b.fetch()).errors).toHaveLength(1);
  });

  it('makes no requests and reports no error when there are no seeds', async () => {
    const fetchFn = vi.fn();
    const src = createRecommendSource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual({ candidates: [], errors: [] });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('requests recommendations per seed via maxResultsPerSeed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(s2([]));
    const src = createRecommendSource(['2508.09217'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      delayMs: 0,
      maxResultsPerSeed: 4,
    });
    await src.fetch();
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('limit=4');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd outreach && npx vitest run test/otherSources.test.ts`
Expected: FAIL. The recommend tests fail because `fetch()` resolves to an array and reads the wrong key; `maxResultsPerSeed` is not a known option; the authorWatch wipeout test fails because `fetch()` rejects.

- [ ] **Step 3: Rewrite the header, options type, and paper interface**

In `outreach/src/discovery/sources/recommend.ts`, replace lines 9 through 18 (the imports, the shared-contract comment, the options alias, and the `S2Recommendation` interface) with:

```typescript
import type { DB } from '../../db/db.js';
import type { Candidate, DiscoverySource, SourceResult } from '../types.js';
import { queryArxivFeed, sleep, type ArxivQueryOptions } from './arxivQuery.js';

// D4. What is actually shared with arxivQuery.ts, and what deliberately is
// not. Shared: `sleep`, and the same one-request-per-few-seconds courtesy, and
// (since this file was corrected) the same failure contract, a SourceResult
// carrying errors rather than a swallowed catch. NOT shared: `arxivGate`, the
// process-wide chain that serialises requests to export.arxiv.org. Semantic
// Scholar is a different host with a different rate limit, and routing it
// through the arXiv gate would make the two sources contend for one another's
// pacing budget for no reason.
export interface RecommendOptions {
  fetchFn?: typeof fetch;
  // D5. Recommendations requested per seed paper. This is NOT the same unit as
  // ArxivQueryOptions.maxResults ("arXiv results per query"), which is why this
  // type is no longer an empty alias of it: the alias read as though the two
  // meant the same thing.
  maxResultsPerSeed?: number;
  delayMs?: number;
}

// D1. The verified shape of one element of `recommendedPapers`, checked live
// against GET /recommendations/v1/papers/forpaper/arXiv:2506.02373 on
// 2026-07-30. The endpoint returns
//   {"recommendedPapers": [ {paperId, title, abstract, externalIds} ]}
// so the paper objects ARE the array elements. There is no `paper` wrapper and
// no `data` key. The previous code read `rec.paper?.externalIds?.ArXiv`, which
// was undefined for every element, so `if (!arxivId) continue` fired every
// time and this source returned zero every day since it was written. Because
// it returned [] rather than failing, discoverAll recorded no error and the
// dead source was indistinguishable from a quiet day.
interface S2Paper {
  externalIds?: { ArXiv?: string } | null;
  title?: string;
  abstract?: string | null;
}
```

- [ ] **Step 4: Adapt `resolveKeyPaperSeeds` to the new `queryArxivFeed` return**

In the same file, inside `resolveKeyPaperSeeds`, replace the `let candidates: Candidate[];` declaration and the `try`/`catch` block that follows it with:

```typescript
    let found: Candidate[];
    try {
      const res = await queryArxivFeed('ti', [value], 'recommend', () => 'key_paper title lookup', {
        ...opts,
        maxResults: opts.maxResults ?? 5,
      });
      // queryArxivFeed no longer throws for an upstream failure, so its errors
      // arrive here as data. Seed resolution is best effort and a failure to
      // resolve one key_paper title must not fail the run, so these are warned
      // and the fact is skipped, exactly as the old catch did.
      for (const err of res.errors) {
        console.warn(`key_paper title lookup failed for ${JSON.stringify(value)}: ${err}`);
      }
      found = res.candidates;
    } catch (e) {
      // Defensive only: nothing in queryArxivFeed throws for an expected
      // upstream failure any more. A throw here is a bug, not a 429.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`key_paper title lookup failed for ${JSON.stringify(value)}: ${msg}`);
      continue;
    }

    const match = found.find((c) => normalizeTitle(c.title) === target);
```

and delete the now-duplicated `const match = candidates.find(...)` line that followed the old `catch`.

- [ ] **Step 5: Rewrite `createRecommendSource`**

Replace the whole `createRecommendSource` function with:

```typescript
export function createRecommendSource(seeds: string[], opts: RecommendOptions = {}): DiscoverySource {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxResultsPerSeed = opts.maxResultsPerSeed ?? 10;
  const delayMs = opts.delayMs ?? 3000;

  return {
    name: 'recommend',
    async fetch(): Promise<SourceResult> {
      const candidates: Candidate[] = [];
      const failures: string[] = [];

      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        if (s === undefined) continue;
        if (i > 0) await sleep(delayMs);
        try {
          const url =
            `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:${encodeURIComponent(s)}` +
            `?fields=title,abstract,externalIds&limit=${maxResultsPerSeed}`;
          const res = await fetchFn(url);
          if (!res.ok) {
            // Semantic Scholar rate limits aggressively without an API key, so
            // a 429 here is the expected failure mode, not an exotic one. It
            // used to hit a bare `continue` and vanish.
            failures.push(`${s}: HTTP ${res.status}`);
            console.warn(`Semantic Scholar recommendations failed for seed ${s}: HTTP ${res.status}`);
            continue;
          }
          const body = (await res.json()) as { recommendedPapers?: S2Paper[] | null };
          for (const rec of body.recommendedPapers ?? []) {
            const arxivId = rec.externalIds?.ArXiv;
            // The pipeline is arXiv only. Verified live: many recommendations
            // carry only a DOI, and dropping those is correct and is NOT a
            // failure, so nothing is pushed to `failures` here.
            if (!arxivId) continue;
            candidates.push({
              // seen_papers keys on an unversioned id, and parseSearchFeed
              // strips the suffix too, so the two paths agree on the key.
              arxivId: arxivId.replace(/v\d+$/, ''),
              title: rec.title ?? '',
              abstract: rec.abstract ?? undefined,
              discoveredVia: 'recommend',
              sourceDetail: `seed: ${s}`,
            });
          }
        } catch (e) {
          // Covers a network throw and a res.json() parse failure. Both used
          // to hit a bare `catch { continue; }`.
          const msg = e instanceof Error ? e.message : String(e);
          failures.push(`${s}: ${msg}`);
          console.warn(`Semantic Scholar recommendations failed for seed ${s}: ${msg}`);
        }
      }

      if (failures.length === 0) return { candidates, errors: [] };

      // Same contract as queryArxivFeed (D4): one headline per source, total
      // distinguished from partial in the first word, first failure quoted.
      const total = failures.length === seeds.length;
      const headline = total
        ? `all ${seeds.length} Semantic Scholar seeds failed (${failures[0] ?? 'unknown'})`
        : `${failures.length} of ${seeds.length} Semantic Scholar seeds failed (${failures[0] ?? 'unknown'})`;
      return { candidates, errors: [headline] };
    },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd outreach && npx vitest run test/otherSources.test.ts`
Expected: 22 passed (5 `deriveWatchAuthors`, 3 `authorWatch source`, 4 `deriveSeedPapers`, 1 `extractArxivId`, 3 `resolveKeyPaperSeeds`, 10 `recommend source`). `npm run typecheck` still fails on `index.ts` and the remaining test doubles; Task 3 closes it.

- [ ] **Step 7: Commit**

```bash
git add outreach/src/discovery/sources/recommend.ts outreach/test/otherSources.test.ts
git commit -m "Fix the Semantic Scholar shape that made recommend return zero

The endpoint returns {recommendedPapers: [{paperId, title, abstract,
externalIds}]}, verified live. The code read rec.paper.externalIds.ArXiv,
which was undefined for every recommendation, so every one hit the
no-arxiv-id continue and this source has yielded nothing since it was
written. A bare 'if (!res.ok) continue' and a bare catch hid the 429s and
network errors on top of that, and returning [] made a dead source look like
a quiet day.

The two existing tests encoded the wrong shape ({data: [{paper: ...}]}), so
they agreed with the bug rather than with the server. They are replaced with
the verified shape plus a regression guard that rejects the wrapped form.
Fetch failures now reach the run summary; a recommendation with no arXiv id
is still dropped silently, because that is a real and common quiet result."
```

---

### Task 3: `discoverAll` folds source-reported errors

**Files:**
- Modify: `outreach/src/discovery/index.ts`
- Test: `outreach/test/discovery.test.ts`
- Test: `outreach/test/loop.test.ts` (source double only)
- Test: `outreach/test/stranding.test.ts` (source double only)

**Interfaces:**
- `discoverAll(sources): Promise<DiscoveryResult>` is unchanged in signature. Its `errors` array now also carries errors from sources that resolved.

- [ ] **Step 1: Rewrite the failing tests**

Replace the `src` helper and add two tests in `outreach/test/discovery.test.ts`. Keep the `cand` helper as it is.

```typescript
const src = (name: Candidate['discoveredVia'], result: Candidate[] | Error, errors: string[] = []): DiscoverySource => ({
  name,
  fetch: async () => {
    if (result instanceof Error) throw result;
    return { candidates: result, errors };
  },
});
```

Then, in the four existing tests, the assertions on `got.candidates` and `got.errors` already read correctly and need no change. Add:

```typescript
  it('folds errors from a source that resolved, so a partial failure is not silent', async () => {
    const got = await discoverAll([
      src('saved_query', [cand('2601.00001', 'saved_query')], ['9 of 25 arXiv all queries failed (a: HTTP 429)']),
      src('recommend', [cand('2601.00002', 'recommend')]),
    ]);
    expect(got.candidates).toHaveLength(2);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toBe('saved_query: 9 of 25 arXiv all queries failed (a: HTTP 429)');
  });

  it('distinguishes a broken source from a quiet day', async () => {
    const broken = await discoverAll([src('recommend', [], ['all 12 Semantic Scholar seeds failed (x: HTTP 429)'])]);
    const quiet = await discoverAll([src('recommend', [])]);
    expect(broken.candidates).toEqual([]);
    expect(quiet.candidates).toEqual([]);
    // Same candidate count, and the ONLY thing that tells them apart is the
    // error list. This is the assertion the whole plan exists for.
    expect(broken.errors).toHaveLength(1);
    expect(quiet.errors).toEqual([]);
  });
```

In `outreach/test/loop.test.ts` line 20 and `outreach/test/stranding.test.ts` line 34, change the shared source double (identical line in both files):

```typescript
const source = (cs: Candidate[]): DiscoverySource => ({
  name: 'saved_query',
  fetch: async () => ({ candidates: cs, errors: [] }),
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd outreach && npx vitest run test/discovery.test.ts`
Expected: FAIL on the two new tests, because `discoverAll` ignores `r.value.errors`.

- [ ] **Step 3: Fold the errors**

In `outreach/src/discovery/index.ts`, replace the body of the `settled.forEach` callback:

```typescript
  settled.forEach((r, i) => {
    const source = sources[i];
    const name = source ? source.name : 'unknown';
    if (r.status === 'rejected') {
      // Backstop only. Sources report expected upstream failures by returning
      // errors (see SourceResult), so a rejection here means a source threw
      // unexpectedly, which is a bug rather than a 429. It must still surface.
      errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    // A source that RESOLVED can still have failed, wholly or partly. Before
    // this, discoverAll recorded an error only for a rejected promise, so a
    // source that swallowed every failure and returned [] was indistinguishable
    // from a quiet day, and one that partly failed had no channel at all.
    for (const e of r.value.errors) errors.push(`${name}: ${e}`);
    for (const c of r.value.candidates) {
      if (seen.has(c.arxivId)) continue;
      seen.add(c.arxivId);
      candidates.push(c);
    }
  });
```

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `cd outreach && npm test && npm run typecheck`
Expected: all tests pass, typecheck clean. This is the first point in the plan where the tree is consistent. The count should be the previous 331 minus the 2 deleted wrong-shape S2 tests plus the tests added in Tasks 1 through 3, which is 348. If typecheck reports an error in a file this plan does not list, stop and investigate rather than widening the change.

- [ ] **Step 5: Commit**

```bash
git add outreach/src/discovery/index.ts outreach/test/discovery.test.ts \
        outreach/test/loop.test.ts outreach/test/stranding.test.ts
git commit -m "Fold source-reported errors into the discovery run summary

discoverAll recorded an error only for a rejected promise, so a source that
resolved after swallowing every failure looked exactly like a quiet day. It
now folds each resolved source's errors too, prefixed with the source name,
which is what reaches summary.errors and the texted run summary."
```

---

### Task 4: A dry run arms nothing

**Files:**
- Modify: `outreach/src/pipeline/loop.ts`
- Test: `outreach/test/loop.test.ts`

**Interfaces:**
- `LoopSummary` gains `wouldMessage: number`

**Scope:** only the `--dry-run` side effects described in D3, that is `LoopSummary`, `emit`, `processCandidate`, and the summary line. `handleReply` and `retryApprovedUnsent` belong to a different plan and are not touched. `resolveSendableDraft` is deliberately unchanged (see D3).

**Read first:** `docs/spec-candidate-stranding.md`, sections CS1 (the `discovered` resting state and `resumeStranded` as its one reader), CS7.5 and correction C4 (the dry-run rules that exist today), and CS9 (the status table). This task narrows CS7.5; it does not contradict it. CS7.5 says a dry run "selects, drafts, and parks" at `queued_for_message`. After this task it selects and parks at `discovered`, and does not draft. The invariants CS7.5 protects (no `sendDraftMessage`, no `sender.send`, no `decide`, no attempt increment, no exhaustion sweep) are all preserved and one is added: no state a later real run will flush.

- [ ] **Step 1: Write the failing tests**

Add to `outreach/test/loop.test.ts`, after the existing `it('dry run messages nothing and sends nothing', ...)`:

```typescript
  // D3. The guards that already existed stopped a dry run SENDING during the
  // run. They did not stop it arming the next one: emit wrote
  // queued_for_message, the next real run's flush drained that row and texted
  // the draft, and a "y" there sends a real irreversible email.
  it('dry run leaves no row a later real run would flush and text', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00030', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00030', pid)),
    });
    const summary = await runLoop(deps, { dryRun: true });

    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00030') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('discovered');
    expect(row.reason).toContain('dry run');
    expect(summary.queued).toBe(0);
    expect(summary.wouldMessage).toBe(1);

    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM seen_papers WHERE status = 'queued_for_message'")
      .get() as { n: number };
    expect(queued.n).toBe(0);
  });

  // D3. A dry-run draft is a real drafts row at awaiting_approval, which
  // priorThreads matches, so it permanently blocks that person from every
  // future candidate until a human replies "dX n". The abandonment sweep
  // cannot clear it either, because a dry run does not consume attempts.
  it('dry run creates no draft, so it cannot block a person forever', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00031', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00031', pid)),
    });
    await runLoop(deps, { dryRun: true });

    expect(deps.generateDraft).not.toHaveBeenCalled();
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(0);
    expect(priorThreads(db, pid)).toEqual([]);
  });

  // The work is deferred, not lost. 'discovered' is a resting state with
  // exactly one reader, the resume step (docs/spec-candidate-stranding.md CS1),
  // so the next real run drafts and messages it for real.
  it('a real run after a dry run picks the candidate up and messages it', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const paper = cand('2601.00032', 'Olfactory Embedding Space Sensors');
    const processPaper = vi.fn().mockResolvedValue(resolvedResult('2601.00032', pid));

    const dry = baseDeps(db, { sources: [source([paper])], processPaper });
    await runLoop(dry.deps, { dryRun: true });
    expect(dry.channel.sent).toHaveLength(0);

    // The real run's source returns nothing: the candidate must come back
    // through the resume path, not through rediscovery.
    const real = baseDeps(db, { sources: [source([])], processPaper });
    const summary = await runLoop(real.deps, { dryRun: false });

    expect(summary.resumed).toBe(1);
    expect(real.channel.sent).toHaveLength(1);
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00032') as {
      status: string;
    };
    expect(row.status).toBe('messaged');
  });

  // The cap branch in emit also writes queued_for_message, so the dry-run
  // check has to come BEFORE it or a dry run that goes over budget arms a real
  // run by the other door.
  it('dry run over the message cap still queues nothing', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00033',
      paperTitle: 'Capped',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.00033', 'Capped'));
    db.prepare('UPDATE seen_papers SET draft_id = ? WHERE arxiv_id = ?').run(p.draftId, '2601.00033');

    const { deps, channel } = baseDeps(db, {
      sources: [source([])],
      config: {
        queries: ['olfactory embedding space'],
        authors: [],
        seeds: [],
        gate: { ...GATE, maxMessagesPerRun: 0 },
      },
    });
    const summary = await runLoop(deps, { dryRun: true });

    expect(channel.sent).toHaveLength(0);
    expect(summary.queued).toBe(0);
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00033') as {
      status: string;
    };
    expect(row.status).toBe('discovered');
  });
```

These need three imports added at the top of `outreach/test/loop.test.ts`:

```typescript
import { persistDraft, priorThreads } from '../src/approval/ledger.js';
import { recordDiscovered } from '../src/discovery/seenLedger.js';
```

(`persistDraft` is already imported; add `priorThreads` to that import and add the `seenLedger` line.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd outreach && npx vitest run test/loop.test.ts`
Expected: FAIL. The row is at `queued_for_message` not `discovered`; `summary.wouldMessage` does not exist; a draft row was created; `priorThreads` is non-empty.

- [ ] **Step 3: Add the counter to `LoopSummary`**

In `outreach/src/pipeline/loop.ts`, add to the `LoopSummary` interface after `queued`:

```typescript
  // D3. Candidates a dry run would have texted. Deliberately not `messaged`
  // and deliberately not `queued`: nothing was messaged, and nothing was
  // queued, because a dry run must not arm a later run. Always 0 in a real run.
  wouldMessage: number;
```

and to the initialiser in `runLoop`, after `queued: 0,`:

```typescript
    wouldMessage: 0,
```

- [ ] **Step 4: Make `emit` park instead of queue under a dry run**

In `emit`, move the `dryRun` branch **above** the cap branch and change what it writes:

```typescript
async function emit(
  deps: LoopDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  c: Candidate,
  shortId: string,
  subject: string,
  body: string,
  to: string,
  personName: string,
): Promise<void> {
  // D3. Checked BEFORE the cap, because the cap branch below also writes
  // 'queued_for_message', which is the flush queue: the next real run drains
  // it, texts the draft, and a "y" there sends a real irreversible email. A
  // dry run that arms a later run is not a dry run, over budget or under it.
  //
  // 'discovered' is the correct resting place instead. It means "recorded, not
  // yet resolved", which is exactly true, and it has one reader, the resume
  // step (docs/spec-candidate-stranding.md CS1), which is bounded by
  // max_resume_per_run and max_resume_attempts and is reported in
  // summary.resumed and by `outreach stranded`. So the work is deferred to a
  // real run rather than lost, and it is deferred visibly.
  if (opts.dryRun) {
    setStatus(deps.db, c.arxivId, 'discovered', 'dry run: would message, nothing sent or queued');
    summary.wouldMessage++;
    return;
  }
  if (summary.messaged >= deps.config.gate.maxMessagesPerRun) {
    setStatus(deps.db, c.arxivId, 'queued_for_message', 'deferred by max_messages_per_run');
    summary.queued++;
    return;
  }
  try {
    await deps.channel.sendDraftMessage({ shortId, subject, body, to, personName });
    setStatus(deps.db, c.arxivId, 'messaged');
    summary.messaged++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(deps.db, c.arxivId, 'queued_for_message', `message failed, queued for retry: ${msg}`);
    summary.queued++;
    summary.errors.push(`${c.arxivId}: ${msg}`);
  }
}
```

- [ ] **Step 5: Stop a dry run from drafting**

In `processCandidate`, insert this block immediately after the `priorThreads` check and immediately **before** `const input = deps.buildDraftInput(result);`:

```typescript
    // D3. A dry run may persist observation, never obligation.
    //
    // Everything above this line is observation: the gate verdict, the people
    // and facts processPaper upserted (idempotent, and true regardless of
    // dry-run mode), and the terminal verdicts the pipeline genuinely reached.
    // A draft is an obligation. persistDraft writes a real drafts row at
    // awaiting_approval, priorThreads matches that status, and the row then
    // blocks this person from EVERY future candidate until a human replies
    // "dX n". The abandonment sweep cannot clear it either: it only retires
    // drafts owned by a row that exhausted its attempts, and a dry run
    // deliberately does not consume attempts (CS7.5, correction C4), so a
    // rehearsal artifact sits there indefinitely.
    //
    // So the rehearsal stops here, having answered the question it is actually
    // asked ("how many candidates would become drafts, and why not the rest"),
    // and leaves the row resting at 'discovered' for a real run to draft. That
    // also keeps the draft-generation LLM spend out of a rehearsal.
    if (opts.dryRun) {
      setStatus(deps.db, c.arxivId, 'discovered', 'dry run: sendable, draft deferred to a real run');
      summary.wouldMessage++;
      return;
    }

    const input = deps.buildDraftInput(result);
```

- [ ] **Step 6: Report it in the summary line**

In the `finally` block of `runLoop`, add the `wouldMessage` term after `queued`:

```typescript
    const line =
      `outreach loop${opts.dryRun ? ' (dry run)' : ''}: seen ${summary.seen}, filtered ${summary.filtered}, ` +
      `unsendable ${summary.unsendable}, messaged ${summary.messaged}, queued ${summary.queued}, sent ${summary.sent}, ` +
      `resumed ${summary.resumed}` +
      // Only meaningful in a dry run, where messaged and queued are both 0 by
      // construction. Named "would message" rather than "messaged" because the
      // per-run cap is not simulated in a dry run, so this can exceed
      // max_messages_per_run; a real run applies the cap and defers the rest.
      (opts.dryRun ? `, would message ${summary.wouldMessage}` : '') +
      (summary.retryable ? `, retryable ${summary.retryable}` : '') +
      (summary.stranded ? `, stranded ${summary.stranded}` : '') +
      (summary.errors.length ? `, errors: ${summary.errors.join(' | ')}` : '');
```

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `cd outreach && npm test && npm run typecheck`
Expected: all pass. Pay particular attention to `test/stranding.test.ts`'s two dry-run tests. Neither asserts `queued_for_message`, and both assert the row ends at `discovered`, which this change preserves, so both should still pass unmodified. If either fails, stop: it means this change contradicts `docs/spec-candidate-stranding.md` somewhere the analysis in D3 missed.

- [ ] **Step 8: Commit**

```bash
git add outreach/src/pipeline/loop.ts outreach/test/loop.test.ts
git commit -m "Stop a dry run arming the next real run

A dry run persisted a real drafts row at awaiting_approval and set the ledger
row to queued_for_message. The next real run's flush drained that row and
texted the draft, where a 'y' sends a real irreversible email, so the
rehearsal armed the thing it was rehearsing. The draft also blocked that
person from every future candidate through priorThreads, and the abandonment
sweep could not clear it because a dry run does not consume attempts.

The rule is now: a dry run may persist observation, never obligation. It runs
discovery, the gate, and processPaper, evaluates every terminal verdict, then
stops before drafting and rests the row at 'discovered', which the resume step
already reads. No new status, no new column, no schema change. summary gains
wouldMessage so the rehearsal still reports what a real run would text."
```

---

### Task 5: Verify against the live database and against the real endpoint

**Files:** none modified. This task is verification only.

**Context:** the project rule is verification by demonstration, not assertion. This task produces the actual output that shows the recommend source now yields candidates and that the live database holds no dry-run artifacts. Both scripts are temporary files inside `outreach/` (because `npx tsx -e` cannot resolve ESM imports here) and both are deleted immediately afterwards.

- [ ] **Step 1: Re-measure the live database for dry-run artifacts**

The measurement in D3 was taken on 2026-07-30 and found **zero**. The database changes daily, so re-measure before merging. Create `outreach/tmp-verify-dryrun.ts`:

```typescript
import { openDb } from './src/db/db.js';

const db = openDb('data/outreach.db');
const show = (label: string, sql: string) => {
  console.log(`--- ${label}`);
  console.log(JSON.stringify(db.prepare(sql).all()));
};

show('by status', `SELECT status, COUNT(*) n FROM seen_papers GROUP BY status`);
show(
  'DRY RUN ARTIFACTS (must be 0)',
  `SELECT arxiv_id, status, draft_id, reason FROM seen_papers WHERE reason LIKE '%dry run%'`,
);
show('queued reasons', `SELECT reason, COUNT(*) n FROM seen_papers WHERE status = 'queued_for_message' GROUP BY reason`);
show('drafts by status', `SELECT status, COUNT(*) n FROM drafts GROUP BY status`);
```

Run: `cd outreach && npx tsx tmp-verify-dryrun.ts; rm -f tmp-verify-dryrun.ts`

Expected, matching the 2026-07-30 measurement: `DRY RUN ARTIFACTS` is `[]`, and every `queued_for_message` reason is `deferred by max_messages_per_run`.

**If `DRY RUN ARTIFACTS` is non-empty**, do not write a migration. Each such row is a `queued_for_message` row armed by a rehearsal. The remedy, applied by hand and shown to Aditya before it is run, is per row: set the row back to the resting state with `UPDATE seen_papers SET status = 'discovered', reason = 'dry-run artifact disarmed', updated_at = datetime('now') WHERE arxiv_id = ?`, and if it has a `draft_id`, retire that draft through the existing `decide(db, draftId, 'skip', 'cli', 'dry-run artifact, never approved')` rather than by direct SQL, so `priorThreads` stops matching it and the person is contactable again. The reason text is the only marker available, because this plan deliberately adds no `dry_run` column (D3), so a rehearsal artifact whose reason was later overwritten by another `setStatus` is not identifiable and must not be guessed at.

- [ ] **Step 2: Demonstrate the recommend source against the real endpoint**

This is the one place a live request is warranted, and it is a manual verification step, not a test. Do not hammer the endpoint: one seed, one request. Create `outreach/tmp-verify-recommend.ts`:

```typescript
import { createRecommendSource } from './src/discovery/sources/recommend.js';

const src = createRecommendSource(['2506.02373'], { maxResultsPerSeed: 10 });
const got = await src.fetch();
console.log('errors:', got.errors);
console.log('candidates:', got.candidates.length);
for (const c of got.candidates) console.log(' ', c.arxivId, c.title.slice(0, 70));
```

Run: `cd outreach && npx tsx tmp-verify-recommend.ts; rm -f tmp-verify-recommend.ts`

Expected: `errors: []` and a non-zero `candidates` count, with real arXiv ids and titles printed. Before this plan the same command printed `candidates: 0` with no error, which is the whole defect.

Two acceptable non-failures, both of which must be reported rather than retried:
- `errors: [ 'all 1 Semantic Scholar seeds failed (2506.02373: HTTP 429)' ]` means the endpoint rate limited this one request. That output is itself a successful demonstration of D1's failure-reporting half. Wait several minutes and try once more; do not loop.
- `candidates: 0` with `errors: []` is possible if every recommendation for that particular seed is journal-only (the live probe during planning saw exactly that for the first two results). If that happens, run once with a different seed from `deriveSeedPapers` output before concluding anything.

- [ ] **Step 3: Confirm no temporary file was left behind**

Run: `cd outreach && ls tmp-verify-*.ts 2>&1; git status --short`
Expected: `ls: tmp-verify-*.ts: No such file or directory`, and a clean `git status` (all four commits already made).

- [ ] **Step 4: Full suite, typecheck, and no em dashes**

Run:

```bash
cd outreach && npm test && npm run typecheck
```

Expected: all tests pass, typecheck clean.

Run the em-dash check over everything this plan touched:

```bash
cd /Users/apgupta/Documents/Coding/new/networks && \
  grep -rn $'—' outreach/src/discovery outreach/src/pipeline/loop.ts outreach/test docs/superpowers/plans/2026-07-29-discovery-correctness.md
```

Expected: no output (grep exits 1). Any hit must be replaced with a comma, colon, or parentheses before merging.

- [ ] **Step 5: First run after merge is a dry run, and it must arm nothing**

Following `docs/spec-candidate-stranding.md` CS10.4 and CS10.5: back up the database first, then run the rehearsal, then prove it armed nothing.

```bash
cd outreach
cp data/outreach.db "data/outreach.backup-$(date +%Y%m%d-%H%M%S).db"
npx tsx src/cli.ts loop --dry-run
```

Expected: a summary line of the form `outreach loop (dry run): seen N, filtered N, unsendable N, messaged 0, queued 0, sent 0, resumed N, would message N`, with `messaged 0` and `queued 0` both literal. If `errors:` appears with a `saved_query:` or `recommend:` term, that is the D1/D2 reporting working, and the error should be read and reported rather than treated as a failure of this plan.

Then prove the rehearsal armed nothing, by re-running the Step 1 script and additionally checking that no draft was created by the rehearsal. Show both outputs to Aditya before the plist is loaded.

- [ ] **Step 6: Commit any final documentation touch-up**

If Steps 1 through 5 surfaced a number worth recording (for instance the actual candidate count the fixed recommend source now yields), update the D3 measurement table in this plan document with the re-measured values and commit:

```bash
git add docs/superpowers/plans/2026-07-29-discovery-correctness.md
git commit -m "Record the re-measured live database state for the discovery correctness plan"
```

---

## Explicitly out of scope

- `listen.ts`, `photonChannel.ts`, `ledger.ts`, `research.ts`, `intersect.ts`, `relevanceGate.ts`. None are touched.
- `handleReply` and `retryApprovedUnsent` in `loop.ts`. A different plan owns those, including their own dry-run questions.
- `resolveSendableDraft`'s dry-run behaviour. Settled by `docs/spec-candidate-stranding.md` CS7.5 and correction C4, and its writes are observation under D3's rule.
- A cheaper `--dry-run=discovery-only` mode that skips `processPaper` as well as drafting. It would make the rehearsal answer much less, and the facts `processPaper` writes are true and idempotent.
- A Semantic Scholar API key to raise the rate limit. It would reduce how often the new `recommend` error fires, but the error path has to be correct either way, and adding a credential is a separate change.
- Writing `sent` and `rejected` into `seen_papers`. That is `docs/spec-status-audit-trail.md`.
