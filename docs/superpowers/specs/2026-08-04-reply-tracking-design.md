# Reply Tracking: find out whether any of the 56 cold emails were answered

**Date:** 2026-08-04
**Status:** Revised after three reviews. Round one corrected the facts (the
restricted-scope claim and the launchd sleep semantics, both since verified
against primary sources). Round two found five design blockers, all of which
would have shipped a poller that stops working: a conflict-throwing insert that
turns one out-of-office into a permanently blinded thread, a failure counter
that cannot tell a per-thread failure from a cycle-wide one, an alarm that can
never fire, a timestamp format that makes every row permanently not-yet-due, and
a stale listener process. Those are fixed below.
**Problem owner:** the system optimizes end to end for sending, and sending is not the goal

## Problem

The system has sent 56 real cold emails to 56 distinct researchers and has no
mechanism of any kind for learning whether one of them answered. There is no
reply table, no inbox read, no thread tracking, and no Gmail read scope. Every
success signal it currently records is a signal about itself.

**Measurement snapshot, `outreach/data/outreach.db`, re-measured 2026-08-04
21:03 UTC.** Every number here is date stamped because the 09:00 batch is live
and a batch ran during review: three of these moved between the second and third
readings. **Only the sent-side numbers are stable enough to design against.** The
`seen_papers` and `drafts` counts are reported for context and nothing in this
design depends on their exact values.

| metric | value | stability |
| --- | --- | --- |
| drafts by status | sent 56, skipped 13, awaiting_approval 15 | moves every batch |
| distinct recipients among sent | 56 addresses over 56 distinct `person_id` (no repeats, no NULLs, none to an `asu.edu` address) | stable |
| `draft_events` types | draft_created 84, decision 69, sent 56, send_attempted 51, address_requested 3, address_request_deferred 2 | append-only, grows |
| `sent` events carrying a distinct `sentId` | 56 of 56 | stable |
| shape of every stored `sentId` | 16 lowercase hex characters, no `@`, no `smtp-`/`gmail-` fallback prefix (newest: `19fca6e82b8956ad`) | stable |
| send window | 2026-07-28 03:35:08 UTC to 2026-08-04 01:41:07 UTC (oldest send is about 7.7 days old) | stable |
| sends per day | Jul 28: 2, Jul 30: 3, Jul 31: 10, Aug 4: 41 | **the load-bearing measurement** |
| `seen_papers` by status | drafted_unsendable 276, filtered_low_relevance 202, messaged 73, discovered 15 | moves every batch; nothing here depends on it |
| tables in the database | people, ontology_facts, intersections, drafts, revisions, decisions, draft_events, seen_papers | stable |

The 5-row gap between `sent` (56) and `send_attempted` (51) is the `outreach
add` CLI path, which calls `decide` then `sender.send` then `markSent` directly
(`cli.ts:398-413`) and never touches `beginSendAttempt`. That gap is expected
and stable (it was also exactly 5 at the previous measurement of 39 sends).

**What actually guarantees at most one send on the `add` path.** Not
`beginSendAttempt`, which that path bypasses entirely, as the 5-row gap proves.
It is `decide`'s `UNIQUE(draft_id)` on the `decisions` table (the constraint is
`schema.sql:96`; the comment "UNIQUE(draft_id) IS the A9 first-write-wins
guarantee" is `schema.sql:93`).
`cli.ts:398-402` calls `decide` and returns early if `applied` is false, so a
second `outreach add` on the same draft cannot reach `sender.send`. This matters
for Change 2: `recordSentThread` is called on both paths and must not assume the
`beginSendAttempt` invariant holds on either.

So the raw material for reply tracking already exists and is complete: `markSent`
(`src/approval/ledger.ts:119`) writes `logEvent(db, draftId, 'sent', { sentId })`
(`ledger.ts:122`)
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
| `intersections` (live, derived) | **14 of the 56 sent drafts have no rows left at all** (re-measured 2026-08-04 21:03; it was 15 earlier the same day, which is itself the point) | 1 |
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
   `prompt: 'consent'` is already set (`gmail-auth.ts:25`, not `:24` as the
   earlier draft said), which is what actually forces a refresh token, so the
   correct remedy is to re-run rather than to revoke. If a revoke is genuinely
   needed, the message must say in the same breath that the send token dies with
   it and must be re-minted.

**The consent grant is shared state even though the refresh tokens are not.**
Both tokens are issued by the same OAuth client to the same Google account, so
the second consent modifies a grant the send token also hangs off. The refresh
tokens are independent strings and Google's documented behavior is that granting
an additional scope does not invalidate an existing refresh token, but "does not"
is a documented behavior, not a property of this repo, and the cost of being
wrong is the only working outbound path. **Verification 0c therefore re-proves
the existing send token after the second consent, and it is the single check the
"cannot break sending" claim actually rests on.** The earlier draft asserted the
claim and never tested it.

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

The two failure modes are **not** equally reachable, and the earlier draft
overstated this by calling both "reachable, not hypothetical". Corrected:

- **Duplicate `thread_id` is reachable today.** Gmail threads on subject plus
  participants, so two `outreach add --to-self` sends (`cli.ts:391`) land in one
  thread, and a `--force` second email to one person (`cli.ts:383`) can too.
  Both are explicitly supported operations. **This case alone carries the
  decision.**
- **Duplicate `sent_message_id` is a theoretical tail, not a live case.** It
  needs the SMTP fallback `smtp-${Date.now()}` (`gmail.ts:31`) to fire, which
  needs nodemailer to return a nullish `info.messageId`, **and** two such sends
  inside the same millisecond. The Gmail fallback `gmail-${Date.now()}`
  (`gmail-api.ts:52`) has the same shape and the same double precondition.
  Neither has ever fired: all 56 stored ids are real Gmail hex. Dropping the
  UNIQUE here is cheap insurance, not a response to an observed collision, and
  it should be described that way.

So: the schema in Change 3 drops both UNIQUE constraints in favour of plain
indexes, **and** the watch row is written by a separate `recordSentThread(db,
draftId, sentId, threadId?)` called by the caller **after** `markSent` returns,
wrapped so that any throw is logged and swallowed. A missing watch row is
recoverable at zero cost by the head-of-cycle adopt below. A rolled-back `sent`
event is not recoverable at all. The asymmetry decides it.

**Where the swallow sits, and why Verification 7 must assert more than it did.**
In `performApprovedSend` (`loop.ts:137-240`) the network `try` spans lines
**224-232**: `deps.sender.send`, `markSent`, `summary.sent++`, and the `SENT ...`
notify. If `recordSentThread` were called inside that block unwrapped, a throw
would land in the catch at **:233**, which calls `markSendFailed` (writing a
`send_failed` event) and texts `"${shortId} failed to send: ..."` **for an email
that already went out**. The draft would stay `sent` (that UPDATE committed) but
the ledger and the human would both be told the opposite. So the call is placed
**after** the try/catch closes, and Verification 7 asserts three things, not one:
the draft is `sent`, the `sent` event is present, and **no `send_failed` event
was written**. The third assertion is the one that catches a misplaced call.

**The head-of-cycle adopt, so a swallowed failure is actually self-healing.**
The earlier draft called `recordSentThread` "recoverable at zero cost by the
backfill" and then put the backfill behind an explicit `--backfill` flag, which
the plist never passes. A swallowed throw would therefore mean a thread that is
never polled and nothing that counts the gap. Split the two:

- **Adopt (every cycle, zero API calls, no flag).** A pure SQL anti-join at the
  head of every run:

  ```sql
  INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, watch_state)
  SELECT e.draft_id, d.person_id,
         json_extract(e.detail_json, '$.sentId'),
         json_extract(e.detail_json, '$.threadId'),
         e.created_at,
         -- The Gmail-shape guard, applied AT ADOPT TIME. Without this column the
         -- insert falls through to the table DEFAULT of 'open', so a non-Gmail
         -- sentId (an SMTP Message-ID, or one of the two synthesized fallbacks)
         -- is adopted as pollable and the poller retries it forever, which
         -- directly contradicts "recorded once as unresolvable and never
         -- retried" two paragraphs below. GLOB rather than a regex because
         -- SQLite has no REGEXP by default: the pair of clauses is "starts with
         -- a lowercase hex character" AND "contains no character that is not
         -- lowercase hex".
         CASE WHEN json_extract(e.detail_json, '$.sentId') GLOB '[0-9a-f]*'
               AND json_extract(e.detail_json, '$.sentId') NOT GLOB '*[^0-9a-f]*'
              THEN 'open' ELSE 'unresolvable' END
    FROM draft_events e
    JOIN drafts d ON d.id = e.draft_id
    LEFT JOIN sent_threads st ON st.draft_id = e.draft_id
   WHERE e.type = 'sent'
     AND st.draft_id IS NULL
     AND json_extract(e.detail_json, '$.sentId') IS NOT NULL
   ON CONFLICT(draft_id) DO NOTHING;
  ```

  `e.created_at` is already `datetime('now')` format, which is why `sent_at`
  uses that form and not ISO (see Change 3). The cycle logs `adopted N sends
  with no watch row` on every run, including `N = 0`, in `data/replies.log`.
  A persistent non-zero `N` is the signal that `recordSentThread` is failing.
