# Technical Spec: Send Retry Cap and Terminal Held State

> Sibling of [`docs/spec-inbound-dedup.md`](./spec-inbound-dedup.md) (same file, different
> problem: that one is inbound, this one is outbound). Builds on the F5 status semantics in
> [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md) AL4 and the loop
> design in
> [`docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`](./superpowers/specs/2026-07-26-discovery-outreach-loop-design.md).
> Scope is exactly one problem: an approved draft whose send keeps failing is retried forever.

## Overview

`retryApprovedUnsent` in `outreach/src/pipeline/loop.ts` selects every draft at status
`approved` with a `sendable_revision_id` and attempts the send. `markSendFailed` in
`outreach/src/approval/ledger.ts` deliberately leaves the draft at `approved` (F5 AL4: that
status is the healable transient state) and logs a `send_failed` event. Nothing counts those
events and nothing ever gives up.

Consequences today, with the loop armed daily under launchd:

- A permanently bad recipient address (typo, retired mailbox, hard bounce at submission time)
  causes one send attempt and one "d7 failed to send: ..." text every single day, forever.
- The `person?.email` missing branch is worse: it texts "d7 has no email on record." every run
  and does not even log an event, so it leaves no trace at all and can never be reasoned about
  after the fact.
- The draft is stuck in a state that `priorThreads` counts as an existing thread, so that
  person is permanently unreachable by this system while nobody is told the situation is
  terminal.

Retrying is correct, unbounded retrying is not. This spec caps attempts, spaces them, defines
a terminal held state that neither vanishes nor retries, tells the user once when it is
reached, and provides a deliberate way to re-arm.

Nothing in this spec sends anything that was not already explicitly approved by a human reply.
`retryApprovedUnsent` only ever operates on drafts already at `approved`, which is reachable
only through `decide`, and this spec only ever makes it attempt fewer sends than it does now.

## Resolved Decisions

### RC1. The attempt count is derived from `draft_events`, not a new column

`markSendFailed` already writes exactly one `send_failed` row per failed attempt into
`draft_events`, which is append-only, is already the audit trail F5 AL6 defines, and is
already indexed by `draft_id` (`idx_events_draft`). The count is therefore already in the
database and simply is not read.

```sql
SELECT count(*) FROM draft_events
 WHERE draft_id = ? AND type = 'send_failed'
   AND created_at > coalesce(
         (SELECT max(created_at) FROM draft_events
           WHERE draft_id = ? AND type = 'send_rearmed'), '');
```

The alternative, a `send_attempts INTEGER` column on `drafts`, is cheaper to query but costs
an `ALTER TABLE` against a live database plus an idempotency guard, because `schema.sql` is
re-executed on every `openDb` and a bare `ALTER TABLE` would throw on the second open. It also
creates a second source of truth that can disagree with the event log. At this volume (single
digit approved drafts, a handful of events each) the derived count is free. Derived wins.

The count resets at the most recent `send_rearmed` event (RC6), which is what makes re-arming
a one-row append rather than a mutation or a delete.

### RC2. Cap: 5 attempts

Five failed attempts, then terminal.

Justification: the loop runs once a day under launchd, and RC3 keeps the effective spacing at
roughly that cadence, so five attempts spans about five days. That is long enough to ride out
every transient failure this system realistically hits (an expired Gmail OAuth token, a
quota-exceeded day, the Mac being offline, a greylisting mail server) and short enough that a
permanently bad address stops texting the user within a week rather than forever. Two would be
too tight for a weekend outage; twenty would be indistinguishable from today's behavior.

The value lives in `GateConfig`'s neighbor as a constant in the loop module,
`SEND_MAX_ATTEMPTS = 5`, overridable in `config/watchlist.yaml` under a new `send:` key
(`send: { max_attempts: 5, retry_schedule_hours: [1, 6, 24, 24] }`) so tuning does not need a
code change. Absent keys fall back to the constants, matching how `loadConfig` already treats
`gate`.

### RC3. Backoff: minimum interval between attempts, by attempt number

Wall-clock exponential backoff is nearly meaningless on a once-a-day batch job, but the job is
also runnable by hand, and a user running `outreach loop` three times in an afternoon while
debugging would burn the entire cap in minutes and terminally hold a draft that only had a
transient problem. So the cap needs a companion floor.

A draft is skipped by `retryApprovedUnsent` (silently, no text, not counted as an attempt) if
its most recent `send_failed` event is younger than the interval for its next attempt:

| Next attempt | Minimum wait since last failure |
|---|---|
| 2 | 1 hour |
| 3 | 6 hours |
| 4 | 24 hours |
| 5 | 24 hours |

This is a floor, not a schedule: the daily run is what actually triggers attempts, and the
floor only prevents an unnaturally fast burn. Attempt 1 is the original send from
`handleReply` and has no wait.

### RC4. Terminal state: `approved` plus a `send_abandoned` event, and no new status literal

`drafts.status` is `CHECK`-constrained to exactly `awaiting_approval`, `approved`,
`sent (stubbed)`, `sent`, `skipped`.

What a new literal would cost: SQLite cannot alter a `CHECK` constraint, so adding one means
rebuilding `drafts` (create a shadow table with the new constraint, copy, drop, rename) with
`foreign_keys` off inside a transaction, while `revisions.draft_id`, `decisions.draft_id`, and
`seen_papers.draft_id` all reference it. Worse, `schema.sql` is applied with
`CREATE TABLE IF NOT EXISTS`, so a changed constraint would never reach the live database at
all: the rebuild would have to be a real versioned migration step, the first this project has
ever needed. That is a large, risky change for a status word.

**Decision: no new status.** A draft is terminally held when it is at status `approved` and
has a `send_abandoned` event that is newer than any `send_rearmed` event. `retryApprovedUnsent`
excludes those drafts with a `NOT EXISTS` subquery.

This is honest rather than a workaround: the draft genuinely is approved and genuinely was
never sent, and `approved` is precisely F5's word for that. It also preserves the two
behaviors that matter most:

- The draft does not vanish. It stays in `drafts`, it stays visible, and `priorThreads` still
  counts it as an existing thread, so nothing will cold-email that person behind the user's
  back.
- It is not retried forever.

Cost of the choice, recorded so nobody trips on it later: status alone no longer tells you
whether an `approved` draft is live or held. Any future query about retryability must go
through one helper, `heldDraftIds(db)` in `approval/ledger.ts`, and must not key on status
alone. Use `NOT EXISTS`, never `NOT IN`, on the events subquery, for the same NULL reason F5
AL6 already documents.

### RC5. Missing email counts as a failed attempt

The `!person?.email` branch currently texts the user and `continue`s, forever, logging nothing.
It becomes a real failed attempt: `markSendFailed(db, draftId, 'no email on record')`, which
logs `send_failed` and therefore counts toward the cap and is subject to the RC3 floor. This is
the single loudest instance of the defect and it should be the first one the cap silences.

The same treatment applies in `handleReply`, where the identical branch exists on the first
send path.

### RC6. Exhaustion: what the user is told, and how to re-arm

When the cap is reached (the attempt that produced the fifth `send_failed`):

1. Log `send_abandoned` with `{ attempts, lastError, to }`.
2. Send exactly one text, not a repeat of the per-attempt failure text:

   ```
   d7 could not be sent after 5 tries. Last error: 550 no such user.
   Held, not sent, not retrying. Fix the address, then run: outreach rearm d7
   ```

3. Add one line to `summary.errors` for that run only, so the run summary agrees with the
   thread.

Per-attempt failure texts are kept as they are today (attempts 1 through 5), because a
failing send the user cares about should be visible immediately, and the cap already bounds
the total to five texts plus one exhaustion text.

Re-arming is a CLI command, `outreach rearm <shortId>`, not a new iMessage reply keyword. Two
reasons: the reply grammar in `outreach/src/approval/channel.ts` deliberately treats anything
it does not recognize as `unsupported` and must not drift toward accepting more shapes near
the approve path, and re-arming should follow the human actually fixing the address, which is
not something done from a phone thread. `rearm` appends a `send_rearmed` event, which resets
both the RC1 count and the RC4 terminal check. It changes no status and deletes nothing.

### RC7. Held drafts stay visible

The run summary line gains a `held N` field when N is greater than zero, counting drafts that
are terminally held. It is one word in a line the user already reads every day, and it is what
stops a held draft from becoming invisible after its one exhaustion text scrolls away.

## Interfaces

