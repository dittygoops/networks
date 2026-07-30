# Technical Spec: Candidate Stranding

> Design: [`docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`](./superpowers/specs/2026-07-26-discovery-outreach-loop-design.md)
> (Sections 4, 5, 6, 9). Reads, and in one narrow case writes, the approval ledger owned by
> [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md): it reads
> `priorThreads` (F9) and `drafts.status` (AL4), and the only ledger write it ever makes is a
> `skip` decision through the existing `decide` (AL7 first-write-wins), never a `send`, never a
> new status literal. CS4.4 states that rule; CS3.4 and CS4.2 are the only two call sites.
>
> Scope is exactly one problem: work that the loop recorded and then lost. Finishing the
> `seen_papers` audit trail past the point of messaging (the unwritten `sent` and `rejected`
> statuses) is a different problem and lives in
> [`docs/spec-status-audit-trail.md`](./spec-status-audit-trail.md). This spec does not change
> discovery sources, the relevance gate, drafting, or grounding.

## Overview

`outreach loop` records every fresh candidate into `seen_papers` at status `discovered`
before it processes any of them, and no code path ever reads a `discovered` row back. Any
run that ends before the processing loop drains (a kill, a machine sleep, a launchd timeout,
an OOM, an error escaping the outer `try`) leaves its unprocessed candidates permanently
invisible to every future run, because `filterUnseen` excludes them by primary key regardless
of status. The papers are lost silently, with no reason recorded. This has happened three
times in real operation and each time required hand-written SQL to recover.

The same silent loss also happens without any crash at all, at higher frequency: a 30 second
arXiv or Tavily blip inside `processPaper`, or an LLM blip inside `generateDraft`, marks the
candidate `drafted_unsendable` terminally on attempt one and nothing ever looks at it again
(CS3.5).

This spec closes both gaps. It makes `discovered` behave the way the design already claims it
behaves ("a resting state that the next run picks up"), by adding a resume step at the front of
each run, an attempt counter that bounds retries, a draft-aware resume path so a candidate that
already has a persisted draft is messaged rather than re-drafted, and an operator surface so
nothing this spec parks can be parked invisibly.

This is a spec-versus-implementation gap, not a design change. Nothing here alters what the
loop is allowed to send.

### Safety invariants this spec preserves, and where

| Invariant | Where it is held |
|---|---|
| Nothing sends without an explicit human approval reply | CS4.6: no resume path may call `deps.sender.send`, and the loop may only ever write a `skip` decision, never `send` |
| Never email the same person twice | CS4.2 (mandatory `priorThreads` re-check before any resumed emit), CS4.3 (atomic draft plus pointer), CS5 (status-filtered draft load), CS6 (orphan handling) |
| A dry run sends nothing and texts nothing | CS7.5: under dry run the resume step drafts and parks but never messages, never decides, never abandons |
| Ambiguity resolves toward doing nothing, never toward sending | CS6.2 (two candidate drafts: send neither, report both), CS3.4 (never abandon a row whose draft is still live) |

### Corrections applied during implementation

A pre-merge review found four blocking defects in the draft of this spec. All four are fixed
in the shipped code, and this document has been edited throughout to describe the corrected
design rather than the original one. They are recorded here as a single index; each is also
called out inline at its section.

**C1 (the most important one).** The draft put the mandatory pre-emit `priorThreads` re-check
(CS4.2) only on the resume path. That left the queued flush emitting with **no**
never-email-twice check at all, and a row sitting at `queued_for_message` can wait a day or
more, during which `outreach add` or `outreach listen` can give that person a thread. Fixed by
moving the check into `loadSendableDraft` (CS5), the one query both the flush and the resume
step share, so neither caller can independently forget it.

**C2.** The draft's CS5.3 table covered draft states but not a missing person email, leaving a
second silent `continue` in place (the same silent-drop class this whole spec removes
everywhere else). It also would have let CS6.1's orphan adoption adopt an `outreach add`
manual-lookup-queue draft (deliberately created with no email, and never linked into
`seen_papers`), which the loop can never message either. Fixed: the no-email case now gets an
explicit resolution with a recorded reason, and orphan adoption is restricted to drafts whose
person has a resolved email.

**C3.** The draft's `summary.stranded` was a monotone lifetime counter (it matched rows by
reason prefix with no window), so the texted daily line would read `stranded 3`, then `4`,
never returning to zero, defeating the whole point of a number meant to be noticed. It also
counted every normal in-flight `outreach add` draft awaiting a reply as stranded, a false
positive in the alarm itself, since such a draft is not something this system stranded at all.
Fixed: `stranded` is now a per-run delta (rows this run's sweep or ambiguity handling actually
parked), and the definition of an "orphan" draft excludes any draft whose paper the loop never
discovered (no `seen_papers` row exists for its arxiv id at all), which is exactly the shape of
a normal `outreach add` draft.

**C4.** The draft had a dry run claim a row (incrementing `attempts`) while performing no
sweep, and also mandated a dry run as the first post-merge step (CS10.5). Three rehearsal dry
runs would have pushed every resumable row to the abandon threshold, and the very first real
run would then abandon the entire backlog: a rehearsal destroying the work it rehearses. Fixed:
`claimCandidate` is never called under `dryRun: true`, for both fresh and resumed candidates.

Two further non-blocking issues were fixed at the same time: `getQueued`'s reorder to
age-first broke an existing ordering test the original draft never mentioned (CS7.3, updated
below along with `test/seenLedger.test.ts`), and CS9's status table listed `rejected` as a
legal `drafts.status`, which it is not (the schema `CHECK` only allows `awaiting_approval`,
`approved`, `sent (stubbed)`, `sent`, `skipped`); `sent (stubbed)` is legal there and is now
explicitly covered by `loadSendableDraft`'s `decided_out_of_band` handling.

## 1. Root cause

Verified against the code on `main`. Line numbers are from the working tree at the time of
writing and are stated as anchors, not as contract.

**1.1 The ledger is written before the work, and read back only for one status.**

`runLoop` (`outreach/src/pipeline/loop.ts:388-394`) does, in order:

```ts
const fresh = filterUnseen(deps.db, discovered.candidates);
summary.seen = fresh.length;
for (const c of fresh) recordDiscovered(deps.db, c);   // all rows written up front

for (const c of fresh) {
  await processCandidate(deps, opts, summary, c);      // then processed one at a time
}
```

`recordDiscovered` (`outreach/src/discovery/seenLedger.ts:29-33`) inserts without a status,
so the row takes the column default `'discovered'` (`outreach/src/db/schema.sql:106-107`).

**1.2 `filterUnseen` ignores status.**

`outreach/src/discovery/seenLedger.ts:15-26` drops any candidate whose `arxiv_id` exists in
`seen_papers`, with no status predicate:

```ts
const stmt = db.prepare('SELECT 1 FROM seen_papers WHERE arxiv_id = ?');
```

So once a row exists, rediscovery is a no-op forever. That is correct and desirable for
terminal statuses. It is fatal for a resting one.

**1.3 Nothing reads `discovered` rows back.**

`getQueued` (`outreach/src/discovery/seenLedger.ts:62-70`) is the only reader of the ledger
that returns rows, and it selects `status = 'queued_for_message'` only. A repo-wide search for
`seen_papers`, `getQueued`, `filterUnseen`, `recordDiscovered`, and `setStatus` across `src/`,
`test/`, and `scripts/` finds `outreach/src/pipeline/loop.ts` as the sole caller. No query
anywhere selects `status = 'discovered'`.