- **Resolve thread ids (`--backfill`, costs API calls).** The 56
  `users.messages.get` calls that fill `thread_id` where it is NULL. This stays
  behind the flag because it spends quota.

**Backfill for existing sends.** Do not assume the first message in a thread has
`id == threadId`. It is widely observed and nowhere documented, and the check is
cheap: `users.messages.get(id, format=metadata)` returns the message's
`threadId`. 56 calls at 20 quota units each is **1,120 units, once**.

**Guard on which ids are resolvable.** Only a Gmail-shaped `sentId` is polled:
matches `/^[0-9a-f]+$/`, contains no `@`, and does not start with `smtp-` or
`gmail-`. All 56 current ids pass. Anything else (an SMTP `Message-ID`, a
fallback timestamp) is recorded once as `unresolvable` and never retried, so a
non-Gmail send path can never make the poller spin.

**Needs-address drafts need no special case, but the reason is a while-parked
property, not a permanent one.** The earlier draft said such drafts "never
send", which is false. The address-correction feature
(`src/pipeline/addressCorrection.ts`, shipped 2026-08-04) parks drafts with
`to_email = NULL` and marks the `seen_papers` row `drafted_unsendable` with
reason `awaiting address correction%`. **While parked**, such a draft cannot
pass `loadApprovedSend`'s `no_snapshot` check (`ledger.ts:188`), so it produces
no `sent` event. But `applyAddressCorrection` writes `drafts.to_email`
(`addressCorrection.ts:208`) in the same transaction as `people.email`, after
which the draft is a completely ordinary approved draft and sends through the
unchanged path. Measured 2026-08-04 21:03: **5 drafts have `to_email IS NULL`**,
so the parked case is live now, where the earlier draft measured zero.

This still needs no filter, and the reason is the keying rather than the
parking: both the send-time write and the adopt are keyed on `draft_events` rows
of type `sent`. A parked draft has none, so it is absent. A corrected draft that
then sends produces one, so it is present, which is correct: a corrected draft's
reply is exactly as interesting as any other.

### Change 3: three new tables, and one canonical timestamp format

New tables are safe to add via `schema.sql`: `openDb` execs it on every open
(`src/db/db.ts:19`) and `CREATE TABLE IF NOT EXISTS` reaches a live database. The
guarded-ALTER hazard documented in `db.ts:24-37` applies to new **columns** on
existing tables, which this change does not need. `drafts` is not modified.

#### The timestamp format, stated once, because getting it wrong stops the poller after one cycle

**Every timestamp column this design adds is stored as `YYYY-MM-DD HH:MM:SS` in
UTC**, the exact form `datetime('now')` produces. That is `next_poll_at`,
`sent_at`, `last_polled_at`, `received_at`, `detected_at`, `notified_at`, and
every column on `reply_poll_state`. No `T` separator, no `Z` suffix, no
fractional seconds, no offset.

The earlier draft said `received_at` would be stored "as an ISO UTC string to
match every other timestamp in the schema". **That claim is false and the format
it prescribes is a bug.** No other timestamp in this schema is ISO-Z: every one
of them is `datetime('now')`, which emits a space separator and no `Z`. Measured
on this machine 2026-08-05:

```
strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 hour') <= datetime('now')  ->  0
strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 day')  <= datetime('now')  ->  1
strftime('%Y-%m-%d %H:%M:%S','now','-1 hour')  <= datetime('now')  ->  1
```

SQLite compares TEXT bytewise, `T` is 0x54 and space is 0x20, so an ISO-Z string
sorts above `datetime('now')` **only while the two share a date prefix**. A due
time an hour in the past reads as not yet due; one a day in the past reads as
due, because the date prefix settles the comparison before the separator is
reached.

**The severity, corrected.** An earlier draft of this section said an ISO-Z
`next_poll_at` is "false forever" and the poller "goes permanently silent after
the first cycle". That overstates it. What actually happens is a **cadence
collapse**: a row written with a due time later today is not selected again until
the UTC date rolls over, so every tier degenerates to roughly one poll a day, the
`+4h` tier stops meaning anything, and the 60 day close stretches with it. Bad
and recoverable, not silent forever. What is unchanged is that it happens **with
no error, no failed cycle, and no notification**: nothing reports that the
feature is running at a quarter speed. The prescription below (one canonical
space-separated form, everywhere) is unchanged and still correct.

The reason this survives a green test suite: `julianday()` parses both forms
identically (`2461256.91666667` for each), so any test that computes
time-to-reply, or asserts a cadence with `julianday(next_poll_at) -
julianday(sent_at)`, passes under both. **The only test that can catch this is
one that asserts the stored string against `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/`,
and one that re-selects a row it has just written with a past due time.** Both
are required (Verification 3a). The second one must pin that past due time to the
**current UTC date** (for example the start of `date('now')`), not to a relative
offset like "an hour ago": the same-day window above is the only window in which
the bug is observable, so a fixture an hour in the past silently stops proving
anything for any run in the first hour of the UTC day.

`internalDate` arrives from Gmail as a string of epoch milliseconds. Convert it
with a single helper, used for every timestamp this feature writes from
TypeScript, so there is one place to get it wrong:

```ts
// The one canonical form. Matches datetime('now') byte for byte, which is what
// makes `next_poll_at <= datetime('now')` work. Never Date#toISOString() alone:
// its T and Z sort above a space and above nothing, and a past due time then
// compares as not-yet-due forever. Verified: '...T10:00:00Z' <= datetime('now')
// is 0 while '... 10:00:00' <= datetime('now') is 1.
export function toSqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
export function fromInternalDate(ms: string): string {
  return toSqlTime(new Date(Number(ms)));
}
```

Cadence arithmetic uses the injected `now` and the same helper
(`toSqlTime(new Date(now() + 4 * 3600_000))`), not SQL's `datetime('now', '+4
hours')`, because Change 5 injects `now` precisely so the age tiers and the
60-day close are testable without waiting.

