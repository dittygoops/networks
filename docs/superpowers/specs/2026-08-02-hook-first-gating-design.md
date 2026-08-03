# Hook-First Gating: spend paid lookups only on people we will actually email

**Date:** 2026-08-02
**Status:** Reviewed (2 independent reviewers), revised, ready for implementation planning
**Problem owner:** cost of discovery runs (Tavily plan quota)

## Problem

One backfill consumed the entire 1,000-credit monthly Tavily plan (816 searches
+ 184 extracts, verified live against `GET https://api.tavily.com/usage`),
roughly 5.4 credits per paper. The spend is structural, not a rate limit.

**Measurement snapshot, `data/outreach.db` as of 2026-08-02.** These figures
move every run (the 09:00 batch is live), so they are date-stamped and were
re-measured in one query after review:

| metric | value |
| --- | --- |
| people rows | 217 |
| people actually mined (have ≥1 fact) | 172 |
| people who ever produced a draft | 57 |
| intersections (hooks) | 186 |
| hooks by person-fact source | arXiv 125, OpenAlex 58, **web/paid 3** |
| `drafted_unsendable` reasons | 95 no grounded hook, 72 identity unconfirmed, 49 no email resolved, 18 collision |

So **57 of 172 mined people ever got contacted; about two thirds of paid
research bought nothing.** The cause is ordering: `processPaper` buys contact
lookup and profile mining *before* asking whether there is any reason to email
the person. The hook check, which is free, runs last.

Two specific wastes:

1. **72 papers ended `identity unconfirmed`, each after paying for a full web
   contact hunt.** `processPaper` calls `extractContact` (orchestrate.ts:91)
   above the `if (resolution && raw)` branch, while `processCandidate`
   (loop.ts:358) discards any result without a `personId`. The resulting
   contact-only rows (orchestrate.ts:166-174) have no ontology, so they can
   never hook and never draft. Verified: 45 such rows, **0 with any fact, 0
   with any draft.**
2. **95 papers ended `no grounded hook`**, each after paying for both contact
   extraction and profile mining, to answer a question that free facts alone
   could have answered.

### What the paid path is genuinely worth

Web mining is not worthless, and an earlier draft of this spec wrongly claimed
it was. Person 58 (Daniel Kepple) has three hooks resting on a Tavily-fetched
CSHL page (`academic / research_area = olfaction`), and the strongest of them
is **tier A, strength 0.9, outranking his best arXiv hook at 0.8/B**. That
person owns draft `d19`, status `sent`. Free sources carry near-equivalents
(`Olfactory system` from OpenAlex, `olfactory perception` from arXiv), so he
would still hook without it, but the *lead* hook would degrade.

Conclusion: the paid mining path occasionally produces the best hook on
Aditya's core topic. It should be **retimed, not removed**.

## Design

Move every paid call behind the free gates that already discard most
candidates, and let paid mining *enrich* hooks for people who already passed
rather than *discover* hooks for people who never will.

### Change 1: reorder `processPaper`

New order:

1. Fetch paper metadata, select target author, build context (free, unchanged).
2. Resolve identity via OpenAlex.
   - **A transport failure must re-throw, not degrade.** Today
     `orchestrate.ts:77-86` catches every exception (429, DNS, JSON parse) and
     produces the same `identity unconfirmed` note as a genuine no-match. Under
     the new order that verdict is terminal (see Risks), so an outage would
     permanently discard a day of candidates. Only `resolveAuthor` returning
     `null` may yield the terminal verdict; transport failures propagate to
     `processCandidate`'s catch (loop.ts:433) and stay retryable.
   - **Gate: unresolved → return immediately.** No contact extraction, no
     person row. The contact-only branch (orchestrate.ts:166-174) is deleted.
3. Gather free facts: `factsFromOpenAlex`, persist, then
   `detectIdentityCollision`.
   - **Preserve the detector's current input set.** It runs today on
     `factsFromOpenAlex` output only, *before* `extractPaperFacts`. Keep that.
     Feeding it paper facts would change verdicts (arXiv-sourced
     `academic/collaborator` rows exist) and is out of scope.
   - **Gate: collision suspected → return.** Also
     `DELETE FROM intersections WHERE person_id = ?` on this path, so a person
     flagged on a later run does not keep stale hook rows from an earlier one.