**Therefore:** the interval between `recordDiscovered` and the candidate's own
`processCandidate` call is a loss window. Every candidate not yet reached when the process dies
is stranded permanently, with `status = 'discovered'`, `relevance = NULL`, and `reason = NULL`.
The outer `try/catch` at `outreach/src/pipeline/loop.ts:395-401` does not help: it catches an
escaped error but does not resume the remaining candidates, and it cannot catch a `SIGKILL` or
a power loss at all.

**1.4 The narrower variant: a persisted draft that is never messaged.**

Inside `processCandidate`, the success path is (`outreach/src/pipeline/loop.ts:263-273`):

```ts
const persisted = persistDraft(deps.db, {...});
setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, persisted.draftId);
await emit(deps, opts, summary, c, persisted.shortId, ...);
```

`persistDraft` and `setStatus` are two separate transactions, and `emit` is a third write.
A crash between `persistDraft` and `setStatus` leaves a draft row at `awaiting_approval` that
the ledger does not point at. A crash between `setStatus` and `emit` leaves the ledger pointing
at a real draft that was never messaged. Both are permanent under 1.1 through 1.3.

The second case is worse than a lost candidate, because the orphan draft at `awaiting_approval`
is matched by `priorThreads` (`outreach/src/approval/ledger.ts:134-144`, which matches
`status LIKE 'sent%'`, `approved`, and `awaiting_approval`). So even a hypothetical
rediscovery of that paper would be marked `drafted_unsendable` with reason "prior thread
exists", and the person would silently never be contacted while the ledger reports a thread
that does not exist. **Any rule this spec adds must therefore never leave a row terminal while
its draft is still sitting at `awaiting_approval`** (CS3.4).

**1.5 Drafting is not single-process, and the two processes check the guard in opposite
orders.**

`persistDraft` is called from two places that are separate OS processes:

- `outreach/src/pipeline/loop.ts:263`, the batch loop, which checks `priorThreads` at
  `loop.ts:248`, **before** persisting.
- `outreach/src/cli.ts:293`, the interactive `outreach add <arxiv-id>` flow, which checks
  `priorThreads` at `cli.ts:329`, **after** persisting, and passes `excludeDraftId` so its own
  just-created row does not match itself.

Consequences that matter to this spec:

1. A `drafts` row at `awaiting_approval` can appear for a person at any moment from a process
   the loop knows nothing about. So "the loop is the only writer" is false, and any resume
   requirement premised on it is unsound.
2. The two orders are not equivalent. Because `cli.ts` persists first, there is a real interval
   in which the CLI has created an `awaiting_approval` draft that it has not yet decided is
   allowed, and in that interval a concurrent loop run sees a non-empty `priorThreads` and
   correctly refuses. The reverse race also exists: both processes can read an empty
   `priorThreads` and both go on to draft the same person.
3. `outreach add` never touches `seen_papers` at all, so every draft it creates is, from the
   ledger's point of view, an orphan (CS6).
4. A third process, the `outreach listen` daemon, writes `decisions` and `drafts.status`
   concurrently with a run. So a draft that was `awaiting_approval` when the resume step
   selected it can be `skipped` or `sent` by the time the step reaches it (CS5).

This spec does not fix the two-process drafting race. It is a run-lock problem and it exists
today. What this spec must do, and does, is stop **assuming** single-writer anywhere, re-read
the guard at the last moment before any emit (CS4.2), and filter on live draft status at the
moment of use rather than at the moment of selection (CS5). CS3's attempt counter bounds the
damage of the race it does not fix.

**1.6 Current database state, measured.**

`outreach/data/outreach.db`, measured directly with `openDb` on the date of this revision:

| Query | Result |
|---|---|
| `seen_papers` total | 25 |
| `seen_papers` by status | 21 `drafted_unsendable`, 2 `filtered_low_relevance`, 2 `messaged` |
| `seen_papers` at `discovered` | **0** |
| `seen_papers` with non-null `draft_id` | **2** (`2512.05693` to `d7`, `2402.15505` to `d8`, both rows at `messaged`) |
| `drafts` by status | 2 `sent` (`d7`, `d8`), 6 `skipped` (`d1` to `d6`) |
| `drafts` at `awaiting_approval` | **0** |
| Orphan `awaiting_approval` drafts (no `seen_papers` pointer) | **0** |
| `seen_papers` has an `attempts` column | No |
| `journal_mode` | `wal` |

Read this as three facts. First, there is no live backlog to rescue today: the three historical
stranding incidents were cleaned by hand. Second, two real cold emails have now been sent
(`d7`, `d8`), so the cost of a mistake in this spec is no longer hypothetical. Third, both
sent drafts have a `seen_papers` row still at `messaged`, which is the audit-trail gap now
tracked in [`docs/spec-status-audit-trail.md`](./spec-status-audit-trail.md), not here.

The migration in Section 5 must still handle a backlog, because the bug is live until this spec
is implemented and the next interrupted run will create one. The implementer re-measures before
merging (CS10.2).

## 2. Resolved Decisions

### CS1. Mechanism: resume `discovered` rows at the start of the next run

**Decision.** `discovered` becomes a genuine resting state. Each run, after the
`queued_for_message` flush and before discovery, selects rows at `status = 'discovered'`,
reconstructs a `Candidate` from the stored columns, and runs them through the same
`processCandidate` path as fresh candidates. `filterUnseen` is unchanged.

**Alternatives considered.**

| Option | Why not chosen |
|---|---|
| **A. Resume `discovered` rows next run** (chosen) | Matches the design's stated semantics exactly, needs no schema rebuild, keeps a durable audit row for every candidate the loop ever saw, and reuses the existing `processCandidate` path so there is one drafting code path, not two. |
| **B. Do not record until processed** | Removes the loss window only if the source re-surfaces the paper. `saved_query` and `author_watch` are recency-windowed, so a paper that ages out of the window is never seen again: the same silent loss, now nondeterministic and untestable. It also destroys the "what did the loop see" audit record, which is the ledger's other job. |
| **C. Distinct pre-processing status (`processing` / `claimed`)** | Semantically cleaner, but `seen_papers.status` carries a `CHECK` constraint and SQLite cannot alter a `CHECK`. Worse, `openDb` applies `schema.sql` with `CREATE TABLE IF NOT EXISTS` on every open, so an edited `CHECK` in `schema.sql` never reaches an existing database at all: it is silently ignored, and the new literal fails at write time. Adding a value means rebuilding the table (new table, copy, drop, rename) on a live database that has an FK into `drafts`, for information CS3's attempt counter already carries (`attempts = 0` means never started, `attempts >= 1` means started and did not finish). Rejected as risk without payoff. This is the same reason CS4.4 reuses `via = 'cli'` rather than adding a `'loop'` literal to `decisions.via`. |
| **D. Staleness timeout (retry rows older than N hours)** | A lease needs a threshold that is wrong in both directions: too short and a legitimately long in-flight run gets its rows stolen, too long and a crash strands work for hours. Rejected. Note that the single-writer argument that would otherwise support a lease is false (1.5), which is why CS4.2 re-checks the guard at emit time instead of relying on any timing assumption. |

**CS1.1** Resume order within a run is: drain approvals, retry approved-but-unsent, flush
`queued_for_message`, **resume `discovered`**, discover fresh, process fresh. Resumed work
precedes new discovery for the same reason queued work does: the design's rule that older
committed work goes out ahead of newly found work.

**CS1.2** Resumed rows are selected oldest first by `first_seen_at`, then `arxiv_id` for a
stable tiebreak, so a backlog drains in the order it accumulated and no row can starve behind
a churn of newer arrivals.

