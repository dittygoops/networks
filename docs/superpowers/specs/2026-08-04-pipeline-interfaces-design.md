> **SCOPE DECISION, 2026-08-04: this spec is DEFERRED, not rejected.**
>
> Its own strongest argument ("do not draw a boundary without a second
> consumer", evidenced by `src/pipeline/intake.ts`, an earlier resolve-plus-reach
> extraction that no production code imports) applies to the Reacher as well as
> to the Source. There is no second address-finder today; Hunter/Apollo/
> pattern-plus-verify were discussed, never committed to. Extracting that seam
> now would repeat exactly the mistake `intake.ts` records.
>
> Only the **Understander** has a concrete second consumer: identity resolution
> without an OpenAlex anchor. That work is specced separately, and the
> Understander seam is folded into it as step one, where it can be designed
> against a real second implementation instead of a guess.
>
> **Carried forward into that spec:** the two-method Understander
> (`understand` free, `enrich` paid) so the hook gate is enforced between them
> by the type rather than by a comment. That protects the 2026-08-02 reorder
> from being silently undone, and it is this document's most durable idea.
>
> **Revisit this spec when** a second Source or a second Reacher actually
> exists. The Phase 0-3 migration plan below remains valid at that point.

# Pipeline Interfaces: make sourcing, reaching, and understanding independently swappable

**Date:** 2026-08-04
**Status:** Draft, not yet reviewed
**Problem owner:** the pipeline can only find people the way it finds them today
**Recommendation up front:** implement two of the three interfaces now (Reacher,
Understander). Design the third (Source) here, but do **not** implement it until a
concrete second source spec exists. Reasoning in "Cost, benefit, and whether to do
this now".

## Problem

This tool was built to find olfaction researchers on arXiv. The owner now wants a
general cold-outreach tool where the way candidates are found is changeable
(LinkedIn, corporate lead lists, conference programs, GitHub) without rewriting the
pipeline. Three separable concerns are currently fused:

- **Sourcing**: who are the candidates?
- **Reaching**: what is their address?
- **Understanding**: who is this person, and is there a genuine reason to write?

### Where the fusion actually is

Verified against the source on 2026-08-03.

`processPaper` (`outreach/src/pipeline/orchestrate.ts:115-260`) takes
`arxivId: string` and does all three itself:

| line | what it does | which concern |
| --- | --- | --- |
| 123-125 | `fetchArxivPaper` / `selectTargetAuthor` / `buildPaperContext` | Sourcing (re-fetch) |
| 171-174 | `fetchAuthorCandidates` + `resolveAuthor` + `currentAffiliation` | Understanding (identity) |
| 191-195 | unresolved gate | Understanding |
| 198-201 | `fetchIdentityAnchors`, `minePersonFree`, `persistPerson` | Understanding (free facts) |
| 207-217 | `detectIdentityCollision` gate + `clearIntersections` | Understanding |
| 220 | `addPaperFacts` (`extractPaperFacts` on the arXiv abstract) | Understanding, via a **Sourcing-shaped input** |
| 226 | `computeIntersections` | Understanding (hooks) |
| 228-231 | **hook gate** | the cost boundary |
| 234-246 | `minePersonWeb` + `persistPerson` + re-`computeIntersections` | Understanding (paid) |
| 140-162, 249 | `runContactExtraction`, PDF fetch, `extractContact` | Reaching |
| 250-258 | `upsertPerson(email)` | Reaching (persistence) |

The hardcoded couplings, precisely:

1. The entry point is a string that only means something to arXiv. Every caller
   passes an arXiv id: `loop.ts:360` (via the `deps.processPaper` seam declared at
   `loop.ts:62`), `cli.ts:149`, `cli.ts:278`.
2. Identity resolution is OpenAlex and only OpenAlex. `persistPerson`
   (`persist.ts:13-22`) requires `resolution.author.id`, which is an OpenAlex author
   id, and writes it to `people.openalex_id`.
3. The tier-1 contact document is hardcoded to the arXiv PDF: `defaultPaperText`
   (`orchestrate.ts:56-64`) fetches `https://arxiv.org/pdf/<id>`.