4. `extractPaperFacts` (LLM, free of Tavily), persist. Then
   `computeIntersections`.
   - **`SelfOntologyMissingError` must re-throw**, not fall through. Today it
     is caught (orchestrate.ts:162-164) leaving `hooks = []`, which under the
     new order is indistinguishable from "no hook" and would silently
     terminate *every paper in the run* with nothing captured. `CLAUDE.md`
     documents how easily the self ontology is emptied (`persona` uses
     `replaceSelfFacts`; `intersections` cascades on `ontology_facts`). It must
     surface as a retryable run error.
   - **Gate: `noStrongHook || hooks.length === 0` → return** (`no grounded
     hook`). **Zero paid calls made.**
5. Paid enrichment, for survivors only: `minePersonalFacts`, persist its facts,
   then **re-run `computeIntersections`** so a web-mined fact can become the
   lead hook (the Kepple case). A mining failure is non-fatal: keep the
   step-4 hooks.
6. Contact extraction, for survivors only:
   - **Skip entirely if `people.email` is already on record** for this person.
     Repeat authors currently re-pay for an address we already have.
   - Otherwise fetch the paper PDF (`orchestrate.ts:90`, `getPaperText` /
     `defaultPaperText`) and run `extractContact`. **Line 90 moves with line
     91**; leaving it behind keeps every no-hook paper hitting
     `arxiv.org/pdf/<id>` and preserves the 429 exposure this change is meant
     to reduce.
   - **The `upsertPerson(email)` write (orchestrate.ts:149-157) moves with
     it.** Dropping it would leave `people.email` NULL, and both
     `loadSendableDraft` (loop.ts:511-517) and `findAdoptableOrphans`
     (loop.ts:636-651) key off that column.

Applied to the snapshot: the 95 no-hook, 72 unresolved, and 18 collision papers
would cost zero paid calls. Only the 57 drafting people plus the 49 `no email
resolved` would reach steps 5-6.

### Change 2: reorder `processCandidate`'s gates

**This is required, not optional.** Current order (loop.ts:358-383) is
`personId` → collision → **email (:368)** → **hooks (:373)** → prior thread.
After Change 1 a hookless paper returns with `personId` set and `email === null`
because extraction never ran, so the email gate fires first and records
`no email resolved`. That would relabel all 95 `no grounded hook` papers,
collapse that bucket to zero, and make the hook gate unobservable, destroying
the signal this spec's own cost verification depends on.

Move the hook gate above the email gate. Both reviewers found this
independently.

### Change 3: two adjacent fixes this change makes urgent

- `persistPerson` must pass `profileSummary || null`. `minePerson` returns `''`
  on LLM failure (research.ts:527-532) and `upsertPerson` uses
  `coalesce(?, profile_summary)`, so `''` overwrites a good stored summary.
  Pre-existing, but step 5 re-mines more often.
- Nothing else. No provider swap, no Playwright, no new dependencies. Those
  belong to the pipeline-interfaces spec.

### What is explicitly NOT deleted

An earlier draft proposed deleting `minePersonalFacts` and its helpers. Because
the path is retimed rather than removed, all of it stays:
`pageIsAboutPerson`, `buildDomainGate`, `urlSlugMatchesPerson`, `safeClassify`,
`extractFactsFromPage`, `personNameInText`, and `anchorAdmitsUrl`.

Recorded so a future reader does not re-attempt the deletion:
`scripts/purge-contaminated-facts.ts:45,75,76` imports `urlSlugMatchesPerson`
and `anchorAdmitsUrl`, and `tsconfig.json` includes only `src/**` and `test/**`,
so `npm run typecheck` would **not** have caught breaking it. The page-identity
gates also remain load-bearing: they are the defense against the fact
contamination that `minePersonalFacts` can still cause, and the D6 comment in
`test/identity-collision.test.ts` stays accurate.

## Behavioral changes to acknowledge

- **`no email resolved` shrinks, `no grounded hook` grows**, once Change 2
  lands: papers failing both gates now report the hook failure. Run-over-run
  status comparisons cross this boundary.
- **`people` stops accumulating contact-only rows.** Accepted: 45 exist, none
  ever produced a fact or a draft.
- **Hooks are computed from *accumulated* facts, not this run's facts.**
  `computeIntersections` reads `factRows(db, personId)` (intersect.ts:53), i.e.
  everything ever persisted. 146 web-mined facts from past runs stay in the DB,
  so post-merge hook yield will look better than steady state. Ordering tests
  must therefore use a fresh in-memory DB per case, or "no hook → zero paid
  calls" can pass for the wrong reason.
- **`outreach add` (cli.ts:278) changes on the unresolved path.** It is the
  remedy `cmdStranded` points operators at (cli.ts:184-185), and today it
  prints a found address for unresolved authors. After the reorder it returns
  before extraction and would print `email: not found (manual queue)` for a
  lookup that never ran, which is reporting a non-result as a result. **The
  manual path is exempted from the identity gate**: `outreach add` is one
  deliberate human invocation, not a 184-paper batch, and its cost is
  irrelevant. Its draft predicate (cli.ts:296) must also be corrected to
  `!noStrongHook && hooks.length > 0 && !identityCollisionReason` to match
  loop.ts:373.