```sql
CREATE TABLE IF NOT EXISTS sent_threads (
  draft_id INTEGER PRIMARY KEY REFERENCES drafts(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  sent_message_id TEXT NOT NULL,          -- materialized from draft_events.detail_json
  thread_id TEXT,                         -- NULL until send-time capture or backfill
  sent_at TEXT NOT NULL,                  -- 'YYYY-MM-DD HH:MM:SS' UTC. See above.
  watch_state TEXT NOT NULL DEFAULT 'open'
    CHECK(watch_state IN ('open','replied','closed_no_reply','unresolvable')),
  last_polled_at TEXT,
  -- Due time, not elapsed time. Survives missed cycles and wake coalescing:
  -- a row that is overdue is simply picked up on the next run.
  --
  -- MUST be 'YYYY-MM-DD HH:MM:SS'. Written as ISO-with-Z this column silently
  -- stops the poller forever: 'T' sorts above ' ', so a past due time never
  -- satisfies `next_poll_at <= datetime('now')`. julianday() parses both, so a
  -- cadence test cannot catch it.
  next_poll_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Counts ONLY failures attributable to THIS thread: a 404, or a per-thread
  -- 4xx. A cycle-wide failure (expired refresh token, 429, 5xx, SQLITE_BUSY)
  -- must never touch this column, because it hits every selected row at once
  -- and five such cycles would mark the entire watch set unresolvable. Reset to
  -- 0 on any successful poll. See Change 4.
  poll_failures INTEGER NOT NULL DEFAULT 0,
  -- Set when a human re-arms an unresolvable row. Kept so a row that has been
  -- re-armed and failed again is visibly different from a fresh one.
  rearmed_at TEXT
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
  -- From internalDate, never the Date: header. 'YYYY-MM-DD HH:MM:SS' UTC,
  -- written through fromInternalDate(), not Date#toISOString().
  received_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('human','auto_reply','bounce')),
  detected_at TEXT DEFAULT (datetime('now')),
  -- NULL until channel.notify() has returned successfully for this row. This
  -- column is what makes "exactly one notification" implementable at all.
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_replies_draft ON replies(draft_id);
CREATE INDEX IF NOT EXISTS idx_replies_unnotified ON replies(notified_at) WHERE notified_at IS NULL;

-- Cycle-level durable state. Exactly one row, enforced by the CHECK.
--
-- This table exists because the job is StartCalendarInterval with no KeepAlive,
-- so EVERY cycle is a fresh short-lived process with no memory of the last one.
-- Change 6 promises to notify "after 3 consecutive failed cycles". Without a
-- durable counter that promise is unimplementable rather than merely untested:
-- a whole-cycle failure that records nothing before exiting resets the count to
-- zero on every run, so the alarm can never fire, and the silent-death mode the
-- notification exists to catch is exactly the mode it would miss.
--
-- It also carries the run lease. launchd will not start a second copy of this
-- job, but every verification in this spec hand-runs `outreach replies` while
-- the scheduled job may be mid-cycle, and two concurrent cycles would both
-- select the same due rows and both spend quota on them.
CREATE TABLE IF NOT EXISTS reply_poll_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  last_cycle_at TEXT,
  last_success_at TEXT,
  -- Incremented ONLY by a cycle-wide failure. Reset to 0 by any cycle that
  -- completes. This is the counter the 3-cycle alarm reads.
  consecutive_cycle_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                        -- err.message ONLY, never the object
  -- Set after the failure notification is delivered, cleared on recovery, so
  -- the alarm fires once per outage rather than once per cycle for days.
  failure_notified_at TEXT,
  -- The lease. A cycle claims it with a conditional UPDATE, the same shape as
  -- beginSendAttempt (ledger.ts:219-250): SQLite serializes writers and the
  -- WHERE clause carries the whole precondition, so there is no read-then-write
  -- gap. The loser exits 0 immediately and says so.
  lock_pid INTEGER,
  lock_expires_at TEXT
);
INSERT OR IGNORE INTO reply_poll_state (id) VALUES (1);
```

`INSERT OR IGNORE` on a singleton row is idempotent and safe to run on every
`openDb`, exactly like the `CREATE TABLE IF NOT EXISTS` statements around it.

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
`internalDate` arrives as a string of epoch milliseconds and is stored through
`fromInternalDate()` in the one canonical `YYYY-MM-DD HH:MM:SS` form defined in
Change 3. It is **not** stored as an ISO-Z string, and the earlier draft's
justification for doing so ("to match every other timestamp in the schema") was
backwards: no other timestamp in this schema is ISO-Z.

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

**The insert must be conflict-ignoring, or that fix defeats itself.** Keeping the
thread `open` means the same auto-reply is fetched again on every subsequent
poll, and `gmail_message_id` is `UNIQUE`. A plain `INSERT` therefore throws, and
it throws **inside the per-thread synchronous transaction**, which rolls back
`last_polled_at`, `next_poll_at`, `watch_state` and `poll_failures` along with
it. The row stays due, is re-selected next cycle, throws again, and after five
cycles is marked `unresolvable`. **A single Monday out-of-office would blind the
thread permanently in about 30 hours, which is verbatim the outcome this fix
exists to prevent.** So:

```sql
INSERT INTO replies (draft_id, person_id, gmail_message_id, thread_id,
                     from_address, received_at, kind)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(gmail_message_id) DO NOTHING;
```

**Seeing a message again is a normal no-op, not a failure and not an anomaly.**
It is the expected steady state for every thread carrying an auto-reply or a
bounce, forever, until a human reply closes it or the 60-day window expires. The
cycle counts these as `alreadyKnown` and logs the count; it does not warn, does
not increment `poll_failures`, and does not notify. `changes === 0` from that
statement is the signal, and the `notified_at IS NULL` selection in Change 6 is
what keeps a re-seen row from re-notifying: an already-notified row has a
non-NULL `notified_at`, and `DO NOTHING` cannot clear it.

The same applies to the adopt statement in Change 2 (`ON CONFLICT(draft_id) DO
NOTHING`) and for the same reason: it runs every cycle over an append-only log.

#### Failure scope: a per-thread failure and a cycle-wide one are different animals

The earlier draft had one counter, `poll_failures`, and one rule, "five
consecutive failures marks the row `unresolvable`". That is wrong in a way that
destroys the whole watch set. An expired `GMAIL_OAUTH_READ_REFRESH_TOKEN`, a 429,
a 5xx, or a `SQLITE_BUSY` from the concurrent batch job does not fail one
thread, it fails **every row selected in that cycle, at once**. Five such cycles,
which at four runs a day is about 30 hours of a Google outage or one expired
token, would mark the **entire watch set** `unresolvable`, and `unresolvable` was
terminal with no recovery path stated anywhere in Rollback. The feature would
delete its own reason to exist and report nothing, silently.

Every failure is classified into exactly one of two scopes before anything is
written:

| scope | what triggers it | what it does |
| --- | --- | --- |
| **thread** | `404` (thread deleted), and any other per-thread `4xx` that is not `401`, `403` or `429` | `poll_failures = poll_failures + 1` on **that row only**; `next_poll_at` advances by the normal cadence so it retries; at 5, `watch_state = 'unresolvable'` |
| **cycle** | `401`, `invalid_grant`, `403` (insufficient scope or rate-limit), `429`, any `5xx`, any network or DNS error, `SQLITE_BUSY`, `SQLITE_READONLY`, an unclassifiable throw | **abort the cycle immediately**, touch **no** `sent_threads` row's `poll_failures`, increment `reply_poll_state.consecutive_cycle_failures`, record `last_error` (message only), release the lease, exit |

Two consequences that are load bearing:

- **A cycle-wide failure never advances any row toward `unresolvable`.** The
  threads it did not reach keep their existing `next_poll_at` and are simply due
  again next cycle. Rows already resolved in the same cycle keep their
  committed per-thread transactions, which is the point of Change 5's
  per-thread rather than per-cycle persistence.
- **An unclassifiable throw is treated as cycle-wide**, which is the safe
  direction: it stops the run and raises the alarm rather than quietly
  attributing an unknown fault to whichever thread happened to be in hand.
- `poll_failures` is **reset to 0 on any successful poll of that thread**, so
  five *consecutive* means consecutive.

**`unresolvable` must be re-armable, and re-arming is a stated operation.** New
subcommand `outreach replies --rearm [all | <draftId>...]`:

```sql
UPDATE sent_threads
   SET watch_state = 'open',
       poll_failures = 0,
       next_poll_at = datetime('now'),
       rearmed_at = datetime('now')
 WHERE watch_state = 'unresolvable'
   AND thread_id IS NOT NULL;   -- a non-Gmail id is unresolvable for a real reason
```

The `thread_id IS NOT NULL` guard is what keeps `--rearm all` from resurrecting
the Change 2 guard's genuinely unpollable rows (an SMTP `Message-ID`, a fallback
timestamp) into a permanent spin. Every cycle also prints the current
`unresolvable` count to `data/replies.log`, so a mass transition is visible
without anyone thinking to look.

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

**Age-tiered cadence, aligned to the actual fire times.** The earlier draft set
the newest tier to `+6 hours` and the schedule to 07:30 / 12:30 / 17:30 / 21:30
independently, and the two do not compose. Worked through: a poll at 07:30 sets
`next_poll_at` to 13:30, which the 12:30 run misses, so the row waits for 17:30
and is then due again at 23:30, which the 21:30 run misses, so it waits for 07:30
the next morning. **A `+6 hours` tier under this schedule gives the newest and
most valuable threads about 2 polls a day, not 4**, and the design's own quota
arithmetic assumed 4.

The tier is therefore **`+4 hours`**, which is the largest interval that lands
inside every gap in the schedule (the gaps are 5h, 5h, 4h, 10h):

| age of send | next poll | polls per day under the 07:30/12:30/17:30/21:30 schedule |
| --- | --- | --- |
| under 3 days | +4 hours | 4 (07:30 → due 11:30, caught 12:30 → due 16:30, caught 17:30 → due 21:30, caught 21:30 → due 01:30, caught 07:30) |
| 3 to 14 days | +24 hours | 1 |
| 14 to 60 days | +72 hours | 1 per 3 days |
| 60 days or more | row closes as `closed_no_reply` | 0 |

