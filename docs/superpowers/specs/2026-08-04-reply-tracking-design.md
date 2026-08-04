# Reply Tracking: find out whether any of the 39 cold emails were answered

**Date:** 2026-08-04
**Status:** Draft, not yet reviewed
**Problem owner:** the system optimizes end to end for sending, and sending is not the goal

## Problem

The system has sent 39 real cold emails to 39 distinct researchers and has no
mechanism of any kind for learning whether one of them answered. There is no
reply table, no inbox read, no thread tracking, and no Gmail read scope. Every
success signal it currently records is a signal about itself.

**Measurement snapshot, `outreach/data/outreach.db`, 2026-08-04.** These move
every run (the 09:00 batch is live), so they are date stamped and were measured
directly:

| metric | value |
| --- | --- |
| drafts by status | sent 39, awaiting_approval 18, skipped 12 |
| distinct recipients among sent | 39 (no repeats, none to an `asu.edu` address) |
| `draft_events` types | draft_created 69, decision 51, sent 39, send_attempted 34 |
| `sent` events carrying a `sentId` | 39 of 39 |
| shape of every stored `sentId` | 16 lowercase hex characters, no `@`, no `smtp-`/`gmail-` fallback prefix |
| send window | 2026-07-28 03:35 UTC to 2026-08-04 01:19 UTC (oldest send is 6.9 days old) |
| sends per day | Jul 28: 2, Jul 30: 3, Jul 31: 10, Aug 4: 24 |
| tables in the database | people, ontology_facts, intersections, drafts, revisions, decisions, draft_events, seen_papers |

So the raw material for reply tracking already exists and is complete: `markSent`
(`src/approval/ledger.ts:119`) writes `logEvent(db, draftId, 'sent', { sentId })`
inside the same transaction as the status update, and all 39 of those ids are
real Gmail message ids rather than the two synthesized fallbacks in the code
(`gmail-${Date.now()}` at `src/sender/gmail-api.ts:52`, `smtp-${Date.now()}` at
`src/sender/gmail.ts:31`). Nothing reads them.

### Why this is the highest-value missing signal

Every metric the system can compute today is a prediction. An approval is Aditya
guessing that a hook will land. A reply is the researcher confirming that it did.
The system currently has 39 predictions and zero observations, and it is about to
spend more Tavily credits and more LLM budget tuning a process whose output it
cannot see.

### The frozen hook is in `drafts`, not in `intersections`

This matters for the evaluation payoff and was verified before being asserted.
`saveIntersections` (`src/db/db.ts:222`) is `DELETE` plus `INSERT` per person on
every recompute, and `intersections` cascades on `ontology_facts` deletion
(`schema.sql:33-40`), so that table holds the present state, not the state at
draft time. Measured right now across the 39 sent drafts:

| source of truth | lead hook tier mix | lead hook from web/paid facts |
| --- | --- | --- |
| `intersections` (live, derived) | A 4, B 20, **15 drafts have no rows left at all** | 1 |
| `drafts.draft_input_json` (frozen at persist time) | A 5, B 34 | 0 |

`persistDraft` stores `draft_input_json` verbatim and never rewrites it, and a
spot check confirms the shape: `$.hooks[0]` carries `tier`, `strength`,
`personSourceUrl`, `selfValue`, `personValue`, and `rationale`. Any reply metric
must slice on that frozen JSON. A metric built on `intersections` would be
measuring a different table's current contents, not what was actually emailed.

## Design

Watch the Gmail threads this system started, using a read scope that is
physically incapable of returning a message body, and tell Aditya once per real
reply.

### Change 1: a second, read-only OAuth refresh token (`gmail.metadata`)

The stored `GMAIL_OAUTH_REFRESH_TOKEN` is bound to `gmail.send` only
(`scripts/gmail-auth.ts:26`), and that is the single working outbound path (ASU
Workspace blocks SMTP app passwords). Reading requires a broader scope, and a
scope change forces re-consent, so the send credential must not be the one that
changes.

