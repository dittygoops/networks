# Technical Spec: Candidate Stranding and the Status Lifecycle

> Design: [`docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`](./superpowers/specs/2026-07-26-discovery-outreach-loop-design.md)
> (Sections 4, 5, 6, 9). Touches the approval ledger owned by
> [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md) (AL4, AL7) at
> exactly two points, both called out inline (CS9, CS10). Does not change discovery sources,
> the relevance gate, drafting, or grounding.

## Overview

`outreach loop` records every fresh candidate into `seen_papers` at status `discovered`
before it processes any of them, and no code path ever reads a `discovered` row back. Any
run that ends before the processing loop drains (a kill, a machine sleep, a launchd timeout,
an OOM, an error escaping the outer `try`) leaves its unprocessed candidates permanently
invisible to every future run, because `filterUnseen` excludes them by primary key
regardless of status. The papers are lost silently, with no reason recorded. This has
happened three times in real operation and each time required hand-written SQL to recover.

This spec closes that gap. It makes `discovered` behave the way the design already claims it
behaves ("a resting state that the next run picks up"), by adding a resume step at the front
of each run, an attempt counter that bounds retries of a candidate that kills the process,
and a draft-aware resume path so a candidate that already has a persisted draft is messaged
rather than re-drafted. It also finishes the status lifecycle: `sent` and `rejected` exist in
the schema and in `SeenStatus` but are never written by any code, so the ledger cannot answer
what happened to a paper after it was messaged.

This is a spec-versus-implementation gap, not a design change. Nothing here alters what the
loop is allowed to send, and nothing here sends anything: approval remains an explicit human
reply, and every fact in every draft still comes from stored facts.

## 1. Root cause

Verified against the code on `main` (2026-07-27).

**1.1 The ledger is written before the work, and read back only for one status.**

`runLoop` (`outreach/src/pipeline/loop.ts:371-380`) does, in order:

```ts
const fresh = filterUnseen(deps.db, discovered.candidates);
summary.seen = fresh.length;
for (const c of fresh) recordDiscovered(deps.db, c);   // all rows written up front

for (const c of fresh) {
  await processCandidate(deps, opts, summary, c);      // then processed one at a time
}
```

`recordDiscovered` (`outreach/src/discovery/seenLedger.ts:29-34`) inserts without a status,
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
that returns rows, and it selects `status = 'queued_for_message'` only. A repo-wide search
for `seen_papers`, `getQueued`, `filterUnseen`, `recordDiscovered`, and `setStatus` across
`src/`, `test/`, and `scripts/` finds `outreach/src/pipeline/loop.ts` as the sole caller. No
query anywhere selects `status = 'discovered'`.

**Therefore:** the interval between `recordDiscovered` and the candidate's own
`processCandidate` call is a loss window. Every candidate not yet reached when the process
dies is stranded permanently, with `status = 'discovered'`, `relevance = NULL`, and
`reason = NULL`. The outer `try/catch` at `outreach/src/pipeline/loop.ts:381-386` does not
help: it catches an escaped error but does not resume the remaining candidates, and it cannot
catch a `SIGKILL` or a power loss at all.

**1.4 The narrower variant: a persisted draft that is never messaged.**

Inside `processCandidate`, the success path is
(`outreach/src/pipeline/loop.ts:249-259`):

```ts
const persisted = persistDraft(deps.db, {...});
setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, persisted.draftId);
await emit(deps, opts, summary, c, persisted.shortId, ...);
```

`persistDraft` and `setStatus` are two separate transactions, and `emit` is a third write.
A crash between `persistDraft` and `setStatus` leaves a draft row at `awaiting_approval`
that the ledger does not point at. A crash between `setStatus` and `emit` leaves the ledger
pointing at a real draft that was never messaged. Both are permanent under 1.1 through 1.3.

The second case is worse than a lost candidate, because the orphan draft at
`awaiting_approval` is matched by `priorThreads`
(`outreach/src/approval/ledger.ts:134-144`, which matches `status LIKE 'sent%'`, `approved`,
and `awaiting_approval`). So even a hypothetical rediscovery of that paper would be marked
`drafted_unsendable` with reason "prior thread exists", and the person would silently never
be contacted while the ledger reports a thread that does not exist.

**1.5 The lifecycle is incomplete on the other end.**