The selection is `next_poll_at <= datetime('now')`, inclusive, so the 21:30
boundary case fires rather than slipping a cycle. The recomputed load at a
sustained 20 sends per day is unchanged in total, because the intended 4 polls a
day was already what the earlier arithmetic assumed: 60 threads under 3 days at
4 polls = 240, 220 threads at 1 poll = 220, 920 threads at 1 per 3 days = 307,
so **about 770 `threads.get` per day**, around 31,000 units per day, spread over
four runs at roughly 192 threads per cycle. What changed is that the number is
now true.

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
(`unresolvable`, and not re-armable), or `threads.get` returns a 404 or fails 5
consecutive **thread-scoped** times (`unresolvable`, re-armable). A cycle-wide
failure never moves a row out of `open`. Nothing polls forever, and nothing that
left `open` for a recoverable reason is stuck there.

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

New command `outreach replies [--dry-run] [--backfill] [--rearm all|<draftId>...]`
and a new launchd job
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
on open, which is exactly right.

**The array form is documented but is not proven in this repo, and the earlier
draft conflated the two.** `com.aditya.outreach.plist:29-35` uses
`StartCalendarInterval` with a **single dictionary** (`Hour` 9, `Minute` 0). That
proves the key works here; it does not prove the array-of-dictionaries form does,
and `launchctl` accepts a malformed plist quietly enough that this needs
checking rather than asserting. Deploy step 4 below therefore loads the job and
reads the schedule back out of `launchctl print`, and does not proceed until all
four fire times appear.

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
  by: `listen.ts:54-59` records a one-year timeout that overflowed Node's 32-bit
  timer field, became 1ms, and rebuilt the client four times in 45 seconds
  against the live service.
- A separate job also gets its own logs, its own restart behavior, and can be run
  by hand for the live verification below.

**Module shape: an options object with injected seams**, matching `ListenDeps`
(`listen.ts:21-45`) and `createGmailApiSender`'s `opts` parameter
(`gmail-api.ts:25-29`). The reader takes `{ db, reader, channel?, leaseHeld?,
now, sleep, log, maxThreadsPerCycle, maxCallsPerMinute, senderEmail, dryRun }`,
where `now`, `sleep` and `log` all default to the real implementations.

**`channel` is a factory, `() => Promise<ApprovalChannel>`, not a channel.** This
is what makes "never connect on a quiet cycle" below achievable rather than
aspirational: typed as a value, whatever assembles the options object has to have
connected before the cycle function is entered, so no behavior inside that
function can undo it and no assertion inside it can observe it. The cycle holds
the resolved instance in a local and closes that, so its own cleanup path cannot
construct one either.

**`leaseHeld` says the caller already holds the run lease** and will release it.
The CLI command sets it, because `--backfill` (the largest single quota spend in
this feature) and `--rearm` both run outside the cycle function and must be
covered by the same lock. Unset, the cycle takes and releases its own lease. Without an injected
`now` the age-tier logic and the 60 day close are untestable except by waiting,
and without an injected `sleep` the pacing rule makes the test suite take
minutes. Both mistakes have already been made and fixed once in `listen.ts`.

**`--dry-run` semantics, stated so they cannot be guessed wrong.** It reads (real
Gmail calls, real quota spend, real classification) and prints what it would do,
and it **writes nothing and notifies nothing**: no `sent_threads` insert or
update, no `replies` row, no `notified_at`, no `last_polled_at`, no
`next_poll_at`, no `poll_failures` increment, no `reply_poll_state` write, and
no Photon channel is constructed at all. It does not run the head-of-cycle adopt
either, because that is a write. It **does** take the lease, so a dry run and a
scheduled cycle cannot overlap and double-spend quota. This mirrors `outreach
loop --dry-run`, whose real citations are `cli.ts:111` (the flag), `cli.ts:135`
(the stub channel instead of Photon) and `cli.ts:166` (the zeroed reply window).
The earlier draft cited `cli.ts:266`, which is the command dispatch line and has
nothing to do with dry-run behavior.

**Overlapping instances, and why launchd is not enough.** launchd will not start
a second copy of a job that has not exited, so the scheduled runs cannot collide
with each other. But Verifications 1, 2, 2b and the `--rearm` path all hand-run
`outreach replies` from a terminal, and that process is invisible to launchd's
scheduler. Two cycles would select the same due rows under the same
`next_poll_at <= datetime('now')` predicate and both spend 40 units on each.
The lease on `reply_poll_state` (Change 3) closes this:

```sql
UPDATE reply_poll_state
   SET lock_pid = ?, lock_expires_at = ?
 WHERE id = 1
   AND (lock_expires_at IS NULL OR lock_expires_at <= datetime('now'));
```

`changes === 1` wins the cycle. Anything else prints `another reply cycle holds
the lease (pid N, until T); exiting` and **exits 0**, because a skipped cycle is
not a failure and must not increment `consecutive_cycle_failures` or raise the
3-cycle alarm. The lease is 15 minutes, comfortably longer than a worst-case
400-thread cycle at 100 calls per minute (4 minutes), and is released in a
`finally`, so a crashed process blocks at most one cycle rather than forever.
This is the same conditional-UPDATE shape as `beginSendAttempt`
(`ledger.ts:219-250`) and works for the same reason: SQLite serializes writers
and the whole precondition sits in the `WHERE`.

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
googleapis carries its response and request config as **own enumerable
properties**, and `console.error(err)` appends those to the stack trace. Verified
on this machine with Node 24:

```
$ node -e "const e=new Error('boom'); e.response={headers:{from:'Someone <secret@uni.edu>'}}; \
           e.config={url:'https://gmail.googleapis.com/gmail/v1/users/me/threads/abc?format=metadata'}; \
           console.error(e)"
Error: boom
    at [eval]:1:11
    ... {
  response: { headers: { from: 'Someone <secret@uni.edu>' } },
  config: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/abc?format=metadata' }
}
```

The same command with `console.error(e.stack)` prints the stack and nothing
else. Use `e instanceof Error ? e.message : 'unknown error'`.

**`cli.ts:431` currently bypasses this rule, and it is on this job's path.**
`main().catch((e) => { console.error(e); process.exit(1); })` prints the full
object, so any `GaxiosError` that escapes the replies command lands in
`data/replies.err.log` complete with the response headers and the request URL,
which is precisely the leak Change 7 exists to prevent. Two fixes, both required:

1. **`cmdReplies` owns its own catch** and never lets a Gaxios error reach the
   top-level handler. It logs `err.message`, and exits non-zero.
2. **Harden the top-level handler anyway**, as defense in depth for the next
   command that forgets: `console.error(e instanceof Error ? (e.stack ?? e.message) : 'unknown error')`.
   This keeps the stack trace every other command relies on for debugging and
   drops only the appended own-property dump, which is the part that carries the
   response. Measured above.

### Change 6: what Aditya is told, and when

He is already receiving a lot of messages (41 sends in one day on 2026-08-04, each
producing a draft message and a `SENT ...` confirmation) and has complained about
volume. So:

- **Notify only on a state change.** Never a heartbeat, never a "no replies"
  line, never a per-cycle summary. A quiet cycle sends nothing.
- **Exactly one message per newly detected `human` reply**, coalesced if a cycle
  finds several.
- **`bounce` notifies once per bounce, coalesced the same way human replies
  are** (best effort, see Change 4). The earlier draft coalesced human replies
  and left bounces unbounded, which is backwards: a human reply arrives once,
  while an MTA routinely emits several DSNs for one message (a delay warning,
  then a hard failure, sometimes one per hop), each a distinct
  `gmail_message_id` and so each a distinct row. Uncoalesced, one bad address
  could produce three or four separate texts. **`auto_reply` is recorded and
  never notified** (an out-of-office is noise).
- **Two bounds, because coalescing alone bounds the wrong quantity.** Coalescing
  bounds the *count* of messages; it does nothing about the *length* of one, and
  a burst day could produce a single text listing thirty names, which is
  unreadable on a phone and is its own kind of noise.
  - **Count, structural: at most 3 messages per cycle.** One for human replies,
    one for bounces, one for the persistent-failure alarm. This is a property of
    the design, not a check: there is nowhere else a message can come from.
  - **Length, a hard cap: at most 5 names per message**, with an `and N more`
    tail. `3 replies: Daniel Kepple (d19), Ada Chen (d22), Lin Wu (d31). Read
    them in Gmail.` at three; `... and 7 more. Read them in Gmail.` at twelve.

  The cap is on names **shown**, never on rows recorded or on rows notified:
  every reply is written to `replies`, and **every row covered by a delivered
  message gets `notified_at` set, including the ones folded into the `and N
  more` tail**. Otherwise a 12-reply cycle would re-notify the unnamed 7 on the
  next cycle, forever, which is worse than the problem the cap solves.
