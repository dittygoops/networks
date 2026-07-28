# Technical Spec: Inbound Reply Deduplication

> Implements the `channel_inbound` half of the F5 spec
> ([`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md), AL3 and AL4) for
> the batch loop that actually exists today
> ([`docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`](./superpowers/specs/2026-07-26-discovery-outreach-loop-design.md)).
> Scope is exactly one problem: an inbound iMessage reply can be delivered more than once and
> is currently processed more than once. The unbounded send-retry defect in the same file is a
> separate problem with its own spec ([`docs/spec-send-retry-cap.md`](./spec-send-retry-cap.md)).

## Overview

`drainApprovals` in `outreach/src/pipeline/loop.ts` reads inbound replies from
`ApprovalChannel.captureReplies` and acts on each one. `InboundReply` already carries a
`messageId` (`outreach/src/approval/channel.ts`), and `createPhotonChannel` already populates
it from `message.id` (`outreach/src/approval/photonChannel.ts`, the `spc-msg-<uuid>` value the
F5 spike recorded as the dedup key). Nothing reads it. There is no `channel_inbound` table in
`outreach/src/db/schema.sql`, so no inbound message is ever recorded and no redelivery is ever
detected.

`app.messages` is a resumable ordered stream that reconnects, which is the exact replay
scenario F5 AL4 anticipated when it wrote `provider_message_id TEXT NOT NULL UNIQUE` with the
comment "providers can redeliver (stream replay on reconnect)".

This spec adds the table, records every accepted inbound message before acting on it, skips
messages already recorded, and turns the table into the inbound audit trail F5 AL4 wants.

### Current blast radius, stated exactly

A duplicate approval does **not** send a duplicate email today. `decide` in
`outreach/src/approval/ledger.ts` is first-write-wins: `INSERT OR IGNORE INTO decisions`
against `UNIQUE(draft_id)`, and on `changes === 0` it returns `{ applied: false, existing }`
and the caller replies with the existing outcome instead of sending. `handleReply` returns
immediately on that branch for both `send` and `skip`. So the never-email-twice invariant is
held by the decisions table, not by anything in this spec.

What a replay costs today:

- A repeated text back to the user ("d7 was already send.", "No draft found for d9.", "Could
  not read ... "). On a loop that runs daily, a stream that replays a window of history is a
  small burst of confusing texts.
- No inbound audit trail at all: nothing records what the user texted, when, or what it
  resolved to. When something goes wrong there is no way to reconstruct the reply side.
- Wasted work: parse, existence check, decide transaction, and one outbound text per replay.

This spec closes those three. It does not change the email-safety posture, which already
rests on `decide`. The dedup table is a second, independent guard on the same invariant, which
matters because `decide` protects a draft *decision*, not a *message*: any future inbound
command that is not a decision (an edit instruction, a `retry`, a `list`) has no
first-write-wins protection of its own and would be replayed for real.

## Resolved Decisions

### ID1. Ordering: record first, then act

The dangerous window is between recording a message and acting on it. Two orderings, one
must be chosen:

| Ordering | Crash in the window means |
|---|---|
| Act, then record | The action happened but no dedup row exists. Replay re-acts. |
| Record, then act | The dedup row exists but the action did not happen. Replay is ignored, so the reply is dropped. |

**Decision: record first, then act.** The project rule is that ambiguity must never resolve
toward sending, and a duplicate must never resolve toward sending twice. Record-then-act fails
toward doing less, act-then-record fails toward doing more. A cold email is irreversible, a
dropped reply is not.

The tradeoff is real and is accepted: a crash (or a `kill` from launchd, or a power loss)
between the insert and the action loses that one reply's effect, permanently, because the
replayed copy will be recognized as a duplicate and ignored. Three things bound that cost:

1. The window is small and synchronous. `better-sqlite3` commits the claim before
   `handleReply` runs; the window is one function call, not a network round trip.
2. Nothing is lost silently. The claim row stays in state `claimed` (ID3). The next run
   reports every stale claim (ID6), so the user is told which reply was dropped.
3. Recovery is trivial and safe. The draft is still `awaiting_approval`, so the user simply
   texts `d7 y` again. That is a new provider message id, so it is not a duplicate, and
   `decide` would refuse a second decision anyway.

Implementation shape, all inside `drainApprovals`, before `handleReply` is called:

```ts
const claim = claimInbound(deps.db, reply);   // committed INSERT OR IGNORE
if (!claim.fresh) continue;                   // duplicate: no action, no reply text
try {
  await handleReply(deps, opts, summary, reply);
  finishInbound(deps.db, claim.id, resolution, draftId);   // state -> 'handled'
} catch (e) { /* existing catch, plus finishInbound(..., 'error') */ }
```

`claimInbound` and `finishInbound` live in `outreach/src/approval/ledger.ts` next to `decide`,
because they are ledger writes and the ledger module is where the first-write-wins pattern
already lives.

### ID2. The dedup key, and what happens when the provider gives none

The key is `provider_message_id`, taken from `InboundReply.messageId`, which
`photonChannel.ts` sets from `message.id`.

`RawMessage.id` is typed non-optional in `photonChannel.ts` today, but the same mapper already
guards `sender` because the SDK types it as possibly absent. Do not assume the id is always
present and non-empty. When `messageId` is missing or empty, synthesize a deterministic key:

```
synth:<sha256(from + '\n' + providerTimestamp + '\n' + text) truncated to 32 hex chars>
```

A genuine replay of the same message hashes identically and is deduplicated. Two genuinely
distinct messages with identical sender, timestamp, and text collapse into one and the second
is dropped. That collision direction is "act less", never "send twice", which is the side this
spec is required to take. Log a `inbound_synth_key` event when the fallback fires so a
provider regression is visible rather than silent.

### ID3. Channel interface change

`InboundReply` gains the two fields the table needs and the synthetic key needs. This is
additive and the stub channel is updated in step with it.

```ts
export interface InboundReply {
  text: string;
  messageId: string;
  from: string;          // NEW: E.164 as reported by the provider (message.sender.id)
  receivedAt: string;    // NEW: provider timestamp, ISO; '' when the provider omits it
}
```

`photonChannel.ts` already reads `message.sender.id` for the allowlist check and the F5 spike
recorded `message.timestamp` as available, so both fields are free at the mapping site.
`createStubChannel` sets `from` to the configured approver and `receivedAt` to the current ISO
time.

### ID4. Rejected senders are counted, never quoted

The sender allowlist runs inside `photonChannel.captureReplies` today: a message whose
`sender.id` is not `APPROVER_PHONE` is dropped at the transport and never reaches the loop.
That placement stays.

F5 AL3 and AL4 would have recorded rejected messages into `channel_inbound` with
`accepted = 0`, text included. **This spec supersedes that for the text.** The line is a
shared Photon service number, so anyone can text it. Recording unbounded attacker-controlled
text in the same database whose rows get rendered into iMessage summaries today and into a
review page later is a stored-injection surface bought for very little: the system never acts
on those messages, so the text has no operational value.

What is recorded instead, in `draft_events` (`draft_id NULL`, matching the F5 convention for
non-draft events), one row per rejected message:

```
type: 'inbound_rejected'
detail_json: { senderFingerprint: <first 12 hex of sha256(sender)>, textLength: <int>, hasAttachment: <bool> }
```

The fingerprint preserves the only audit question worth answering, "is this one stranger five
times or five strangers", without storing a phone number or a single character of their text.
Rejected messages are not deduplicated (they are never claimed), so a replayed stranger
message is counted twice. That is accepted: the count feeds a digest line, not a decision.

### ID5. DDL

Added to `outreach/src/db/schema.sql`, following its existing conventions (`IF NOT EXISTS`,
`CHECK` on status-shaped columns, `datetime('now')` defaults, an explicit never-delete comment
on tables whose rows are load-bearing).

```sql
-- Inbound iMessage dedup and audit trail (spec-inbound-dedup ID5; realizes the
-- channel_inbound table of F5 AL4). Providers redeliver: app.messages is a
-- resumable ordered stream that replays on reconnect, so the UNIQUE key on
-- provider_message_id is what makes redelivery free instead of a hazard.
-- NEVER DELETE rows: a deleted row re-opens the message for reprocessing, and
-- this is also the only record of what the approver actually texted.
CREATE TABLE IF NOT EXISTS channel_inbound (
  id INTEGER PRIMARY KEY,
  provider_message_id TEXT NOT NULL UNIQUE,   -- Photon 'spc-msg-<uuid>', or 'synth:<hash>' (ID2)
  from_number TEXT NOT NULL,                  -- allowlisted senders only (ID4)
  text TEXT NOT NULL,                         -- verbatim reply text, approver only
  state TEXT NOT NULL DEFAULT 'claimed' CHECK(state IN ('claimed','handled','abandoned')),
  resolution TEXT CHECK(resolution IN
    ('approve','skip','unsupported','unparseable','unknown_draft','error')),
  draft_id INTEGER REFERENCES drafts(id),     -- NULL when the reply named no known draft
  duplicate_count INTEGER NOT NULL DEFAULT 0, -- redeliveries seen after the first (ID7)
  provider_timestamp TEXT,                    -- as reported by the provider; NULL if absent
  received_at TEXT DEFAULT (datetime('now')), -- when this process first saw it
  handled_at TEXT                             -- set when state leaves 'claimed'
);

CREATE INDEX IF NOT EXISTS idx_inbound_state ON channel_inbound(state);
```

`state` semantics: `claimed` is the transient state between the insert and the action;
`handled` means `handleReply` returned (successfully or with a reported error, which is
recorded in `resolution`); `abandoned` is set by the stale-claim sweep (ID6) for a claim that
a previous run never finished, which is the crash signature from ID1.

`resolution` maps one-to-one onto the branches already present in `handleReply`:
`unparseable`, `unknown_draft` (the `!draftExists` branch), `unsupported`, `skip`, `approve`,
and `error` (the `catch` in `drainApprovals`). `draft_id` is set whenever a short id parsed to
an existing draft, including on the `unsupported` branch.

### ID6. Stale claims are reported, not retried

At the start of `drainApprovals`, before draining, sweep rows still in `claimed` whose
`received_at` is older than the current run's start:

- Set `state = 'abandoned'`, `handled_at = datetime('now')`.
- Log `inbound_abandoned` in `draft_events` with the row id, the draft id when known, and the
  text.
- Add one line to `summary.errors` so it lands in the run summary text the user already gets:
  `inbound reply "d7 y" was recorded but never acted on (crash); reply again if it still matters`.

They are never re-run. Re-running a claim is exactly the act-twice behavior ID1 exists to
prevent, since the crash may have happened after the action rather than before it. Telling the
user is the correct recovery, and the recovery costs one text.

### ID7. Duplicate accounting

On a duplicate (the `INSERT OR IGNORE` reports `changes === 0`):

- `UPDATE channel_inbound SET duplicate_count = duplicate_count + 1 WHERE provider_message_id = ?`.
- Log `inbound_duplicate` in `draft_events` with the provider message id and the stored
  resolution.
- Take no action and send no text. Silence is the point: today's damage is the repeated text.
- Do not count it in `summary.errors`. A replay is normal provider behavior, not an error.

### ID8. What this does not change

- `decide` is untouched. It remains the never-email-twice guard, and this spec does not weaken
  or duplicate its responsibility.
- The allowlist stays in `photonChannel.ts`.
- Nothing here can cause a send. Every code path added is an insert, an update, or a skip.

## Interfaces

| Interface | Shape | Consumer |
|---|---|---|
| `claimInbound(db, reply)` | `{ id: number; fresh: boolean }`, committed before return | `drainApprovals` |
| `finishInbound(db, id, resolution, draftId \| null)` | void, sets `state='handled'` | `drainApprovals` |
| `sweepStaleClaims(db, runStartedAt)` | `AbandonedClaim[]` for the summary | `drainApprovals` |
| `InboundReply` | `{ text, messageId, from, receivedAt }` (ID3) | channel adapters, loop, tests |

## Implementation Plan

1. **Schema and ledger helpers**: ID5 DDL into `schema.sql`; `claimInbound`, `finishInbound`,
   `sweepStaleClaims` in `approval/ledger.ts`; `InboundReply` fields (ID3) plus the
   `photonChannel.ts` and `createStubChannel` mapping updates.
   ✅ *Human: open the live DB and confirm `channel_inbound` exists and is empty, and that the
   existing tables and row counts are untouched.*
2. **Wire `drainApprovals`**: claim before act, finish after act, duplicate accounting,
   stale-claim sweep and its summary line. Unit tests IDT1 through IDT8.
   ✅ *Human: run the loop against a stub channel that queues the same reply twice; confirm one
   decision, one outbound text, and `channel_inbound` showing `duplicate_count = 1`.*
3. **Live verification**: run one real loop, reply from the phone, then force a reconnect
   (kill the process mid window and rerun) so the stream replays.
   ✅ *Human: the replayed reply produces no second text, and `sqlite3` shows exactly one
   `channel_inbound` row for it with `state='handled'` and the right `resolution`.*

## Test Requirements

Vitest, in-memory DB (`openDb(':memory:')`), stub channel, no network, matching the existing
pattern in `outreach/test/loop.test.ts`.

- **IDT1**. A reply delivered once is claimed, acted on, and the row ends `state='handled'`
  with the correct `resolution` and `draft_id`.
- **IDT2**. **The replay case.** The same `messageId` queued twice in one drain: exactly one
  `decisions` row, exactly one outbound notify text, one `channel_inbound` row with
  `duplicate_count = 1`, and an `inbound_duplicate` event.
- **IDT3**. The same `messageId` delivered in a *later* run (fresh `runLoop` call, same DB):
  same assertions as IDT2. This is the reconnect-replay shape, and it is the one the table
  exists for.
- **IDT4**. Two distinct replies with distinct ids in one drain both act. Dedup must not
  swallow real traffic.
- **IDT5**. Record-then-act ordering: with a `handleReply` stubbed to throw before doing
  anything, the `channel_inbound` row still exists afterward, and a redelivery of that id in
  the next run is ignored rather than acted on.
- **IDT6**. Stale-claim sweep: a row seeded in `claimed` with an older `received_at` becomes
  `abandoned`, produces an `inbound_abandoned` event, and contributes one line to
  `summary.errors`. It is not re-acted on.
- **IDT7**. Every `resolution` value is reachable: `approve`, `skip`, `unsupported`,
  `unparseable`, `unknown_draft`, `error` each get a case asserting the stored value.
- **IDT8**. Empty `messageId` falls back to the synthetic key (ID2); the same triple
  (`from`, `receivedAt`, `text`) delivered twice is deduplicated; a different text is not.
- **IDT9**. A rejected sender never reaches `channel_inbound`, and the `inbound_rejected`
  event carries a fingerprint and a length but no text and no phone number (ID4).
- **IDT10**. Schema idempotency: opening the same DB file twice applies the DDL without error
  and preserves `channel_inbound` rows.

## Migration

The table is new, and `outreach/data/outreach.db` holds live data (5 drafts at
`awaiting_approval`, 1 `skipped` at the time of writing).

`openDb` executes `schema.sql` on every open and every statement in it is
`CREATE TABLE IF NOT EXISTS` or `CREATE INDEX IF NOT EXISTS`, so first run after this change
creates `channel_inbound` empty and touches nothing else. There is no `ALTER TABLE`, no
constraint change, no rebuild, and no backfill. Existing rows in `drafts`, `revisions`,
`decisions`, `draft_events`, and `seen_papers` are untouched, and the change is safe to apply
while the daily launchd job is armed.

There is no backfill because there is nothing to backfill from: inbound messages were never
recorded, so their ids are unrecoverable. The consequence, stated plainly: a message that was
already processed before this lands and is then replayed after it lands will be treated as
new and acted on once. That is exactly today's behavior for that one message, and `decide`
still prevents any double send. From the first recorded message onward, dedup is total.

Take the usual file copy of `outreach/data/outreach.db` before the first run, consistent with
the existing `outreach.backup-*.db` practice in that directory.

## Open Questions

1. **Photon replay window**: how far back the stream replays on reconnect is undocumented (F5
   Open Question 2 verified that replay happens, not how much). The dedup key makes any window
   safe, so this blocks nothing; it only affects how many `inbound_duplicate` events to expect.
2. **`message.id` stability across a replay**: the F5 spike recorded the id format but did not
   re-observe the same message twice to confirm the id is identical on redelivery. If Photon
   ever mints a new id per delivery, dedup by id silently stops working. Step 3's live
   verification is what confirms it; if it fails, fall back to the ID2 synthetic key for all
   messages, not just id-less ones.