**CS1.3** The reconstructed `Candidate` uses the stored `arxiv_id`, `title`, `discovered_via`,
`source_detail`, and `abstract`. The abstract is newly persisted for exactly this reason: the
gate's `bestTermMatch` scores against title plus abstract
(`outreach/src/discovery/relevanceGate.ts`), so a resumed candidate reconstructed without one
scores systematically lower than it did as a fresh candidate, and a row that survives one
resume would be permanently penalised relative to fresh work. `recordDiscovered` stores
`Candidate.abstract` into a new nullable `abstract` column (Section 3), and the resume step
reads it back verbatim.

**CS1.4** A row whose `abstract` is NULL (any row recorded before the column existed, or a
source that supplies no abstract) is resumed with `abstract: undefined`. The gate already
accepts `abstract?`. Nothing fabricates an abstract and nothing refetches one: refetching adds
a network dependency to a recovery path, and inventing one is forbidden outright.

### CS2. The resume step assumes no single writer

**CS2.1** No requirement in this spec may be justified by "only one process does X". 1.5
records the three processes that write drafts and decisions (`outreach loop`, `outreach add`,
`outreach listen`). Every requirement below is written to be correct when another process
mutates `drafts` between the moment a row is selected and the moment it is acted on.

**CS2.2** The consequences are concentrated in three requirements, and an implementer who
follows those three does not need to reason about concurrency anywhere else: CS4.2 (re-check
`priorThreads` immediately before any emit), CS5 (the shared draft load filters
`d.status = 'awaiting_approval'`), and CS4.4 (the only ledger write the loop makes is a `skip`
through `decide`, which is first-write-wins, so a concurrent human decision always beats it).

**CS2.3** The two-process drafting race in 1.5 point 2 is out of scope and belongs to a
run-lock spec. It is pre-existing, it is not widened by anything here, and CS3's attempt
counter bounds its cost.

### CS3. Bounded attempts, so nothing retries forever and nothing gives up on attempt one

**CS3.1** `seen_papers` gains `attempts INTEGER NOT NULL DEFAULT 0`.

**CS3.2** `claimCandidate(db, arxivId)` increments `attempts` in its own committed statement
immediately **before** `processCandidate` runs, for both fresh and resumed candidates. The
increment must be durable before the work starts, otherwise a crash does not count and a
poison candidate that hard-kills the process (an OOM on a pathological PDF) would be resumed
by every future run and kill every future run, turning a silent data loss bug into a total
outage.

**CS3.3** The resume selection excludes rows at `attempts >= maxResumeAttempts`
(config `gate.max_resume_attempts`, default 3).

**CS3.4 Exhaustion, split by whether a draft exists. This is the safety-critical half.**

A row at `discovered` that has reached the attempt limit is swept in the same pass, and what
happens depends entirely on `draft_id`:

- **`draft_id IS NULL`.** Nothing was created for this candidate, so abandoning it costs only
  the candidate. Set `status = 'drafted_unsendable'`, reason
  `abandoned after N attempts: <last recorded reason>`. `drafted_unsendable` is reused rather
  than adding a status, for the `CHECK` reason in CS1 option C.
- **`draft_id IS NOT NULL`.** The row owns a real draft. Marking the row terminal here would
  leave that draft at `awaiting_approval` forever, where `priorThreads` matches it, which makes
  the person **permanently uncontactable** by this system while the ledger reports a thread
  that was never sent. That is precisely the failure 1.4 calls worse than a lost candidate, so
  it is forbidden. Instead the sweep retires the draft first and only then retires the row, as
  one atomic unit: `decide(db, draftId, 'skip', 'cli', 'loop: abandoned after N attempts')`,
  then `setStatus(..., 'drafted_unsendable', 'abandoned after N attempts, draft dX skipped')`.
  If `decide` reports `applied: false`, a human already decided that draft, so the draft is
  already out of `awaiting_approval` and the row is simply marked terminal with the existing
  decision named in the reason.

The `skip` in the second case is the only write this spec makes into the approval ledger. It is
safe by construction in three independent ways: `decide` only ever accepts `'send'` or
`'skip'` and this call site passes `'skip'` literally, so no code path here can approve
anything; `decide` is first-write-wins on `UNIQUE(draft_id)`, so it can never overwrite a human
decision; and skipping strictly reduces what the system may send.

**CS3.5 Transient failures come under the counter.** Today a thrown error inside
`deps.processPaper` (`loop.ts:219-226`, reason `pipeline failed: ...`) or anywhere else in
`processCandidate` (`loop.ts:274-280`, reason `pipeline error: ...`) marks the candidate
terminal on attempt one. A 30 second arXiv, Tavily, or OpenRouter blip therefore causes the
same permanent silent loss this spec exists to remove, at far higher frequency than a crash.
The rule, which is deliberately mechanical so it needs no judgment at the call site:

> **A thrown error is retryable. A returned verdict is terminal.**

- A thrown error from `deps.processPaper`, `deps.generateDraft`, or the outer `catch` in
  `processCandidate` leaves the row at `status = 'discovered'` with the error text written to
  `reason` (`setStatus(..., 'discovered', 'attempt N failed: <msg>')`) and pushes to
  `summary.errors` as it does today. `attempts` was already incremented by CS3.2, so the row
  is retried by the next run and eventually abandoned per CS3.4. It is not counted in
  `summary.unsendable`; it is counted in a new `summary.retryable`.
- A *returned* terminal verdict is unchanged and stays terminal on attempt one:
  `filtered_low_relevance`, `identity unconfirmed` (`loop.ts:229`),
  `identityCollisionReason`, `no email resolved` (`loop.ts:239`), `no grounded hook`
  (`loop.ts:244`), `grounding failed` (`loop.ts:258`), and `prior thread exists`. These are
  decisions the pipeline made successfully, not failures to make one. Retrying them would burn
  three runs of LLM budget to reach the identical answer.

**CS3.6** `gateCandidate` is deliberately not on the retryable list. It already catches its own
LLM failure internally and returns a deterministic fallback verdict
(`outreach/src/discovery/relevanceGate.ts`, the `catch` that returns
`borderline <score>, judge unavailable`), so a judge outage cannot throw out of the gate and
cannot strand anything. No change there.

### CS4. Idempotent resume, and the never-email-twice guard

This is the highest-risk part of the change.

**CS4.1 A resumed row with a draft is emitted, never re-drafted.** When a resumed row has
`draft_id IS NOT NULL`, the resume step **must not** call `deps.processPaper`,
`deps.generateDraft`, or `persistDraft`. It loads the existing draft through the shared query
in CS5 and goes to emit. This is the crash-between-`setStatus`-and-`emit` window from 1.4, and
re-running the pipeline there would create a second draft for a person who already has one.

**CS4.2 Every sendable-draft load re-runs `priorThreads` immediately before emitting. Mandatory,
no exceptions, and shared by both callers (correction C1).** The original draft of this spec put
this re-check only on the resume path, which left the queued flush (CS7.2's deferred rows,
sometimes a day or more old) emitting with **no** never-email-twice check at all. The check
instead lives inside `loadSendableDraft` (CS5), the one query the flush and the resume step both
call to load a sendable draft: it calls `priorThreads(db, personId, /* excludeDraftId */
row.draftId)` immediately after confirming the draft is grounded and its person has an email,
and returns a `prior_thread` result instead of `ok` when that comes back non-empty. Neither
caller can independently forget the check, because neither caller has its own copy of it.

