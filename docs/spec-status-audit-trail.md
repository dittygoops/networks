# Technical Spec: Finishing the `seen_papers` Audit Trail (`sent` and `rejected`)

> Split out of [`docs/spec-candidate-stranding.md`](./spec-candidate-stranding.md), which owns a
> different problem (candidates the loop recorded and then lost). This one owns exactly one
> problem: the `seen_papers` status lifecycle stops at `messaged`, so the ledger cannot say what
> happened to a paper after the user was texted about it. No shared schema change with that
> spec, and no shared code: this spec touches the approval side only.
>
> Depends on the F5 status semantics in
> [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md) (AL4, AL7) and
> collides with [`docs/spec-send-retry-cap.md`](./spec-send-retry-cap.md) (see AT6).

## Overview

`SeenStatus` (`outreach/src/discovery/types.ts:4-11`) and the `seen_papers.status` `CHECK`
(`outreach/src/db/schema.sql:106-107`) both allow `sent` and `rejected`. Neither string appears
in any write anywhere in the repo. A paper that has been messaged stays at `messaged` forever,
whether the user approved it, skipped it, or never replied. `markSent` and `decide`
(`outreach/src/approval/ledger.ts:81-109`) update `drafts.status` only.

The design's claim that `seen_papers.status` plus its `reason` is "the whole audit trail
answerable without joins" is therefore false past the point of messaging.

This is now observable in the live database rather than theoretical. Measured directly with
`openDb` on `outreach/data/outreach.db` at the time of writing:

| Query | Result |
|---|---|
| `seen_papers` at `messaged` | 2 (`2512.05693` to `d7`, `2402.15505` to `d8`) |
| `drafts` `d7`, `d8` | both `sent` |
| `seen_papers` at `sent` or `rejected` | 0 |

Two real cold emails have gone out and the discovery ledger says only that they were texted
about. Every "who have I already contacted" question has to join into `drafts` to get a true
answer, which is the join the design says should not be necessary.

This spec is purely additive bookkeeping. It writes no new status literal (both already pass the
`CHECK`), changes no `drafts` write, does not touch `decide`'s first-write-wins path, and cannot
cause anything to be sent: every write it adds happens strictly *after* a send has already
succeeded or a skip has already been recorded.

## Resolved Decisions

### AT1. Write them, do not remove them

The alternative is to delete `sent` and `rejected` from `SeenStatus` and the `CHECK`. Rejected
twice over. First, `seen_papers.status` is the single-column answer to what happened to a paper,
and removing the values makes the ledger permanently unable to distinguish a paper whose email
was sent, from one the user rejected, from one still awaiting a reply. Second, removing a value
from the `CHECK` is not even possible in place: SQLite cannot alter a `CHECK`, and `openDb`
re-executes `schema.sql` with `CREATE TABLE IF NOT EXISTS` on every open, so an edited `CHECK`
never reaches the live database. It would require a full table rebuild against a live file with
an FK into `drafts`. Writing the values costs one helper.

### AT2. One helper, keyed by draft id

`outreach/src/discovery/seenLedger.ts` gains:

```ts
export function setStatusByDraftId(db: DB, draftId: number, status: SeenStatus, reason?: string): void;
```

It updates the single `seen_papers` row whose `draft_id` matches, and is a no-op when no row
matches. The no-op is the normal case, not an error: `outreach add` creates drafts without ever
touching `seen_papers` (`outreach/src/cli.ts:293`), and `outreach listen` acts on replies to
those drafts too. Keying by `draft_id` rather than by `paper_arxiv_id` is deliberate, because a
person can have several drafts for one paper (`d1`, `d2`, `d4` in the live database are all for
`2604.09758`) and only one of them is the one the ledger points at.

### AT3. `sent` is written after `markSent`, from all three callers

`markSent` is called from three places, and all three must write, or the status becomes a
coin flip that depends on which process handled the reply:

- `handleReply` in `outreach/src/pipeline/loop.ts` (the batch loop's reply drain).
- `retryApprovedUnsent` in `outreach/src/pipeline/loop.ts` (the approved-but-unsent healer).
- `handleReply` again, reached from `outreach/src/pipeline/listen.ts`, the persistent daemon.
  `handleReply` is shared between the loop and the listener precisely so their invariants cannot
  drift, so writing inside `handleReply` rather than at its call sites covers the daemon for
  free. Do not write at the call sites.

The write is `setStatusByDraftId(db, draftId, 'sent', 'sent as <sentId>')`, immediately after
`markSent` returns, carrying the provider's `sentId` so the reason names the actual message.

### AT4. `rejected` is written in the skip branch, only when the decision applied

In `handleReply`'s skip branch, `setStatusByDraftId(db, draftId, 'rejected', 'user replied n')`,
and only when `decide` returned `applied: true`. A losing (already decided) reply writes nothing,
which preserves AL7's first-write-wins semantics: the row must reflect the decision that was
actually recorded, not the last reply that arrived.

### AT5. A failed send writes nothing

`markSendFailed` deliberately leaves the draft at `approved` so `retryApprovedUnsent` can heal
it, and the `seen_papers` row correspondingly stays at `messaged` until a send actually
succeeds. The failure is recorded in `draft_events`, which is the append-only log that owns
failure history.

### AT6. Collision with `spec-send-retry-cap.md`, and how it resolves

That spec's RC4 defines the terminal held state as "status `approved` plus a `send_abandoned`
event, and no new status literal". So under both specs there is a fourth outcome that AT3 to
AT5 do not cover: a draft the human explicitly approved, whose send failed the cap number of
times, which now stays at `approved` forever and will never reach `markSent`. Its `seen_papers`
row would sit at `messaged` indefinitely, which is wrong in the one way that matters: `messaged`
means "awaiting the user's reply", and the user already replied.

**Resolution, and it is a requirement on whichever spec lands second.** When
`markSendAbandoned` (RC4) runs, it also calls
`setStatusByDraftId(db, draftId, 'rejected', 'send abandoned after N attempts: <last error>')`.
`rejected` is reused rather than adding a `send_failed` status literal, for the `CHECK` reason
in AT1, and the reason string carries the distinction. This is defensible because `rejected`
means "no email will be sent about this paper", which is exactly true of a held draft, and
because RC6's re-arm path already exists as the way to change that answer: a re-armed draft that
then sends reaches `markSent` and AT3 moves the row to `sent`.

If `spec-send-retry-cap.md` lands first, this becomes a one-line addition to
`markSendAbandoned`. If this spec lands first, RC4's implementation must include it, and
`spec-send-retry-cap.md`'s RC4 should cite AT6.

### AT7. Status semantics after this spec

| Status | Meaning | Who writes it |
|---|---|---|
| `messaged` | Resting. Texted, awaiting the user's reply. Not terminal, needs no resume: the reply is the only thing that can advance it and the reply drain runs every run plus continuously in the daemon. | `emit`, the flush (existing) |
| `sent` | Terminal. Approved and the email actually left. | AT3 |
| `rejected` | Terminal. The user replied `n`, or the send was abandoned after the retry cap (AT6). | AT4, AT6 |

## Data model

None. No new column, no new table, no `CHECK` change. Both status literals already pass the
existing `CHECK` and both already exist in `SeenStatus`.

## Testing

vitest against `openDb(':memory:')`, following the existing `outreach/test/loop.test.ts` and
`outreach/test/listen.test.ts` harnesses.

**AT-T1. `sent` is written on approval.** Seed a messaged row pointing at a grounded draft.
Approve it via a stubbed `y` reply with a sender returning `sentId: 'msg-1'`. Assert the
`seen_papers` row is `sent` and the reason contains `msg-1`.

**AT-T2. `rejected` is written on skip.** Same setup, reply `n`. Assert the row is `rejected`
with reason `user replied n`, and that `sender.send` was never called.

**AT-T3. A losing reply writes nothing.** Reply `y`, then reply `n` to the same short id.
Assert the row is `sent`, not `rejected`, and that exactly one `decisions` row exists.

**AT-T4. The listener writes it too.** Drive `handleReply` through the `listen` harness rather
than the loop and assert the same result as AT-T1, proving the write is inside `handleReply` and
not at the loop's call site.

**AT-T5. A failed send does not write `sent`.** Sender rejects. Assert the row stays at
`messaged`, the draft stays `approved`, and that `retryApprovedUnsent` on the following run
(with the sender succeeding) moves the row to `sent`.

**AT-T6. A draft with no `seen_papers` row is a silent no-op.** Create a draft the way
`outreach add` does, with no `seen_papers` row at all. Approve it. Assert the send succeeded, the
draft is `sent`, and nothing threw.

**AT-T7. AT6.** Only once `spec-send-retry-cap.md` is implemented: an abandoned send leaves the
row at `rejected` with a reason containing `send abandoned`, and a re-armed draft that
subsequently sends moves it to `sent`.

## Implementation plan

1. `setStatusByDraftId` in `seenLedger.ts`, plus unit tests in
   `outreach/test/seenLedger.test.ts` covering the match and the no-match no-op.
2. The `sent` write inside `handleReply` and in `retryApprovedUnsent` (AT3). Tests AT-T1, AT-T4,
   AT-T5, AT-T6.
3. The `rejected` write in the skip branch (AT4). Tests AT-T2, AT-T3.
4. Backfill decision: see the open question below.
5. AT6, in whichever spec lands second.

## Open questions

**Backfill.** The live database has two rows at `messaged` whose drafts are `sent` (`d7`, `d8`),
predating this spec. Options are to leave them (the join still answers correctly, the ledger is
simply silent), or to run a one-time `UPDATE seen_papers SET status = 'sent', reason = ... WHERE
draft_id IN (SELECT id FROM drafts WHERE status = 'sent')`. The backfill is two rows and
recoverable from a backup, but it is a hand-written `UPDATE` against a live database holding the
record of two real cold emails. Decide with Aditya before implementing, and re-measure the
counts first: they were taken at the time of writing and the database changes daily.