`SeenStatus` (`outreach/src/discovery/types.ts:4-11`) and the schema `CHECK` constraint both
allow `sent` and `rejected`. Neither string appears in any write. A paper that is messaged
stays at `messaged` forever, whether the user approved it, skipped it, or never replied.
`markSent` and `decide` (`outreach/src/approval/ledger.ts:81-109`) update `drafts.status`
only. The design's claim that the status column plus its reason is "the whole audit trail
answerable without joins" is therefore false past the point of messaging.

**1.6 Current production state.**

`outreach/data/outreach.db` as of 2026-07-27 holds 23 `seen_papers` rows:
21 `drafted_unsendable`, 2 `filtered_low_relevance`, **0 at `discovered`**, and 0 rows with a
non-null `draft_id`. The three historical stranding incidents were already cleaned by hand,
so there is no live backlog to rescue today. The migration in Section 5 must still handle a
backlog, because the bug is live until this spec is implemented and the next interrupted run
will create one.

## 2. Resolved Decisions

### CS1. Mechanism: resume `discovered` rows at the start of the next run

**Decision.** `discovered` becomes a genuine resting state. Each run, immediately after the
`queued_for_message` flush and before discovery, selects rows at `status = 'discovered'`,
reconstructs a `Candidate` from the stored columns, and runs them through the same
`processCandidate` path as fresh candidates. `filterUnseen` is unchanged.

**Alternatives considered.**

| Option | Why not chosen |
|---|---|
| **A. Resume `discovered` rows next run** (chosen) | Matches the design's stated semantics exactly, needs no schema rebuild, keeps a durable audit row for every candidate the loop ever saw, and reuses the existing `processCandidate` path so there is one drafting code path, not two. |
| **B. Do not record until processed** | Removes the loss window only if the source re-surfaces the paper. `saved_query` and `author_watch` are recency-windowed, so a paper that ages out of the window is never seen again: the same silent loss, now nondeterministic and untestable. It also destroys the "what did the loop see" audit record, which is the ledger's other job. |
| **C. Distinct pre-processing status (`processing` / `claimed`)** | Semantically cleaner, but `seen_papers.status` carries a `CHECK` constraint and SQLite cannot alter a `CHECK`. Adding a value means rebuilding the table (new table, copy, drop, rename) on a live database that has an FK into `drafts`, for information that CS2's attempt counter already carries (`attempts = 0` means never started, `attempts >= 1` means started and did not finish). Rejected as risk without payoff. |
| **D. Staleness timeout (retry rows older than N hours)** | A lease needs a threshold that is wrong in both directions: too short and a legitimately long in-flight run gets its rows stolen, too long and a crash strands work for hours. It only buys anything under concurrent writers, and the loop is single-writer by construction (launchd will not start a second instance of a job with the same `Label` while the previous one runs, and `outreach loop` is a run-once-and-exit command). Rejected. |

**CS1.1** Resume order within a run is: drain approvals, retry approved-but-unsent, flush
`queued_for_message`, **resume `discovered`**, discover fresh, process fresh. Resumed work
precedes new discovery for the same reason queued work does: the design's rule that older
committed work goes out ahead of newly found work.

**CS1.2** Resumed rows are selected oldest first by `first_seen_at`, then `arxiv_id` for a
stable tiebreak, so a backlog drains in the order it accumulated and no row can starve behind
a churn of newer arrivals.

**CS1.3** The reconstructed `Candidate` uses the stored `arxiv_id`, `title`,
`discovered_via`, and `source_detail`. `Candidate.abstract` is optional and is not stored, so
it is reconstructed as `undefined`. The relevance gate must therefore tolerate a missing
abstract on a resumed candidate (it already accepts `abstract?`). A gate that scores lower
without an abstract is acceptable: the alternative is fabricating one, which the never
fabricate rule forbids outright.

### CS2. Bounded attempts, so a poison candidate cannot wedge the loop forever

A candidate that hard-kills the process (an OOM on a pathological PDF, for example) would be
resumed by every future run and kill every future run. That converts a silent data loss bug
into a total outage.

**CS2.1** `seen_papers` gains `attempts INTEGER NOT NULL DEFAULT 0`.

**CS2.2** `claimCandidate(db, arxivId)` increments `attempts` in its own committed statement
immediately **before** `processCandidate` runs, for both fresh and resumed candidates. The
increment must be durable before the work starts, otherwise a crash does not count.

**CS2.3** The resume selection excludes rows at `attempts >= maxResumeAttempts`
(config `gate.max_resume_attempts`, default 3).