Mint a **separate** refresh token, from the same OAuth client, carrying only
`https://www.googleapis.com/auth/gmail.metadata`, stored as a new env var
`GMAIL_OAUTH_READ_REFRESH_TOKEN`. `GMAIL_OAUTH_REFRESH_TOKEN` is never touched.
Consequences:

- A failed or fumbled re-consent cannot break sending, because the send token is
  not part of the flow.
- The read path is structurally unable to send, and the send path is structurally
  unable to read. Least privilege in both directions.
- `scripts/gmail-auth.ts` gains an optional scope argument (default unchanged:
  `gmail.send`), so the existing documented invocation keeps working verbatim.

**Why `gmail.metadata` and not `gmail.readonly`.** Verified against Google's
current docs:

- `gmail.metadata` "View your email message metadata such as labels and headers,
  but not the email body." It is **not** on the restricted-scope list (that list
  is `mail.google.com`, `gmail.readonly`, `gmail.compose`, `gmail.insert`,
  `gmail.modify`, `gmail.settings.sharing`), so it does not pull the project into
  restricted-scope OAuth verification or a CASA security assessment.
- `users.messages.get` and `users.threads.get` both accept `gmail.metadata`.
- Its one real cost: `users.messages.list` rejects the `q` parameter under this
  scope ("Parameter cannot be used when accessing the api using the
  gmail.metadata scope"). The design below never needs `q`.

The privacy property is therefore enforced by Google, not by our own restraint:
even a buggy implementation cannot fetch a researcher's reply body.

### Change 2: capture `threadId` at send time, backfill it for the 39

`users.messages.send` returns a `Message` resource, which carries `threadId`
alongside `id`. Widen the sender seam:

- `Sender.send` returns `{ sentId: string; threadId?: string }`
  (`src/sender/types.ts:12`). Optional, so the SMTP sender
  (`src/sender/gmail.ts`) and every test stub compile unchanged.
- `createGmailApiSender` returns `res.data.threadId ?? undefined`.
- `markSent(db, draftId, sentId, threadId?)` logs `{ sentId, threadId }` and
  upserts the watch row from Change 3 in the same transaction that already
  guarantees the audit record survives (`ledger.ts:119-125`). Its two callers
  (`loop.ts:200`, `cli.ts` in the `add` flow) pass through what the sender
  returned.

**Backfill for existing sends.** Do not assume the first message in a thread has
`id == threadId`. It is widely observed and nowhere documented, and the check is
cheap: `users.messages.get(id, format=metadata)` returns the message's
`threadId`. 39 calls at 20 quota units each is 780 units, once.

**Guard on which ids are resolvable.** Only a Gmail-shaped `sentId` is polled:
matches `/^[0-9a-f]+$/`, contains no `@`, and does not start with `smtp-` or
`gmail-`. All 39 current ids pass. Anything else (an SMTP `Message-ID`, a
fallback timestamp) is recorded once as `unresolvable` and never retried, so a
non-Gmail send path can never make the poller spin.

### Change 3: two new tables

New tables are safe to add via `schema.sql`: `openDb` execs it on every open
(`src/db/db.ts:19`) and `CREATE TABLE IF NOT EXISTS` reaches a live database. The
guarded-ALTER hazard documented in `db.ts:25-37` applies to new **columns** on
existing tables, which this change does not need. `drafts` is not modified.

```sql
CREATE TABLE IF NOT EXISTS sent_threads (
  draft_id INTEGER PRIMARY KEY REFERENCES drafts(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  sent_message_id TEXT NOT NULL UNIQUE,   -- materialized from draft_events.detail_json
  thread_id TEXT UNIQUE,                  -- NULL until send-time capture or backfill
  sent_at TEXT NOT NULL,
  watch_state TEXT NOT NULL DEFAULT 'open'
    CHECK(watch_state IN ('open','replied','closed_no_reply','unresolvable')),
  last_polled_at TEXT,
  poll_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  gmail_message_id TEXT NOT NULL UNIQUE,  -- the idempotency key
  thread_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  received_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human','auto_reply','bounce')),
  detected_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_replies_draft ON replies(draft_id);
CREATE INDEX IF NOT EXISTS idx_threads_state ON sent_threads(watch_state);
```

**Why materialize `sent_message_id` instead of joining on JSON.** `json_extract`
works here (`ledger.ts:280-283` already uses it, so SQLite's JSON1 is available),
but `draft_events` is append-only and authoritative and should stay a log, not a
polling index. `sent_threads` is a projection of it, built once by the backfill
and maintained at send time, and it is where the mutable polling state
(`last_polled_at`, `poll_failures`) lives so that no volatile column lands next to
the frozen approval state in `drafts`.

`sent_threads.draft_id` is the primary key: `priorThreads` (`ledger.ts:310`)
already refuses a second thread per person, so one draft is one thread.

### Change 4: detection by thread polling, not inbox sweeping

For each `sent_threads` row in state `open`, call
`users.threads.get(threadId, format=metadata, metadataHeaders=[From, Date,
Auto-Submitted, Precedence, X-Autoreply])`. A message in that thread is a reply
if and only if its id is not `sent_message_id` **and** its `From` address is not
`SENDER_EMAIL`. Classification, from headers only:

- `bounce`: `From` is `mailer-daemon@...` or `postmaster@...`
- `auto_reply`: `Auto-Submitted` present and not `no`, or `Precedence` in
  {`auto_reply`, `bulk`, `junk`}, or `X-Autoreply: yes`
- `human`: everything else

Misclassification is cheap by construction: it can only change a notification and
a metric slice, never an outbound action, and the row can be reclassified by hand
because `from_address` and `kind` are both stored.

**Why polling, not the History API or a `q` sweep.**

| option | verdict |
| --- | --- |
| `threads.get` per open thread | **Chosen.** 40 quota units each. Stateless and self-healing (no watermark to expire). It touches only threads this system started, so the code never enumerates Aditya's inbox at all. |
| `history.list` + `messages.get` | Cheaper (2 units per page) but stateful: a `historyId` watermark that Gmail expires returns 404 and forces a full-sync fallback, and it hands back every new message in the mailbox, which is strictly more of Aditya's private mail than this feature needs to look at. |
| label or `q` sweep for known addresses | Impossible under `gmail.metadata` (`q` is rejected), and buying it would mean `gmail.readonly`, a restricted scope with full body access over the whole inbox. |

**Cost.** Verified against Google's current quota page: `threads.get` 40 units,
`messages.get` 20, `messages.list` 5, `history.list` 2, `messages.send` 100. The
limits are 6,000 units per minute per user and (from 2026) 80,000,000 units per
day per project. 39 open threads is 1,560 units per cycle. Steady state is bounded
by `max_messages_per_run: 10` (`config/watchlist.yaml`) and the 30-day close rule
below, so roughly 300 threads at worst: 12,000 units per cycle. **Pacing rule: at
most 100 `threads.get` calls per minute** (4,000 units), which keeps the worst
case under the per-minute ceiling with headroom.

**Bounding the watch set.** A row leaves `open` when: a reply is recorded
(`replied`), 30 days pass with no reply (`closed_no_reply`), the id is not
Gmail-shaped (`unresolvable`), or `threads.get` 404s (the thread was deleted) or
fails 5 consecutive times (`unresolvable`). Nothing polls forever.

**Replies from a different address.** Gmail assigns a thread from
`In-Reply-To`/`References`, not from the sender, so a researcher replying from a
personal, forwarded, or delegated address still lands in the watched thread and is
still attributed to the right draft. Storing `from_address` makes the mismatch
against `drafts.to_email` visible in the data. What this misses is a **fresh
compose** with no reference headers, which Gmail may not thread. That case is
unreachable under `gmail.metadata` and would cost full inbox body access to catch.
Accepted and recorded, not silently ignored.

### Change 5: where it runs, a third supervised job

New command `outreach replies [--dry-run] [--backfill]` and a new launchd job
`com.aditya.outreach-replies`, `StartInterval` 14400 (every 4 hours), modeled on
`scripts/com.aditya.outreach.plist`: absolute node path, tsx entry directly (not
the `.bin` shim), `WorkingDirectory`, `PATH` including Homebrew, `Umask` 63
(owner only), `data/replies.log` and `data/replies.err.log`.

Rejected alternatives, against how the existing jobs are actually built:

- **Inside the 09:00 batch (`runLoop`).** Its failure mode is "no discovery
  today", and it already carries discovery, drafting, messaging, resume, and
  stall reporting inside one `try/finally`. Bolting an unrelated Gmail poll onto
  it widens that blast radius for no benefit, and caps reply latency at 24 hours.
- **Inside the listener daemon (`runListenLoop`).** Its structure is a blocking
  `channel.streamReplies(...)` that intentionally does not return for hours, and
  its health model (`minHealthySessionMs`, capped backoff, exit-for-supervisor-
  restart, `MIN_CYCLE_INTERVAL_MS`) is entirely about the Spectrum stream, with
  no place to express a Gmail failure. Adding a concurrent timer beside that
  await is precisely the shape of change this codebase has already been burned
  by: `listen.ts:55-60` records a one-year timeout that overflowed Node's 32-bit
  timer field, became 1ms, and rebuilt the client four times in 45 seconds
  against the live service.
- A separate job also gets its own logs, its own restart behavior, and can be run
  by hand for the live verification below. `StartInterval` fires on wake if the
  interval elapsed while the laptop was asleep, which is the right semantics here.

### Change 6: what Aditya is told, and when

He is already receiving a lot of messages (24 sends in one day on 2026-08-04, each
producing a draft message and a `SENT ...` confirmation) and has complained about
volume. So:

- **Notify only on a state change.** Never a heartbeat, never a "no replies"
  line, never a per-cycle summary. A quiet cycle sends nothing.
- **One message per newly detected `human` reply**, coalesced if a cycle finds
  several: `d19: Daniel Kepple replied (2h ago). Read it in Gmail.` The person is
  named because he needs to know who; the message is never quoted, excerpted, or
  summarized.
- **`bounce` notifies once** (the address is wrong, and that is actionable).
  **`auto_reply` is recorded and never notified** (an out-of-office is noise).
- **Failures are silent until they persist:** notify only after 3 consecutive
  failed cycles (about 12 hours), so a transient Gmail blip says nothing.
- **Construct the Photon channel only when there is something to say.** On a
  quiet cycle the job never connects to Spectrum at all, which also avoids a
  third concurrent connection six times a day. (The batch already opens a second
  connection alongside the listener once a day, so the pattern is proven, but
  there is no reason to do it for nothing.)

Expected steady-state volume at a 10% reply rate and 10 sends per day: about one
message per day, and it is the single most valuable message this system can send.

### Change 7: the privacy line, stated as code structure

The Gmail adapter projects every API response down to
`{ id, internalDate, headers }` (lowercased header names, only the five requested)
**at the boundary**, and returns nothing else to any other module.

- **Stored:** `from_address`, `received_at`, `kind`, `gmail_message_id`,
  `thread_id`, and the draft/person link.
- **Not stored, ever:** the reply body, the `snippet` field (Gmail returns a short
  excerpt of the message text even under `format=metadata`, and this is the
  design's single most likely leak), the reply subject (it is the researcher's
  text, it is almost always `Re:` our own subject, and it buys nothing), and any
  attachment metadata.
- **Logged:** draft short id, person id, `kind`, counts, and error strings. Not
  the address, not the subject, not the snippet. `data/replies.log` is owner-only
  by `Umask` 63, like the existing logs, but the rule holds regardless of file
  permissions because these are other people's private correspondence.
- **Never:** an automatic reply, an automatic follow-up, or any outbound message
  of any kind from this job. It reads Gmail and writes iMessage notifications to
  Aditya. It has no `Sender` dependency and must not be given one.

## Behavioral changes to acknowledge

- **`Sender.send`'s return type widens** to include an optional `threadId`. Every
  existing implementation and stub still satisfies it, because the field is
  optional. The SMTP sender never sets it, which is correct: it has no Gmail ids.
- **`markSent` gains a fourth optional parameter.** Both call sites
  (`loop.ts:200`, the `add` flow in `cli.ts`) keep compiling unchanged.
- **`sent` events gain a `threadId` field going forward.** The 39 existing ones
  will not have it, and any reader must tolerate its absence. The backfill fills
  `sent_threads.thread_id` for them, not the historical event rows, because
  `draft_events` is append-only.
- **A new env var and a new launchd job must be installed by hand**, exactly like
  the two existing jobs. Until `GMAIL_OAUTH_READ_REFRESH_TOKEN` is set, the
  command must fail loudly on startup with the remedy in the message, in the style
  of `createGmailApiSender`'s existing error, not degrade to a silent no-op.
- **A new class of iMessage exists.** Volume budget stated above.
- **Reply attribution is retroactive.** The first backfill can immediately mark
  threads from the past week as already replied, so the first real run may produce
  several notifications at once. That is intended; it is the answer to the
  question that motivated this spec.

## Verification

Per the project rule: demonstrate against reality, not artifacts. Baseline before
changes, measured 2026-08-04 with `npx vitest run`: **47 files, 529 tests, all
passing.**

0. **Prove the scope is grantable before writing any code.** Re-run
   `scripts/gmail-auth.ts` with `gmail.metadata`, confirm a refresh token comes
   back, and confirm it can call `users.threads.get` on one real thread and is
   refused on `users.messages.send`. If Google refuses to grant `gmail.metadata`
   to this unverified app, the detection mechanism in Change 4 is blocked and the
   spec needs revision, not a workaround. Do this first.
1. **Live end-to-end demonstration.** Send one real email to an address Aditya
   controls using the existing `outreach add <arxiv-id> --to-self` path
   (`cli.ts:385`), reply to it **from a different Gmail account**, then run
   `outreach replies` by hand. This exercises thread capture, thread polling,
   attribution, the different-sender-address case, and the notification, all
   against the live Gmail API. Show the actual `replies` row and the actual
   iMessage text.
2. **Live backfill demonstration.** Run `outreach replies --backfill` over the 39
   real sends and report the actual numbers: how many resolved to a `threadId`,
   how many threads already contain an inbound message, and the `kind` breakdown.
   This is the payoff, and it either answers the motivating question immediately
   or proves nobody has answered yet.
3. **Unit tests against an injected `GmailReader` seam** (`threadIdForMessage`,
   `getThreadMetadata`), so no test touches the network. Cases: our own sent
   message is never a reply; a reply from an unrelated address in the thread is
   attributed to the right draft; a `mailer-daemon` message classifies as
   `bounce`; an `Auto-Submitted: auto-replied` message classifies as `auto_reply`
   and produces no notification; a 404 marks the row `unresolvable` and stops
   polling; five consecutive failures stop polling.
4. **Idempotency test.** Poll the same thread twice with the same fixture and
   assert exactly one `replies` row (the `UNIQUE(gmail_message_id)` guarantee) and
   exactly one notification.
5. **Privacy regression test, mutation-verified.** A fixture thread whose raw API
   response carries both a `snippet` and a body payload, asserting that no column
   in `replies`, no column in `sent_threads`, and no emitted log line contains that
   text. Then mutate the adapter to persist the snippet, confirm the test goes red,
   and restore. A privacy test that cannot fail is worthless.
6. **Non-Gmail id guard.** A fixture `sentId` of `smtp-1234567890` and one
   containing `@` both land in `unresolvable` and cause zero API calls.

Mutate each guard in 3, 5, and 6, confirm red, restore.

## What this unlocks for evaluation

A reply is ground truth that a hook worked. An approval is only Aditya predicting
that it will. Once `replies` exists, every one of these becomes a one-line query,
sliced from state already frozen at draft time:

- **Reply rate by lead-hook tier**, from
  `json_extract(draft_input_json, '$.hooks[0].tier')`. Current denominator across
  the 39 sent: **A 5, B 34.**
- **Reply rate by hook source**, from `$.hooks[0].personSourceUrl`. Current
  denominator: **arXiv 34, OpenAlex 5, web/paid 0.**
- **Reply rate by hook strength** (`$.hooks[0].strength`, continuous).
- **Reply rate by paper age at send** (`seen_papers.first_seen_at` against the
  arXiv date) and by `drafts.intent`.
- **Time to reply**, from `sent_threads.sent_at` to `replies.received_at`.

All of these must read `drafts.draft_input_json` and not `intersections`, for the
reason measured in the Problem section: 15 of the 39 sent drafts have no rows left
in `intersections` at all, and the two sources disagree on both tier mix and hook
provenance.

**On the specific question of whether tier-A hooks from the paid web-mining path
beat the tier-B hooks the system mostly produces, and therefore whether the Tavily
enrichment step earns its 1,000 monthly credits: reply tracking is necessary but
not sufficient, and the reason is measurable today.** Zero of the 39 sent drafts
led with a web-mined hook: 34 led with an arXiv-sourced fact and 5 with an
OpenAlex-sourced one. There is no web-mined arm for a reply to discriminate
against, and at n=39 split 5/34 by tier, no reply rate will separate A from B with
any confidence either.

What reply tracking does is make the question answerable **going forward**, and it
identifies its own precondition. The hook-first gating spec
(`2026-08-02-hook-first-gating-design.md`, Change 1 step 5) retimes web mining to
enrich survivors and re-run `computeIntersections` so a web-mined fact can become
the lead hook, which is exactly the change that would start producing the missing
arm. Reply tracking should land **first**, so that change has an outcome variable
from its first day instead of being judged, again, on hook counts.

## Risks

- **The scope may not be grantable.** `gmail.metadata` is sensitive rather than
  restricted, and this is an unverified single-test-user desktop app, so the
  consent screen may warn or balk. Unverified, and Verification step 0 exists
  precisely to find out before any code is written.
- **`snippet` leakage is the real privacy failure mode.** Gmail returns an excerpt
  of the message text even under `format=metadata`. The boundary projection in
  Change 7 plus the mutation-tested assertion in Verification 5 are the defense.
  A casual `console.log(response)` during debugging would defeat both.
- **Threading is Gmail's decision, not ours.** A researcher who composes a fresh
  email instead of replying is invisible to this design. Accepted, above.
- **Early zeros are not evidence.** The oldest send is 6.9 days old, and
  academics answer cold email on week-to-month timescales. Any read of the first
  backfill must say so out loud rather than concluding the hooks do not work.
- **A reply is ground truth about the hook and about eleven other things**
  (seniority, inbox load, time of year, the ask itself). Reply rate by hook tier
  is an observation, not an experiment, and nothing here randomizes anything.
- **Quota is not the binding constraint, but pacing still matters.** 300 open
  threads at 40 units is 12,000 units per cycle against a 6,000 unit per-minute
  per-user ceiling, so the 100-calls-per-minute rule is load bearing, not
  decoration.
- **A third launchd job is a third thing that can silently die.** It shares the
  same failure mode the listener already has and no new one; the mitigation is
  that its logs are separate and its failure cannot affect discovery or sending.

## Out of scope

Each of these is a separate problem and belongs in its own spec:

- **Auto-follow-ups, auto-replies, or any automatic outbound message.**
  Non-negotiable: human approval gates every outbound message and this change does
  not weaken it. This job has no `Sender` dependency.
- Drafting a suggested reply, even one routed through the approval gate.
- A metrics dashboard, an `outreach stats` command, or any reporting surface
  beyond the notification. The queries listed above are one-liners against the new
  tables.
- Storing, summarizing, sentiment-scoring, or classifying the intent of reply
  bodies.
- Catching replies sent as fresh composes (requires `gmail.readonly`).
- Full-inbox sweeps, History API sync, and Gmail push notifications
  (`users.watch` plus Pub/Sub).
- Backfilling thread ids for anything sent over SMTP.
- Any change to discovery, drafting, approval, or sending, beyond the optional
  `threadId` on the sender seam.
- Making `drafted_unsendable` rows visible in `outreach stranded`.
