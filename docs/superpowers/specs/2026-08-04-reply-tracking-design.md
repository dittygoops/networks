# Reply Tracking: find out whether any of the 56 cold emails were answered

**Date:** 2026-08-04
**Status:** Revised after two reviews. The design survives; the scope
justification, the launchd key, the watch-set bound, and several persistence
details are corrected below.
**Problem owner:** the system optimizes end to end for sending, and sending is not the goal

## Problem

The system has sent 56 real cold emails to 56 distinct researchers and has no
mechanism of any kind for learning whether one of them answered. There is no
reply table, no inbox read, no thread tracking, and no Gmail read scope. Every
success signal it currently records is a signal about itself.

**Measurement snapshot, `outreach/data/outreach.db`, re-measured 2026-08-04
16:05 UTC.** These move every run (the 09:00 batch is live), so they are date
stamped and were measured directly, not carried over from the first draft of
this spec:

| metric | value |
| --- | --- |
| drafts by status | sent 56, skipped 12, awaiting_approval 1 |
| distinct recipients among sent | 56 addresses over 56 distinct `person_id` (no repeats, no NULLs, none to an `asu.edu` address) |
| `draft_events` types | draft_created 69, decision 68, sent 56, send_attempted 51 |
| `sent` events carrying a `sentId` | 56 of 56 |
| shape of every stored `sentId` | 16 lowercase hex characters, no `@`, no `smtp-`/`gmail-` fallback prefix (newest: `19fca6e82b8956ad`) |
| send window | 2026-07-28 03:35:08 UTC to 2026-08-04 01:41:07 UTC (oldest send is about 7.5 days old) |
| sends per day | Jul 28: 2, Jul 30: 3, Jul 31: 10, Aug 4: 41 |
| `seen_papers` by status | drafted_unsendable 252, filtered_low_relevance 176, messaged 63, discovered 7 |
| tables in the database | people, ontology_facts, intersections, drafts, revisions, decisions, draft_events, seen_papers |

The 5-row gap between `sent` (56) and `send_attempted` (51) is the `outreach
add` CLI path, which calls `decide` then `sender.send` then `markSent` directly
(`cli.ts:399-413`) and never touches `beginSendAttempt`. That gap is expected
and stable (it was also exactly 5 at the previous measurement of 39 sends).

So the raw material for reply tracking already exists and is complete: `markSent`
(`src/approval/ledger.ts:119`) writes `logEvent(db, draftId, 'sent', { sentId })`
inside the same transaction as the status update, and all 56 of those ids are
real Gmail message ids rather than the two synthesized fallbacks in the code
(`gmail-${Date.now()}` at `src/sender/gmail-api.ts:52`, `smtp-${Date.now()}` at
`src/sender/gmail.ts:31`). `makeSender` (`cli.ts:15-18`) picks the Gmail API
sender whenever `GMAIL_OAUTH_REFRESH_TOKEN` is set, which it is, and the hex
shape of all 56 ids confirms every send went through it. Nothing reads them.

### Why this is the highest-value missing signal

Every metric the system can compute today is a prediction. An approval is Aditya
guessing that a hook will land. A reply is the researcher confirming that it did.
The system currently has 56 predictions and zero observations, and it is about to
spend more Tavily credits and more LLM budget tuning a process whose output it
cannot see.

### The frozen hook is in `drafts`, not in `intersections`

This matters for the evaluation payoff and was verified before being asserted.
`saveIntersections` (`src/db/db.ts:222`) is `DELETE` plus `INSERT` per person on
every recompute, and `intersections` cascades on `ontology_facts` deletion
(`schema.sql:33-37`), so that table holds the present state, not the state at
draft time. Re-measured across the 56 sent drafts:

| source of truth | lead hook tier mix | lead hook from web/paid facts |
| --- | --- | --- |
| `intersections` (live, derived) | **15 of the 56 sent drafts have no rows left at all**; across the surviving 41 the rows are A 27, B 74 (rows, not drafts: one person can carry several) | 1 |
| `drafts.draft_input_json` (frozen at persist time) | A 6, B 50 (one lead hook per draft) | 0 |

`persistDraft` (`ledger.ts:32`) stores `draft_input_json` verbatim and never
rewrites it, and a spot check confirms the shape: `$.hooks[0]` carries `tier`,
`strength`, `personSourceUrl`, `selfValue`, `personValue`, and `rationale`. Any
reply metric must slice on that frozen JSON. A metric built on `intersections`
would be measuring a different table's current contents, not what was actually
emailed, and the two disagree on both the denominator and the tier mix.

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

**`scripts/gmail-auth.ts` must change in three places, not one.** The earlier
draft of this spec said only that it "gains an optional scope argument", which
would have left a live footgun:

1. It gains an optional scope argument (default unchanged: `gmail.send`), so the
   existing documented invocation keeps working verbatim.
2. **The printed variable name must follow the scope.** Line 52 currently prints
   a hardcoded `GMAIL_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`. A user who
   completes a `gmail.metadata` consent and then follows the script's own
   instruction overwrites the only working send credential with a token that
   cannot send. The script must print `GMAIL_OAUTH_READ_REFRESH_TOKEN=` when the
   requested scope is a read scope, and it must print the scope it actually
   obtained on the same screen so the paste is self-checking.
3. **The "revoke and re-run" advice at line 47 must be scoped or removed.**
   "Revoke the app at myaccount.google.com/permissions and re-run" revokes the
   OAuth *client* for the *account*, which kills `GMAIL_OAUTH_REFRESH_TOKEN` as
   collateral. Replace it with advice that does not destroy the send path:
   `prompt: 'consent'` is already set (line 24), which is what actually forces a
   refresh token, so the correct remedy is to re-run rather than to revoke. If a
   revoke is genuinely needed, the message must say in the same breath that the
   send token dies with it and must be re-minted.

**Why `gmail.metadata` and not `gmail.readonly`.** The earlier draft rested this
on a claim that is **false**. Verified 2026-08-04 against Google Cloud Console
Help, "Restricted Scopes" (`support.google.com/cloud/answer/13464325`):