**CS2.4** When a row reaches the limit and is still at `discovered`, the resume step marks it
terminal in the same pass: `status = 'drafted_unsendable'`, reason
`abandoned after N interrupted attempts`. It is never silently dropped, and the reason string
names the actual failure mode so `outreach` operators can find it. `drafted_unsendable` is
reused rather than adding a status, for the CHECK-constraint reason in CS1 option C.

**CS2.5** A candidate that fails loudly (any thrown error) is already caught inside
`processCandidate` and given a terminal status, so it never reaches the resume path. The
attempt counter exists only for failures that prevent any status write at all.

### CS3. Idempotent resume: a candidate that already has a draft is emitted, not re-drafted

This is the never-email-twice interaction, and the highest-risk part of the change.

**CS3.1** When a resumed row has `draft_id IS NOT NULL`, the resume step **must not** call
`processPaper`, `generateDraft`, or `persistDraft`. It loads the existing draft's short id,
subject, body, and recipient exactly as the `queued_for_message` flush already does
(`outreach/src/pipeline/loop.ts:341-348`), and goes straight to `emit`. This is the
crash-between-`setStatus`-and-`emit` window from 1.4, and re-running the pipeline there would
create a second draft for a person who already has one.

**CS3.2** The success path in `processCandidate` must persist the draft and point the ledger
at it **atomically**. `persistDraft` and the following `setStatus(..., 'discovered', reason,
persisted.draftId)` are wrapped in one `db.transaction`, so no crash can produce a draft the
ledger does not reference:

```ts
const persisted = db.transaction(() => {
  const p = persistDraft(deps.db, {...});
  setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, p.draftId);
  return p;
})();
```

`better-sqlite3` nests transactions as savepoints, so `persistDraft`'s own internal
transaction remains correct.

**CS3.3** Defence in depth for drafts created before CS3.2 exists (and for drafts created by
the CLI `add` flow, which does not touch `seen_papers` at all): before drafting, a resumed
candidate with `draft_id IS NULL` looks for an adoptable draft, defined as a `drafts` row
with `paper_arxiv_id = <candidate arxiv id>` and `status = 'awaiting_approval'` that no
`seen_papers` row already points at. If exactly one exists, the row adopts it
(`setStatus(..., 'discovered', 'adopted orphan draft <shortId>', draftId)`) and proceeds per
CS3.1 instead of drafting. If more than one exists, the candidate is marked
`drafted_unsendable` with reason `ambiguous orphan drafts (<shortIds>)` and left for a human,
because guessing which cold email to send to a real researcher is exactly the kind of
decision this system is not allowed to make.

**CS3.4** The `priorThreads` guard is unchanged and still runs for every resumed candidate
that reaches the drafting path. Its status set (`sent%`, `approved`, `awaiting_approval`)
already covers every state a real prior thread can be in. CS3.1 and CS3.3 exist precisely so
that the guard is never reached with the candidate's *own* draft as the match, which is the
false positive described in 1.4.

**CS3.5** No resume path may call `deps.sender.send`. Resume only ever reaches
`channel.sendDraftMessage`, which asks for approval. The invariant that an email leaves only
in response to an explicit human reply is untouched by this spec.

### CS4. Message cap and starvation

**CS4.1** `summary.messaged` stays a single counter for the whole run. The queued flush, the
resume step, and fresh processing all check and increment the same counter, so the per-run
cap `gate.max_messages_per_run` is a whole-run budget and nothing is double counted.

**CS4.2** A resumed candidate that becomes sendable when the budget is already spent takes
the existing path in `emit`: `queued_for_message`, reason
`deferred by max_messages_per_run`. It is then handled by the flush step of a later run.
Recovery adds no new deferral mechanism.

**CS4.3** The resume step is bounded by `gate.max_resume_per_run` (default 10) so a large
backlog cannot consume the whole run's LLM and API budget and starve discovery. New discovery
runs on every run regardless of backlog depth. With CS1.2's oldest-first order, a backlog of
any size drains deterministically over successive runs.

**CS4.4** Resume runs in dry-run mode too, because it is the same processing path and a dry
run is meant to exercise it. Under dry run, `emit` parks the candidate at
`queued_for_message` with reason `dry run, not messaged`, which is the existing behaviour for
fresh candidates. A dry run therefore still consumes attempts and still mutates the ledger,
exactly as it does today for fresh candidates. A dry run still messages nothing and sends
nothing.

