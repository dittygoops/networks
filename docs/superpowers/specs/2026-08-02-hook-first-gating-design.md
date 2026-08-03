# Hook-First Gating: stop paying to research people we never contact

**Date:** 2026-08-02
**Status:** Draft, awaiting review
**Problem owner:** cost of discovery runs (Tavily plan quota)

## Problem

One backfill of 184 papers consumed the entire 1,000-credit monthly Tavily plan
(816 searches + 184 extracts, verified live against `GET
https://api.tavily.com/usage`). The spend is structural, not a rate limit:
about 5.4 credits per paper, every run.

Measured against `data/outreach.db` after that run:

- 148 people were mined; only 40 ever produced a draft. **73% of paid calls
  bought research on people the pipeline never contacted.**
- Of the 50 surviving intersections (hooks), the person-side fact came from
  arXiv 42 times, OpenAlex 8 times, and a Tavily-fetched page **0 times**.
- Tavily-fetched pages produced 118 of 9,719 person facts (1.2%). Checked
  fact-by-fact against every draft body, subject, and `draft_input_json`: no
  draft depends on any of them. The single specific overlap (`method = hair
  reconstruction`, d38) is redundant with the paper's own facts (`DynHair`,
  `hair tracking` from arXiv 2607.23861).
- 53 papers ended `drafted_unsendable / identity unconfirmed`, yet each paid
  for a full web contact hunt first: `processPaper` calls `extractContact`
  (orchestrate.ts:91) *above* the `if (resolution && raw)` branch, while
  `processCandidate` (loop.ts:358) discards any result without a `personId`.
  A contact-only person row (orchestrate.ts:166-174) has no ontology, so it
  can never reach a hook and can never be drafted. Verified in the DB: 45
  contact-only rows (`openalex_id IS NULL`), **0 with any fact, 0 with any
  draft**. That spend buys nothing.

Root cause: `processPaper` buys contact lookup and profile mining **before**
asking whether there is any reason to email the person. The hook check, which
is free, runs last.

## Design

Reorder `processPaper` so every paid call sits behind the two free gates that
already discard most candidates. Delete the one paid path that has never
contributed to an outcome.

### Change 1: reorder `processPaper`

New order:

1. Fetch paper, select target author, build context (free, unchanged).
2. Resolve identity via OpenAlex (free, unchanged).
   **Gate: unresolved → return immediately** (`identity unconfirmed`). No
   contact extraction, no person row. The contact-only persistence branch
   (orchestrate.ts:166-174) is deleted; its rows were unreachable by the
   draft path (no ontology → no hooks → `no grounded hook`).
3. Gather free facts: `factsFromOpenAlex` + `extractPaperFacts`, persist,
   run `detectIdentityCollision` (all unchanged, just earlier).
   **Gate: collision suspected → return** (unchanged semantics, now cheaper).
4. `computeIntersections` on those facts.
   **Gate: no hook → return** (`no grounded hook`). Zero paid calls made.
5. Only now: `extractContact` (PDF tier first, free; web tier paid), then the
   existing email/prior-thread gates in `processCandidate`, then draft.

Applied to the last run's terminal statuses: the 74 `no grounded hook` papers,
the 53 `identity unconfirmed` papers, and both collision papers would have cost
zero paid calls. Only the 40 drafted people plus the 23 `no email resolved`
would still pay for the contact web tier.

**Why the same 40 people still draft**, verified rather than assumed:
`extractContact`'s result reaches only `upsertPerson`'s `email` /
`email_confidence` / `email_source` columns (orchestrate.ts:149-157, 166-172).
It never produces an `OntologyFact` and never calls `saveFacts`.
`computeIntersections` (intersect.ts:48-56) reads its person-side facts from
the DB by `person_id`, i.e. from exactly the free facts persisted in step 3.
So no ordering of `extractContact` can change a hook outcome; moving it after
the hook gate is behaviour-preserving for drafting, and only changes who pays.

### Change 2: delete `minePerson`'s paid path

`minePerson` (research.ts:507) is already split: `factsFromOpenAlex` (free,
unconditional) then `minePersonalFacts` (research.ts:559-621, Tavily: 2
searches + up to 3 extracts per person). Delete `minePersonalFacts`.

**The page-identity gates die with it.** Verified call graph:
`buildDomainGate` (research.ts:491) has one caller, line 595; `pageIsAboutPerson`
(654) has one caller, line 599; both are inside `minePersonalFacts`.
`urlSlugMatchesPerson` (674) is called only from `pageIsAboutPerson` (659), and
`personNameInText` (src/text/match.ts) is used only by those two. All become
dead code and are deleted with the paid path.

This removes a safety control, so record why it is safe: those gates exist
because web-mined pages once contaminated person ontologies (a `dr-jan-delcker`
page attributed to Nicolai Plintz; 57 facts purged from 4 people). **`contacts.ts`
never persists a fact** (verified: no `saveFacts` / `persistPerson` / `OntologyFact`
reference in the file). So `minePersonalFacts` was the only path by which a
fetched web page could become a stored fact. Deleting the contamination vector
and its defenses together is coherent; keeping the gates would leave guards on
a door that no longer exists.

