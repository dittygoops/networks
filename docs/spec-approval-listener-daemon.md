# Technical Spec: Persistent Approval Listener Daemon

> Scope: one problem/solution pair. **Problem:** an approval reply sent while `outreach loop` is
> not running is permanently lost, so the system has sent zero emails despite an explicit
> approval. **Solution:** a supervised, always-on `outreach listen` process owns the receive side
> and the send-on-approval side; `outreach loop` stays a daily batch that discovers, gates,
> drafts, and emits outbound messages.
>
> Out of scope (owned elsewhere): inbound message *decoding* and observability (named rejection
> reasons, `sender.address` versus `sender.id`, non-text content types) is owned by the companion
> [`docs/spec-inbound-decode.md`](./spec-inbound-decode.md) and is a hard dependency, see
> [Dependencies](#dependencies). Test seams for the Photon transport are
> owned by [`docs/spec-photon-channel-testing.md`](./spec-photon-channel-testing.md) and are
> referenced, not redesigned here. The edit path (F5) is untouched.

---

## 1. Problem

### 1.1 What happened

On 2026-07-27, Aditya texted `d8 y` to approve a real cold email. It was never acted on.

Evidence, all from direct experiment, not inference:

1. A subsequent `outreach loop` run connected, drained its reply window, and recorded nothing.
   `d8` stayed `awaiting_approval`, with no `decisions` row and no `draft_events` row.
2. A diagnostic listener (`outreach/scripts/spike-photon.ts --listen-only`) was then connected
   fresh and sat for more than two minutes. The earlier `d8 y` never arrived. This rules out a
   timing miss inside the 20 second window: a freshly connected client does not receive it at
   all.
3. A test message sent *while that listener was connected* arrived in about 9 seconds, with
   `sender: {"id":"+15555550123","address":"+15555550123","service":"iMessage"}` and
   `content: {"type":"text","text":"Test"}`. `APPROVER_PHONE` is exactly `+15555550123`, so the
   allowlist check and the content-type check in `photonChannel.ts` are **correct and are not the
   cause**.

Conclusion, stated as narrowly as the evidence supports: **Spectrum did not deliver, to a
newly connected client, a message that was sent while no client of this project was connected.**
Whatever queueing exists did not survive the disconnect for this project's credentials.

### 1.2 Why the current architecture cannot work

`createPhotonChannel.captureReplies` (`outreach/src/approval/photonChannel.ts`) drains inbound for
`replyWindowMs`, which `cmdLoop` sets to 20000. `runLoop` calls it once, at the top of a run, and
the process then exits. The connected window is therefore on the order of a few minutes per day,
during a scheduled run. Aditya replies whenever he happens to see the text. Those windows
essentially never overlap, and when they do not overlap the reply is gone forever.

### 1.3 What this invalidates

- [`docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`](./superpowers/specs/2026-07-26-discovery-outreach-loop-design.md)
  chose "pure scheduled batch, approvals drained at the next run". That choice rests on replies
  surviving until the next run. They do not. **This spec supersedes that decision and only that
  decision**; discovery, gating, drafting, and the data model from that design stand.
- [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md) asserts (line 577)
  that "queued messages redeliver on reconnect and the dedup key makes redelivery safe". That
  assertion is **contradicted by experiment for a fresh client** and must be treated as false
  going forward. Its outbox and dedup machinery are still useful and are partly adopted below,
  but not for the reason stated there.
- The sibling project's `docs/spec-core-messaging-loop.md` records empirical question SP-1 as
  "confirmed: a message sent while the process was dead was delivered on the next connection"
  (run 2026-07-17, different Photon project). Our 2026-07-27 experiment on the outreach project's
  own credentials shows the opposite. **Treat the sibling's SP-1 verdict as unverified for this
  project.** Do not build anything that depends on backfill. If backfill does happen to work
  sometimes, everything in this spec still holds; it just loses less.

### 1.4 The one thing this spec fixes

Be connected when the human replies. Nothing else reliably closes the gap, because there is no
polling API to fall back on (`spec-imessage-approval-loop.md` line 50: "Inbound polling API:
Unverified. Not documented; webhooks only").

---

## 2. Solution overview

Split the system into two processes with one owner per direction of the approval conversation.

```
                       data/outreach.db  (SQLite, WAL)
                        ^                    ^
        writes drafts,  |                    | writes decisions, sent/send_failed
        seen_papers,    |                    | events, drains channel_outbox
        channel_outbox  |                    |
                        |                    |
  +---------------------+--+        +--------+---------------------------+
  | outreach loop          |        | outreach listen (daemon)           |
  | launchd, daily 09:00   |        | launchd, RunAtLoad + KeepAlive     |
  | RunAtLoad false        |        | never exits voluntarily            |
  |                        |        |                                    |
  | discover -> gate ->    |        | Spectrum stream (always connected) |
  | orchestrate -> draft   |        |   -> allowlist -> parseReply       |
  | -> persistDraft        |        |   -> decide() -> Gmail send        |
  | -> enqueue ping        |        |   -> ack text                      |
  | -> summary to outbox   |        | outbox drain (all outbound text)   |
  | exits                  |        | approved-unsent retry timer        |
  | NEVER opens Spectrum   |        | startup reconciliation nudge       |
  +------------------------+        +------------------------------------+
```

The batch stops opening a Spectrum connection entirely. Everything it wants to say goes into a
`channel_outbox` table; the daemon, the single owner of the transport, drains and sends it. This
is the pivotal structural choice and section 4 defends it.

---

## 3. Process split

### 3.1 Disposition of every piece of today's `runLoop`

| Today, in `runLoop` | Moves to | Why |
| --- | --- | --- |
| `drainApprovals` / `captureReplies` | **Daemon** | It is the bug. A bounded drain window cannot catch an unbounded human. |
| `handleReply` (`parseReply`, `draftExists`, `decide`, notify) | **Daemon** | Must run the instant a reply lands, in the same process that received it. |
| The Gmail send after an approval | **Daemon** | See 3.2. |
| `markSent` / `markSendFailed` | **Daemon** | Follows the send. |
| `retryApprovedUnsent` | **Daemon**, on a timer | It is a send, and the daemon owns sends. Running it in the batch would put two processes on the Gmail send path for the same rows. |
| Queued flush (`getQueued` re-messaging) | **Batch**, but writing to the outbox instead of the transport | It is outbound draft delivery, which is batch work. Only the transport call moves. |
| `discoverAll`, `filterUnseen`, `recordDiscovered`, `gateCandidate`, `processPaper`, `generateDraft`, `persistDraft`, `setStatus`, `setRelevance` | **Batch** | Expensive, bursty, network and LLM heavy, once a day. Keeping it out of the daemon keeps the daemon small enough to trust as an always-on process, and keeps a drafting crash from taking down the receive side. |
| `emit` (send the draft ping) | **Batch**, via outbox | Same reasoning as the queued flush. |
| Run-summary `notify` | **Batch**, via outbox | It summarizes the batch. It is not approval traffic. |
| `LoopSummary.sent` | **Removed from the batch summary** | The batch no longer sends email. Replaced by `enqueued` and by a daemon-side counter. Prevents a false "sent 0" reading as a failure. |

**AD1.** `outreach loop` MUST NOT import `spectrum-ts`, MUST NOT call `createPhotonChannel`, and
MUST NOT call `deps.sender.send`. Enforced by a test that asserts on the module import graph
(T14), in the same spirit as PC5 in `spec-photon-channel-testing.md`.

**AD2.** `outreach listen` MUST NOT import the discovery, orchestration, or drafting modules.

### 3.2 The daemon performs the Gmail send. Stated explicitly.

**AD3.** On an approval the daemon MUST perform the Gmail API send itself, in-process,
immediately after `decide()` commits.

Justification, since the prompt asks for it rather than an assumption:

- Latency and honesty. The human is holding the phone. An ack that says "d8 sent to
  name@university.edu" within seconds is the only feedback that the approval was received. If the
  send waited for tomorrow's batch, the ack would have to say "queued", and a queued send that
  later fails is discovered a day late.
- Single writer for the send path. Splitting "decide" from "send" across processes creates a
  window in which a draft is `approved` but unsent and two processes both believe they may send
  it. One owner removes that class of bug.
- The daemon already holds the only thing the send needs beyond the DB: nothing. The Gmail API
  client is constructed from env and refresh token, exactly as in the batch today
  (`src/sender/gmail-api.ts`).

**AD4. When the daemon's send fails.** The existing semantics are preserved and are correct:
`markSendFailed` logs a `send_failed` event and **leaves the draft at status `approved`**
(`src/approval/ledger.ts`). The daemon MUST then:

1. Text the human the failure verbatim: `d8 failed to send: <message>`. Never silently swallow.
2. Leave the draft `approved` so it is picked up by the retry sweep.
3. Run a retry sweep (`retryApprovedUnsent`, moved per 3.1) on daemon start and every
   `RETRY_SWEEP_MS` (default 900000, 15 minutes).
4. Respect the existing send-attempt cap in [`docs/spec-send-retry-cap.md`](./spec-send-retry-cap.md).
   The sweep MUST NOT become an unbounded retry loop against a permanently rejecting recipient. On
   reaching the cap the daemon texts once, stops retrying that draft, and leaves it `approved` for
   a human.

**AD5.** A draft is never promoted into `approved` by anything other than an explicit human
approval reply. The retry sweep only reads rows already at `approved`; it is not a promoter. This
is unchanged from today's comment in `loop.ts` and MUST stay true after the move.

### 3.3 The outbound outbox

**AD6.** New table `channel_outbox`. The batch inserts; the daemon drains.

```sql
CREATE TABLE IF NOT EXISTS channel_outbox (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER REFERENCES drafts(id),   -- NULL for run summaries and nudges
  kind TEXT NOT NULL CHECK(kind IN ('draft_ping','notice')),
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON channel_outbox(state, id);
```

**AD7.** The daemon drains `pending` rows in `id` order, oldest first, one at a time, with at most
`OUTBOX_RATE_MS` (default 1500) between sends so a 12-draft batch does not arrive as an
indistinguishable wall of text. On send success: `state='sent'`, `sent_at`. On failure: increment
`attempts`, record `last_error`, leave `pending`, back off. At `attempts >= 8` set
`state='abandoned'` and log a `draft_events` row, so a permanently broken transport does not spin.

**AD8. Stale ping suppression.** Before sending a `draft_ping`, the daemon MUST re-read the
draft's status and skip (mark `abandoned`, reason `already_decided`) if it is not
`awaiting_approval`. This closes the "batch enqueued a ping for a draft the human decided in the
meantime" race without a lock. See 4.5.

**AD9.** The batch enqueues a `draft_ping` only inside the same transaction that reads the draft
status, so it cannot enqueue for a draft that was already decided at enqueue time. Belt and
braces with AD8, which covers the drain-time window.

### 3.4 Command surface

```
outreach listen [--dry-run]      # new. Long lived. Owns Spectrum.
outreach loop   [--dry-run]      # unchanged name, reduced job. Exits.
outreach loop   --drain-replies  # rollback escape hatch only, see section 10.
```

---

## 4. Concurrency and the database

Two processes now open `outreach/data/outreach.db`. `openDb` (`src/db/db.ts`) already sets
`journal_mode = WAL` and `foreign_keys = ON`. This section is the load-bearing part of the spec.

### 4.1 What WAL does and does not give us

- WAL allows **many concurrent readers and exactly one writer**. Readers never block the writer
  and the writer never blocks readers.
- It does **not** allow two concurrent writers. A second writer attempting to begin a write
  transaction while another holds the write lock gets `SQLITE_BUSY`.
- `better-sqlite3` is **synchronous**. Within one process there is no interleaving at all: a
  statement runs to completion before any other JS runs. So the only concurrency that exists in
  this system is between the two OS processes, at transaction granularity. This is a much smaller
  surface than it first appears.

**AD10.** `openDb` MUST additionally set:

```ts
db.pragma('busy_timeout = 5000');   // wait, do not immediately fail, on writer contention
db.pragma('synchronous = NORMAL');  // safe under WAL, avoids fsync per commit
db.pragma('wal_autocheckpoint = 1000');
```

`busy_timeout = 5000` is the single most important line. Without it, a `SQLITE_BUSY` from a
50 millisecond overlap surfaces as a thrown exception and, in the daemon, as a lost approval.

### 4.2 The rule that makes 5 seconds always enough

**AD11. No transaction may remain open across an `await`.** Every write transaction in this system
must be pure SQLite: no network, no LLM, no Gmail, no Spectrum call inside `db.transaction(...)`.

The current code already obeys this and it must be preserved and tested:

- `persistDraft` is pure SQLite (`ledger.ts` lines 33 to 72). Good.
- `decide` is pure SQLite. Good.
- The Gmail send in `handleReply` happens **after** `decide()` returns, not inside it
  (`loop.ts` lines 90 to 131). This must remain true in the daemon. If a multi-second Gmail HTTP
  call were ever moved inside the transaction, it would hold the single write lock for seconds and
  the batch would start eating `SQLITE_BUSY` despite the timeout.

Under AD11, every write transaction is sub-millisecond. Two processes contending for a
sub-millisecond lock with a 5 second timeout will effectively never fail. **T9** asserts this rule
statically.

**AD12.** Read-then-write transactions that cross processes MUST use an immediate transaction
(`db.transaction(fn).immediate(...)` in better-sqlite3), which issues `BEGIN IMMEDIATE` and takes
the write lock up front. A deferred transaction that reads first and writes later can fail with
`SQLITE_BUSY_SNAPSHOT` at upgrade time, which `busy_timeout` does **not** retry away, because the
snapshot is already stale. Applies to: `persistDraft`, `decide`, the AD9 enqueue, and the AD8
drain check. (`decide` today happens to write first, so it is already safe, but relying on
statement order inside a transaction is fragile; make it explicit.)

**AD13.** Both processes MUST wrap every DB call site that can contend in a bounded retry helper
(`withBusyRetry`, 3 attempts, 50/150/400 ms) that only retries on `SQLITE_BUSY` and
`SQLITE_BUSY_SNAPSHOT` and rethrows everything else. Defense in depth behind AD10 and AD12, not a
substitute for them.

### 4.3 Can interleaving violate `decide`'s first-write-wins?

No, and the reason is structural rather than lucky.

`decisions.draft_id` is `NOT NULL UNIQUE` (`schema.sql`), and `decide` uses
`INSERT OR IGNORE ... ; if (res.changes === 0) report existing`. The uniqueness is enforced by
SQLite itself, inside a single write transaction, under a single write lock that is global to the
database file and therefore global across processes. Two processes cannot both see
`changes === 1`. The loser reads the winner's row and reports it.

The remaining question is whether two *different* surfaces can now decide the same draft. Today:
`via` can be `imessage`, `web`, or `cli`. After the split, only the daemon writes `imessage`
decisions; the CLI add-flow can still write `cli`. That is exactly the case `UNIQUE(draft_id)` was
built for (A9 first-write-wins), and it is unchanged by this spec.

**AD14.** The batch MUST NOT call `decide()` at all. Verified by T15.

### 4.4 Can interleaving violate the never-email-twice guard?

No, and the analysis is worth writing down because it is the invariant with the worst failure
mode.

`priorThreads` (`ledger.ts` line 134) matches drafts for a person whose status is `LIKE 'sent%'`,
`= 'approved'`, or `= 'awaiting_approval'`. The batch calls it at `processCandidate` time, then
does slow work (draft generation) before `persistDraft`. So there is a real read-to-write gap of
possibly tens of seconds. What can the daemon do inside that gap?

The daemon can only perform these status transitions:

| Transition | Effect on the `priorThreads` match set |
| --- | --- |
| `awaiting_approval` -> `approved` | stays matched (both are in the set) |
| `approved` -> `sent` | stays matched (`sent%` is in the set) |
| `awaiting_approval` -> `skipped` | **leaves** the set |

Crucially, **the daemon cannot insert a draft**. Only `persistDraft` does that, and only the batch
calls it. Therefore the daemon can never cause the batch to *miss* a prior thread that exists.

The one shrinking transition is `awaiting_approval -> skipped`. Its worst case is that the batch
reads `priorThreads` at T0, sees a draft that the human is skipping at T0+1ms, and conservatively
marks the new candidate `drafted_unsendable` with reason `prior thread exists (d5)`. That is a
false negative: one candidate not drafted today. It costs a paper, not an email. The paper stays
in `seen_papers` with an explicit reason and can be revisited.

**Conclusion: cross-process interleaving can only make the never-email-twice guard more
conservative, never less.** That asymmetry is the safety property, and it follows from "only one
process creates drafts". **AD15** freezes it: `persistDraft` MUST have exactly one caller process
(the batch, plus the interactive `cli.ts add` flow which is human-driven and never concurrent with
itself). If a future feature lets the daemon create drafts, this analysis is void and must be
redone.

### 4.5 Can the batch messaging a draft race the daemon mid-approval?

Three sub-cases:

1. **A newly drafted, never-messaged draft.** The human has not seen it, so cannot have replied
   about it. No race.
2. **A `queued_for_message` draft being re-messaged by the flush.** The first message attempt may
   in fact have been delivered before the error (the failure could have been in the ack, not the
   delivery), so the human may already have replied. Sequence: batch enqueues a second ping ->
   daemon drains it -> human now sees two copies of `d5`. If the human replies `d5 y` twice,
   `decide()` first-write-wins makes the second a no-op and the daemon texts back
   "d5 was already send". **No second email.** AD8 further suppresses the duplicate ping entirely
   whenever the draft has already left `awaiting_approval`.
3. **Mid-approval, exactly interleaved.** The daemon is inside `decide()` while the batch is
   inside its enqueue transaction. Both are single write transactions on the same file; SQLite
   serializes them. Whichever runs second sees the other's committed state, which is precisely
   what AD8 and AD9 read. There is no torn state.

**AD16.** The batch MUST re-read draft status inside the enqueue transaction (AD9) and MUST NOT
cache a status read from before its slow work.

### 4.6 WAL file hygiene with a long-lived reader

A process that holds a read transaction open indefinitely prevents WAL checkpointing and the
`-wal` file grows without bound. `better-sqlite3` does not hold an implicit snapshot between
statements outside an explicit transaction, and the daemon's transactions are all sub-millisecond
per AD11, so this does not arise. **AD17** makes it a rule anyway: the daemon MUST NOT open a
long-lived read transaction, and MUST run `db.pragma('wal_checkpoint(TRUNCATE)')` once at startup
and once per hour, logging the result. **T10** asserts the `-wal` file does not grow monotonically
across a simulated 24 hour run.

### 4.7 Single-instance enforcement

Two daemons would both consume the stream (unknown SDK behavior with two clients on one project),
both drain the outbox, and both attempt sends. **AD18.** `outreach listen` MUST take an exclusive
advisory lock at startup (`flock` on `data/listen.lock`, or an `O_EXCL` pidfile with a liveness
check) and MUST exit non-zero with a clear message if another instance holds it. `--dry-run` takes
the same lock, so a dry-run daemon can never run beside the real one.

---

## 5. The read loop

Modelled directly on the sibling's proven implementation,
`/Users/apgupta/Documents/Coding/new/daily-prompts/src/channel/spectrum.ts`
(`SpectrumChannel.readLoop`, lines 238 to 275). Cited rather than reinvented, because it has been
running in production since 2026-07-17.

### 5.1 Structure

**AD19.** The daemon MUST run a `readLoop` of this shape:

```ts
private async readLoop(): Promise<void> {
  let consecutiveFailures = 0;
  while (!this.stopped) {
    try {
      for await (const [space, message] of this.app.messages) {
        consecutiveFailures = 0;              // any delivered message proves health
        try { this.handleMessage(space, message); }
        catch (err) { this.log(`inbound handling error: ${err}`); }
      }
      this.log('spectrum message stream ended');
    } catch (err) {
      this.log(`spectrum stream error: ${err}`);
    }
    if (this.stopped) break;
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_STREAM_FAILURES) process.exit(1);
    await sleep(BACKOFF_BASE_MS * Math.min(consecutiveFailures, 6));
    await this.rebuildClient();               // NOT just re-entering the for-await
  }
}
```

**AD20. Rebuild, do not re-iterate.** On stream end or error the daemon MUST call `app.stop()`,
construct a **new** `Spectrum(...)` instance, and discard every cached space handle. The sibling's
comment states the reason and it is the whole point: *"Re-iterating a dead stream on the same
client reconnects nothing"*. The outreach code has a matching scar: `spec-photon-channel-testing.md`
records that `app.close?.()` silently no-opped (the real method is `stop()`), leaving the stream
resumable and the process hanging forever. Cached space handles bound to a dead client are the
same class of bug.

**AD21. Backoff.** `BACKOFF_BASE_MS = 5000`, multiplier `min(consecutiveFailures, 6)`, so 5s, 10s,
15s, ... capped at 30s. Matches the sibling.

**AD22. Failure ceiling and supervised restart.** `MAX_CONSECUTIVE_STREAM_FAILURES = 30`. On reach,
log loudly and `process.exit(1)`. launchd `KeepAlive` restarts the process clean. A fresh process
is strictly stronger than a rebuilt client: it re-reads env, re-opens the DB, and drops every
piece of in-process state. At 30s cap this is roughly 15 minutes of failure before restart, which
is long enough to ride out a Photon incident and short enough to bound damage.

**AD23. `consecutiveFailures` resets on the first successfully delivered message**, not on a
successful connect. A client that connects and immediately dies is not healthy, and resetting on
connect would loop forever without ever hitting the ceiling.

### 5.2 Laptop sleep and wake

This is the dominant real-world disconnect and it needs explicit handling, because the failure
mode is silent.

- **On sleep:** the gRPC connection dies or is suspended. Messages sent during sleep are, per
  section 1.1, presumed lost. This is stated in section 6, not hidden here.
- **On wake:** the stream is frequently *half open*. The socket looks alive to the client, the
  `for await` never throws and never yields, and `consecutiveFailures` never increments. The
  read loop alone cannot detect this. This is the single most likely way a naive daemon silently
  stops working, and it would reproduce the exact bug this spec exists to fix.

**AD24. Liveness probe.** Every `PROBE_INTERVAL_MS` (default 300000, 5 minutes) the daemon MUST
issue a cheap, side-effect-free SDK request (`imessage(app).space.create(APPROVER_PHONE)`, which
resolves an existing DM handle and **sends no message**) with a 10 second timeout. On failure or
timeout, treat it exactly as a stream error: increment `consecutiveFailures`, back off, rebuild the
client. **The probe must never text anyone.** A probe implemented by sending a message would spam
the human 288 times a day and is forbidden.

**AD25. Wake trigger.** The daemon MUST additionally force a client rebuild when it detects a wall
clock jump: if more than `PROBE_INTERVAL_MS * 3` of wall time elapses between probe ticks, the
machine slept. Rebuild immediately rather than waiting for the next probe. Cheap, no platform APIs
needed, catches the common case seconds after wake instead of minutes.

**AD26.** Every rebuild, every probe failure, and every reconnect MUST be logged with an ISO
timestamp. The log is the only way a human can answer "was the daemon actually connected when I
texted?" after the fact. See section 6.3.

---

## 6. What is still lost. Be honest.

**The daemon does not make approval loss impossible.** It shrinks the loss window from about 23
hours 58 minutes per day to the daemon's downtime. Do not claim otherwise anywhere in code
comments, docs, or user-facing text.

### 6.1 Residual exposure, enumerated

| Window | Typical duration | Mitigated? |
| --- | --- | --- |
| Machine off or asleep | hours, nightly | **No.** Unavoidable without a server. Largest residual by far. |
| Reboot, before launchd `RunAtLoad` | seconds to a minute | No, but small. |
| Crash, before `KeepAlive` restart | seconds (`ThrottleInterval` 10) | No, but small. |
| Deliberate restart for a code update | seconds | No. Note it in the deploy step. |
| Failure ceiling backoff (AD22) | up to about 15 minutes | No. |
| Photon-side outage | unbounded | No. |
| Half-open socket after wake | up to `PROBE_INTERVAL_MS` (5 min) | Partly, by AD24 and AD25. |

The honest one-line summary for the README: *if your Mac is asleep or off when you reply, the
reply is probably gone; reply again when you see no confirmation.*

### 6.2 Mitigation 1: every reply gets an acknowledgement (loss becomes detectable)

**AD27.** The daemon MUST text a response to **every** inbound message from `APPROVER_PHONE` that
it processes, including:

| Case | Ack text |
| --- | --- |
| approved and sent | `d8 sent to name@university.edu.` |
| approved, send failed | `d8 failed to send: <error>` |
| skipped | `d8 skipped.` |
| already decided | `d8 was already send.` |
| unknown short id | `No draft found for d8. Ignoring that reply.` |
| unparseable | `Could not read "...". Reply like "d7 y" or "d7 n".` |
| edit attempt | `Edits are not yet supported for d8. Reply "y" to send or "n" to skip.` |

These strings already exist in `handleReply` and move with it unchanged.

This converts silent loss into detectable loss. **The absence of an ack within roughly a minute is
the signal that the reply did not land.** That is the single highest-value mitigation in this
spec, and it costs nothing. It must be documented in the operator README so the human knows to
re-send.

### 6.3 Mitigation 2: startup reconciliation nudge

**AD28.** On startup, after taking the lock and connecting, the daemon MUST run a reconciliation
pass:

1. Count drafts at `awaiting_approval`.
2. If greater than zero, enqueue one `notice` to the outbox:
   `Listener up. N drafts still awaiting approval: d1 d2 d4 ... Reply "d1 y" to send or "d1 n" to skip.`
3. Cap the id list at 10 and append `(+K more)`.
4. Run the approved-unsent retry sweep (AD4.3) so a send that failed while the daemon was down
   heals immediately.

This does not recover the lost reply. It gives the human a standing, low-friction way to re-issue
it, which is what actually closes the loop.

**AD29. Do not nag.** At most one reconciliation notice per daemon start, and suppress it entirely
if an identical notice was enqueued within `NUDGE_COOLDOWN_MS` (default 6 hours). A crash-looping
daemon must not text the same list every 10 seconds. Track via a `draft_events` row with
`type='reconcile_nudge'` and `draft_id NULL`.

**AD30.** The batch's run-summary line MUST include `awaiting <n>` so the daily message also
surfaces the standing queue without a separate nudge.

### 6.4 What cannot be mitigated and must not be papered over

- A reply sent while the Mac is asleep is gone. There is no polling API to reconcile against, and
  backfill is disproven for a fresh client (section 1.1).
- The system therefore has **no read-your-writes guarantee on the human's side**. Only the ack
  (AD27) tells the human anything landed.
- Whether Photon delivers to a client that was connected but network-partitioned is **untested**.
  It could be backfilled or dropped; the daemon behaves identically either way, because it never
  relies on backfill. Listed as Open Question OQ2.

---

## 7. Safety invariants after the split

Each invariant, where it lives after the split, and the argument that it survives.

### 7.1 Nothing sends without an explicit human approval reply

- The only call site of `sender.send` is the daemon, reached from exactly two places: (a)
  `handleReply` after `decide(db, id, 'send', 'imessage')` returned `applied: true`, which only
  happens for `parseReply(...).kind === 'approve'`; (b) the retry sweep, which selects
  `WHERE d.status = 'approved'`, a status only reachable through (a) or a human `cli` decision.
- **AD31.** The daemon MUST NOT contain any code path that calls `decide(..., 'send', ...)` other
  than from a parsed inbound approve. No timers, no reconciliation, no "auto-approve after N days".
- **AD1** removes the send path from the batch entirely, which strictly reduces the number of
  places this invariant can be broken from two processes to one.
- **T1** asserts a fake sender records zero sends across a full daemon run with no inbound.

### 7.2 Never email the same person twice

- Enforced by `priorThreads` in the batch, unchanged. Section 4.4 proves interleaving can only
  make it more conservative.
- **AD32.** The daemon MUST also re-check `priorThreads(db, personId, draftId)` immediately before
  sending, and MUST refuse (text the human, log `send_blocked_prior_thread`, leave the draft
  `approved`) if any *other* draft for that person is already `sent%`. This guard does not exist
  today. It is new, cheap, and it is the last line of defense at the moment of irreversibility.
  Note that `approved` and `awaiting_approval` siblings must **not** block here (only `sent%`),
  otherwise a draft could block itself out of ever sending.
- **T2, T3** cover both directions.

### 7.3 Ambiguous replies never resolve toward sending

- `parseReply` (`src/approval/channel.ts`) is a pure function and moves to the daemon **unchanged
  and unweakened**. Its bare-digit rule (a lone `8` with no `d` prefix and no keyword is
  `unparseable`) is the specific protection against an accidental text becoming a cold email.
- **AD33.** No new grammar, no fuzzy matching, no "did you mean". The daemon receives far more
  traffic than the old 20 second window did, which makes the grammar *more* exposed to stray
  texts, not less. Tighten nothing, loosen nothing, and re-run the existing
  `outreach/test/channel.test.ts` unchanged.
- **T4** re-asserts the bare-digit case at the daemon level, not just at the parser level.

### 7.4 The sender allowlist holds

- The line may be shared. Only `APPROVER_PHONE` may be acted on.
- **AD34.** The allowlist check MUST run in the daemon before `parseReply`, and a non-matching
  sender MUST produce no outbound text of any kind (no "who are you?"), so the system cannot be
  used as a reflector to text arbitrary numbers.
- **AD35.** The precise field the allowlist reads is **owned by the companion decoding spec**.
  Today's code reads `message.sender?.id` only; the observed payload carries both `id` and
  `address` with the same value, and the sibling implementation prefers `address ?? id`
  (`daily-prompts/src/channel/spectrum.ts` line 124). Do not change it here. The daemon consumes
  whatever decode function the companion spec defines. This spec depends on that decision, it does
  not make it.
- **T5** (allowlist) and **T6** (no outbound to strangers) run against the injected fake transport
  from `spec-photon-channel-testing.md` (PC1, PC6), never a real connection.

### 7.5 What `--dry-run` means for a daemon

A daemon has no natural end, so "dry run" has to be defined rather than inherited.

**AD36.** `outreach listen --dry-run` MUST:

- connect for real (there is no other way to observe the transport),
- receive, allowlist-filter, decode, and `parseReply` for real,
- log to stdout exactly what it *would* have done, one line per inbound message,
- write **nothing** to the database: no `decisions` row, no `draft_events` row, no outbox state
  change,
- send **no** email,
- send **no** iMessage, including acks and the reconciliation nudge,
- **not** drain the outbox (otherwise it would text on the batch's behalf),
- still take the single-instance lock (AD18), so it can never shadow the real daemon.

**AD37.** The dry run MUST print a banner at startup and on every decision line so a human reading
the log cannot mistake it for the real thing:
`DRY RUN: would send d8 to name@university.edu (nothing sent, nothing written)`.

**AD38.** `outreach loop --dry-run` keeps today's meaning, now simpler because the batch has no
transport: it performs discovery, gating, and drafting, marks candidates `queued_for_message` with
reason `dry run, not messaged`, and **enqueues nothing into the outbox**. Since the batch no
longer touches Spectrum or Gmail at all, a dry run cannot text or email even by mistake. Today's
`createStubChannel` substitution in `cmdLoop` becomes unnecessary and MUST be deleted rather than
left as a decorative safety net.

**AD39.** A dry run of either process MUST NOT be usable to launder a real send. `--dry-run` is
read-only with respect to `decisions`, `drafts.status`, and outbound transport, in both processes.

---

## 8. Operations

### 8.1 The plist

New file `outreach/scripts/com.aditya.outreach.listen.plist`, modelled on
`/Users/apgupta/Documents/Coding/new/daily-prompts/ops/com.dailyprompts.daemon.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aditya.outreach.listen</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>exec npx tsx --env-file=.env src/cli.ts listen</string>
  </array>
  <key>WorkingDirectory</key>
  <string>REPLACE_WITH_ABSOLUTE_PATH/outreach</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>REPLACE_WITH_ABSOLUTE_PATH/outreach/data/listen.log</string>
  <key>StandardErrorPath</key>
  <string>REPLACE_WITH_ABSOLUTE_PATH/outreach/data/listen.err.log</string>
</dict>
</plist>
```

Notes on the differences from the sibling and from the existing batch template:

- `RunAtLoad true` + `KeepAlive true` is the whole supervision story and mirrors the sibling
  exactly. It is what makes AD22's `process.exit(1)` a recovery mechanism rather than an outage.
- `exec` in the `zsh -lc` string so launchd supervises `tsx` directly and `KeepAlive` is not
  fooled by an intermediate shell.
- `ThrottleInterval 10` bounds a crash loop to 6 restarts a minute.
- `ProcessType Background` keeps macOS from aggressively throttling it, without claiming
  `Interactive` priority it does not need.
- **AD40.** The plist template ships with `REPLACE_WITH_ABSOLUTE_PATH` placeholders and is
  **deliberately not installed**, matching the existing `outreach/scripts/com.aditya.outreach.plist`
  convention (that one is a template for the daily batch and has `RunAtLoad false`; it is
  untouched by this spec). Installation is a human step, documented below.
- **AD41.** The batch plist and the listener plist are separate labels and separate log files. Do
  not merge them.

### 8.2 Install, start, stop, status

```sh
# install (one time, after substituting paths)
cp scripts/com.aditya.outreach.listen.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aditya.outreach.listen.plist

# status: 0 exit code means loaded; look at "state" and "last exit code"
launchctl print gui/$(id -u)/com.aditya.outreach.listen

# restart after a code change (this is a loss window, see 6.1)
launchctl kickstart -k gui/$(id -u)/com.aditya.outreach.listen

# stop / uninstall
launchctl bootout gui/$(id -u)/com.aditya.outreach.listen
```

### 8.3 Logs

| Path | Contents |
| --- | --- |
| `outreach/data/listen.log` | daemon stdout: startup, connect, rebuild, probe, decisions, sends |
| `outreach/data/listen.err.log` | daemon stderr: stack traces, exit reasons |
| `outreach/data/loop.log`, `loop.err.log` | unchanged, batch only |

**AD42.** Every daemon log line MUST begin with an ISO 8601 timestamp, matching the sibling's
`log()` helper. Without timestamps the log cannot answer "were you connected at 11:42pm?", which is
the exact question this whole spec exists to answer.

**AD43.** The daemon MUST log a heartbeat line at most every 15 minutes
(`listener alive; connected since <t>; probes ok <n>; last inbound <t or never>`) so an idle log
still proves liveness. It MUST NOT log a heartbeat per probe (that is 288 lines a day of noise).

**AD44.** Logs MUST NOT contain draft bodies, recipient email addresses beyond the ack line, or
the Spectrum project secret.

### 8.4 How a human verifies the daemon is actually receiving

This is the acceptance test that would have caught the original bug, and it must be in the README.

**The safe liveness text:** text `d0 y` to the Photon line from `+15555550123`.

`parseShortId('d0')` parses, `draftExists` returns false, and the daemon replies
`No draft found for d0. Ignoring that reply.` within about 15 seconds. This exercises the entire
receive path (stream, allowlist, decode, parse, DB read, outbound send) and **cannot send an
email**, because draft 0 does not exist and never will (`drafts.id` starts at 1 and rows are never
deleted, per the schema comment).

**AD45.** `d0 y` MUST remain safe. Any future change that makes short id 0 resolvable breaks the
documented liveness check and is forbidden.

Secondary checks, in order of decreasing confidence:

1. `d0 y` returns an ack. (Full path, highest confidence.)
2. `tail -f data/listen.log` shows a heartbeat within the last 15 minutes.
3. `launchctl print` shows the job running with a recent PID and last exit code 0.
4. `sqlite3 data/outreach.db "select count(*) from channel_outbox where state='pending'"` returns
   0 or a small number. A growing pending count means the daemon is up but not draining.

---

## 9. Requirements and tests

### 9.1 Requirement index

| ID | Requirement | Section |
| --- | --- | --- |
| AD1 | Batch must not import spectrum-ts, nor call the sender | 3.1 |
| AD2 | Daemon must not import discovery/orchestration/drafting | 3.1 |
| AD3 | Daemon performs the Gmail send on approval | 3.2 |
| AD4 | Send failure: text the human, stay `approved`, retry sweep, respect the cap | 3.2 |
| AD5 | Nothing but a human reply promotes a draft to `approved` | 3.2 |
| AD6 | `channel_outbox` table | 3.3 |
| AD7 | Drain order, pacing, backoff, abandon at 8 attempts | 3.3 |
| AD8 | Stale ping suppression at drain time | 3.3 |
| AD9 | Enqueue reads status in the same transaction | 3.3 |
| AD10 | `busy_timeout`, `synchronous`, `wal_autocheckpoint` pragmas | 4.1 |
| AD11 | No transaction open across an `await` | 4.2 |
| AD12 | Cross-process read-then-write transactions use `BEGIN IMMEDIATE` | 4.2 |
| AD13 | Bounded `SQLITE_BUSY` retry helper | 4.2 |
| AD14 | Batch never calls `decide()` | 4.3 |
| AD15 | Only the batch/CLI creates drafts | 4.4 |
| AD16 | No cached status across slow work | 4.5 |
| AD17 | No long-lived read transaction; periodic checkpoint | 4.6 |
| AD18 | Single-instance lock, including for dry runs | 4.7 |
| AD19 | `readLoop` shape | 5.1 |
| AD20 | Rebuild the client, do not re-iterate | 5.1 |
| AD21 | Exponential backoff, 5s base, capped at 30s | 5.1 |
| AD22 | Failure ceiling 30, then `process.exit(1)` | 5.1 |
| AD23 | Reset failures on delivered message, not on connect | 5.1 |
| AD24 | Side-effect-free liveness probe every 5 min; never texts | 5.2 |
| AD25 | Wall-clock jump forces rebuild (sleep/wake) | 5.2 |
| AD26 | Log every rebuild, probe failure, reconnect | 5.2 |
| AD27 | Ack every processed reply | 6.2 |
| AD28 | Startup reconciliation nudge and retry sweep | 6.3 |
| AD29 | Nudge cooldown, no nagging | 6.3 |
| AD30 | Batch summary includes `awaiting <n>` | 6.3 |
| AD31 | No non-human path to a `send` decision | 7.1 |
| AD32 | Pre-send `priorThreads` re-check for `sent%` siblings | 7.2 |
| AD33 | `parseReply` grammar unchanged | 7.3 |
| AD34 | Allowlist before parse; silence toward strangers | 7.4 |
| AD35 | Sender field choice owned by the decoding spec | 7.4 |
| AD36 | `listen --dry-run` semantics | 7.5 |
| AD37 | Dry-run banner on every line | 7.5 |
| AD38 | `loop --dry-run` semantics; delete the stub-channel substitution | 7.5 |
| AD39 | Dry run cannot launder a real send | 7.5 |
| AD40 | Listener plist is a template, not installed | 8.1 |
| AD41 | Separate labels and logs for batch and listener | 8.1 |
| AD42 | ISO timestamps on every daemon log line | 8.3 |
| AD43 | Heartbeat at most every 15 minutes | 8.3 |
| AD44 | No secrets or draft bodies in logs | 8.3 |
| AD45 | `d0 y` stays a safe liveness check | 8.4 |

### 9.2 Test requirements

**Constraint, non-negotiable: no test may open a real gRPC connection.** Tests use the injected
transport seam specified by
[`docs/spec-photon-channel-testing.md`](./spec-photon-channel-testing.md) (PC1 interface, PC5
no-network rule, PC6 fake session). That spec is a **prerequisite**, and this spec does not
redesign the seam. The daemon is constructed from an injected transport factory
`() => Promise<PhotonSession>` so a test can hand it a fake that yields scripted messages and
records outbound text, and can fail the "connection" on demand.

| ID | Test | Asserts |
| --- | --- | --- |
| T1 | Daemon runs with no inbound | zero sends, zero decisions, zero outbound (AD31) |
| T2 | Approve `d8` with a `sent` sibling draft for the same person | refused, logged `send_blocked_prior_thread`, still `approved`, human texted (AD32) |
| T3 | Approve `d8` with only `awaiting_approval` siblings | sends normally (AD32 does not self-block) |
| T4 | Inbound `8`, `yes`, `d8 maybe`, empty, emoji | none produce a send; bare digit is `unparseable` (AD33) |
| T5 | Inbound `d8 y` from a non-allowlisted number | no decision, no send (AD34) |
| T6 | Same | no outbound text of any kind to that number (AD34) |
| T7 | Fake transport ends the stream 3 times, then delivers | client rebuilt 3 times (a *new* session object each time), message handled, failures reset to 0 (AD20, AD23) |
| T8 | Fake transport fails 30 consecutive times | `process.exit(1)` invoked via an injected `exit` fn, backoff sequence 5s,10s,...,30s,30s (AD21, AD22) |
| T9 | Static scan of `src/` | no `await` inside any `db.transaction(...)` callback (AD11) |
| T10 | Two real `better-sqlite3` handles on one temp file: batch loop writing drafts while daemon loop writes decisions, 1000 iterations | zero unhandled `SQLITE_BUSY`, all rows present, `-wal` bounded (AD10, AD13, AD17) |
| T11 | Two handles both call `decide(db, id, 'send')` in a tight interleave | exactly one `applied: true`, one `decisions` row, one `sent` event (AD12, 4.3) |
| T12 | Batch enqueues a ping for `d5`; daemon decides `d5` before drain | ping abandoned with `already_decided`, no text (AD8) |
| T13 | Outbox drain with a failing transport | attempts increment, stays `pending`, abandons at 8, never double-sends a `sent` row (AD7) |
| T14 | Import-graph test on the batch entrypoint | `spectrum-ts` and the sender module unreachable (AD1) |
| T15 | Import-graph / call-graph test | `decide` unreachable from the batch entrypoint (AD14) |
| T16 | `listen --dry-run` against a fake yielding `d8 y` | zero DB writes (row counts identical before and after), zero sends, zero outbound, banner printed (AD36, AD37) |
| T17 | Startup with 7 `awaiting_approval` drafts | exactly one nudge enqueued, listing 7 ids; a second start within the cooldown enqueues none (AD28, AD29) |
| T18 | Probe returns a rejected promise | counted as a stream failure, client rebuilt, **no message sent** to anyone (AD24) |
| T19 | Clock jumps forward 20 minutes between probe ticks | rebuild triggered without waiting for the next probe (AD25) |
| T20 | Second `outreach listen` while one holds the lock | exits non-zero, prints the holder's pid, does not connect (AD18) |
| T21 | `d0 y` inbound | replies `No draft found for d0.`, no send, no decision (AD45, AD27) |
| T22 | Every ack case in the 6.2 table | exactly one outbound per inbound, text matches (AD27) |
| T23 | Gmail send throws | `send_failed` event, status stays `approved`, human texted, next sweep retries, cap respected (AD4) |

**T24 (manual, required before enabling).** The section 8.4 checklist, performed by a human,
including: text `d0 y` and observe the ack; close the laptop lid for 10 minutes, reopen, text
`d0 y` again and observe the ack (this is the sleep/wake regression, and it is the one thing no
unit test can prove).

---

## 10. Migration and rollback

### 10.1 The 7 drafts currently at `awaiting_approval`

Verified against `data/outreach.db` on 2026-07-27:

| short id | status | created |
| --- | --- | --- |
| d1 | awaiting_approval | 2026-07-20 14:03 |
| d2 | awaiting_approval | 2026-07-20 14:12 |
| d3 | awaiting_approval | 2026-07-20 14:14 |
| d4 | awaiting_approval | 2026-07-22 22:03 |
| d5 | awaiting_approval | 2026-07-22 22:03 |
| d6 | **skipped** | 2026-07-27 23:07 |
| d7 | awaiting_approval | 2026-07-27 23:26 |
| d8 | awaiting_approval | 2026-07-27 23:27 |

Seven awaiting approval, and `seen_papers` shows only 2 rows at status `messaged`, so **most of
these were never texted to the human at all.**

**AD46. Migration is additive and touches no existing row.** The migration adds
`channel_outbox` and nothing else. It MUST NOT bulk-approve, bulk-skip, bulk-expire, or re-message
anything. Cold emails are irreversible and these drafts are up to a week old, built from facts
mined a week ago.

**AD47.** On first daemon start the reconciliation nudge (AD28) lists all 7 ids. The human decides
each one by replying, or ignores them.

**AD48. Do not auto-resend the 7 draft bodies.** Texting 7 full drafts unprompted is a wall of
text and invites a hasty approval. The nudge lists ids only. If the human wants the body again,
that is a `list`/`show` command (F5 territory), explicitly out of scope here.

**AD49. Staleness warning.** d1 through d5 are 5 to 7 days old. The reconciliation notice MUST
append: `d1-d5 are several days old; re-check before approving.` It MUST NOT claim anything about
the drafts' content, and it MUST NOT invent a reason. A stale draft is not a wrong draft, it is
an unreviewed one.

**AD50.** `d8` specifically: the approval that started all this was lost and there is no record of
it (no `decisions` row, no `draft_events` row). The system MUST NOT infer or reconstruct that
approval. It was not received; treating a remembered text as a recorded approval would be
fabricating a user action. The human re-replies `d8 y` after the daemon is up, and that reply is
the record.

### 10.2 Rollback

**AD51.** The rollback path MUST be a single launchctl command plus a flag, with no code revert
and no schema revert:

```sh
launchctl bootout gui/$(id -u)/com.aditya.outreach.listen
# then, until the daemon is fixed:
npx tsx --env-file=.env src/cli.ts loop --drain-replies
```

**AD52.** `drainApprovals`, `handleReply`, and the batch's `captureReplies` wiring MUST be
**retained behind `--drain-replies`, not deleted**, for exactly one release cycle. That flag
restores today's exact behavior (a 20 second drain window, batch-side send) as a degraded fallback.
It is off by default, and running it while the daemon is up is prevented by having it acquire the
same single-instance lock (AD18); if the daemon holds the lock, `--drain-replies` refuses to run.

**AD53.** `channel_outbox` rows left `pending` at rollback are drained by `--drain-replies` before
its reply window, so nothing the batch already enqueued is stranded.

**AD54. Rollback trigger criteria**, decided in advance so the call is not made under pressure:
roll back if, over any 24 hour period, the daemon restarts more than 20 times, or the liveness
check (`d0 y`) fails twice in a row, or any send occurs without a matching `decisions` row.

---

## 11. Dependencies

1. **[`docs/spec-inbound-decode.md`](./spec-inbound-decode.md)** (companion, written in
   parallel with this one). Owns named
   rejection reasons, `sender.address` versus `sender.id`, and non-text content types. The daemon
   consumes its decode function. **Blocking for AD35.** Without it, the daemon inherits today's
   `sender?.id`-only read, which happens to work for the current payload shape but is unverified
   against reactions, tapbacks, group messages, and attachments.
2. **[`docs/spec-photon-channel-testing.md`](./spec-photon-channel-testing.md).** Owns the
   injection seam (PC1, PC3), the no-network rule (PC5), and the fake session (PC6). **Blocking for
   every test in 9.2.** Not redesigned here.
3. **[`docs/spec-send-retry-cap.md`](./spec-send-retry-cap.md).** Owns the attempt cap that AD4
   defers to.
4. **[`docs/spec-inbound-dedup.md`](./spec-inbound-dedup.md).** If Photon ever does redeliver on
   reconnect, dedup is what keeps a redelivered `d8 y` harmless. Not required for correctness here
   (`decide`'s first-write-wins already makes a duplicate approve a no-op), but it is what turns a
   duplicate into a clean "already send" ack rather than a confusing one.

---

## 12. Open questions

**OQ1.** Can two Spectrum clients hold the same project's message stream at once, and does the
second steal or split delivery? **Unknown, and this spec is deliberately built so the answer does
not matter**: the outbox design (AD6) means exactly one process ever connects. If the answer later
turns out to be "yes, safely", the simpler design (batch opens a send-only client) becomes
available and the outbox could be retired. Do not assume it until measured.

**OQ2.** Does Photon backfill to a client that was connected and then network-partitioned (as
opposed to fully disconnected)? Untested. The daemon behaves identically either way because it
never relies on backfill. Worth a 5 minute experiment (connect, disable wifi, text, re-enable)
purely to size the residual in 6.1.

**OQ3.** Is `imessage(app).space.create(phone)` truly free of side effects when the DM already
exists? The spike evidence says it returns an existing handle, but AD24 makes it a request every 5
minutes forever. **Verify before enabling the probe.** If it turns out to create or bump a
conversation, replace the probe with a different read-only call, or drop the probe and rely on
AD25 alone. Never replace it with a probe that sends a message.

**OQ4.** Should the daemon also own the daily schedule (a timer that shells out to the batch),
replacing the second launchd job, as the sibling does with its in-process `scheduleLoop`? Simpler
ops, one job instead of two. Rejected for now: it couples batch failures to daemon uptime, and the
batch's whole design is "crash safely and try again tomorrow". Revisit only after the daemon has
been stable for a month.