**CS4.5** The resume step is failure-isolated like every other stage: it is wrapped in its own
`try/catch` that pushes to `summary.errors`, so a resume failure never prevents discovery
(design Section 9, F1).

### CS5. Write `sent` and `rejected`

**Decision: write them, do not remove them.** The design makes the status column the
single-column answer to what happened to a paper, and today that answer stops at "messaged".
Removing the two values would make the ledger permanently unable to distinguish a paper whose
email was sent from one the user rejected from one still awaiting a reply, and the outreach
history is the input to any future "who have I already contacted" question.

**CS5.1** `seenLedger` gains `setStatusByDraftId(db, draftId, status, reason?)`, updating the
single `seen_papers` row whose `draft_id` matches. A no-op when no row matches, which is the
normal case for drafts created by the CLI `add` flow.

**CS5.2** `sent` is written from the two places that call `markSent`:
`handleReply` (`outreach/src/pipeline/loop.ts:124`) and `retryApprovedUnsent`
(`outreach/src/pipeline/loop.ts:297`), immediately after `markSent` succeeds, with the reason
carrying the provider's `sentId`.

**CS5.3** `rejected` is written in `handleReply`'s skip branch
(`outreach/src/pipeline/loop.ts:82-88`), only when `decide` returns `applied: true`, with
reason `user replied n`. A losing (already decided) reply writes nothing, preserving the
first-write-wins semantics of AL7.

**CS5.4** A failed send writes nothing. `markSendFailed` deliberately leaves the draft at
`approved` so `retryApprovedUnsent` can heal it, and the `seen_papers` row correspondingly
stays at `messaged` until a send actually succeeds. The failure is recorded in
`draft_events`, which is the append-only log that owns failure history.

**CS5.5** `messaged` remains the resting state for "texted, no reply yet". It is not terminal
and needs no resume, because the user's reply is the only thing that can advance it and the
reply drain already runs every run.

**CS5.6** Both writes cross from the loop into ledger territory. They are additive: no
existing `drafts` write changes, and `decide`'s first-write-wins path is not touched.

### CS6. What `discovered` means after this change

| Status | Meaning | Who moves it |
|---|---|---|
| `discovered` | Recorded, not yet resolved. `attempts = 0`: never started. `attempts >= 1`: started and interrupted. Also the transient state between drafting and messaging within one run. | The resume step, next run |
| `filtered_low_relevance` | Terminal. Gate said no. | Nothing |
| `drafted_unsendable` | Terminal. No email, no hook, prior thread, pipeline error, or abandoned after N attempts. | Nothing |
| `queued_for_message` | Resting. Sendable draft deferred by the cap, by a dry run, or by a message failure. | The flush step, next run |
| `messaged` | Resting. Texted, awaiting the user's reply. | The reply drain, on reply |
| `sent` | Terminal. Approved and the email actually left. | CS5.2 |
| `rejected` | Terminal. User replied `n`. | CS5.3 |

Every non-terminal status now has exactly one code path that picks it up. That property is
what this spec buys, and CS-T9 tests it directly.

### CS7. Concurrency, explicitly out of scope

Recovery assumes a single writer. launchd does not start a second instance of a job with the
same `Label` while the previous one is running, and `scripts/com.aditya.outreach.plist` uses
`StartCalendarInterval` with a single label, so scheduled runs are serialized. A manual
`outreach loop` overlapping a scheduled one could have both runs process the same candidate.
That race already exists today for freshly discovered candidates (two runs, two
`priorThreads` checks, both passing before either persists), so it is not introduced here and
is not fixed here. It belongs in a run-lock spec. CS2's attempt counter bounds the damage.
This is documented rather than silently assumed.

## 3. Data model

One additive column. No `CHECK` constraint changes, no table rebuild.

```sql
ALTER TABLE seen_papers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_seen_resume ON seen_papers(status, first_seen_at);
```

`outreach/src/db/schema.sql` gains the column in the `CREATE TABLE` body (for fresh
databases) and the index. `openDb` executes `schema.sql` on every open, and
`CREATE TABLE IF NOT EXISTS` is a no-op on an existing database, so the `ALTER` needs the
guarded migration in Section 5.

`SeenRow` in `outreach/src/discovery/seenLedger.ts` gains `attempts: number`, plus the
`discoveredVia` and `sourceDetail` fields the resume step needs to rebuild a `Candidate`.

## 4. Interfaces

New or changed exports in `outreach/src/discovery/seenLedger.ts`:

```ts
// Rows to resume, oldest first, excluding exhausted ones.
export function getResumable(db: DB, limit: number, maxAttempts: number): ResumableRow[];

// Rows at 'discovered' whose attempts have run out. Marked terminal by the caller.
export function getExhausted(db: DB, maxAttempts: number): ResumableRow[];

// Durable attempt increment. Called before processing, fresh or resumed.
export function claimCandidate(db: DB, arxivId: string): void;

// Closes the audit trail from the approval side (CS5).
export function setStatusByDraftId(db: DB, draftId: number, status: SeenStatus, reason?: string): void;

export interface ResumableRow extends SeenRow {
  discoveredVia: DiscoveredVia;
  sourceDetail: string | null;
  draftId: number | null;
  attempts: number;
}
```

New config in `outreach/src/discovery/config.ts` (`GateConfig`, both with defaults so
`config/watchlist.yaml` stays optional):

```yaml
gate:
  max_resume_per_run: 10      # CS4.3
  max_resume_attempts: 3      # CS2.3
```

`LoopSummary` gains `resumed: number` and the run summary line gains `resumed N`, so an
interrupted run is visible in the iMessage thread on the following run rather than being
invisible until someone reads the database.

## 5. Migration

**CS8.1 Schema.** Add a guarded migration in `openDb`
(`outreach/src/db/db.ts`), run after `schema.sql` is applied:

```ts
const cols = db.prepare('PRAGMA table_info(seen_papers)').all() as { name: string }[];
if (!cols.some((c) => c.name === 'attempts')) {
  db.exec('ALTER TABLE seen_papers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
}
```

Idempotent, safe to run on every open, and correct for both a fresh database (column already
present from `schema.sql`, so the guard skips) and the live one.

**CS8.2 Existing stranded rows.** As of 2026-07-27 `outreach/data/outreach.db` holds zero
rows at `discovered` and zero rows with a non-null `draft_id`, verified directly against the
file, because the three historical incidents were cleaned by hand. So there is no backlog to
migrate today. No data migration script is required, and none should be written on
speculation.

**CS8.3 Whatever backlog exists at implementation time is handled by the feature itself.**
Any row sitting at `discovered` when the new code first runs is picked up by the resume step
with `attempts = 0` (the column default), which is exactly right: those rows were never
started. This is the correct outcome and needs no separate rescue script. The implementer
must re-run the count from CS8.2 before merging and report it, rather than assuming it is
still zero.

**CS8.4 Backup before first run.** The implementer takes a timestamped copy of
`outreach/data/outreach.db` before the first real (non dry-run) execution of the new code,
matching the existing `outreach.backup-HHMMSS.db` convention already in `outreach/data/`.

**CS8.5 First run is a dry run.** The first execution after merge is
`outreach loop --dry-run`, and its summary line (including the new `resumed` count) is shown
before launchd is re-armed.

## 6. Testing

All tests are vitest against `openDb(':memory:')` with stubbed deps, following the existing
`outreach/test/loop.test.ts` harness, except CS-T6 which needs a real process and a real file
database.

**CS-T1. Stranded row is resumed.** Seed a `seen_papers` row at `discovered` with
`attempts = 0` and no `draft_id`. Run `runLoop` with a source returning zero candidates.
Assert: `processPaper` was called for that arxiv id, the row is now `messaged`, and
`summary.resumed === 1`.

**CS-T2. Resume with an existing draft never re-drafts.** Seed a person, a grounded draft via
`persistDraft`, and a `seen_papers` row at `discovered` pointing at that `draft_id`. Run the
loop. Assert: `processPaper` and `generateDraft` were **not** called, `SELECT COUNT(*) FROM
drafts` is still 1, the channel received exactly one message carrying that draft's short id,
and the row is `messaged`. This is the never-email-twice case from CS3.1.

**CS-T3. Resume respects the never-email-twice guard.** Seed a person with a `sent` draft and
a `seen_papers` row at `discovered` for a different paper by that person, with no `draft_id`.
Run the loop. Assert: no message was sent, the row is `drafted_unsendable`, and the reason
contains `prior thread exists`.

**CS-T4. Attempts are exhausted, not retried forever.** Seed a row at `discovered` with
`attempts = 3` and `max_resume_attempts = 3`. Run the loop. Assert: `processPaper` was not
called, the row is `drafted_unsendable`, and the reason contains
`abandoned after 3 interrupted attempts`.