| Interface | Shape | Consumer |
|---|---|---|
| `sendAttempts(db, draftId)` | `number` (RC1) | `retryApprovedUnsent` |
| `isHeld(db, draftId)` / `heldDraftIds(db)` | `boolean` / `number[]` (RC4) | retry query, summary |
| `markSendAbandoned(db, draftId, detail)` | void, logs `send_abandoned` | `retryApprovedUnsent` |
| `rearmDraft(db, draftId)` | void, logs `send_rearmed` | `outreach rearm` CLI |
| `send` config block | `{ maxAttempts, retryScheduleHours }` (RC2, RC3) | `loadConfig`, loop |

## Implementation Plan

1. **Ledger helpers and config**: `sendAttempts`, `heldDraftIds`, `markSendAbandoned`,
   `rearmDraft` in `approval/ledger.ts`; the `send:` config block in `discovery/config.ts` with
   its defaults. Unit tests RCT1 through RCT4.
   ✅ *Human: with a seeded DB, `sendAttempts` returns the right count before and after a
   `send_rearmed` row.*
2. **Wire `retryApprovedUnsent`**: exclusion of held drafts, the RC3 floor, missing-email as an
   attempt, exhaustion text and event, `held` in the summary. Tests RCT5 through RCT10.
   ✅ *Human: run the loop five times against a stub sender that always throws, with the floor
   configured to zero; watch five failure texts, then one exhaustion text, then a sixth and
   seventh run that say nothing at all about that draft and show `held 1`.*
3. **`outreach rearm`**: CLI subcommand, help text, and the event write.
   ✅ *Human: `outreach rearm d7` on the held draft, then one more run attempts the send again
   and the counter starts from zero.*

## Test Requirements

Vitest, in-memory DB, stub channel and stub sender, no network.

- **RCT1**. `sendAttempts` counts only `send_failed` events for that draft, ignoring other
  types and other drafts.
- **RCT2**. `sendAttempts` counts only events after the latest `send_rearmed`.
- **RCT3**. `heldDraftIds` returns a draft with `send_abandoned` and not one with a later
  `send_rearmed`.
- **RCT4**. Config defaults apply when `config/watchlist.yaml` has no `send:` key, and
  overrides apply when it does.
- **RCT5**. **The cap case.** A sender that always throws, driven across runs with the floor
  disabled: exactly 5 `send_failed` events, exactly one `send_abandoned`, and the draft is not
  attempted again on run 6 or 7.
- **RCT6**. The exhaustion text is sent exactly once, contains the short id, the attempt
  count, and the last error, and is distinct from the per-attempt failure text.
- **RCT7**. The RC3 floor: a second run started immediately after a failure does not attempt
  the send, sends no text, and does not increment the count.
- **RCT8**. A draft whose person has no email accrues a `send_failed` event per attempt and
  reaches the cap, rather than texting forever.
- **RCT9**. A held draft still exists at status `approved`, is still returned by
  `priorThreads`, and is counted in the summary's `held` field.
- **RCT10**. After `rearmDraft`, the next run attempts the send again, and a subsequent
  success marks the draft `sent` normally.
- **RCT11**. A transient failure followed by a success does not abandon: one `send_failed`,
  then `sent`, no `send_abandoned`.
- **RCT12**. Dry run attempts nothing and writes no `send_failed` or `send_abandoned` rows
  (today's `if (!opts.dryRun)` guard, asserted so the cap work cannot regress it).

## Migration

No schema change at all. Every mechanism in this spec is expressed in rows of `draft_events`,
a table that already exists with the right shape, so the live `outreach/data/outreach.db`
needs no DDL, no `ALTER TABLE`, no rebuild, and no backfill.

Behavior on first run against the live database: existing `send_failed` events (if any) are
counted retroactively, which is correct. A draft that already accumulated five or more failures
is treated as at-cap and is abandoned on the next run, producing one exhaustion text and then
silence. That is the intended outcome and it is the fastest possible relief from the defect.
No draft is deleted, no status is changed, and nothing becomes sendable that was not sendable
before.

## Open Questions

1. **Distinguishing permanent from transient failures**: a 550 hard bounce deserves to stop
   immediately, while a 429 deserves all five attempts. The current `Sender` interface reports
   only a thrown `Error` with a message string, so the distinction is not available without
   classifying error text, which is exactly the kind of guessing this project avoids. The flat
   cap of 5 is correct until `Sender` reports a structured, permanent-versus-transient result.
   Revisit when the real Gmail sender lands.
2. **Post-submission bounces**: a send that the API accepts and that bounces hours later never
   reaches this code path at all; the draft is marked `sent` and the bounce lands in the user's
   mailbox. Bounce handling is a separate feature and is deliberately out of scope here.