This requirement exists because the interval between a draft being created (or last checked)
and it being emitted is unbounded and is not exclusive (1.5). In that interval the same person
can acquire a `sent`, `approved`, or `awaiting_approval` draft from `outreach add`, from
`outreach listen` acting on a reply, or from a later loop run reaching them by a different
paper. Without this re-check, a resumed or queued row goes straight to emit with **no**
never-email-twice check at all, and the human is asked to approve a second cold email to a
researcher who has already been contacted. Approving it would send it. That is the single worst
outcome this system can produce.

`priorThreads` already takes `excludeDraftId` (`outreach/src/approval/ledger.ts:134`) for
exactly this shape of caller, and passing the row's own `draft_id` is what stops the row from
matching itself and refusing forever, which is the 1.4 false positive.

When `priorThreads` is non-empty for a row that has its own draft, the caller (flush or resume)
does not emit, and it applies CS3.4's draft-bearing philosophy so the row's own now-superseded
draft does not linger at `awaiting_approval`: `decide(db, row.draftId, 'skip', 'cli', 'loop:
superseded by prior thread dX')` (skipped under a dry run, see CS7.5), then
`setStatus(..., 'drafted_unsendable', 'prior thread exists (dX), own draft dY skipped')`. When
`priorThreads` is non-empty for a row with no draft yet (the fresh-drafting path inside
`processCandidate`), the existing behaviour applies unchanged: `drafted_unsendable`, reason
`prior thread exists (dX)`.

**CS4.3 The draft and the ledger pointer are written atomically.** `persistDraft` and the
following `setStatus(..., 'discovered', reason, persisted.draftId)` in `processCandidate`
(`loop.ts:263-272`) are wrapped in one `db.transaction`, so no crash can produce a draft the
ledger does not reference:

```ts
const persisted = db.transaction(() => {
  const p = persistDraft(deps.db, {...});
  setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, p.draftId);
  return p;
})();
```

`better-sqlite3` nests transactions as savepoints, so `persistDraft`'s own internal transaction
remains correct. This closes the window going forward. It does not help drafts created before
it exists, or drafts created by `outreach add`, which is what CS6 is for.

**CS4.4** The loop's only write into the approval ledger is `decide(..., 'skip', 'cli', ...)`,
from CS3.4 and CS4.2. `via = 'cli'` is reused rather than adding a `'loop'` literal because
`decisions.via` carries a `CHECK` (`outreach/src/db/schema.sql:86`) and the CS1 option C
argument applies verbatim. The reason string always begins `loop: ` so the audit trail
distinguishes it from a real terminal approval.

**CS4.5** The `priorThreads` status set (`sent%`, `approved`, `awaiting_approval`) is unchanged.
It already covers every state a real prior thread can be in.

**CS4.6** No resume path may call `deps.sender.send`. Resume only ever reaches
`channel.sendDraftMessage`, which asks for approval. The invariant that an email leaves only in
response to an explicit human reply is untouched by this spec.

### CS5. One draft-loading query, and it filters on live draft status

**CS5.1** The `queued_for_message` flush's inline draft query is extracted into one exported
helper, `loadSendableDraft(db, arxivId): SendableLookup`, used by both the flush and the resume
path so the two cannot drift. It returns a tagged union rather than a plain row, because it now
resolves every state a draft can be in at load time, not just "found" or "not found":
`ok` (sendable, no conflicts), `prior_thread`, `decided_out_of_band`, `not_grounded`, `no_email`
(correction C2), and `dangling`.

**CS5.2** The query adds a predicate the pre-spec inline query lacked:

```sql
SELECT s.draft_id AS draftId, d.status AS draftStatus, d.person_id AS personId,
       d.sendable_revision_id AS sendableRevisionId, d.short_id AS shortId,
       r.subject AS subject, r.body AS body
FROM seen_papers s
LEFT JOIN drafts d ON d.id = s.draft_id
LEFT JOIN revisions r ON r.id = d.sendable_revision_id
WHERE s.arxiv_id = ?
```

The joins are `LEFT`, not `INNER`: a dangling `draft_id` (points at a `drafts` row that does not
exist) must be distinguishable from "no draft_id at all", which an `INNER JOIN` would collapse
into the same empty result. The pre-spec inline query joined on `sendable_revision_id` with no
status predicate at all. Because `drafts.status` is mutated by two other processes (1.5 point
4), a draft that was decided out of band, a `skipped` from `outreach listen` or from a CLI
decision, satisfied that query and got re-texted, asking the human to re-approve something they
already declined. `loadSendableDraft` checks `draftStatus === 'awaiting_approval'` explicitly
before treating anything as sendable.

**CS5.3 (extended by correction C2 for the no-email case)** A lookup that is not `ok` is not
left to a silent `continue`, because that is how work goes missing. The caller
(`resolveSendableDraft`, itself shared by the flush and the resume step) resolves each kind
explicitly:

| `loadSendableDraft` result | Action |
|---|---|
| `decided_out_of_band` with draft status `skipped` | `setStatus(..., 'drafted_unsendable', 'draft dX was skipped out of band')`. Terminal, and the draft is already out of `awaiting_approval`, so the person is not blocked. |
| `decided_out_of_band` with draft status `sent`, `sent (stubbed)`, or `approved` | `setStatus(..., 'messaged', 'draft dX already approved out of band')`. The row is not terminal here on purpose: the audit trail past this point is [`docs/spec-status-audit-trail.md`](./spec-status-audit-trail.md)'s problem, and `messaged` is the correct resting state today. |
| `not_grounded` (`awaiting_approval` but `sendable_revision_id IS NULL`) | `setStatus(..., 'drafted_unsendable', 'draft dX has no grounded revision, draft skipped')`, and the draft is retired (`decide(..., 'skip', ...)`, skipped under a dry run per CS7.5) per CS3.4's draft-bearing philosophy so it does not block the person forever. |
| `no_email` (correction C2: the draft's person has no email on record) | `setStatus(..., 'drafted_unsendable', 'no email on record for draft dX, draft skipped')`, and the draft is retired the same way. This is the explicit resolution that replaces the `if (!person?.email) continue;` the original draft of this spec left in place at the flush site, the same silent-drop class this whole spec exists to remove. |
| `prior_thread` (correction C1: the mandatory re-check, now run for every load, found a conflict) | `decide(db, draftId, 'skip', 'cli', 'loop: superseded by prior thread dX')` (skipped under a dry run), then `setStatus(..., 'drafted_unsendable', 'prior thread exists (dX), own draft dY skipped')`. |
| `dangling` (`draft_id` set but no such `drafts` row, or no `draft_id` at all; only reachable by manual SQL) | `setStatus(..., 'discovered', 'draft_id dX does not exist')` and report through CS8. Ambiguity resolves toward doing nothing. |

The `if (!row) continue;` that the original inline flush query had is gone; every branch above
writes something. All `decide` calls in this table are skipped under `dryRun: true` (CS7.5): the
row is still marked, with a note that the draft was not retired.

### CS6. Orphan drafts: adopt the unambiguous one, report the ambiguous one

`outreach add` creates drafts and never touches `seen_papers` (1.5 point 3), and any draft
created before CS4.3 may have lost its pointer to a crash. So a resumed row with
`draft_id IS NULL` can nonetheless have a real draft already sitting at `awaiting_approval`
for its paper, and drafting again would produce a second cold email for one person.

**CS6.1 Adoption, restricted to a resolved email (correction C2).** Before drafting, a resumed
candidate with `draft_id IS NULL` looks for an *adoptable* draft: a `drafts` row with
`paper_arxiv_id = <candidate arxiv id>` and `status = 'awaiting_approval'`, **whose person has a
non-null email**, that no `seen_papers` row already points at. If exactly one exists, the row
adopts it (`setStatus(..., 'discovered', 'adopted orphan draft dX', draftId)`) and then proceeds
exactly as CS4.1 and CS4.2 require, including the `priorThreads` re-check (via
`loadSendableDraft`/`resolveSendableDraft`, CS5).

The email restriction was not in the original draft of this spec and is a blocking correction.
`outreach add` deliberately parks a draft with **no** email at `awaiting_approval` as a
manual-lookup queue (`cli.ts`: "no email found: draft stays awaiting_approval in the manual-lookup
queue"), and that draft never touches `seen_papers` either, so from the ledger's point of view it
is structurally identical to an adoptable orphan. Without the restriction, adoption would attach
a candidate to a draft the loop can never message (it has no email to send to), which steers the
resumed row straight into the `no_email` branch of CS5.3 instead of ever drafting fresh for a
person the loop might actually be able to reach.

**CS6.2 Ambiguity.** If more than one adoptable draft exists, nothing is sent and nothing is
guessed: `setStatus(..., 'drafted_unsendable', 'ambiguous orphan drafts (dX, dY): see outreach
stranded')`. The orphan drafts themselves are left exactly as they are, at
`awaiting_approval`, because retiring one is a decision about which cold email a real
researcher should receive and this system is not allowed to make it.

**CS6.3** CS6.2 does leave that person blocked by `priorThreads` until a human acts, which is
the one place this spec knowingly trades reachability for safety. It is acceptable only because
the state is loud rather than silent: it is counted in the run summary line every day and
listed by `outreach stranded` (CS8), and the human's remedy already exists and needs no new
code, a `dX n` reply to the listener retires the draft they do not want. Without CS8 this would
recreate the exact bug this spec fixes, so CS8 is not optional.

### CS7. Message cap, flush order, and starvation

**CS7.1** `summary.messaged` stays a single counter for the whole run. The queued flush, the
resume step, and fresh processing all check and increment the same counter, so the per-run cap
`gate.max_messages_per_run` (default 3) is a whole-run budget and nothing is double counted.

**CS7.2** A resumed candidate that becomes sendable when the budget is already spent takes the
existing path in `emit`: `queued_for_message`, reason `deferred by max_messages_per_run`. It is
then handled by the flush step of a later run. Recovery adds no new deferral mechanism.

**CS7.3 `getQueued` is reordered from relevance-first to age-first.** It currently orders
`relevance DESC, arxiv_id` with a limit of `maxMessagesPerRun`, default 3. Combined with CS7.2,
that permanently starves resumed rows: a resumed row that reconstructed without an abstract
scores lower than fresh work (CS1.3 stores the abstract, which fixes new rows but not rows
already in the ledger, whose `abstract` is NULL), so it sorts behind every fresh arrival, every
run, forever. The fix is one clause:

```sql
ORDER BY first_seen_at ASC, arxiv_id
```

Every row in `queued_for_message` has already cleared the relevance gate, so relevance has
already done its job and re-applying it as a queue priority buys nothing while making
starvation unbounded. Age-first also matches the design's existing rule that older committed
work goes out ahead of newer work, which is why the flush runs before discovery in the first
place. This changes existing behaviour and is asserted directly by CS-T8.

**CS7.4** The resume step is bounded by `gate.max_resume_per_run` (default 10) so a large
backlog cannot consume the whole run's LLM and API budget and starve discovery. New discovery
runs on every run regardless of backlog depth. With CS1.2's oldest-first order, a backlog of
any size drains deterministically over successive runs.

**CS7.5 Dry run, and correction C4: a rehearsal must never consume the attempt budget.** The
resume step runs in dry-run mode, because it is the same processing path and a dry run is meant
to exercise it, and it behaves as follows. It selects, drafts, and parks: `emit` puts the
candidate at `queued_for_message` with reason `dry run, not messaged`, which is the existing
dry-run behaviour for fresh candidates. So a dry run does mutate the ledger and can create real
`drafts` rows, exactly as it does today for fresh candidates.

The original draft of this spec additionally said a dry run "does consume attempts", i.e. that
`claimCandidate` runs unconditionally before both fresh and resumed processing. That is wrong
and was corrected (C4): `runLoop` and the resume step both call `claimCandidate` only when
`!opts.dryRun`. CS10.5 mandates a dry run as the very first execution after merge, and the
un-corrected behaviour would have let three rehearsal dry runs push every resumable row to
`attempts = maxResumeAttempts`, so the *first real run* would abandon the entire backlog before
ever actually trying it, a rehearsal destroying the work it exists to rehearse.

What a dry run must **not** do, restated against the shipped code:

- No `channel.sendDraftMessage` and no `sender.send`, so it texts nothing and sends nothing.
  This is existing `emit` behaviour plus CS4.6.
- No `decide` call anywhere. This now covers every `decide` call site introduced by this spec,
  not only the exhaustion sweep: `resolveSendableDraft` (CS5.3's `prior_thread`, `not_grounded`,
  and `no_email` branches) takes a `dryRun` flag and skips its `decide` call under it, recording
  in the reason that the draft was not retired.
- No attempt increment (correction C4): `claimCandidate` is skipped entirely.
- No exhaustion sweep (CS3.4), because that writes terminal statuses and retires drafts.
  `getExhausted` still runs unconditionally so the count is still reported (CS8), but none of
  its writes execute under `dryRun: true`.

**CS7.6** The resume step is failure-isolated like every other stage: it is wrapped in its own
`try/catch` that pushes to `summary.errors`, so a resume failure never prevents discovery
(design Section 9, F1).

### CS8. Operator surface, so nothing this spec parks is parked invisibly

Every state introduced or reused above needs either a code path that picks it up or a human who
is told about it. Two states have no automatic reader by design: CS3.4's abandoned rows and
CS6.2's ambiguous-orphan rows, both terminal at `drafted_unsendable`. Leaving them at that
without a surface would recreate the class of bug this spec fixes.

**CS8.1 `summary.stranded` is a per-run delta, not a lifetime total (correction C3).** The
original draft of this spec defined `stranded` as an end-of-run query: rows at `discovered`
whose `attempts >= maxResumeAttempts`, plus rows whose reason begins `ambiguous orphan drafts`
or `abandoned after`, plus orphan `awaiting_approval` drafts with no `seen_papers` pointer. That
is a monotone lifetime count, since terminal rows never stop matching their own reason text: the
texted line would read `stranded 3`, then `4`, and never return to zero, which defeats the
purpose of a number meant to be *noticed*. Worse, the orphan-draft term counted every normal
in-flight `outreach add` draft still awaiting a reply as stranded, a permanent false positive
(see CS8.1's orphan definition, corrected below).

Shipped instead: `LoopSummary` gains `resumed`, `retryable`, and `stranded` as counters
incremented in place, during the run, at the exact moments something is actually parked:

- `+1` in the resume step for each row marked `ambiguous orphan drafts` (CS6.2), during that
  run's resume pass.
- `+1` in the exhaustion sweep (CS3.4) for each row it abandons, during that run's sweep, whether
  or not the row owned a draft.
- Under `dryRun: true`, the sweep does not run (CS7.5), but `getExhausted`'s count is still added
  to `stranded` so a rehearsal still reports what a real run would abandon, without abandoning it.

The run summary line gains `resumed N` always, plus `retryable N` and `stranded N` only when
non-zero, so a non-zero `stranded` cannot scroll away unnoticed for long, but a quiet run reads
quiet.

**CS8.2 The `outreach stranded` orphan-draft definition is restricted to drafts the loop could
plausibly have adopted (correction C3).** A `drafts` row at `awaiting_approval`, with a resolved
email (excluding, as CS6.1 does, an `outreach add` manual-lookup-queue draft), whose paper the
loop **has actually discovered** (a `seen_papers` row exists for its arxiv id), but which no
`seen_papers` row currently points at. The "loop has discovered this paper" clause is the
correction: without it, every `outreach add` draft for a paper the loop never saw at all (which
is most of them, since `outreach add` is normally run on a paper found by hand) would appear as
an "orphan" forever, even though it is simply a normal draft awaiting the human's reply, nothing
this system stranded. `outreach stranded`, a new read-only command, prints this list alongside
every row at `discovered` with its `attempts`, `first_seen_at`, and last `reason`, and every row
abandoned or marked ambiguous with its `draft_id`. It writes nothing, takes no arguments, needs
no API keys, and is dispatched in `outreach/src/cli.ts` alongside `loop` and `listen`. Read-only
is deliberate: the remedy for every case it prints is an existing human action (a `dX n` reply,
or `outreach add` on the paper), and a `--fix` flag would be a second code path making sending
decisions.

**CS8.3** `attempts`, `abstract`, and the reason text are the whole diagnostic record. No new
table and no new event type. `draft_events` remains the append-only log for draft history.

### CS9. What each status means after this change

| Status | Meaning | Who moves it |
|---|---|---|
| `discovered` | Recorded, not yet resolved. `attempts = 0`: never started. `attempts >= 1`: started and either interrupted or failed with a thrown error (CS3.5), with the error in `reason`. Also the transient state between drafting and messaging within one run. | The resume step, next run (CS1). Reported by CS8 once `attempts` is exhausted. |
| `filtered_low_relevance` | Terminal. Gate said no. | Nothing |
| `drafted_unsendable` | Terminal. No email, no hook, prior thread, a returned terminal verdict, abandoned after N attempts (CS3.4), decided out of band (CS5.3), or ambiguous orphans (CS6.2). Whenever the row had a draft, that draft has been retired to `skipped` first, except in the CS6.2 ambiguous case where it is reported instead. | Nothing. Reported by CS8. |
| `queued_for_message` | Resting. Sendable draft deferred by the cap, by a dry run, or by a message failure. | The flush step, next run, oldest first (CS7.3) |
| `messaged` | Resting. Texted, awaiting the user's reply. | The reply drain, on reply |
| `sent`, `rejected` | Allowed by the schema and by `SeenStatus`, still written by no code. Out of scope here: [`docs/spec-status-audit-trail.md`](./spec-status-audit-trail.md). | Nothing yet |

Every non-terminal status now has exactly one code path that picks it up, and every terminal
state this spec can produce is either self-explanatory or listed by `outreach stranded`.

## 3. Data model

Two additive nullable-or-defaulted columns. No `CHECK` constraint changes, no table rebuild, no
new table.

```sql
ALTER TABLE seen_papers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE seen_papers ADD COLUMN abstract TEXT;
CREATE INDEX IF NOT EXISTS idx_seen_resume ON seen_papers(status, first_seen_at);
```

`outreach/src/db/schema.sql` gains both columns in the `CREATE TABLE` body (for fresh
databases) and the index. `openDb` executes `schema.sql` on every open and
`CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so an edit to the `CREATE
TABLE` body never reaches the live file. That is why the `ALTER`s need the guarded migration in
CS10.1, and it is the same mechanism that makes editing a `CHECK` constraint impossible
(CS1 option C).

`recordDiscovered` gains `abstract` in its insert. `SeenRow` in
`outreach/src/discovery/seenLedger.ts` gains `attempts`, plus the `discoveredVia`,
`sourceDetail`, `abstract`, `draftId`, and `firstSeenAt` fields the resume step needs to rebuild
a `Candidate` and report on it.

## 4. Interfaces

New or changed exports in `outreach/src/discovery/seenLedger.ts`:

```ts
// Rows to resume, oldest first (CS1.2), excluding exhausted ones (CS3.3).
export function getResumable(db: DB, limit: number, maxAttempts: number): ResumableRow[];

// Rows at 'discovered' whose attempts have run out. Swept by the caller per CS3.4.
export function getExhausted(db: DB, maxAttempts: number): ResumableRow[];

// Durable attempt increment (CS3.2). Called before processing, fresh or resumed.
export function claimCandidate(db: DB, arxivId: string): void;

// CS8.1 / CS8.2. Read-only.
export function strandedReport(db: DB, maxAttempts: number): StrandedReport;

export interface ResumableRow {
  arxivId: string;
  title: string;
  discoveredVia: DiscoveredVia;
  sourceDetail: string | null;
  abstract: string | null;
  draftId: number | null;
  attempts: number;
  firstSeenAt: string;
  relevance: number | null;
  status: SeenStatus;
  reason: string | null;
}
```

`strandedReport`'s shape (CS8.2, restricted per correction C3):

```ts
export interface StrandedReport {
  discovered: { arxivId: string; attempts: number; firstSeenAt: string; reason: string | null }[];
  terminalStranded: { arxivId: string; status: SeenStatus; reason: string | null; draftId: number | null }[];
  orphanDrafts: { shortId: string; personId: number; personName: string; paperArxivId: string | null }[];
}
```

Changed in `outreach/src/pipeline/loop.ts`:

```ts
// CS5. Extracted from the inline flush query, plus the never-email-twice
// re-check baked in (correction C1). Returns a tagged union, not a plain row,
// because CS5.3's whole resolution table lives on the caller side of this
// return value.
export function loadSendableDraft(db: DB, arxivId: string): SendableLookup;

export interface SendableDraft {
  draftId: number;
  shortId: string;
  personId: number;
  subject: string;
  body: string;
}

export type SendableLookup =
  | { kind: 'ok'; draft: SendableDraft }
  | { kind: 'prior_thread'; draft: SendableDraft; priorShortId: string }
  | { kind: 'decided_out_of_band'; draftId: number; status: string }
  | { kind: 'not_grounded'; draftId: number }
  | { kind: 'no_email'; draftId: number }             // correction C2
  | { kind: 'dangling'; draftId: number | null };
```

`loadSendableDraft` is not itself exported as taking a `dryRun` flag: the write side of CS5.3's
table (which `decide` calls to skip under a dry run, correction C4) lives in a private
`resolveSendableDraft(db, arxivId, summary, dryRun)` inside `loop.ts`, used by both the flush and
the resume step, so `loadSendableDraft` itself stays a pure read.

`getQueued`'s `ORDER BY` changes per CS7.3. Its signature does not.

New config in `outreach/src/discovery/config.ts` (`GateConfig`, both with defaults so
`config/watchlist.yaml` stays optional):

```yaml
gate:
  max_resume_per_run: 10      # CS7.4
  max_resume_attempts: 3      # CS3.3
```

`LoopSummary` gains `resumed: number`, `retryable: number`, and `stranded: number`, and the
summary line reports them per CS8.1, so an interrupted run is visible in the iMessage thread on
the following run rather than being invisible until someone reads the database.

## 5. Migration

**CS10.1 Schema.** Add a guarded migration in `openDb` (`outreach/src/db/db.ts`), run after
`schema.sql` is applied:

```ts
const cols = new Set(
  (db.prepare('PRAGMA table_info(seen_papers)').all() as { name: string }[]).map((c) => c.name),
);
if (!cols.has('attempts')) db.exec('ALTER TABLE seen_papers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
if (!cols.has('abstract')) db.exec('ALTER TABLE seen_papers ADD COLUMN abstract TEXT');
```

Idempotent, safe to run on every open, and correct for both a fresh database (columns already
present from `schema.sql`, so the guards skip) and the live one.

**CS10.2 Re-measure, do not trust Section 1.6.** Before merging, the implementer re-runs the
1.6 measurements against `outreach/data/outreach.db` and reports the numbers. 1.6 was measured
on the date of this revision and the database changes daily. In particular the count of rows at
`discovered` and of orphan `awaiting_approval` drafts determines whether the first real run has
a backlog to work through.

**CS10.3 Whatever backlog exists at implementation time is handled by the feature itself.** Any
row sitting at `discovered` when the new code first runs is picked up by the resume step with
`attempts = 0` and `abstract = NULL` (the column defaults), which is exactly right: those rows
were never started, and CS1.4 covers the missing abstract. No rescue script, and none should be
written on speculation.

**CS10.4 Backup before first run.** The implementer takes a timestamped copy of
`outreach/data/outreach.db` before the first real (non dry-run) execution of the new code,
matching the existing `outreach.backup-*.db` convention already in `outreach/data/`.

**CS10.5 First run is a dry run, and launchd stays disarmed until it passes.** The first
execution after merge is `outreach loop --dry-run`, and its summary line (including `resumed`,
and `retryable` or `stranded` if non-zero) plus the output of `outreach stranded` are shown
before `outreach/scripts/com.aditya.outreach.plist` is loaded. That plist has
`RunAtLoad: false` and a single `StartCalendarInterval` at 09:00, so loading it does not fire a
run.

## 6. Testing

All tests are vitest against `openDb(':memory:')` with stubbed deps, following the existing
`outreach/test/loop.test.ts` harness, except CS-T6 which needs a real child process and a real
file database.

**As shipped:** the CS-T scenarios below describe the required coverage; the actual tests live
in the new `outreach/test/stranding.test.ts` (resume, the shared CS4.2/C1 re-check on both the
resume and flush paths, C2's no-email resolution and orphan-adoption exclusion, C3's stranded
delta and false-positive exclusion, C4's dry-run attempt-budget test, orphan adoption and
ambiguity, the exhaustion sweep, and a reconstructed-crash test exercising the adopt-existing-
draft path), plus a migration test in `outreach/test/db.test.ts` (CS10.1) and the corrected
ordering test in `outreach/test/seenLedger.test.ts` (CS7.3). CS-T6's real-`SIGKILL`
child-process test was not implemented: it needs the most machinery of any test here for a claim
(CS-T7, the reconstructed-crash version, and the reconstructed-crash adopt-existing-draft test in
`stranding.test.ts`) already covered without it, and the same durability argument CS-T6's own
writeup makes ("this test makes no durability claim... `better-sqlite3` issues synchronous
writes and a committed transaction is already in the OS") applies to the decision not to build
it, not only to what it would prove. Two existing tests in `outreach/test/loop.test.ts` were
rewritten, not just extended, because CS3.5 changes what a thrown pipeline error means: a test
named "marks a candidate unsendable... when gateCandidate throws" asserted the *old*,
now-incorrect behaviour (a thrown error terminal on attempt one) and is renamed and reasserted
against the new one (`summary.retryable`, row stays `discovered`, `attempts` incremented). See
the correction note at the top of this document for why.

**CS-T1. Stranded row is resumed.** Seed a `seen_papers` row at `discovered` with
`attempts = 0` and no `draft_id`. Run `runLoop` with a source returning zero candidates.
Assert: `processPaper` was called for that arxiv id, the row is now `messaged`, and
`summary.resumed === 1`.

**CS-T2. Resume with an existing draft never re-drafts.** Seed a person, a grounded draft via
`persistDraft`, and a `seen_papers` row at `discovered` pointing at that `draft_id`. Run the
loop. Assert: `processPaper` and `generateDraft` were **not** called, `SELECT COUNT(*) FROM
drafts` is still 1, the channel received exactly one message carrying that draft's short id,
and the row is `messaged`. This is CS4.1.

**CS-T3. Resume re-checks `priorThreads` even when it has its own draft.** This is CS4.2, the
most important test in the file. Seed a person, a grounded draft D1 for paper X, and a
`seen_papers` row for X at `discovered` pointing at D1. Then, simulating the interval, seed a
second draft D2 for the *same person* at status `sent`. Run the loop. Assert: zero messages
were sent, the row is `drafted_unsendable` with a reason containing both `prior thread exists`
and `own draft`, D1's status is now `skipped`, and D2 is untouched at `sent`. A second variant
seeds only D1 (no D2) and asserts the row *is* messaged, proving `excludeDraftId` stops the row
from matching itself.

**CS-T4. Resume respects the guard on the drafting path too.** Seed a person with a `sent`
draft and a `seen_papers` row at `discovered` for a *different* paper by that person, with no
`draft_id`. Run the loop. Assert: no message was sent, the row is `drafted_unsendable`, and the
reason contains `prior thread exists`.

**CS-T5. Attempts are exhausted, not retried forever, and never at the cost of a live draft.**
Two variants, both with `max_resume_attempts = 3`.
(a) Row at `discovered`, `attempts = 3`, `draft_id IS NULL`: assert `processPaper` was not
called, the row is `drafted_unsendable`, and the reason contains `abandoned after 3 attempts`.
(b) Same but pointing at a grounded draft at `awaiting_approval`: assert the row is
`drafted_unsendable`, **and** that draft's status is `skipped`, **and**
`priorThreads(db, personId)` is now empty, so that person is contactable again. This is CS3.4
and the 1.4 permanent-block failure.

**CS-T6. Real mid-run crash (`SIGKILL`), resume path only.** Spawn the fixture entry point
below as a child process against a temp file database, with three stubbed candidates and a
`processPaper` stub that writes a marker file and then blocks forever on the second candidate.
`SIGKILL` the child once the marker appears. In the parent: reopen the database and assert
candidates 2 and 3 are at `discovered` (establishing the bug's precondition against a real
kill, which is what actually happened three times in production), then run the loop in-process
and assert both are resolved and `summary.resumed === 2`.

This test makes **no durability claim**. `better-sqlite3` issues synchronous writes and a
committed transaction is already in the OS, so a commit cannot be lost to a process kill
regardless of journal mode, and a test asserting otherwise would be asserting something that
cannot fail. What it does prove is that the resume path works against a database left by a real
uncatchable kill rather than by a hand-built fixture, which CS-T7 cannot show.

**Fixture entry point** (this must exist for CS-T6 to be writable):
`outreach/test/fixtures/crashLoop.ts`, run as `node_modules/tsx/dist/cli.mjs
test/fixtures/crashLoop.ts` with the database path and marker path passed in argv. It builds
`LoopDeps` itself: `openDb(argv[0])`, `createStubChannel()`, a stub `sender` whose `send`
throws, a single stubbed `DiscoverySource` returning three fixed candidates, and the blocking
`processPaper` stub. It must **not** go through `outreach/src/cli.ts`. `cmdLoop` there requires
`TAVILY_API_KEY` and `OPENROUTER_API_KEY`, and for any non-`--dry-run` invocation constructs a
real Photon channel against the real iMessage thread, which a test must never do.

**CS-T7. Reconstructed mid-run crash (in-process).** Build the exact database state a crash
leaves: three rows written by `recordDiscovered`, the first advanced to `messaged`, the other
two untouched at `discovered`. Run a second loop with an empty source. Assert: both remaining
rows reach a terminal or resting status, the already-messaged row is not re-messaged, and
`summary.resumed === 2`.

**CS-T8. Resume shares the cap and is not starved by it.** `max_messages_per_run = 2`. Seed one
`queued_for_message` row with a draft and `relevance = 0.1` whose `first_seen_at` is older, and
two `queued_for_message` rows with drafts, `relevance = 0.9`, and newer `first_seen_at`. Run the
loop. Assert: exactly 2 messages went out, the **older low-relevance row was one of them**
(CS7.3 age-first ordering, which fails under the current `relevance DESC`), the third row is
still at `queued_for_message`, and `summary.messaged === 2`.

**CS-T9. Resume does not starve discovery.** `max_resume_per_run = 1`. Seed three resumable
rows and a source returning one fresh candidate. Assert: exactly one row was resumed, the fresh
candidate was still processed, and the two unresumed rows remain at `discovered` for the next
run.

**CS-T10. A thrown pipeline error is retried, a returned verdict is not.** (a) `processPaper`
rejects once: assert the row is still `discovered`, `attempts === 1`, the reason contains the
error text, `summary.retryable === 1`, and `summary.unsendable === 0`. Run the loop a second
time with `processPaper` succeeding and assert the row reaches `messaged`. (b) `processPaper`
resolves with `personId` set and `email: undefined`: assert the row is `drafted_unsendable`
with reason `no email resolved` and `attempts === 1`, and that a second run does not re-process
it. This is CS3.5.

**CS-T11. A draft decided out of band is not re-texted.** Seed a `queued_for_message` row
pointing at a draft with a `sendable_revision_id`, then `decide(db, draftId, 'skip', 'cli')`.
Run the loop. Assert: zero messages were sent, and the row is `drafted_unsendable` with a
reason containing `skipped out of band`. Without CS5.2's status predicate this test texts the
user a draft they already declined.

**CS-T12. Orphan draft adoption and ambiguity.** (a) Seed a draft at `awaiting_approval` for
arxiv id X with no `seen_papers` row referencing it, plus a `seen_papers` row for X at
`discovered` with `draft_id IS NULL`. Assert the row adopts the draft (`draft_id` now set,
reason contains `adopted orphan draft`), no second draft is created, and one message goes out.
(b) Two orphan drafts for X: assert the row is `drafted_unsendable` with reason containing
`ambiguous orphan drafts`, zero messages went out, **both drafts are still at
`awaiting_approval`** (CS6.2 retires neither), and `summary.stranded >= 1`.

**CS-T13. The reconstructed candidate carries its abstract.** Run a loop with one fresh
candidate whose abstract contains a gap term absent from its title, and a `processPaper` stub
that rejects, so the row stays at `discovered` (CS3.5). Run a second loop with an empty source
and assert the gate saw the same abstract on the resumed candidate: the recorded `relevance` is
equal on both runs. Then repeat with a row whose stored `abstract` is NULL and assert the gate
was called with `abstract === undefined` and did not throw (CS1.4).

**CS-T14. Dry run messages nothing, sends nothing, decides nothing, abandons nothing.** With
resumable rows present, including one at `attempts = 3` with a live draft, run
`{ dryRun: true }`. Assert: `channel.sent` is empty, `sender.send` was not called,
`SELECT COUNT(*) FROM decisions` is unchanged, the exhausted row is still at `discovered` with
its draft still at `awaiting_approval`, and the processed resumable rows are at
`queued_for_message` with reason `dry run, not messaged`. This is CS7.5.

**CS-T15. The lifecycle invariant, as a concrete state assertion.** After a run in which one
candidate is filtered, one is abandoned at the attempt cap, one is resumed and messaged, and
one is deferred by the cap, assert exactly this and nothing softer:

```ts
const rows = db.prepare('SELECT arxiv_id, status, attempts, draft_id FROM seen_papers').all();
// 1. Every row is at one of the six statuses this spec can produce.
// 2. No row is at 'discovered' with attempts >= maxResumeAttempts (the sweep ran).
// 3. No row at 'drafted_unsendable' has a draft_id whose draft is 'awaiting_approval'
//    (CS3.4: nothing terminal blocks a person), except rows whose reason starts
//    'ambiguous orphan drafts' (CS6.2, which is reported instead).
// 4. summary.stranded equals the number of rows matching CS8.1's definition.
```

Assertion 3 is the machine-checkable form of "no person is permanently blocked", which is what
this spec is actually protecting. The earlier phrasing, "no row is at X unless a code path
exists that selects it", is not something a test can evaluate at all: it is a statement about
the program text, and it is instead discharged by CS9's table plus CS-T1, CS-T7, and CS-T9,
which exercise each non-terminal status's reader directly.

## 7. Implementation plan

1. Schema columns, index, and the guarded `ALTER`s in `openDb` (CS10.1). `recordDiscovered`
   writes `abstract`. Test: reopening a database created by the old schema gains both columns
   exactly once.
2. `seenLedger`: `getResumable`, `getExhausted`, `claimCandidate`, `strandedReport`, widened
   `SeenRow` and `ResumableRow`, and `getQueued`'s new `ORDER BY` (CS7.3). Unit tests in
   `outreach/test/seenLedger.test.ts`.
3. Config: `max_resume_per_run`, `max_resume_attempts`, defaults plus yaml override, in
   `outreach/test/discoveryConfig.test.ts`.
4. Extract `loadSendableDraft` with its status predicate and the CS5.3 resolution table, and
   repoint the existing flush at it. Test CS-T11.
5. Atomic persist-plus-setStatus in `processCandidate` (CS4.3), `claimCandidate` before every
   `processCandidate` call (CS3.2), and the retryable-versus-terminal split (CS3.5). Test
   CS-T10.
6. The resume step in `runLoop` between the flush and discovery, with its own `try/catch`, the
   `resumed` counter, and the exhaustion sweep (CS3.4). Tests CS-T1, CS-T4, CS-T5, CS-T7,
   CS-T8, CS-T9, CS-T13, CS-T14.
7. Draft-aware resume, the mandatory `priorThreads` re-check with `excludeDraftId`, and orphan
   adoption (CS4.1, CS4.2, CS6). Tests CS-T2, CS-T3, CS-T12.
8. `summary.stranded` plus the summary line, and the `outreach stranded` command (CS8). Test
   CS-T15.
9. The fixture entry point and the `SIGKILL` test (CS-T6). **Not implemented**; see the note at
   the top of Section 6 for why.
10. Re-measure against the live database and report (CS10.2), back it up (CS10.4), then
    `outreach loop --dry-run` plus `outreach stranded` and show both outputs before the plist is
    loaded (CS10.5).

## 8. Explicitly out of scope

- **Writing `sent` and `rejected` into `seen_papers`.** A different problem (an incomplete
  audit trail, not lost work), different code (the approval side, not the discovery side), and
  no shared schema change. Split to
  [`docs/spec-status-audit-trail.md`](./spec-status-audit-trail.md), which also has to
  reconcile with [`docs/spec-send-retry-cap.md`](./spec-send-retry-cap.md).
- **The two-process drafting race** (1.5 point 2, CS2.3). A run-lock spec. Pre-existing, not
  widened here, bounded by CS3.
- **`gateCandidate` retries** (CS3.6). It cannot throw; there is nothing to retry.
- **Refetching a missing abstract** (CS1.4). Adds a network dependency to a recovery path.

## 9. Open questions

None. The mechanism, the schema change, the status semantics, the concurrency assumptions, and
the migration are all settled above, and the database state in 1.6 was measured directly rather
than assumed. CS10.2 requires it to be measured again before merge.