4. The paid contact hunt is hardcoded to Tavily. `OrchestrateDeps`
   (`orchestrate.ts:20-27`) declares `search: SearchClient` and
   `fetcher: PageFetcher` and both call sites inject the same Tavily client
   (`cli.ts:165`, `cli.ts:279`).

### What is already separated, and should be credited

- `DiscoverySource` (`src/discovery/types.ts:33-36`) already exists and is already
  a real interface with three implementations (`savedQuery`, `authorWatch`,
  `recommend`). It is not, however, source-agnostic: `Candidate.arxivId` is
  required, `DiscoveredVia` is a closed three-value union, and `seen_papers` has
  `arxiv_id TEXT PRIMARY KEY` plus
  `discovered_via TEXT CHECK(discovered_via IN ('saved_query','author_watch','recommend'))`
  (`src/db/schema.sql:113-120`).
- `contacts.ts` is already pure over the store. Its only import is `tldts`
  (verified: `grep -n "import" src/pipeline/contacts.ts` returns one line). It
  never touches the DB and never persists facts.
- **The 2026-08-02 hook-first reorder already created the boundary in embryo.**
  "Understanding runs before Reaching" is exactly the separation this spec
  formalizes, and `test/ordering.test.ts` already proves it with a shared call log.

### The one cautionary precedent in this repo

`src/pipeline/intake.ts` exports `resolveAndExtractContact`, which is a
resolve-then-reach module extracted at some earlier point. **Nothing in `src/`
imports it.** Its only consumers are `test/intake.test.ts` and
`test/resilience.test.ts`. A boundary drawn here without a second consumer has
already rotted into dead code once. That is an argument for staging, not for
skipping, but it is the reason this spec refuses to authorize all three interfaces
at once.

## Design

### Decision 1: the three interfaces

New file `src/pipeline/ports.ts`. It imports types only (`OntologyFact`,
`Intersection`); it must not import `arxiv.ts`, `openalex/client.ts`, or
`search/tavily.ts`, and that constraint is the actual test of whether the split
worked.

#### Sourcing

```ts
// A person the pipeline might write to, plus the artifact that surfaced them.
// The pipeline never re-fetches this: whatever a Source knows, it puts here.
export interface SourcedCandidate {
  // Globally unique and source-namespaced ("arxiv:2606.00001",
  // "github:dittygoops", "conf:neurips2026/poster/4412"). Replaces the bare
  // arXiv id as the ledger key. Sources must never mint two ids for one
  // artifact; discoverAll dedups on this string.
  sourceId: string;
  sourceName: string;   // free-form, replaces the closed DiscoveredVia union
  sourceDetail: string; // which query, which author, which seed (unchanged in spirit)
  person: {
    name: string;
    affiliationHint?: string | null; // as the artifact states it, may be stale
  };
  evidence: CandidateEvidence;
}

// Everything downstream is allowed to know about the artifact. The relevance
// gate scores `title` + `summary`; the Understander extracts facts from them;
// the Reacher may fetch `fullTextUrl` as its tier-1 document.
export interface CandidateEvidence {
  title: string;        // paper title, repo name, talk title, job posting title
  summary: string;      // abstract, README, bio, session description
  url: string;          // canonical artifact URL; becomes OntologyFact.sourceUrl
  peers: string[];      // coauthors, co-maintainers, co-panelists (identity corroboration)
  areaTerms: string[];  // 'computer graphics', 'machine olfaction'
  fullTextUrl?: string; // PDF or equivalent; absent means the Reacher skips tier 1
  ageMonths?: number;   // artifact age, drives the Reacher's confidence decay
}

export interface Source {
  readonly name: string;
  // Never throws for an upstream refusal. Expected failures go in `errors` so a
  // quiet day and a 429 day are distinguishable in the summary (this is the
  // existing SourceResult contract, src/discovery/types.ts:27-30, preserved).
  fetch(): Promise<{ candidates: SourcedCandidate[]; errors: string[] }>;
}
```

Writing a second Source means: emit `SourcedCandidate[]`, invent a stable
`sourceId` prefix, fill `evidence`. It requires no knowledge of OpenAlex, Tavily,
hooks, or the DB.

#### Understanding