**CS-T5. Reconstructed mid-run crash (in-process).** Build the exact database state a crash
leaves: three rows written by `recordDiscovered`, the first advanced to `messaged`, the other
two untouched at `discovered`. Run a second loop with an empty source. Assert: both remaining
rows reach a terminal or resting status, the already-messaged row is not re-messaged, and
`summary.resumed === 2`.

**CS-T6. Real mid-run crash (`SIGKILL`).** Spawn a child process running the loop against a
temp file database with three stubbed candidates and a `processPaper` stub that writes a
marker file and blocks on the second candidate. `SIGKILL` the child once the marker appears.
In the parent: reopen the database, assert candidate 2 and 3 are at `discovered` (proving the
bug's precondition), then run the loop in-process and assert both are resolved and
`summary.resumed === 2`. This is the only test that proves the WAL-durability of
`recordDiscovered` and `claimCandidate` under an uncatchable kill, which is the failure mode
that actually occurred three times in production.

**CS-T7. Resume shares the message cap.** `max_messages_per_run = 2`. Seed one
`queued_for_message` row with a draft and two resumable rows that will both become sendable.
Run the loop. Assert: exactly 2 messages were sent, the third candidate is at
`queued_for_message`, and `summary.messaged === 2`.

**CS-T8. Resume does not starve discovery.** `max_resume_per_run = 1`. Seed three resumable
rows and a source returning one fresh candidate. Assert: exactly one row was resumed, the
fresh candidate was still processed, and the two unresumed rows remain at `discovered` for
the next run.

**CS-T9. `sent` and `rejected` are written.** Approve a messaged draft via a stubbed `y`
reply, assert its `seen_papers` row is `sent` and the reason contains the `sentId`. Skip a
second one with `n`, assert its row is `rejected`. Then assert the lifecycle invariant
directly: after the run, no `seen_papers` row is at `discovered` or `queued_for_message`
unless a code path exists that selects it.

**CS-T10. A failed send does not write `sent`.** Sender rejects. Assert the row stays at
`messaged`, the draft stays `approved`, and `retryApprovedUnsent` on the following run moves
the row to `sent`.

**CS-T11. Orphan draft adoption.** Seed a draft at `awaiting_approval` for arxiv id X with no
`seen_papers` row referencing it, plus a `seen_papers` row for X at `discovered` with
`draft_id IS NULL`. Assert the row adopts the draft (`draft_id` now set, reason contains
`adopted orphan draft`), no second draft is created, and one message goes out. A second
variant with two orphan drafts asserts `drafted_unsendable` with `ambiguous orphan drafts`
and zero messages.

**CS-T12. Dry run still messages and sends nothing.** With resumable rows present, a dry run
asserts `channel.sent` is empty, `sender.send` was not called, and the resumed rows are at
`queued_for_message` with reason `dry run, not messaged`.

## 7. Implementation plan

1. Schema column, index, and the guarded `ALTER` in `openDb` (CS8.1). Test: reopening a
   database created by the old schema gains the column exactly once.
2. `seenLedger`: `getResumable`, `getExhausted`, `claimCandidate`, `setStatusByDraftId`,
   widened `SeenRow`. Unit tests in `outreach/test/seenLedger.test.ts`.
3. Config: `max_resume_per_run`, `max_resume_attempts`, defaults plus yaml override, in
   `outreach/test/discoveryConfig.test.ts`.
4. Atomic persist-plus-setStatus in `processCandidate` (CS3.2), and `claimCandidate` before
   every `processCandidate` call (CS2.2).
5. Extract the existing `queued_for_message` flush's draft-loading query into a shared helper,
   so the resume path (CS3.1) and the flush use one query and cannot drift.
6. The resume step in `runLoop` between the flush and discovery, with its own `try/catch`,
   the `resumed` counter, and the exhausted-row sweep. Tests CS-T1, CS-T3 to CS-T5, CS-T7,
   CS-T8, CS-T12.
7. Draft-aware resume and orphan adoption (CS3.1, CS3.3). Tests CS-T2, CS-T11.
8. `sent` and `rejected` writes (CS5). Tests CS-T9, CS-T10.
9. The `SIGKILL` test (CS-T6).
10. Re-run the CS8.2 count against the live database, back it up (CS8.4), then
    `outreach loop --dry-run` and show the summary line (CS8.5).

## 8. Open questions

None. The mechanism, the schema change, the status semantics, and the migration are all
settled above, and the live database state was verified directly rather than assumed.