- `gmail.metadata` **is a RESTRICTED scope.** The list is `https://mail.google.com/`,
  `gmail.readonly`, `gmail.metadata`, `gmail.modify`, `gmail.insert`,
  `gmail.compose`, `gmail.settings.basic`, `gmail.settings.sharing`. The earlier
  draft asserted `gmail.metadata` was absent from that list and also omitted
  `gmail.settings.basic` from its enumeration. Both were wrong.
- This collapses the old argument entirely. "Metadata avoids restricted-scope
  overhead and readonly does not" is not a real distinction: `gmail.readonly` is
  restricted too, and so is `gmail.metadata`.

**The new justification for why restricted status does not block this, and why
`gmail.metadata` still wins:**

- **Verification is not triggered here.** Google's verification exemptions cover
  apps in development, testing, or staging, and personal use. This app's consent
  screen is a personal GCP project with test users, so it is not submitting for
  verification either way. Verification status is therefore not a differentiator
  between `metadata` and `readonly`, and neither is CASA.
- **The CASA security assessment is triggered by third-party-server access to
  restricted data.** Google requires the annual assessment for apps that access
  restricted data "from or through a third-party server". This job runs on
  Aditya's own laptop, reads into a local SQLite file, and transmits nothing to
  any server. Neither scope pulls the project into an assessment.
- **The privacy argument carries the decision on its own, and it is the only
  argument that survives.** `gmail.metadata` grants "View your email message
  metadata such as labels and headers, but not the email body." It is
  structurally incapable of returning a body. `gmail.readonly` grants full body
  access to the entire mailbox. Choosing the scope that cannot read a
  researcher's reply body, over one that can, is the whole point, and it holds
  regardless of what Google's verification pipeline does.