Understanding is **two methods, not one**, and that is the load-bearing decision in
this spec. The 2026-08-02 reorder put the free half before the hook gate and the
paid half after it. A single `understand()` that did both would silently undo that
and restore the spend the hook-first spec removed (measured there: 816 Tavily
searches plus 184 extracts, one month's plan, on a single backfill). The interface
must make the split structural rather than a comment.

```ts
export interface PersonIdentity {
  // Namespaced anchor id ("openalex:A5023888391", "github:dittygoops"). The
  // Understander owns the namespace; the orchestrator only passes it through.
  anchorId: string;
  displayName: string;
  affiliation?: string | null;  // CURRENT affiliation, not the artifact's
  homepageUrls: string[];
}

export interface Understanding {
  personId: number;             // persisted people.id; the DB is the Understander's
  identity: PersonIdentity;
  facts: OntologyFact[];
  profileSummary: string;
  hooks: Intersection[];
  noStrongHook: boolean;
}

export type UnderstandVerdict =
  // Could not establish who this is. TERMINAL for the loop path. An Understander
  // MUST reserve this for a well-formed no-match and MUST re-throw transport
  // failures (see orchestrate.ts:164-170 and test/orchestrate.test.ts:120-131).
  | { kind: 'unresolved'; note: string }
  // The anchor looks like several real people merged into one record. TERMINAL.
  // The Understander has already persisted the person and cleared stale hooks.
  | { kind: 'collision'; personId: number; reason: string }
  | { kind: 'understood'; understanding: Understanding };

export interface Understander {
  readonly name: string;
  // Free half. MUST make no paid call. Runs on every candidate.
  understand(c: SourcedCandidate): Promise<UnderstandVerdict>;
  // Paid half. The orchestrator calls this ONLY after the hook gate passes, and
  // the parameter type enforces that: an `Understanding` cannot be constructed
  // without hooks having been computed. Returns a NEW Understanding with
  // possibly better hooks. A failure inside MUST be non-fatal: return the input
  // unchanged rather than throwing (research.ts:538-542 already behaves this way).
  enrich(u: Understanding): Promise<Understanding>;
}
```

Writing a second Understander means: pick an identity anchor, produce
`OntologyFact[]`, persist a person, call `computeIntersections`. It requires no
knowledge of arXiv or of contact extraction.

#### Reaching

```ts
export interface ReachTarget {
  name: string;
  affiliation?: string | null;  // from PersonIdentity, i.e. current, not stale
  evidence: CandidateEvidence;  // tier-1 document plus disambiguation context
  // Already on record for this person, if any. A Reacher MAY return this
  // verbatim rather than paying to rediscover it. Preserves the repeat-author
  // shortcut at orchestrate.ts:150-155 without the orchestrator owning it.
  knownAddress?: ReachedAddress | null;
}

export interface ReachedAddress {
  address: string;
  confidence: number; // 0..1. The Reacher owns its own threshold.
  // Provenance, persisted to people.email_source. Deliberately `string`, not the
  // closed EmailSource union (contacts.ts:5): the DB already holds a value
  // outside that union ('user_provided', 1 row), and a second Reacher would need
  // its own labels. SOURCE_CONFIDENCE (contacts.ts:22-28) stays PRIVATE to the
  // Tavily Reacher; it is scoring policy, not an interface concern.
  source: string;
}

export interface Reacher {
  readonly name: string;
  // Returns null for "looked and found nothing above threshold". Throws only for
  // transport failure, which processCandidate's catch (loop.ts:442) makes
  // retryable. The two must not be conflated: a returned null is terminal.
  find(target: ReachTarget): Promise<ReachedAddress | null>;
}
```

Writing a second Reacher (Hunter, Apollo, pattern-plus-verify, a CSV of known
addresses) means implementing one method over a name, an affiliation, and a
document URL.

### Decision 2: what the orchestrator becomes

```ts
export interface PipelineDeps {
  understander: Understander;
  reacher: Reacher;
}

export interface PipelineOptions {
  // `outreach add` is one deliberate human invocation, not a 184-paper batch, so
  // its address lookup is worth the credits even on a terminal verdict. The loop
  // never sets this. Semantics identical to today's alwaysExtractContact
  // (orchestrate.ts:108-113).
  alwaysReach?: boolean;
}

export async function runPipeline(
  deps: PipelineDeps,
  c: SourcedCandidate,
  opts: PipelineOptions = {},
): Promise<PipelineResult> {
  const verdict = await deps.understander.understand(c);          // 1. free

  if (verdict.kind === 'unresolved') {                            // 2. identity gate
    return terminal(c, verdict, opts.alwaysReach ? await reach(deps, c, null) : null);
  }
  if (verdict.kind === 'collision') {                             // 3. collision gate
    return terminal(c, verdict, opts.alwaysReach ? await reach(deps, c, null) : null);
  }

  let u = verdict.understanding;
  if (u.noStrongHook || u.hooks.length === 0) {                   // 4. HOOK GATE
    return terminal(c, verdict, opts.alwaysReach ? await reach(deps, c, u.identity) : null);
  }

  u = await deps.understander.enrich(u);                          // 5. paid understanding
  const address = await reach(deps, c, u.identity);               // 6. paid reaching
  return sendable(c, u, address);
}
```

Six steps, roughly forty lines, and **zero imports of `arxiv.ts`,
`openalex/client.ts`, `contacts.ts`, or `search/tavily.ts`**. The DB is not in
`PipelineDeps` at all: persistence is an Understander responsibility (it already
is, via `persistPerson`), except for the `people.email` write, which moves inside
the Tavily Reacher along with the address it writes.

**Where the hook gate lives, and why it cannot move.** Step 4, strictly between
`understand` and `enrich`. Two independent mechanisms hold it there:

1. The type. `enrich(u: Understanding)` cannot be called before `understand`
   returns, and `Understanding` carries `hooks` and `noStrongHook`, so there is no
   way to reach `enrich` without having computed them.
2. The test. `test/ordering.test.ts` asserts on a single shared call log that no
   paid seam fires before `llm:intersect`, and that a hookless candidate makes zero
   paid calls. That test must keep passing with its assertions unedited.

Ordering that the type system does **not** enforce, and which therefore stays a
tested invariant: that `reach` runs after `enrich` rather than before. Both are
paid, so the order between them is a correctness detail (the Reacher wants the
enriched current affiliation) rather than a cost one.

### Decision 3: migration path

No big-bang rewrite. The daily job keeps sending real email on every intermediate
commit. Each phase is independently revertible.

**Phase 0: types only.** Add `src/pipeline/ports.ts` with the three interfaces and
nothing else. No implementation, no call site changes. `npm run typecheck` and all
529 tests pass unchanged because nothing imports it yet.

**Phase 1: Reacher.** The cleanest extraction, because `contacts.ts` is already
pure.
- Add `createDocumentAndWebReacher(deps: { db, search, fetcher, getPaperText? }): Reacher`
  in a new `src/pipeline/reachers/tavily.ts`. Its `find` is today's
  `runContactExtraction` closure (`orchestrate.ts:140-162`) plus the
  `upsertPerson(email)` write (`orchestrate.ts:250-258`), with `arxivAgeMonths`
  read off `evidence.ageMonths`.
- `OrchestrateDeps` gains `reacher?: Reacher`. When absent, `processPaper` builds
  the default one from `db`/`search`/`fetcher`/`getPaperText`. **Keep
  `getPaperText` on `OrchestrateDeps`**, do not move it onto the Reacher: it is
  the seam `test/ordering.test.ts:108-111` logs as `'pdf'`, and moving it would
  force an edit to the one test that proves the cost invariant.
- Keep `arxivAgeMonths` exported from `orchestrate.ts` so
  `test/orchestrate.test.ts:182-187` needs no edit.
- Tests that keep passing byte-for-byte: `extract-contact`, `web-extraction`,
  `two-pass`, `snippet-scan`, `domains`, `classify-aggregator`, `age-decay`,
  `confidence`, `name-match` (all target `contacts.ts`, untouched);
  `orchestrate.test.ts` (deps default to the same behavior, including the
  already-on-record test at `:146-179`); `ordering.test.ts`.

**Phase 2: Understander.** The valuable one.
- Add `createOpenAlexUnderstander(deps: { db, llm, fetchFn?, search, fetcher }): Understander`
  in `src/pipeline/understanders/openalex.ts`. `understand` is today's steps 2
  through 4 (`orchestrate.ts:171-231`), returning the three-arm verdict. `enrich`
  is today's step 5 (`orchestrate.ts:234-246`).
- The three re-throw rules move with the code and are re-asserted, not re-derived:
  transport failure re-throws (`test/orchestrate.test.ts:120-131`),
  `SelfOntologyMissingError` re-throws (`:112-118`), and the collision path still
  calls `clearIntersections`.
- `OrchestrateDeps` gains `understander?: Understander`, defaulted the same way.
- The one genuinely new test: `enrich` is unreachable without hooks. Mutate
  `runPipeline` to call `enrich` before the hook gate, confirm `ordering.test.ts`
  goes red, restore. If it does not go red, the test is worthless and the phase is
  not done.

**Phase 3: orchestrator body.** Replace `processPaper`'s body with `runPipeline`,
and keep `processPaper(deps, arxivId, opts)` as a thin adapter that builds a
`SourcedCandidate` from an arXiv id (`fetchArxivPaper` plus `selectTargetAuthor`
plus `buildPaperContext`, mapped onto `CandidateEvidence`). Every existing caller
(`loop.ts:360`, `cli.ts:149`, `cli.ts:278`) and every existing test keeps its
current call shape. `OrchestrateResult` keeps its exact field set so
`buildDraftInput` (`cli.ts:151-161`), the loop's five gates (`loop.ts:362-392`),
and `cli.ts:288-362` are untouched.

**Phase 4: Source. DEFERRED, not authorized by this spec.** It is the only phase
that needs a schema migration, and the migration is not small:
`seen_papers.arxiv_id TEXT PRIMARY KEY` becomes a namespaced `source_id`;
`discovered_via CHECK(...)` opens up; `drafts.paper_arxiv_id` and every join
through it (`seenLedger.ts:198-204`) follow; and roughly thirty call sites in
`seenLedger.ts` rename. See the cost section for why this waits.

At every phase boundary the pipeline is shippable and the daily job is unaffected.

### Decision 4: what this does NOT change

Nothing observable changes on the day Phases 1 through 3 land. Specifically, none
of these are weakened, reordered, or made optional:

| invariant | where it lives today | after |
| --- | --- | --- |
| Human approval before any send | `loop.ts` `performApprovedSend`, `loadApprovedSend` | untouched, not in scope |
| At-most-once send claim | `drafts.send_attempted_at`, committed pre-network | untouched |
| Frozen recipient (`drafts.to_email`) vs mutable `people.email` | `schema.sql:66`, `loadApprovedSend` | untouched |
| Identity unresolved gate | `orchestrate.ts:191-195` | `UnderstandVerdict.unresolved`, same terminal effect |
| Transport failure re-throws instead of degrading | `orchestrate.ts:164-170` | inside `understand`, same test |
| Identity collision gate plus `clearIntersections` | `orchestrate.ts:207-217` | `UnderstandVerdict.collision` |
| `SelfOntologyMissingError` re-throws | `orchestrate.ts:221-226` | inside `understand`, same test |
| Hook gate before any paid call | `orchestrate.ts:228-231` | step 4 of `runPipeline`, plus the type |
| Page-identity / anti-fabrication gates | `research.ts` `pageIsAboutPerson`, `buildDomainGate`, `urlSlugMatchesPerson`, `safeClassify`, `anchorAdmitsUrl` | untouched, inside `enrich` |
| Fact-source tier caps | `research.ts:344-351` | untouched |
| Paper facts never downgrade a stored tier-A fact | `orchestrate.ts:89-99` | untouched, inside `understand` |
| Prior-thread check | `loop.ts:387-392` | untouched |
| Draft grounding check | `loop.ts:419-423` | untouched |
| Dry run persists observation, never obligation | `loop.ts:411-415` | untouched |
| `outreach add` exemption | `alwaysExtractContact` | renamed `alwaysReach`, identical semantics |
| Repeat-author address shortcut | `orchestrate.ts:150-155` | inside the Tavily Reacher via `knownAddress` |
| Loop gate ORDER (hook before email) | `loop.ts:372-386` | untouched |

**How to prove it, per the project rule (demonstrate, do not assert).**

1. **Whole suite, zero test edits.** Baseline measured 2026-08-03: 47 files, 529
   tests, all passing, 3.69s. Phases 1 through 3 must land with that number
   unchanged except for tests deliberately *added*. Any phase that requires
   editing an existing assertion has changed behavior and must stop for review.
2. **Mutation check on the gate.** Move `enrich` above the hook gate, confirm
   `test/ordering.test.ts` goes red, restore. A regression test that cannot fail
   is worthless.
3. **Byte-identical `outreach add`.** Copy `data/outreach.db` twice. Run
   `outreach add <fixed-id>` against a copy on the pre-change commit and on the
   post-change commit, with the same arXiv id and the drafting step disabled
   (LLM output is not deterministic, so compare everything above `--- DRAFT ---`).
   `diff` the captured stdout. Expect zero differences in `resolved`, `email`,
   `facts`, `hooks`, and `notes`.
4. **Byte-identical dry run.** `outreach loop --dry-run` against a DB copy on both
   commits. `diff` the printed `LoopSummary` JSON and
   `SELECT arxiv_id, status, reason FROM seen_papers ORDER BY arxiv_id`.
5. **Live cost check.** `GET https://api.tavily.com/usage` before and after one
   real cycle on the post-change commit. Credits consumed must match the
   post-hook-first steady state. A jump means the gate moved.

Verification 3 and 4 are the ones that catch what the suite cannot, and this
project's history says that is where the bugs are.

## Cost, benefit, and whether to do this now

This is plumbing. Nothing the owner can see improves on the day it lands. That is
the honest starting point, and the rest of this section argues that the three
interfaces are **not equally justified**.

### Reacher: do it now. Cost near zero, second implementation plausible.

`contacts.ts` is already pure and already has a narrow signature. The extraction is
roughly twenty lines of interface plus a factory. The concern with the most likely
near-term second implementation is address-finding, because it is a commodity
(Hunter, Apollo, pattern-plus-verify, a manual CSV) and because address failure is
a visible bucket: `no email resolved` was 49 papers in the 2026-08-02 snapshot. As
of 2026-08-03 the DB holds 180 addresses across 234 people, sourced pdf 111,
homepage 45, directory 20, github_profile 3, user_provided 1. That last value is
already outside the `EmailSource` union, which is direct evidence that a second
address provenance has *already* leaked into the system by hand.

### Understander: do it now, and this is the real payoff.

Two reasons, and neither is aesthetic.

1. **It makes a load-bearing cost invariant structural.** Today "paid mining runs
   after the hook gate" is protected by a comment and one test. As
   `understand`/`enrich`, it is protected by the type. The invariant is worth 700+
   Tavily credits a month by the hook-first spec's own measurement, and the code
   that enforces it was written four days ago and has not yet been stress-tested by
   a second author.
2. **The Understander, not the Source, is what blocks general outreach.** This is
   the inversion that matters, and it is the strongest argument in this document.

   Suppose Phase 4 shipped tomorrow and a LinkedIn Source began emitting perfect
   `SourcedCandidate`s. Every one of them would die at `orchestrate.ts:191-195`.
   `understand` resolves identity through `fetchAuthorCandidates` and
   `resolveAuthor`, which search OpenAlex, and `persistPerson` (`persist.ts:13-22`)
   requires `resolution.author.id` to write `people.openalex_id`. A sales lead, a
   conference attendee, or a GitHub maintainer who has never published has no
   OpenAlex author record, so `resolveAuthor` returns `null`, `processPaper`
   returns with `personId === null`, and `loop.ts:362-366` records
   `drafted_unsendable / identity unconfirmed`. That bucket is also invisible:
   `getResumable` and `getExhausted` filter `status = 'discovered'`, and
   `strandedReport` does not match it (noted as a known gap in the hook-first
   spec's Risks).

   So **swapping the Source alone yields a pipeline where every non-academic
   candidate is silently discarded.** The thing that has to become swappable for
   general outreach is the identity anchor, which lives inside Understanding. The
   Understander interface is the seam the identity-resolution spec will need on day
   one; the Source interface is not.

### Source: DEFER until a concrete second source spec exists.

Three reasons.

1. **The shape is a guess.** `CandidateEvidence` above is derived from exactly one
   implementation. An interface designed against one consumer is arXiv with the
   names filed off, and this repo already has the receipt:
   `src/pipeline/intake.ts` is an earlier extraction that no production code
   imports. Designing `evidence` against a real LinkedIn or conference-program
   payload will change it, and changing a schema-backed interface is far more
   expensive than changing an unwritten one.
2. **It is the only phase with a schema migration.** `seen_papers.arxiv_id` is a
   PRIMARY KEY, `discovered_via` is a CHECK constraint, `drafts.paper_arxiv_id`
   joins back to it, and `seenLedger.ts` names `arxiv_id` in roughly thirty places.
   Migrating a live database that the daily job writes to is a real risk taken for
   a benefit that is currently zero, because there is no second source.
3. **Done perfectly, it delivers nothing** until identity resolution is also
   swappable. See the Understander argument above.

### Recommendation

Implement **Phase 0, Phase 1, Phase 2, and Phase 3**. They are behavior-preserving,
provable by the verification steps above, and Phase 2 is a prerequisite for the
identity-resolution work that general outreach actually depends on. Budget: one
focused day, most of it verification rather than typing.

**Do not implement Phase 4.** Write the `Source` and `SourcedCandidate` types into
`ports.ts` as a design record so the intent survives, but leave `DiscoverySource`,
`Candidate`, and the `seen_papers` schema exactly as they are until a spec exists
for a specific second source. When that spec arrives, it will (a) tell us the real
shape of `CandidateEvidence` and (b) have to pay for the identity anchor anyway, at
which point the schema migration is a justified cost in service of a visible
feature rather than plumbing for its own sake.

If the reader's instinct is "then why write the Source interface at all", that is a
fair reading, and the answer is only that decision 1 was asked for and the design
record is cheap. The interface is not the deliverable; the staging is.

## Risks

- **A refactor that touches the gates is exactly the refactor this project's
  history says goes wrong.** Nine specs came back NEEDS REVISION, and the recurring
  cause was a claim about the code that evaporated on inspection. Mitigation: no
  existing test assertion may be edited during Phases 1 through 3, and verification
  steps 3 and 4 diff real output rather than trusting green.
- **`Understanding` is a large object crossing an interface.** It carries facts,
  hooks, a summary, and a `personId` that is a DB row. That is a leaky boundary: the
  Understander owns persistence, so a second Understander inherits the obligation to
  write `people` and `ontology_facts` correctly. The alternative (make the
  orchestrator own persistence) was rejected because `computeIntersections` reads
  facts back out of the DB (`intersect.ts:53,56`), so hooks cannot be computed
  without a write first. Accepted, and named here so it is not rediscovered as a
  surprise.
- **`enrich` returning the input unchanged on failure is indistinguishable from
  `enrich` finding nothing.** Both are correct behavior today and neither is an
  error, but it means "is paid enrichment still worth it" cannot be measured from
  the interface. The hook-first spec already flagged that such a measurement must
  slice hooks by `ontology_facts.retrieved_at`. Unchanged by this spec.
- **Two `processCandidate`s.** `loop.ts:345` already defines a local
  `processCandidate`. The new orchestrator entry point is named `runPipeline`
  specifically to avoid the collision. Do not rename either.
- **Optional deps default to the real implementation.** `understander?` and
  `reacher?` defaulting inside `processPaper` is what keeps every existing test
  passing, but it also means a caller that forgets to inject silently gets the
  arXiv/OpenAlex/Tavily stack. That is the desired behavior during migration and a
  latent trap afterwards. Phase 3 should make them required on `PipelineDeps` even
  while `OrchestrateDeps` keeps them optional.

## Out of scope

Each of these is a separate spec with its own problem/solution pair. None may be
folded in here.

- **Identity resolution without an academic anchor.** The actual blocker for
  general outreach. Needs its own spec, and it should be written next.
- **A second Source (LinkedIn, corporate lead lists, conference programs, GitHub)**
  and the `seen_papers` / `drafts` schema migration that Phase 4 requires.
- **A second Reacher** (Hunter, Apollo, pattern-plus-verify, manual CSV import).
- **Contact-provider swap away from Tavily**, including Playwright or DOM-based
  extraction.
- Making `drafted_unsendable` rows visible or retryable in `outreach stranded`,
  including the invisible `identity unconfirmed` bucket.
- Any change to drafting, approval, sending, the reply listener, or the persona
  subsystem.
- Deleting or reviving `src/pipeline/intake.ts`. It is cited here as evidence, not
  targeted for change.