- **Failures are silent until they persist:** notify only after 3 consecutive
  failed cycles (about 18 hours at four runs a day), so a transient Gmail blip
  says nothing. **This is implementable only because of
  `reply_poll_state.consecutive_cycle_failures`** (Change 3). The earlier draft
  specified this rule with no durable counter anywhere in the design, and the
  job is `StartCalendarInterval` with no `KeepAlive`, so every cycle is a fresh
  short-lived process: a whole-cycle failure that recorded nothing before
  exiting reset the count to zero every run, the alarm could never fire, and the
  silent-death mode it exists to guard was exactly the mode it would have
  missed. The mechanics:
  1. Every cycle writes `last_cycle_at` in a `finally`, whatever happened.
  2. A cycle that completes sets `consecutive_cycle_failures = 0`,
     `last_success_at = datetime('now')`, `failure_notified_at = NULL`.
  3. A cycle-wide failure (Change 4's taxonomy) increments the counter and
     writes `last_error` as `err.message` only. **This write happens outside any
     aborted transaction**, or the counter rolls back with it and the bug
     returns in a new shape.
  4. When the counter reaches 3 **and** `failure_notified_at IS NULL`, notify,
     then set `failure_notified_at`. One text per outage, not one per cycle for
     as long as it lasts. Step 2 clears it, so a recovery re-arms the alarm.
  5. A cycle that could not take the lease is neither a success nor a failure:
     it exits 0 and touches none of these columns.
- **Construct the Photon channel only when there is something to say.** On a
  quiet cycle the job never connects to Spectrum at all. This is why `channel` is
  a factory (Change 5) and why the assertion that proves it belongs to the **CLI
  command**, which decides whether a channel gets built, and not to the cycle
  function, which can at most decline to call a factory somebody else already
  invoked. When it does connect, it
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
- one bounce: `Bounced: d19 to Daniel Kepple did not deliver.`
- several bounces: `2 bounced: Daniel Kepple (d19), Ada Chen (d22).`
- either, over 5 names: `12 replies: <5 names> and 7 more. Read them in Gmail.`
- persistent failure: `Reply polling has failed 3 cycles running: <err.message>.`

The person is named because he needs to know who; the message is never quoted,
excerpted, or summarized.

**A tapback on one of these must not produce total silence.** This is the same
defect the needs-address hint branch was added to fix, in a new place. None of
these formats begins `dN:`, deliberately, so `draftIdFromReactedText`
(`photonChannel.ts:135-138`) returns null. None of them matches
`NEEDS_ADDRESS_HEADER` either, so `needsAddressDraftId` also returns null. A
thumbs up on "Reply from Daniel Kepple" therefore falls into the
`reaction on a non-draft message, ignoring` branch and produces **nothing at
all**, which is indistinguishable from a dead listener and is exactly the
outcome Task 4 of the address-correction work existed to eliminate.

Reacting to good news is the most natural thing a human does with this message,
so it gets its own branch rather than an accepted silence. Add a third
recognizer beside `needsAddressDraftId`, in `channel.ts` for the same reason
that one lives there (the sender and the reaction decoder must not drift):

```ts
// Recognizes the reply-tracking notifications. They are informational: there is
// nothing to approve, and unlike a needs-address message there is no typed
// command that would help either. So the hint says so and stops.
const REPLY_NOTICE = /^(Reply from |\d+ replies: |Bounced: |\d+ bounced: |Reply polling has failed )/;
export function replyNoticeTapbackHint(text: string | undefined): string | null {
  if (!REPLY_NOTICE.test((text ?? '').trim())) return null;
  return 'Nothing to approve on a reply notification. Open Gmail to read it.';
}
```

wired into `reactionToDecoded` after the `needsAddressDraftId` check and before
the ignore branch, returning `{ kind: 'hint', text }`. The hint itself begins
with a letter, so it cannot become an approval button, and the existing
`still reflects nothing for a reaction on an ordinary status line` test keeps a
tapback on `d25 sent to ...` silent, which is still correct: that line is not
one of these.

**The new module must be added to the tapback test's SOURCES list, and that test
cannot catch this feature's formats on its own.**
`test/notify-tapback-safety.test.ts:21` enforces the rule at source level for
`src/pipeline/loop.ts`, `src/pipeline/listen.ts`, `src/cli.ts` and
`src/pipeline/addressCorrection.ts`, so a new module is invisible to it until it
is listed. Adding `src/pipeline/replies.ts` to `SOURCES` is part of this change.

But listing it is not sufficient, and the earlier draft treated it as if it
were. That test's predicate is:

```js
const TAPBACK_HEADER = /notify\(\s*\n?\s*`\$\{[A-Za-z.]*[sS]hortId\}:/;
```

It matches an **inline template literal inside a `notify(` call**. Every
notification in this design is produced by a coalescing formatter and passed to
`notify` as a variable, so the regex cannot see it: the offending string would
live in a `formatReplyNotice` function, not at a `notify(` call site, and the
test would pass no matter what that function returned. **Verification 8
therefore adds a direct unit test on the formatter's output**, asserting
`/^\s*(d\d+):/` is false for every one of the six formats above, driven by a
table so a seventh format cannot be added without an entry.

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
- **The listener process must be restarted as part of the deploy.** Change 2
  modifies `performApprovedSend`, which `runListenLoop` executes, and it adds a
  table the listener's long-lived connection has never seen.
  `com.aditya.outreach-listen.plist` sets `KeepAlive` true and `RunAtLoad` true,
  so that process holds for days, and `openDb` execs `schema.sql` **only at
  open** (`db.ts:19`), so `sent_threads` will not exist on that connection until
  it reopens. The failure is doubly silent: the listener would run the old
  `performApprovedSend` (no `recordSentThread` call at all), and even the new
  code would throw `no such table` into the swallow. Nothing automates this.
  `scripts/check-listener-fresh.ts` exists and is manual; it compares the
  newest `src/**/*.ts` mtime against the process start time from `ps`, which is
  exactly the right predicate here. Deploy step 3 runs it with `--restart`.
  **This failure has already happened once**, on 2026-08-04: three tasks shipped,
  606 tests passed, and a live probe of the address-correction path came back
  with the old behavior, because the daemon was still running the previous code.
  That is why the script exists.

## Verification

Per the project rule: demonstrate against reality, not artifacts.

**Baseline, re-measured 2026-08-05 with `npx vitest run --reporter=basic`:
50 files, 633 tests, 633 passing, 0 failing. The suite is fully green.**

An earlier draft of this section recorded "631 passing, 2 failing, both in
`test/draft.test.ts` under `stripTrailingSignoff handles an inline sign-off`",
and told the implementer to stop if either of those failures disappeared. That
claim was already stale when it was written: those two tests were fixed in
`5927688`, the commit immediately before the one carrying this spec. The stop
rule would therefore have fired on step zero, and normalising 2 failures would
have let a real regression back to 2 read as pre-existing.

**The target after this change is 633 + N passing, zero failures.** There is no
allowed-failure list. Any failure is caused by this work.

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
   `outreach/.env` was last modified **2026-07-19 00:50** (re-confirmed
   2026-08-04 21:03) and still contains the original
   `GMAIL_OAUTH_REFRESH_TOKEN`, yet 41 real Gmail API sends succeeded on
   **2026-08-04**, 16 days later. A refresh token on a 7 day clock could not have
   done that. **But the earlier draft drew a narrower conclusion from that than
   the evidence supports, and left a contradiction in place.** Three
   configurations are equally consistent with a 16-day-old working token:
   - **External + Published.** The published-and-unverified case.
   - **External + Testing, but the account is the project owner.** Not relied on;
     Google's exemption here is not clearly documented.
   - **Internal user type.** ASU is a Google Workspace organization, and an
     Internal consent screen has no 7-day expiry and no verification
     requirement at all. The earlier draft never considered this, and it is at
     least as likely as the others given the account.

   The contradiction: the earlier draft leaned toward "published", and if the
   project **is** published-and-unverified, then a restricted scope is **harder**
   to obtain, not easier. An unverified published app requesting a restricted
   scope is the case Google gates hardest: the unverified-app interstitial plus,
   potentially, a refusal. **Internal** is the only one of the three where a
   restricted scope is straightforward, because verification does not apply to
   Internal apps. So the console reading in this step is not a formality that
   confirms a strong inference; it changes what step 0 is likely to find, and
   it must be done before step 0, not after.
0c. **Re-prove the EXISTING send token after the second consent, before writing
   any code.** With `GMAIL_OAUTH_READ_REFRESH_TOKEN` freshly minted and
   `GMAIL_OAUTH_REFRESH_TOKEN` untouched, run one real `outreach add <arxiv-id>
   --to-self` and confirm it sends. **This is the single check the entire
   "a failed or fumbled re-consent cannot break sending" claim rests on, and the
   earlier draft never performed it.** The two refresh tokens are separate
   strings, but they are issued by the same OAuth client to the same Google
   account, so the consent grant is shared state: the second consent modifies the
   object the first token hangs off. Asserting that this is safe without testing
   it is exactly the failure mode this project's own rules call out. If it
   breaks, the recovery is already in Rollback, and it must be exercised here
   rather than discovered later.
### Deploy, in this order, after the code is merged and before Verification 1

Every live verification below runs against the deployed system, so these are
numbered steps rather than prose. Skipping any of them makes the verification
that follows it measure the wrong process.

1. **Put `GMAIL_OAUTH_READ_REFRESH_TOKEN` in `outreach/.env`.** Confirm
   `GMAIL_OAUTH_REFRESH_TOKEN` is byte-identical to what it was before, and that
   `SENDER_EMAIL` is set (Change 4 refuses to start without it).
2. **Reopen the database once so `schema.sql` reaches it.** Any command that
   calls `openDb` does this; `npx tsx --env-file=.env src/cli.ts stranded` is the
   cheapest and touches no network. Then confirm the three new tables exist:
   `sqlite3 data/outreach.db ".tables"` must list `sent_threads`, `replies` and
   `reply_poll_state`, and `SELECT count(*) FROM reply_poll_state` must be 1.
3. **Restart the listener, because it is running stale code AND holding a stale
   database handle.**

   ```bash
   npx tsx scripts/check-listener-fresh.ts --restart
   ```

   `com.aditya.outreach-listen` is `KeepAlive` true and holds its process for
   days. It executes `performApprovedSend`, which Change 2 modifies, so without
   this it keeps running the old code and never calls `recordSentThread`. Worse,
   `openDb` execs `schema.sql` **only at open** (`db.ts:19`), so even the new
   code on that connection would throw `no such table: sent_threads` straight
   into the swallow, and the swallow would hide it. Nothing automates this
   restart. Re-run the script without `--restart` afterwards and confirm it
   reports fresh and exits 0.
   The daily batch job needs no equivalent step: it is a fresh process every
   morning, which is why only the listener can go stale.
4. **Install and load `com.aditya.outreach-replies.plist`, then read the
   schedule back.** The array-of-dictionaries `StartCalendarInterval` form is
   documented but is not proven in this repo (`com.aditya.outreach.plist` uses a
   single dictionary), and `launchctl` is quiet about a plist it half-understood.

   ```bash
   launchctl print gui/$(id -u)/com.aditya.outreach-replies | grep -A 20 'calendar'
   ```

   Do not proceed until all four fire times (07:30, 12:30, 17:30, 21:30) appear.
   If only one does, the array form did not take and the job is running once a
   day, which the age tiers assume it is not.
5. **Run one cycle by hand and read `data/replies.log`.** Confirm it prints the
   adopt count (`adopted N sends with no watch row`, where N on the first run is
   **the current `sent` event count**, `SELECT count(*) FROM draft_events WHERE
   type='sent'`: it was 56 when this spec was written and only ever grows, so
   read it rather than expecting a literal),
   the `unresolvable` count, and that `data/replies.err.log` is empty. Confirm
   `reply_poll_state.last_success_at` is set and
   `consecutive_cycle_failures` is 0.

### Live verification

1. **Live end-to-end demonstration, restructured so it is actually executable.**
   The earlier draft said to send via `--to-self` and then reply "from a
   different Gmail account", which cannot be done as written: `--to-self` sends
   to `SENDER_EMAIL` (`cli.ts:391-392`), so the second account was never a
   participant in that thread and has no message to reply to. Gmail threads on
   `In-Reply-To`/`References`, not on address, so the second account must first
   receive a message carrying the chain. The executable sequence, one thread,
   four assertions:
   1. `outreach add <arxiv-id> --to-self`. The email lands in Aditya's own
      mailbox, which is the point: the thread is somewhere the poller can see it.
   2. Run `outreach replies`. Assert a `sent_threads` row with a non-NULL
      `thread_id` and **no** `replies` row, because the only message in the
      thread is our own.
   3. From that mailbox, hit **Reply** on the message and add a second Gmail
      address as a recipient. This does two things at once: it puts a
      `From: Aditya Gupta <apgupta3@asu.edu>` message into the thread, and it
      seeds the `References` chain into the second account.
   4. From the second account, **Reply** to what it just received. That reply
      carries the chain and lands in the original thread.
   5. Run `outreach replies` again. Assert **exactly one** `replies` row, whose
      `from_address` is the second account and not `SENDER_EMAIL`; assert the
      thread is now `replied`; show the actual iMessage text.

   Step 3's self-sent message is the old Verification 1b, folded in: it is
   present in the thread at step 5 and must produce no row. That is the RFC 5322
   mailbox extraction working against a real `From: Aditya Gupta <...>` header,
   and it is the case that would otherwise fabricate ground truth. Folding it in
   is strictly stronger than running it separately, because both messages are
   now in the same `threads.get` response and the poller has to tell them apart
   in one pass.
2. **Live backfill demonstration.** Run `outreach replies --backfill` over the 56
   real sends and report the actual numbers: how many resolved to a `threadId`,
   how many threads already contain an inbound message, and the `kind` breakdown.
   This is the payoff, and it either answers the motivating question immediately
   or proves nobody has answered yet.
2b. **Live `--dry-run` demonstration, against a thread known to contain a
   reply.** The earlier draft ran `--dry-run` "against the live threads" and
   asserted only that row counts did not change, which passes trivially if the
   command reads nothing, finds nothing, or crashes early: **there was no way for
   it to fail.** Instead, run it against the thread from Verification 1, which is
   known to contain exactly one inbound human reply, after first resetting that
   row (`UPDATE sent_threads SET watch_state='open', next_poll_at=datetime('now')
   WHERE draft_id = ?; DELETE FROM replies WHERE draft_id = ?`). Assert **both**
   halves: the stdout says it **would** record one human reply from the second
   account, **and** the `replies` / `sent_threads` before-and-after row counts
   plus `last_polled_at` are byte-identical. A dry run that reports nothing now
   fails the first half.
3. **Unit tests against an injected `GmailReader` seam** (`threadIdForMessage`,
   `getThreadMetadata`), so no test touches the network. Cases: our own sent
   message is never a reply; `From: Aditya Gupta <apgupta3@asu.edu>` is never a
   reply, and neither is `<APGUPTA3@ASU.EDU>`; a reply from an unrelated address
   in the thread is attributed to the right draft; a `mailer-daemon` message
   classifies as `bounce` **and leaves the row `open`**; an
   `Auto-Submitted: auto-replied` message classifies as `auto_reply`, produces no
   notification, **and leaves the row `open`**, and a `human` reply arriving in a
   later poll of that same thread is still detected; a 404 marks the row
   `unresolvable` and stops polling; five consecutive **thread-scoped** failures
   stop polling; `received_at` comes from `internalDate` even when the `Date:`
   header says 1999; a 61-day-old open thread closes as `closed_no_reply` under
   an injected `now`.
3a. **Timestamp format tests, which are the only thing that can catch the bug in
   Change 3.** Two assertions, both required, because either alone passes for the
   wrong reason:
   - **Shape.** Every written `next_poll_at`, `sent_at`, `last_polled_at` and
     `received_at` matches `/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/`. Explicitly
     assert no `T` and no `Z`.
   - **Round trip through the real predicate.** Write a row whose `next_poll_at`
     is one hour in the past, then run the actual selection query
     (`WHERE watch_state = 'open' AND next_poll_at <= datetime('now')`) and
     assert the row comes back. **Do not assert this with `julianday()`**: it
     parses both forms identically (measured: `2461256.91666667` for
     `'2026-08-04T10:00:00Z'` and for `'2026-08-04 10:00:00'`), so a
     julianday-based cadence test passes under the broken format and proves
     nothing.
   - **Mutation:** change `toSqlTime` to `d.toISOString()`. The shape test and
     the round-trip test must both go red. If only the shape test does, the
     round-trip test is not using the real query.
3b. **Auto-reply repeat-sighting test, which is blocker 1 in test form.** Poll a
   thread carrying an `Auto-Submitted: auto-replied` message **three times** with
   the same fixture, then a fourth time with a `human` reply added. Assert: one
   `replies` row of kind `auto_reply` after all three; `watch_state` still
   `open`; `poll_failures` still **0** after each; `last_polled_at` and
   `next_poll_at` **advance on every cycle**; and the human reply is detected on
   the fourth. **Mutation:** remove `ON CONFLICT(gmail_message_id) DO NOTHING`.
   The test must go red on cycle 2, with the row still at the cycle-1
   `next_poll_at` and `poll_failures` at 1, which is the rollback this
   demonstrates. Restore.
3c. **Failure-scope tests, which are blocker 2 in test form.** With 10 open
   threads due:
   - A **cycle-wide** failure (inject a 401 on the first `threads.get`): assert
     **zero** rows had `poll_failures` incremented, zero moved to `unresolvable`,
     `reply_poll_state.consecutive_cycle_failures` is 1, and the cycle exited.
     Repeat five times and assert the watch set is still 10 rows `open`.
     **Mutation:** classify 401 as thread-scoped; assert 10 rows go
     `unresolvable` and the test goes red.
   - A **thread-scoped** failure (a 404 on thread 3 only): assert thread 3 is
     `unresolvable`, the other 9 polled normally, and
     `consecutive_cycle_failures` is 0.
   - **Re-arm:** `--rearm all` returns an `unresolvable` row with a non-NULL
     `thread_id` to `open` with `poll_failures = 0`, and leaves a row whose
     `sent_message_id` is `smtp-1234567890` (NULL `thread_id`) `unresolvable`.
3d. **The 3-cycle alarm fires across process boundaries, which is blocker 3 in
   test form.** Run three separate cycles, each with a fresh `runReplyCycle`
   call against the same on-disk database file (not `:memory:`, which would
   share nothing between runs the way separate processes do not), each failing
   cycle-wide. Assert **exactly one** notification, on the third. Then a fourth
   failing cycle: assert **still exactly one** (`failure_notified_at` suppresses
   it). Then a successful cycle, then three more failures: assert a **second**
   notification. **Mutation:** hold the counter in a module-level variable
   instead of `reply_poll_state`; the test must go red with zero notifications.
   Restore.
3e. **Lease test.** Take the lease, then call `runReplyCycle` again on the same
   database: assert it exits 0, makes **zero** API calls, and does not touch
   `consecutive_cycle_failures`. Then advance the injected `now` past
   `lock_expires_at` and assert the next cycle runs.
4. **Idempotency and notification-exactly-once tests.** Poll the same thread twice
   with the same fixture and assert exactly one `replies` row (the
   `UNIQUE(gmail_message_id)` guarantee plus `DO NOTHING`) and exactly one
   notification. Then a crash test: make `channel.notify` throw after the row is
   inserted, assert `notified_at` is still NULL, re-run, and assert exactly one
   notification total across both runs and `notified_at` now set.
4a. **Coalescing and the name cap.** One cycle finding 3 human replies sends
   **one** message naming all three. One cycle finding 4 bounces on one draft
   sends **one** message, not four (the MTA case: several DSNs, several
   `gmail_message_id`s, one draft). A cycle finding both sends exactly two.
   A cycle finding 12 human replies sends **one** message naming 5 and carrying
   `and 7 more`, and **all 12 rows have `notified_at` set** afterwards, so the
   next cycle sends nothing. **Two mutations:** (a) drop the `and N more` tail,
   and confirm the tail assertion goes red while the count assertion stays green,
   which is why both are asserted; (b) set `notified_at` only on the 5 named
   rows, and confirm the "next cycle sends nothing" assertion goes red. Mutation
   (b) is the important one: it is the bug that turns a readability cap into a
   permanent notification loop.
5. **Privacy regression test, mutation-verified.** A fixture thread whose raw API
   response carries both a `snippet` and a body payload, asserting that no column
   in `replies`, no column in `sent_threads`, and no emitted log line contains that
   text. Then mutate the adapter to persist the snippet, confirm the test goes red,
   and restore. A privacy test that cannot fail is worthless.
5a. **The error-object leak.** Assert `console.error(err)` is never reached from
   the replies path: build a `GaxiosError`-shaped object with a `response`
   carrying a `From` header and a `config` carrying a URL, throw it from the
   injected reader, capture the log, and assert the captured text contains
   neither the address nor `googleapis.com`. Verified basis: `console.error(e)`
   appends own enumerable properties to the stack; `console.error(e.stack)` does
   not.
6. **Non-Gmail id guard.** A fixture `sentId` of `smtp-1234567890` and one
   containing `@` both land in `unresolvable` and cause zero API calls.
7. **Send-path safety test, with the real trigger named and a third assertion.**
   The earlier draft said to trigger this with "a duplicate `thread_id` from two
   `--to-self` sends", which is **dead**: Change 3 removed the UNIQUE on
   `thread_id`, so that insert no longer throws and the test could never fail.
   The throws that actually remain on `recordSentThread` are a primary-key
   collision on `draft_id` (suppressed by `ON CONFLICT`, so not this either), a
   **foreign-key violation** on `person_id` or `draft_id` (`foreign_keys = ON`,
   set in `db.ts:18`), **`SQLITE_BUSY`** from the concurrent batch or listener
   process, `SQLITE_READONLY`, and `no such table` on a stale connection, which
   is the case Deploy step 3 exists to prevent and is the most likely one in
   practice.

   Test it at the seam rather than by contriving a database fault: make
   `recordSentThread` throw and assert **three** things. Note that
   `performApprovedSend` is **not exported** (`loop.ts:137`), so the send is
   driven through `handleReply` (`loop.ts:243`, exported, and already driven this
   way nineteen times in `test/send-path.test.ts`), and that there is no deps
   seam for `recordSentThread` either: it is a static import. Use `vi.mock` on
   `src/pipeline/sentThreads.js`, or add an optional `recordSentThread` field to
   `ReplyDeps` (`loop.ts:62`). The plan names both. Assert:
   1. the draft is `sent`,
   2. the `sent` event is present,
   3. **no `send_failed` event was written and no `... failed to send` notify was
      emitted.**

   The third assertion is the one that matters and the earlier draft omitted it.
   In `loop.ts` the network `try` spans **224-232** and covers `sender.send`,
   `markSent` and the SENT notify; a `recordSentThread` placed inside it would
   land in the catch at **:233**, which calls `markSendFailed` and texts "failed to
   send" **for an email that went out**. Assertions 1 and 2 both stay green in
   that arrangement, because the `markSent` transaction already committed. Only
   assertion 3 goes red. **Mutation:** move the `recordSentThread` call inside
   the try; confirm assertion 3 goes red while 1 and 2 stay green; restore. Then
   the second mutation: move `recordSentThread` **into** `markSent`'s
   transaction and confirm assertions 1 and 2 go red. This is the whole reason
   for Change 2's split.
8. **Tapback safety, in two parts, because the existing test cannot cover this
   feature.**
   - Add `src/pipeline/replies.ts` to `test/notify-tapback-safety.test.ts:21`'s
     `SOURCES`. Necessary but **not sufficient**: that test's predicate is
     `/notify\(\s*\n?\s*`\$\{[A-Za-z.]*[sS]hortId\}:/`, which only matches an
     **inline template literal at a `notify(` call site**. Every notification
     here comes from a coalescing formatter passed to `notify` as a variable, so
     the scan is structurally blind to it and would pass whatever the formatter
     returned.
   - **Add a direct unit test on the formatter.** Table-driven over all six
     formats (one reply, several replies, one bounce, several bounces, the
     `and N more` tail, the persistent-failure line), asserting
     `/^\s*(d\d+):/.test(output) === false` for each. **Mutation:** change the
     one-reply format to `` `${shortId}: reply from ${name}` ``. The direct test
     must go red; note in the plan that the SOURCES scan does **not**, which is
     the demonstration that listing the file was never enough.
   - **Tapback hint:** a thumbs up on a `Reply from ...` message produces a hint
     message, not silence and not an approval. **Mutation:** remove the
     `replyNoticeTapbackHint` branch; assert the hint test goes red and the
     "never becomes an approval" test stays green.

Mutate each guard in 3a, 3b, 3c, 3d, 4a, 5, 5a, 6, 7 and 8, confirm red, restore.
A regression test that cannot fail is worthless, and three of the tests in the
earlier draft of this section could not fail: 2b, 7, and half of 8.

## Rollback

Four failures need a stated recovery. One is not obvious, one is destructive,
and two were missing entirely from the earlier draft: a watch set that has gone
`unresolvable`, and the whole-feature removal, which claimed something false.

**If the read scope breaks the send token.** `GMAIL_OAUTH_REFRESH_TOKEN` is
untouched by design, so this should be impossible, but the two ways to cause it
by hand are (a) pasting the metadata token over it, following
`gmail-auth.ts:52`'s current output, and (b) revoking the app at
`myaccount.google.com/permissions`, following `gmail-auth.ts:47`'s current
advice. Change 1 fixes both messages. If it happens anyway, recovery is: re-run
`scripts/gmail-auth.ts` with the default `gmail.send` scope and paste the result
back into `GMAIL_OAUTH_REFRESH_TOKEN`.

**Recovering a watch set that has gone `unresolvable`.** Under Change 4's
failure taxonomy this should now be reachable only one thread at a time, but the
recovery must exist because the earlier design could reach it wholesale and
terminally. Diagnose first, then re-arm:

```sql
-- How bad, and was it wholesale (a taxonomy bug) or scattered (real 404s)?
SELECT watch_state, count(*), min(last_polled_at), max(last_polled_at)
  FROM sent_threads GROUP BY watch_state;
```

If a large number went `unresolvable` inside one window, the classifier let a
cycle-wide failure through as thread-scoped, which is a code bug, not an
operational one: fix it before re-arming, or the next outage repeats it. Then
`outreach replies --rearm all`, which returns every `unresolvable` row with a
non-NULL `thread_id` to `open` at `poll_failures = 0` and stamps `rearmed_at`.
Rows whose `sent_message_id` is not Gmail-shaped stay `unresolvable`, correctly.
Nothing is lost by re-arming: the polls are idempotent and `replies` is keyed on
`gmail_message_id`.

**If `reply_poll_state`'s lease is stuck.** A process killed hard between taking
the lease and its `finally` leaves `lock_expires_at` in the future, and every
cycle exits 0 for up to 15 minutes. That is the designed behavior and it clears
itself. If it does not (a clock jump backwards), clear it by hand:
`UPDATE reply_poll_state SET lock_pid = NULL, lock_expires_at = NULL WHERE id = 1;`

**Recovering the approvals burned during a scope outage.** This is the expensive
one. `performApprovedSend` (`loop.ts:137-240`) commits `beginSendAttempt`
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
`GMAIL_OAUTH_READ_REFRESH_TOKEN`, revoke the metadata grant, and restart the
listener (`npx tsx scripts/check-listener-fresh.ts --restart`) so it stops
running the reverted code. The three new tables can be left in place: nothing
else reads them, and `openDb` will keep creating them until the `CREATE TABLE`
statements are removed from `schema.sql`.

**The earlier draft then said "`drafts`, `draft_events` and the send path are
unmodified by this change, so there is nothing else to undo." That is false and
it contradicts Change 2 on the same page.** Change 2 widens `Sender.send`'s
return type, changes `markSent`'s signature to take a fourth parameter, and adds
a `recordSentThread` call after both of its call sites (`loop.ts:226`,
`cli.ts:412`). `draft_events` is also modified in content: `sent` events written
after this change carry a `threadId` field the earlier ones do not. What is true,
and is what the claim was reaching for:

- **The send path's control flow and its safety properties are unchanged.**
  `beginSendAttempt`'s conditional UPDATE, `decide`'s `UNIQUE(draft_id)`,
  `loadApprovedSend`'s five refusals, `assertSafeOutbound`, and the
  `markSent` transaction all behave identically. Nothing new can abort a send,
  and nothing new can cause one.
- **The reverts are additive and independently safe.** Dropping the fourth
  parameter, narrowing the return type, and deleting the `recordSentThread`
  calls each compile on their own, because the parameter and the field are both
  optional.
- **The `threadId` on historical `sent` events stays.** `draft_events` is
  append-only; an extra JSON key on 56 rows is inert and every reader tolerates
  its absence already.

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
reason measured in the Problem section: **14** of the 56 sent drafts have no rows
left in `intersections` at all as of 2026-08-04 21:03, it was 15 earlier the same
day, and the two sources disagree on both tier mix and hook provenance. That the
number moves within a day is itself the argument.

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
- **The refresh token may be on a 7 day clock, and the three explanations are not
  equally good news.** An **external** user type in **Testing** publishing status
  is issued refresh tokens that expire after 7 days, which would silently kill
  `GMAIL_OAUTH_READ_REFRESH_TOKEN` every week. Measured counter-evidence (a send
  token unchanged since 2026-07-19 that still worked on 2026-08-04, 16 days
  later) rules that configuration out, but it does **not** pick between the
  three that remain, and the earlier draft treated "published" as the answer
  without noticing what that implies:
  - **Internal user type.** ASU is a Google Workspace organization. An Internal
    consent screen has no 7-day expiry, no verification requirement, and no
    unverified-app interstitial. **This is the only configuration in which the
    restricted `gmail.metadata` grant is straightforward.**
  - **External + Published (unverified).** No 7-day expiry, but this is the
    configuration in which a restricted scope is **hardest** to obtain: an
    unverified published app requesting a restricted scope hits Google's
    strictest gate. The earlier draft leaned on "published" as reassurance while
    Verification 0 depends on the opposite being true.
  - **External + Testing, owner account.** Possible, not documented clearly
    enough to rely on.

  Verification 0b resolves it and must run **before** Verification 0, because it
  changes what 0 is likely to find. If a 7-day clock does turn out to apply, the
  mitigation is to publish to Production or accept a weekly re-consent, and in
  either case the job must notify on an `invalid_grant` rather than fail
  silently. Under Change 4's taxonomy an `invalid_grant` is cycle-wide, so it
  raises the 3-cycle alarm rather than destroying the watch set, which is the
  whole reason that taxonomy exists.
- **The two most dangerous bugs in this feature are both silent, and both are
  now tested for explicitly.** An ISO-Z `next_poll_at` and a cycle-wide failure
  counted per thread each produce a poller that reports nothing while appearing
  healthy: no error, no failed cycle, no notification. There is no operational
  signal that distinguishes either from "nobody has replied yet", which is the
  expected state for weeks at a time. Verifications 3a and 3c exist because this
  class of failure cannot be caught by watching.
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
- **Early zeros are not evidence.** The oldest send is about 7.7 days old, and
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
  reply rate could produce several notifications in one cycle. Coalescing
  **plus** the 5-name cap with an `and N more` tail (Change 6) is the mitigation.
  Coalescing alone was not enough: it bounds the message count and says nothing
  about the length of one, so a burst day would have produced a single text
  listing thirty names. The earlier draft also did not coalesce bounces at all,
  even though MTAs routinely emit several DSNs per message.
- **A stale long-lived process is a failure mode with no test coverage by
  construction.** Every test in this suite runs against files on disk; the
  listener runs against whatever it compiled at startup, days ago. This has
  already caused one silent shipping failure in this repo (2026-08-04, the
  address-correction probe). Deploy step 3 is the mitigation and it is manual.
  The residual risk is that someone merges a change to `performApprovedSend`
  later and does not run it.

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
  covers. `strandedReport` (`seenLedger.ts:185-202`) surfaces the
  `abandoned after%`, `ambiguous orphan drafts%`, `awaiting address correction%`
  and `address correction not yet requested%` reasons. Measured 2026-08-04 21:03
  against those exact four patterns: **5 of 276** `drafted_unsendable` rows are
  surfaced and **271 are not**. The earlier draft said "the other roughly 250",
  which understated the invisible set and implied the surfaced set was larger
  than five. All five surfaced rows are address-correction rows created today;
  before that feature shipped the count was zero. Changing this is not this
  spec's business, but the number should be stated correctly.