- **The two operational sub-claims survive and are load bearing.**
  `users.messages.get` and `users.threads.get` both accept `gmail.metadata`, and
  `users.messages.list` explicitly rejects the `q` parameter under this scope
  ("Parameter cannot be used when accessing the api using the gmail.metadata
  scope"). The design below never needs `q`. The `q` rejection is also the reason
  bounce detection is demoted in Change 4.

The privacy property is therefore enforced by Google, not by our own restraint:
even a buggy implementation cannot fetch a researcher's reply body.

### Change 2: capture `threadId` at send time, backfill it for the 56

`users.messages.send` returns a `Message` resource, which carries `threadId`
alongside `id`. Widen the sender seam:

- `Sender.send` returns `{ sentId: string; threadId?: string }`
  (`src/sender/types.ts:11-13`). Optional, so the SMTP sender
  (`src/sender/gmail.ts`) and every test stub compile unchanged.
- `createGmailApiSender` returns `res.data.threadId ?? undefined`.
- `markSent(db, draftId, sentId, threadId?)` logs `{ sentId, threadId }`. That
  is a change to the payload of an INSERT that already happens inside the
  existing transaction, so it adds no new way for the transaction to fail.

**The watch row is NOT written inside `markSent`'s transaction.** This is the
one change from the earlier draft that must not be softened. That transaction
exists for exactly one reason, stated at `ledger.ts:117-118`: the status UPDATE
and the audit record of an irreversible email are one unit, because a crash
between them loses the only durable record that an email went out. Adding an
INSERT into `sent_threads` there gives it a brand new way to **abort after Gmail
has already accepted the message**, which would roll back the status UPDATE and
the `sent` event together and leave a genuinely sent email recorded as
approved-and-unsent. `stalledApprovals` would then report it, and a human would
be steered toward sending a second cold email to a stranger. That is the single
worst outcome this codebase has rules against.

Both failure modes are reachable, not hypothetical:

- **Duplicate `thread_id`.** Gmail threads on subject plus participants, so two
  `outreach add --to-self` sends (`cli.ts:391`) land in one thread, and a
  `--force` second email to one person (`cli.ts:383`) can too.
- **Duplicate `sent_message_id`.** The SMTP fallback is `smtp-${Date.now()}`
  (`gmail.ts:31`), which collides for two sends inside the same millisecond, and
  the Gmail fallback `gmail-${Date.now()}` (`gmail-api.ts:52`) has the same
  shape.

So: the schema in Change 3 drops both UNIQUE constraints in favour of plain
indexes, **and** the watch row is written by a separate `recordSentThread(db,
draftId, sentId, threadId?)` called by the caller **after** `markSent` returns,
wrapped so that any throw is logged and swallowed. A missing watch row is
recoverable at zero cost by the backfill, which projects `sent_threads` from
`draft_events` exactly the way the first backfill does. A rolled-back `sent`
event is not recoverable at all. The asymmetry decides it.

**Backfill for existing sends.** Do not assume the first message in a thread has
`id == threadId`. It is widely observed and nowhere documented, and the check is
cheap: `users.messages.get(id, format=metadata)` returns the message's
`threadId`. 56 calls at 20 quota units each is **1,120 units, once**.

**Guard on which ids are resolvable.** Only a Gmail-shaped `sentId` is polled:
matches `/^[0-9a-f]+$/`, contains no `@`, and does not start with `smtp-` or
`gmail-`. All 56 current ids pass. Anything else (an SMTP `Message-ID`, a
fallback timestamp) is recorded once as `unresolvable` and never retried, so a
non-Gmail send path can never make the poller spin.

**Needs-address drafts never enter the watch set, and need no special case.**
The address-correction feature (`src/pipeline/addressCorrection.ts`, shipped
2026-08-04) deliberately parks drafts with `to_email = NULL` and marks the
`seen_papers` row `drafted_unsendable` with reason `awaiting address
correction%`. Such a draft cannot pass `loadApprovedSend`'s `no_snapshot` check
(`ledger.ts:188`), so it never sends, never produces a `sent` event, and never
appears in `sent_threads`. Because both the send-time write and the backfill are
keyed on `draft_events` rows of type `sent`, this falls out for free. Measured
right now: zero drafts have `to_email IS NULL`, so there is no live case, but
the invariant is the reason no filter is needed.

### Change 3: two new tables

New tables are safe to add via `schema.sql`: `openDb` execs it on every open
(`src/db/db.ts:19`) and `CREATE TABLE IF NOT EXISTS` reaches a live database. The
guarded-ALTER hazard documented in `db.ts:24-37` applies to new **columns** on
existing tables, which this change does not need. `drafts` is not modified.

```sql
CREATE TABLE IF NOT EXISTS sent_threads (
  draft_id INTEGER PRIMARY KEY REFERENCES drafts(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  sent_message_id TEXT NOT NULL,          -- materialized from draft_events.detail_json
  thread_id TEXT,                         -- NULL until send-time capture or backfill
  sent_at TEXT NOT NULL,
  watch_state TEXT NOT NULL DEFAULT 'open'
    CHECK(watch_state IN ('open','replied','closed_no_reply','unresolvable')),
  last_polled_at TEXT,
  -- Due time, not elapsed time. Survives missed cycles and wake coalescing:
  -- a row that is overdue is simply picked up on the next run.
  next_poll_at TEXT NOT NULL DEFAULT (datetime('now')),
  poll_failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_state ON sent_threads(watch_state, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_threads_thread ON sent_threads(thread_id);
CREATE INDEX IF NOT EXISTS idx_threads_msg ON sent_threads(sent_message_id);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  gmail_message_id TEXT NOT NULL UNIQUE,  -- the idempotency key
  thread_id TEXT NOT NULL,
  from_address TEXT NOT NULL,             -- bare address, extracted from the From mailbox
  received_at TEXT NOT NULL,              -- from internalDate, never the Date: header
  kind TEXT NOT NULL CHECK(kind IN ('human','auto_reply','bounce')),
  detected_at TEXT DEFAULT (datetime('now')),
  -- NULL until channel.notify() has returned successfully for this row. This
  -- column is what makes "exactly one notification" implementable at all.
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_draft ON replies(draft_id);
CREATE INDEX IF NOT EXISTS idx_replies_unnotified ON replies(notified_at) WHERE notified_at IS NULL;
```

**Why no UNIQUE on `sent_threads.thread_id` or `sent_message_id`.** See Change 2:
both are reachable, and a constraint violation on a table written near the send
path is a liability rather than a safety property. `draft_id` stays the primary
key because one draft has at most one send by construction (`beginSendAttempt`'s
conditional UPDATE, `ledger.ts:219-250`). Note that the earlier draft justified
this with "`priorThreads` already refuses a second thread per person", which is
wrong about the code: `priorThreads` (`ledger.ts:310`) is a pure read that
returns a list, and its callers decide what to do with it. `cli.ts:383` skips
unless `--force` is passed, so a second thread per person is an explicitly
supported operation, not an impossible one.

**Consequence: one thread can map to more than one draft.** The poller therefore
polls each **distinct** `thread_id` once per cycle, and attributes any reply
found in it to the lowest open `draft_id` carrying that thread. `replies` still
has `UNIQUE(gmail_message_id)`, so the same inbound message can never produce two
rows regardless.

**Why materialize `sent_message_id` instead of joining on JSON.** `json_extract`
works here (`ledger.ts:280-283` already uses it, so SQLite's JSON1 is available),
but `draft_events` is append-only and authoritative and should stay a log, not a
polling index. `sent_threads` is a projection of it, built by the backfill and
maintained after each send, and it is where the mutable polling state
(`last_polled_at`, `next_poll_at`, `poll_failures`) lives so that no volatile
column lands next to the frozen approval state in `drafts`.

### Change 4: detection by thread polling, not inbox sweeping

For each distinct `thread_id` due for polling, call
`users.threads.get(threadId, format=metadata, metadataHeaders=[From, Date,
Auto-Submitted, Precedence, X-Autoreply])`. A message in that thread is a reply
if and only if its id is not the thread's `sent_message_id` **and** its `From`
address is not our own.

**`From` is an RFC 5322 mailbox, not a bare address.** Gmail returns
`Aditya Gupta <apgupta3@asu.edu>`, and a naive
`header.from !== process.env.SENDER_EMAIL` compare is always true, which would
classify Aditya's own follow-up in a thread as an inbound reply, notify him about
himself, close the thread, and write fabricated ground truth into the exact table
the whole evaluation section depends on. Required rule:

- Extract the address from the **last** `<...>` group if one is present,
  otherwise take the whole header value.
- Trim surrounding whitespace and any surviving quotes.
- Compare case-insensitively (`toLowerCase()` on both sides) against
  `SENDER_EMAIL`, and against nothing else.
- If `SENDER_EMAIL` is unset, the job refuses to start rather than treating every
  message as inbound. This is the same fail-loud posture as
  `createGmailApiSender`'s missing-credential error (`gmail-api.ts:33-37`).
- Store the **extracted bare address** in `replies.from_address`, not the raw
  mailbox, so the same normalization is what any later query sees.

**`received_at` comes from `internalDate`, never from the `Date:` header.**
`internalDate` is Gmail's own receive timestamp. The `Date:` header is written by
the sender's mail client, is under a third party's control, and is routinely
wrong by hours or years. Time-to-reply is one of the metrics this feature exists
to produce, so the field it is computed from must not be attacker-settable.
`internalDate` arrives as a string of epoch milliseconds and is stored as an ISO
UTC string to match every other timestamp in the schema.

Classification, from headers only:

- `bounce`: extracted `From` is `mailer-daemon@...` or `postmaster@...`
- `auto_reply`: `Auto-Submitted` present and not `no`, or `Precedence` in
  {`auto_reply`, `bulk`, `junk`}, or `X-Autoreply: yes`
- `human`: everything else

Misclassification is cheap by construction: it can only change a notification and
a metric slice, never an outbound action, and the row can be reclassified by hand
because `from_address` and `kind` are both stored.

**Only a `human` reply may close a thread.** An `auto_reply` or a `bounce` is
recorded and **leaves `watch_state = 'open'`**. This is not a detail. Only `open`
threads are polled, so if a Monday out-of-office moved the row out of `open`, the
real reply that arrives the following week would never be seen, and the thread
would be permanently blinded by the single most common piece of email noise
there is. A `bounce` also leaves the thread open, because a bounce for one
address does not preclude a reply from a forwarded one, and the bounce
notification has already done its job.

**Bounce detection is best effort, and probably close to unreachable.** Delivery
status notifications frequently arrive as a **new thread**, not as a message in
the sent thread, because many MTAs do not set `In-Reply-To` or `References`.
Finding those would need `users.messages.list` with a `q` filter, which is
exactly what `gmail.metadata` rejects. So `bounce` is retained as a
classification for the case where the DSN does thread, and is explicitly **not**
claimed as a reliable way to learn that an address is wrong. Nothing else in this
design depends on it.

**Why polling, not the History API or a `q` sweep.**

| option | verdict |
| --- | --- |
| `threads.get` per open thread | **Chosen.** 40 quota units each. Stateless and self-healing (no watermark to expire). It touches only threads this system started, so the code never enumerates Aditya's inbox at all. |
| `history.list` + `messages.get` | Cheaper (2 units per page) but stateful: a `historyId` watermark that Gmail expires returns 404 and forces a full-sync fallback, and it hands back every new message in the mailbox, which is strictly more of Aditya's private mail than this feature needs to look at. |
| label or `q` sweep for known addresses | Impossible under `gmail.metadata` (`q` is rejected), and buying it would mean `gmail.readonly`, which is restricted **and** grants full body access over the whole inbox. |

**Cost.** Verified 2026-08-04 against Google's current Gmail API quota page:
`threads.get` 40 units, `messages.get` 20, `messages.list` 5, `threads.list` 10,
`history.list` 2, `messages.send` 100. The limits are 6,000 units per minute per
user per project, 1,200,000 units per minute per project, and 80,000,000 units
per day per project.

- Backfill, once: 56 `messages.get` = **1,120 units**.
- First poll cycle over the same 56 threads: **2,240 units**.

**Bounding the watch set, re-derived.** The earlier draft bounded this with
`max_messages_per_run: 10` (`config/watchlist.yaml:67`). That is the wrong cap:
it limits how many drafts are **messaged** to Aditya per run
(`loop.ts:413` defers the rest with `queued_for_message`), not how many are
**sent**. Sends happen whenever approvals arrive, and approvals accumulate and
then land in bursts: **41 sends on 2026-08-04 alone**, against a
`max_messages_per_run` of 10. The bound must come from observed sends per day,
not from the messaging cap.

Observed: 56 sends over the 8 day window, mean 7 per day, peak 41 in one day.
Take a sustained worst case of 20 sends per day. Combined with the 60 day close
rule below, that is up to 1,200 open threads, which the earlier draft's "poll
every open thread every cycle" would turn into 48,000 units per cycle and, worse,
would poll a 29 day old thread four to six times a day for a reply that is not
coming.

**Age-tiered cadence.** After each successful poll, `next_poll_at` is set from
the age of the send:

| age of send | next poll |
| --- | --- |
| under 3 days | +6 hours |
| 3 to 14 days | +24 hours |
| 14 to 60 days | +72 hours |
| 60 days or more | row closes as `closed_no_reply` |

At 20 sends per day sustained that is roughly 240 + 220 + 307 = **about 770
`threads.get` per day**, around 31,000 units per day, spread over four runs.

**Two hard bounds on top of the cadence**, because a cadence is a policy and a
policy can be wrong:

- **At most 400 `threads.get` per cycle**, selected `WHERE watch_state = 'open'
  AND next_poll_at <= datetime('now') ORDER BY next_poll_at ASC LIMIT 400`.
  Overflow simply waits for the next run, and the oldest-due ordering means
  nothing starves.
- **At most 100 `threads.get` per minute** (4,000 units), which keeps the worst
  case under the 6,000 unit per-user-per-minute ceiling with headroom.

A row leaves `open` when: a **human** reply is recorded (`replied`), 60 days pass
with no human reply (`closed_no_reply`), the id is not Gmail-shaped
(`unresolvable`), or `threads.get` 404s (the thread was deleted) or fails 5
consecutive times (`unresolvable`). Nothing polls forever.

The close window is **60 days, not 30**. The Risks section of this spec says
academics answer cold email on week-to-month timescales, and a 30 day close
contradicts that on its own terms: it would stop watching at exactly the point
the slower half of the distribution starts landing.

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
`com.aditya.outreach-replies`, modeled on `scripts/com.aditya.outreach.plist`:
absolute node path, tsx entry directly (not the `.bin` shim), `WorkingDirectory`,
`PATH` including Homebrew, `Umask` 63 (owner only), `data/replies.log` and
`data/replies.err.log`.

**Use `StartCalendarInterval`, not `StartInterval`.** The earlier draft claimed
`StartInterval` "fires on wake if the interval elapsed while the laptop was
asleep". `man 5 launchd.plist` says the exact opposite, and this was read
directly:

> **StartInterval**: "If the system is asleep during the time of the next
> scheduled interval firing, that interval will be missed due to shortcomings in
> kqueue(3). If the job is running during an interval firing, that interval
> firing will likewise be missed."
>
> **StartCalendarInterval**: "Unlike cron which skips job invocations when the
> computer is asleep, launchd will start the job the next time the computer wakes
> up. If multiple intervals transpire before the computer is woken, those events
> will be coalesced into one event upon wake from sleep."

On a laptop that sleeps overnight, a 4-hour `StartInterval` silently drops most
of its night cycles. So the job uses an **array of `StartCalendarInterval`
dictionaries at 07:30, 12:30, 17:30 and 21:30**, four runs a day, offset from the
09:00 batch. Wake coalescing means a laptop that was closed all night runs once
on open, which is exactly right. The existing batch job already uses
`StartCalendarInterval` (`com.aditya.outreach.plist:29-35`), so this is also the
form already proven here.

Because cadence is stored per row as `next_poll_at` rather than derived from the
run schedule, a coalesced wake, a skipped run, or a hand-run all behave
identically: whatever is due gets polled.

`RunAtLoad` is `false`, matching the batch job, so installing the plist does not
immediately fire a live Gmail read.

**The job must close its channel and exit.** If it constructs a Photon channel it
must `await channel.close?.()` and let the process exit. `close()` exists on the
`ApprovalChannel` interface (`src/approval/channel.ts:51`) and is implemented at
`photonChannel.ts:373`. A process that stays alive holding a socket is, to
launchd, still running, and launchd will **not** start the next scheduled
invocation of a job that has not exited. A leaked connection therefore does not
degrade the feature, it silently stops it forever.

Rejected alternatives, against how the existing jobs are actually built:

- **Inside the 09:00 batch (`runLoop`).** Its failure mode is "no discovery
  today", and it already carries discovery, drafting, messaging, resume, address
  correction, and stall reporting inside one `try/finally`. Bolting an unrelated
  Gmail poll onto it widens that blast radius for no benefit, and caps reply
  latency at 24 hours.
- **Inside the listener daemon (`runListenLoop`).** Its structure is a blocking
  `channel.streamReplies(...)` that intentionally does not return for hours, and
  its health model (`minHealthySessionMs`, capped backoff, exit-for-supervisor-
  restart, `MIN_CYCLE_INTERVAL_MS`) is entirely about the Spectrum stream, with
  no place to express a Gmail failure. Adding a concurrent timer beside that
  await is precisely the shape of change this codebase has already been burned
  by: `listen.ts:53-60` records a one-year timeout that overflowed Node's 32-bit
  timer field, became 1ms, and rebuilt the client four times in 45 seconds
  against the live service.
- A separate job also gets its own logs, its own restart behavior, and can be run
  by hand for the live verification below.

**Module shape: an options object with injected seams**, matching `ListenDeps`
(`listen.ts:22-45`) and `createGmailApiSender`'s `opts` parameter
(`gmail-api.ts:25-29`). The reader takes `{ db, reader, channel?, now, sleep,
log, maxThreadsPerCycle, maxCallsPerMinute, senderEmail, dryRun }`, where `now`,
`sleep` and `log` all default to the real implementations. Without an injected
`now` the age-tier logic and the 60 day close are untestable except by waiting,
and without an injected `sleep` the pacing rule makes the test suite take
minutes. Both mistakes have already been made and fixed once in `listen.ts`.

**`--dry-run` semantics, stated so they cannot be guessed wrong.** It reads (real
Gmail calls, real quota spend, real classification) and prints what it would do,
and it **writes nothing and notifies nothing**: no `sent_threads` insert or
update, no `replies` row, no `notified_at`, no `last_polled_at`, no
`next_poll_at`, no `poll_failures` increment, and no Photon channel is
constructed at all. This mirrors `outreach loop --dry-run`
(`cli.ts:266`).

**Persistence is one synchronous transaction per thread, after the await, never
around it.** better-sqlite3 transactions are synchronous; a `db.transaction(...)`
whose body awaits does not hold the transaction across the await, and wrapping
network I/O in one is a category error rather than a slow path. So: `await` the
`threads.get`, project the response down at the boundary (Change 7), then call
one synchronous transaction that writes the `replies` rows, the `watch_state`,
`last_polled_at`, `next_poll_at` and `poll_failures` for that one thread.
Per-thread rather than per-cycle, so a failure on thread 200 cannot discard the
199 threads already resolved.

**Error logging is `err.message` only.** Never the error object, never
`String(err)` on an unknown, never `JSON.stringify(err)`. A `GaxiosError` from
googleapis stringifies its entire response, which under `format=metadata` means
header values (including `From` addresses) landing in `data/replies.err.log`,
and under any format means the full request URL. Use
`e instanceof Error ? e.message : 'unknown error'`.

### Change 6: what Aditya is told, and when

He is already receiving a lot of messages (41 sends in one day on 2026-08-04, each
producing a draft message and a `SENT ...` confirmation) and has complained about
volume. So:

- **Notify only on a state change.** Never a heartbeat, never a "no replies"
  line, never a per-cycle summary. A quiet cycle sends nothing.
- **Exactly one message per newly detected `human` reply**, coalesced if a cycle
  finds several.
- **`bounce` notifies once** (best effort, see Change 4). **`auto_reply` is
  recorded and never notified** (an out-of-office is noise).
- **Failures are silent until they persist:** notify only after 3 consecutive
  failed cycles (about 18 hours at four runs a day), so a transient Gmail blip
  says nothing.
- **Construct the Photon channel only when there is something to say.** On a
  quiet cycle the job never connects to Spectrum at all. When it does connect, it
  closes the channel before exiting (Change 5).

**"Exactly one notification" is enforced by `replies.notified_at`, not by
ordering.** Without a durable notification record the property is unimplementable:
inserting the row and then notifying loses the notification on a crash between
the two, and notifying and then inserting repeats the notification forever on
the same crash. So:

1. Insert the `replies` row with `notified_at` NULL, inside the per-thread
   transaction.
2. Select the rows where `notified_at IS NULL AND kind IN ('human','bounce')`.
3. `await channel.notify(...)`.
4. Only after `notify` resolves, `UPDATE replies SET notified_at = datetime('now')`
   for exactly those ids.

A crash between 3 and 4 re-notifies at most once, on the next cycle, which is the
correct failure direction: a duplicate text about a real reply is recoverable, a
silently dropped one is not.

**The notification format must not be tapback-actionable.** The earlier draft
proposed `d19: Daniel Kepple replied (2h ago). Read it in Gmail.` That text
matches `/^\s*(d\d+):/`, which is exactly how `draftIdFromReactedText`
(`photonChannel.ts`) resolves which draft a tapback means, so a thumbs up on good
news decodes to `d19 y`. This project has been bitten by that shape twice
already, which is why `test/notify-tapback-safety.test.ts` exists. Required
formats, all of which begin with literal text and cannot parse as a draft id:

- one reply: `Reply from Daniel Kepple (d19), 2h ago. Read it in Gmail.`
- several: `2 replies: Daniel Kepple (d19), Ada Chen (d22). Read them in Gmail.`
- bounce: `Bounced: d19 to Daniel Kepple did not deliver.`
- persistent failure: `Reply polling has failed 3 cycles running: <err.message>.`

The person is named because he needs to know who; the message is never quoted,
excerpted, or summarized.

**The new module must be added to the tapback test's SOURCES list.**
`test/notify-tapback-safety.test.ts:21` currently enforces this at source level
for `src/pipeline/loop.ts`, `src/pipeline/listen.ts`, `src/cli.ts` and
`src/pipeline/addressCorrection.ts`. It is a static scan of a fixed file list, so
a new module is invisible to it until it is listed. Adding
`src/pipeline/replies.ts` to `SOURCES` is part of this change, not a follow-up.

Expected steady-state volume at a 10% reply rate and the observed mean of 7 sends
per day: under one message per day, and it is the single most valuable message
this system can send.

### Change 7: the privacy line, stated as code structure

The Gmail adapter projects every API response down to
`{ id, threadId, internalDate, headers }` (lowercased header names, only the five
requested) **at the boundary**, and returns nothing else to any other module.

- **Stored:** `from_address` (bare, extracted), `received_at` (from
  `internalDate`), `kind`, `gmail_message_id`, `thread_id`, `notified_at`, and
  the draft/person link.
- **Not stored, ever:** the reply body, the `snippet` field, the reply subject
  (it is the researcher's text, it is almost always `Re:` our own subject, and it
  buys nothing), and any attachment metadata.
- **On `snippet`:** the earlier draft asserted as fact that Gmail returns a
  snippet under `format=metadata`. No Google documentation was found that says
  so, so it is restated here as an **assumed worst case**: the design behaves as
  though a snippet is always present and the boundary projection drops it
  unconditionally. This costs nothing if the assumption is wrong and is the whole
  defense if it is right. Verification 5 tests the projection against a fixture
  that carries a snippet, so the test does not depend on the assumption either.
- **Logged:** draft short id, person id, `kind`, counts, and `err.message`. Not
  the address, not the subject, not the snippet, not the error object.
  `data/replies.log` is owner-only by `Umask` 63, like the existing logs, but the
  rule holds regardless of file permissions because these are other people's
  private correspondence.
- **Never:** an automatic reply, an automatic follow-up, or any outbound message
  of any kind from this job. It reads Gmail and writes iMessage notifications to
  Aditya. It has no `Sender` dependency and must not be given one.

## Behavioral changes to acknowledge

- **`Sender.send`'s return type widens** to include an optional `threadId`. Every
  existing implementation and stub still satisfies it, because the field is
  optional. The SMTP sender never sets it, which is correct: it has no Gmail ids.
- **`markSent` gains a fourth optional parameter.** Both call sites
  (`loop.ts:226`, the `add` flow at `cli.ts:412`) keep compiling unchanged, and
  both gain a following best-effort `recordSentThread` call.
- **`sent` events gain a `threadId` field going forward.** The 56 existing ones
  will not have it, and any reader must tolerate its absence. The backfill fills
  `sent_threads.thread_id` for them, not the historical event rows, because
  `draft_events` is append-only.
- **A new env var and a new launchd job must be installed by hand**, exactly like
  the two existing jobs. Until `GMAIL_OAUTH_READ_REFRESH_TOKEN` is set, the
  command must fail loudly on startup with the remedy in the message, in the style
  of `createGmailApiSender`'s existing error, not degrade to a silent no-op. The
  same applies to a missing `SENDER_EMAIL` (Change 4).
- **A new class of iMessage exists.** Volume budget stated above, and the format
  is constrained by the tapback rule.
- **Reply attribution is retroactive.** The first backfill can immediately mark
  threads from the past week as already replied, so the first real run may produce
  several notifications at once. That is intended; it is the answer to the
  question that motivated this spec.
- **`scripts/gmail-auth.ts` changes output text**, which is documented in this
  repo. The default invocation is unchanged.

## Verification

Per the project rule: demonstrate against reality, not artifacts. Baseline before
changes, re-measured 2026-08-04 with `npx vitest run`: **49 files, 612 tests, all
passing.**

0. **Prove the scope is grantable before writing any code.** Re-run
   `scripts/gmail-auth.ts` with `gmail.metadata`, confirm a refresh token comes
   back, and confirm it can call `users.threads.get` on one real thread and is
   refused on `users.messages.send`. Do not paste the result over
   `GMAIL_OAUTH_REFRESH_TOKEN`. If Google refuses to grant `gmail.metadata` to
   this app, the detection mechanism in Change 4 is blocked and the spec needs
   revision, not a workaround. Do this first.
0b. **Confirm the OAuth consent screen's user type and publishing status in the
   Google Cloud Console, and record both in this spec.** This could not be
   verified from the repo: the console is not reachable from here. It matters
   because an **external** user type in **Testing** status is issued refresh
   tokens that expire after **7 days**, which would kill
   `GMAIL_OAUTH_READ_REFRESH_TOKEN` every week.
   `docs/spec-networking-email-assistant.md:191` describes the intended setup as
   a "personal GCP project (test-mode consent screen)", which is exactly the
   configuration that expires. **Counter-evidence measured here:**
   `outreach/.env` was last modified **2026-07-19 00:50** and still contains the
   original `GMAIL_OAUTH_REFRESH_TOKEN`, yet 41 real Gmail API sends succeeded on
   **2026-08-04**, 16 days later. A refresh token on a 7 day clock could not have
   done that, so the project is evidently **not** external-plus-testing, or was
   published. That inference is strong but indirect; confirm it in the console
   before relying on it.
1. **Live end-to-end demonstration.** Send one real email to an address Aditya
   controls using the existing `outreach add <arxiv-id> --to-self` path
   (`cli.ts:391`), reply to it **from a different Gmail account**, then run
   `outreach replies` by hand. This exercises thread capture, thread polling,
   attribution, the different-sender-address case, `notified_at`, and the
   notification, all against the live Gmail API. Show the actual `replies` row
   and the actual iMessage text.
1b. **Live self-reply demonstration.** In the same thread, reply from Aditya's
   own `SENDER_EMAIL` account, run `outreach replies` again, and show that **no**
   `replies` row is created and **no** notification is sent. This is the RFC 5322
   mailbox extraction working against a real `From: Aditya Gupta <...>` header,
   and it is the case that would otherwise fabricate ground truth.
2. **Live backfill demonstration.** Run `outreach replies --backfill` over the 56
   real sends and report the actual numbers: how many resolved to a `threadId`,
   how many threads already contain an inbound message, and the `kind` breakdown.
   This is the payoff, and it either answers the motivating question immediately
   or proves nobody has answered yet.
2b. **Live `--dry-run` demonstration.** Run `outreach replies --dry-run` against
   the live threads and show, with a before/after row count on `replies` and
   `sent_threads`, that it wrote nothing and notified nothing.
3. **Unit tests against an injected `GmailReader` seam** (`threadIdForMessage`,
   `getThreadMetadata`), so no test touches the network. Cases: our own sent
   message is never a reply; `From: Aditya Gupta <apgupta3@asu.edu>` is never a
   reply, and neither is `<APGUPTA3@ASU.EDU>`; a reply from an unrelated address
   in the thread is attributed to the right draft; a `mailer-daemon` message
   classifies as `bounce` **and leaves the row `open`**; an
   `Auto-Submitted: auto-replied` message classifies as `auto_reply`, produces no
   notification, **and leaves the row `open`**, and a `human` reply arriving in a
   later poll of that same thread is still detected; a 404 marks the row
   `unresolvable` and stops polling; five consecutive failures stop polling;
   `received_at` comes from `internalDate` even when the `Date:` header says
   1999; a 61-day-old open thread closes as `closed_no_reply` under an injected
   `now`.
4. **Idempotency and notification-exactly-once tests.** Poll the same thread twice
   with the same fixture and assert exactly one `replies` row (the
   `UNIQUE(gmail_message_id)` guarantee) and exactly one notification. Then a
   crash test: make `channel.notify` throw after the row is inserted, assert
   `notified_at` is still NULL, re-run, and assert exactly one notification total
   across both runs and `notified_at` now set.
5. **Privacy regression test, mutation-verified.** A fixture thread whose raw API
   response carries both a `snippet` and a body payload, asserting that no column
   in `replies`, no column in `sent_threads`, and no emitted log line contains that
   text. Then mutate the adapter to persist the snippet, confirm the test goes red,
   and restore. A privacy test that cannot fail is worthless.
6. **Non-Gmail id guard.** A fixture `sentId` of `smtp-1234567890` and one
   containing `@` both land in `unresolvable` and cause zero API calls.
7. **Send-path safety test.** Assert that a `recordSentThread` that throws (for
   example on a duplicate `thread_id` from two `--to-self` sends) leaves the
   draft `sent` and the `sent` event present. Mutate `recordSentThread` into
   `markSent`'s transaction, confirm the test goes red, restore. This is the
   whole reason for Change 2's split.
8. **Tapback safety.** Add `src/pipeline/replies.ts` to
   `test/notify-tapback-safety.test.ts:21`'s `SOURCES`, then mutate one
   notification to begin with `${shortId}:` and confirm the test goes red.

Mutate each guard in 3, 5, 6, 7 and 8, confirm red, restore.

## Rollback

Two failures need a stated recovery, because one of them is not obvious and one
of them is destructive.

**If the read scope breaks the send token.** `GMAIL_OAUTH_REFRESH_TOKEN` is
untouched by design, so this should be impossible, but the two ways to cause it
by hand are (a) pasting the metadata token over it, following
`gmail-auth.ts:52`'s current output, and (b) revoking the app at
`myaccount.google.com/permissions`, following `gmail-auth.ts:47`'s current
advice. Change 1 fixes both messages. If it happens anyway, recovery is: re-run
`scripts/gmail-auth.ts` with the default `gmail.send` scope and paste the result
back into `GMAIL_OAUTH_REFRESH_TOKEN`.

**Recovering the approvals burned during a scope outage.** This is the expensive
one. `performApprovedSend` (`loop.ts:212-232`) commits `beginSendAttempt`
**before** the network call, deliberately, so a concurrent process cannot send a
second copy. `markSendFailed` (`ledger.ts:131-139`) writes only a `send_failed`
event and **never clears `send_attempted_at`**, also deliberately, because a
timeout after Gmail accepted the message is indistinguishable from one it never
saw. The consequence is that a send credential which fails for a *known*
non-delivery reason (a 403 `insufficient scope`, an invalid_grant on an expired
refresh token) still permanently consumes the one send attempt for every draft
approved during the outage. Each becomes `already_attempted` forever, refuses on
re-approval (`loop.ts:166-171`), and is recoverable only by hand.

The exact recovery, to be run only after confirming in the **Gmail Sent folder**
that the message did not go out:

```sql
-- Per draft, after eyeballing Gmail Sent. Never run this as a bulk sweep.
UPDATE drafts SET send_attempted_at = NULL WHERE id = ? AND status = 'approved';
INSERT INTO draft_events (draft_id, type, detail_json)
  VALUES (?, 'send_rearmed', json_object('reason', 'scope outage', 'by', 'human'));
```

`send_attempts` is deliberately **not** reset, so the count remains an honest
record and `stallAlreadyReported` (`ledger.ts:276`) still keys correctly on it.
The draft can then be re-approved normally. This is documented here rather than
automated because automating it is exactly the retry loop D1 removed.

**If the whole feature has to come out.** Remove the launchd job, unset
`GMAIL_OAUTH_READ_REFRESH_TOKEN`, and revoke the metadata grant. The two new
tables can be left in place: nothing else reads them, and `openDb` will keep
creating them until the `CREATE TABLE` statements are removed from `schema.sql`.
`drafts`, `draft_events` and the send path are unmodified by this change, so
there is nothing else to undo.

## What this unlocks for evaluation

A reply is ground truth that a hook worked. An approval is only Aditya predicting
that it will. Once `replies` exists, every one of these becomes a one-line query,
sliced from state already frozen at draft time:

- **Reply rate by lead-hook tier**, from
  `json_extract(draft_input_json, '$.hooks[0].tier')`. Current denominator across
  the 56 sent: **A 6, B 50.**
- **Reply rate by hook source**, from `$.hooks[0].personSourceUrl`. Current
  denominator: **arXiv 50, OpenAlex 6, web/paid 0.**
- **Reply rate by hook strength** (`$.hooks[0].strength`, continuous).
- **Reply rate by paper age at send** (`seen_papers.first_seen_at` against the
  arXiv date) and by `drafts.intent`.
- **Time to reply**, from `sent_threads.sent_at` to `replies.received_at`, which
  is only meaningful because `received_at` comes from `internalDate` rather than
  a header the researcher's mail client wrote.

All of these must read `drafts.draft_input_json` and not `intersections`, for the
reason measured in the Problem section: 15 of the 56 sent drafts have no rows left
in `intersections` at all, and the two sources disagree on both tier mix and hook
provenance.

**On the specific question of whether tier-A hooks from the paid web-mining path
beat the tier-B hooks the system mostly produces, and therefore whether the Tavily
enrichment step earns its 1,000 monthly credits: reply tracking is necessary but
not sufficient, and the reason is measurable today.** Zero of the 56 sent drafts
led with a web-mined hook: 50 led with an arXiv-sourced fact and 6 with an
OpenAlex-sourced one. There is no web-mined arm for a reply to discriminate
against, and at n=56 split 6/50 by tier, no reply rate will separate A from B with
any confidence either.

What reply tracking does is make the question answerable **going forward**, and it
identifies its own precondition. The hook-first gating spec
(`2026-08-02-hook-first-gating-design.md`, Change 1 step 5) retimes web mining to
enrich survivors and re-run `computeIntersections` so a web-mined fact can become
the lead hook, which is exactly the change that would start producing the missing
arm. Reply tracking should land **first**, so that change has an outcome variable
from its first day instead of being judged, again, on hook counts.

## Risks

- **`gmail.metadata` is a RESTRICTED scope.** Confirmed 2026-08-04 against Google
  Cloud Console Help. The consent screen for an unverified app requesting a
  restricted scope may warn, may require the account to be a listed test user,
  and may balk. Verification step 0 exists precisely to find out before any code
  is written. Note the cost of failure is asymmetric: there is no non-restricted
  Gmail read scope to fall back to, so if the grant fails the whole detection
  mechanism is blocked.
- **The refresh token may be on a 7 day clock.** An **external** user type in
  **Testing** publishing status is issued refresh tokens that expire after 7
  days, which would silently kill `GMAIL_OAUTH_READ_REFRESH_TOKEN` every week and
  produce a feature that works for a week and then reports nothing. Measured
  counter-evidence (a send token unchanged since 2026-07-19 that still worked on
  2026-08-04, 16 days later) suggests this project is not in that configuration,
  but the console was not reachable from here and this is **unverified**.
  Verification step 0b resolves it. If it turns out to apply, the mitigation is
  to publish the app to Production, or to accept a weekly re-consent and have the
  job notify on an `invalid_grant` rather than fail silently.
- **`snippet` leakage is the real privacy failure mode.** Whether Gmail returns a
  snippet under `format=metadata` is **assumed, not documented**, and the design
  treats its presence as certain. The boundary projection in Change 7 plus the
  mutation-tested assertion in Verification 5 are the defense. A casual
  `console.log(response)` during debugging would defeat both, which is also why
  Change 5 forbids logging the error object.
- **Threading is Gmail's decision, not ours.** A researcher who composes a fresh
  email instead of replying is invisible to this design. So, in practice, are
  most bounces, since DSNs often arrive as new threads and `q` is unavailable
  under this scope. Accepted, above.
- **Early zeros are not evidence.** The oldest send is about 7.5 days old, and
  academics answer cold email on week-to-month timescales. Any read of the first
  backfill must say so out loud rather than concluding the hooks do not work.
  This is also why the close window is 60 days rather than 30.
- **A reply is ground truth about the hook and about eleven other things**
  (seniority, inbox load, time of year, the ask itself). Reply rate by hook tier
  is an observation, not an experiment, and nothing here randomizes anything.
- **Quota is not the binding constraint, but pacing still matters.** At a
  sustained 20 sends per day the watch set reaches roughly 1,200 threads under
  the 60 day close, which the age-tiered cadence reduces to about 770
  `threads.get` per day. The 400-per-cycle cap and the 100-per-minute pacing rule
  are load bearing, not decoration: without the pacing rule a single cycle could
  exceed the 6,000 unit per-user-per-minute ceiling.
- **A third launchd job is a third thing that can silently die**, and it has one
  failure mode the others do not: a leaked Photon connection means the process
  never exits and launchd never schedules it again. Change 5 requires the close
  and exit; the mitigation otherwise is that its logs are separate and its
  failure cannot affect discovery or sending.
- **Volume regression.** The notification budget assumes the observed mean of 7
  sends per day. The 41-send day shows bursts are real, and a burst plus a good
  reply rate could produce several notifications in one cycle. Coalescing (Change
  6) is the mitigation, and it is the reason the coalesced format is specified
  rather than left to the implementation.

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
- Catching replies sent as fresh composes, and catching bounces that arrive as a
  new thread (both require `gmail.readonly`).
- Full-inbox sweeps, History API sync, and Gmail push notifications
  (`users.watch` plus Pub/Sub).
- Backfilling thread ids for anything sent over SMTP.
- Any change to discovery, drafting, approval, or sending, beyond the optional
  `threadId` on the sender seam and the best-effort `recordSentThread` call after
  `markSent`.
- Automating the `send_attempted_at` recovery in the Rollback section.
- Widening `outreach stranded` beyond the `drafted_unsendable` reasons it already
  covers. `strandedReport` (`seenLedger.ts:185-202`) now surfaces the
  `abandoned after%`, `ambiguous orphan drafts%`, `awaiting address correction%`
  and `address correction not yet requested%` reasons; the other roughly 250
  `drafted_unsendable` rows stay invisible on purpose, and changing that is not
  this spec's business.