Keep unchanged: `factsFromOpenAlex`, `splitHobbyFacts`, the profile summary LLM
call, `detectIdentityCollision`, `extractPaperFacts`. `src/text/match.ts` stays
(`containsWholeWords` / `normalizeForMatch` are used by `intersect.ts` and
`discovery/relevanceGate.ts`); only `personNameInText` is removed from it.

**Stale comment to fix:** `test/identity-collision.test.ts` (D6 blind-spot
block) states "The defense for this population is the page-identity gate in
research.ts (pageIsAboutPerson), not this detector." After this change that
sentence is false. It was also imprecise: `pageIsAboutPerson` gated which *web
pages* contributed facts and never defended against a merged OpenAlex identity,
which is what the D6 blind spot actually describes. Update the comment to say
the blind spot is accepted and undefended, rather than silently leaving a
reference to deleted code.

### Change 3: nothing else

Tavily stays as search provider and page fetcher at the new volume. No new
dependencies, no provider swap, no Playwright. Those belong to the pipeline-
interfaces spec (sourcing/reaching/understanding split), not this one.

## Behavioral changes to acknowledge

- **Terminal-status attribution shifts.** Gates now run in a different order,
  and the recorded reason is the first gate that fires. A paper with neither a
  hook nor an email is now `no grounded hook`, where before it could be
  `no email resolved`. Run-over-run status comparisons cross this boundary.
- **`people` stops accumulating contact-only rows** for unresolved identities.
  Accepted: those rows were terminal waste (see Problem).
- **Facet coverage narrows.** `minePersonalFacts` was the only source of
  web-mined personal facets (hobby/location/role from personal pages). The
  measurement says they never mattered to an outcome; if a future spec wants
  them, it reintroduces them behind the hook gate, not in front of it.
- **Hooks can never come from contact-path pages.** This was already true of
  all 50 measured hooks; the reorder makes it an architectural invariant. The
  pipeline-interfaces spec should make this boundary explicit.

## Review status

The two independent reviewers this spec was meant to pass through did not run
(one hit a session limit before starting, the other failed to launch). The
claims below were verified by hand instead, and the spec was corrected where
they proved wrong:

- **Verified:** contact-only rows are terminal (45 / 0 facts / 0 drafts);
  `extractContact` never feeds facts or intersections; the call graph of the
  page-identity gates; `contacts.ts` persists no facts; callers of
  `processPaper` (loop.ts:356 via the `deps.processPaper` seam, cli.ts:149
  wrapper, cli.ts:278 direct).
- **Corrected:** the original spec claimed the page-identity gates survive the
  deletion. They do not; see Change 2.
- **NOT yet reviewed:** re-entry semantics for people already persisted under
  the old order; whether `drafted_unsendable / identity unconfirmed` is ever
  revisited after an OpenAlex outage (Risks, below); the full list of tests
  that encode the old ordering; consumers of `profile_summary` given a thinner
  summary; whether the cli.ts:278 direct path needs its own handling.

Those gaps should be closed by the consequence reviewer before implementation.

## Verification

Per the project rule: demonstrate against reality, not artifacts.

1. **Ordering tests with counting fakes.** Inject a `SearchClient`/`PageFetcher`
   pair that records every call. Assert: a candidate that fails identity
   resolution triggers zero calls; a candidate with no hook triggers zero
   calls; a candidate with a hook triggers calls only after intersections
   exist. Mutate the reorder (move `extractContact` back up), confirm the
   tests go red, restore.
2. **Draft-preservation check from the real DB.** Already measured (0 of 50
   hooks rest on paid facts), and re-assertable by script at review time.
3. **Live cost demonstration.** After merge, run one real cycle and read
   `GET https://api.tavily.com/usage` before and after. Expected: paid calls
   only for hook-passing candidates, on the order of 1-2 credits per seen
   paper rather than 5.4. Report the actual numbers, whatever they are.
   (The plan quota resets monthly; if the run happens while the quota is
   exhausted, the demonstration waits for the reset rather than being skipped.)

## Risks

- **The invariant.** Gating hooks on free facts assumes hooks never need
  contact-path or personal-page facts. True of every hook ever produced by
  this system, but it is now load-bearing. Revisit if hook yield drops.
- **OpenAlex becomes a harder dependency.** Unresolved identity now exits
  before contact extraction, so an OpenAlex outage stops the pipeline's paid
  work entirely. That is the correct failure direction (fail cheap), and the
  existing `degrade to paper context` note remains in the run summary.

## Out of scope

- Provider swap, Playwright/DOM extraction, pattern-plus-verify email guessing
- Sourcing/reaching/understanding interface split
- Identity resolution without an academic anchor
- Any change to drafting, approval, or sending