- **Collision papers no longer get fresh intersections rows** (step 3 returns
  first). No consumer breaks: nothing outside `db.ts` and the purge script
  reads that table. The explicit `DELETE` in step 3 handles staleness.
- **`profile_summary` degradation is confined to `outreach add`.** The loop's
  `buildDraftInput` (cli.ts:151-161) never passes `profileSummary`; only
  cli.ts:313/339/349 does. 201 stored summaries keep their existing text.

## Verification

Per the project rule: demonstrate against reality, not artifacts.

1. **Ordering tests with a shared call log.** `OrchestrateDeps` (`db`, `search`,
   `fetcher`, `llm`, `fetchFn`, `getPaperText`) is sufficient; no refactor
   needed. `test/orchestrate.test.ts:55-65` already injects all six and
   `:47-53` shows how to distinguish LLM calls by system prompt, which is how
   ordering (not just counts) is asserted. Requirements: **count
   `getPaperText` too** (or the PDF fetch is invisible), use **one shared call
   log** across all seams since there is no direct seam on
   `computeIntersections` or `extractContact`, and keep the **fresh
   `:memory:` DB per case**. Assert: unresolved → zero calls; no hook → zero
   calls; hook present → paid calls occur and only after the intersect LLM
   call. Mutate each fix, confirm red, restore.
2. **Regression for Change 2:** a `{ hooks: [], noStrongHook: true, email: null }`
   fixture in `test/loop.test.ts` asserting status `no grounded hook`.
3. **Live cost demonstration.** Run one real cycle, read `GET
   https://api.tavily.com/usage` before and after, report actual numbers.
   Expected on the order of 270 credits for a batch this size versus 1,000.
   If the monthly quota is exhausted, the demonstration waits for reset rather
   than being skipped.

### Test dispositions

| File | Disposition |
| --- | --- |
| `test/orchestrate.test.ts:85-103` (unresolved → contact only) | **Rewrite**: assert `email === null`, `personId === null`, zero paid calls. This is the test Change 1 inverts. |
| `test/orchestrate.test.ts:105-111` (no self ontology) | **Rewrite**: must now assert it throws/is retryable, not that it degrades silently. |
| `test/orchestrate.test.ts:68-83` (full chain) | Keep as the regression for the `upsertPerson(email)` move. |
| `test/mine-person.test.ts` (10 tests, incl. 4 production incidents) | **Keep all.** The path survives; only its timing changes. |
| `test/page-identity.test.ts` (17 tests) | **Keep all.** |
| `test/text-match.test.ts`, `test/vocab.test.ts` | **Keep.** |
| `test/resilience.test.ts:55-75` | Keep; still valid since `minePerson` still makes network calls. |
| `test/loop.test.ts:53-63` fixtures | **Add** the no-hook/no-email fixture from Verification 2. |
| `contacts.ts` suites (`web-extraction`, `two-pass`, `snippet-scan`, `domains`, `classify-aggregator`, `extract-contact`) | Unaffected. `contacts.ts` is untouched. |

Baseline before changes: 46 files, 510 tests, all passing.

## Risks

- **`identity unconfirmed` is terminal and invisible.** `getResumable` and
  `getExhausted` (seenLedger.ts:98,114) filter `status = 'discovered'`;
  `filterUnseen` (:29-41) drops anything already in `seen_papers`; and
  `strandedReport` (:190) matches only abandoned/orphan reasons, so `outreach
  stranded` does not print these rows. 65+ already sit there unseen. Change 1's
  re-throw keeps *transport* failures out of this bucket, which is the
  mitigation. Making the bucket visible in `outreach stranded` is a real gap
  and is deferred to its own spec rather than smuggled in here.
- **Hook enrichment now depends on a second `computeIntersections` call** per
  drafting person. Cost is one extra LLM call for ~57 people per batch.
- **Stale web-mined facts keep producing hooks for already-mined people**, so
  hook yield will not visibly drop even if step 5 stops adding value. Any
  future "is enrichment still worth it" measurement must slice by
  `retrieved_at`.

## Out of scope

- Provider swap, Playwright/DOM extraction, pattern-plus-verify email guessing
- Sourcing / reaching / understanding interface split
- Identity resolution without an academic anchor
- Making `drafted_unsendable` rows visible or retryable in `outreach stranded`
- Any change to drafting, approval, or sending
