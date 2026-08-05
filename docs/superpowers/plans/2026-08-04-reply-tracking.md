# Reply Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The system has sent 56 real cold emails and has no mechanism of any kind for learning whether one of them was answered. Give it one: a second read-only OAuth token bound to `gmail.metadata`, a `threadId` captured at send time and backfilled for the 56, an age-tiered thread poller on its own launchd job, and exactly one iMessage per real human reply. The read path must be structurally incapable of returning a message body, and nothing in it may weaken, slow, or add a failure mode to the send path.

**Architecture:** A new module `src/pipeline/replies.ts` owns one cycle: take a lease, adopt orphaned sends from `draft_events` with zero API calls, select due threads, `await` one `threads.get` per thread, project the response down to `{ id, threadId, internalDate, headers }` at the adapter boundary, then commit one synchronous transaction per thread. Three new tables: `sent_threads` (the watch set and its polling state), `replies` (the observations, keyed on `gmail_message_id`), and `reply_poll_state` (a singleton carrying the run lease and the cross-process failure counter, because the job is a fresh short-lived process every cycle). The send path gains exactly two things: an optional `threadId` on `Sender.send`'s return, and a best-effort `recordSentThread` call placed **after** `performApprovedSend`'s network try/catch closes.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 (synchronous), vitest, tsx, googleapis. Spec: `docs/superpowers/specs/2026-08-04-reply-tracking-design.md`.

## Global Constraints

- **ESM with explicit `.js` import extensions.** `import { x } from './foo.js'` even though the file is `foo.ts`. No exceptions.
- **Baseline: 50 test files, 633 tests, 631 passing, 2 failing.** Measured 2026-08-04 21:04 with `npx vitest run --reporter=dot 2>&1 | tail -5`. **The 2 failures are pre-existing and unrelated**: both are in `test/draft.test.ts`, under `stripTrailingSignoff handles an inline sign-off`. Do NOT fix them in this plan and do NOT treat them as breakage you caused. The target after each task is "633 + N tests, the same 2 failures, no new ones". If a third failure appears, or if either of those two disappears, stop and find out why.
- **ONE timestamp format, everywhere.** `YYYY-MM-DD HH:MM:SS` UTC, exactly what `datetime('now')` emits. Never `Date#toISOString()` directly into a column. Measured on this machine: `SELECT '2026-08-04T10:00:00Z' <= datetime('now')` returns **0** while `SELECT '2026-08-04 10:00:00' <= datetime('now')` returns **1**, because SQLite compares TEXT bytewise and `T` (0x54) sorts above space (0x20). An ISO-Z `next_poll_at` makes every row permanently not-yet-due, and the poller goes silent after one cycle with no error. `julianday()` parses both forms identically (`2461256.91666667` for each), so any cadence test written with `julianday` passes under the bug.
- **A cycle-wide failure must NEVER touch `sent_threads.poll_failures`.** An expired token, a 429, a 5xx or a `SQLITE_BUSY` hits every selected row at once. Five such cycles under a naive counter marks the entire watch set `unresolvable`. Only a 404 or a per-thread 4xx may increment.
- **Every insert that runs on repeat data is conflict-ignoring.** `replies` gets `ON CONFLICT(gmail_message_id) DO NOTHING`; the adopt gets `ON CONFLICT(draft_id) DO NOTHING`. An auto-reply keeps its thread `open` by design, so the same `gmail_message_id` is seen every cycle forever. A plain INSERT throws inside the per-thread transaction, rolls back `next_poll_at` with it, and blinds the thread in five cycles.
- **No message this plan adds may begin with `dN:`.** `draftIdFromReactedText` (`photonChannel.ts:135-138`) turns any message whose text starts `/^\s*(d\d+):/` into a tapback-approvable draft. `dN ` followed by anything other than a colon is safe.
- **`test/notify-tapback-safety.test.ts` cannot catch this feature's formats.** Its predicate is `/notify\(\s*\n?\s*`\$\{[A-Za-z.]*[sS]hortId\}:/`, which matches only an INLINE template literal at a `notify(` call site. Every notification here comes from a formatter passed as a variable. Adding `src/pipeline/replies.ts` to its `SOURCES` is necessary and **not sufficient**; Task 4 adds a direct unit test on the formatter.
- **`better-sqlite3` is synchronous.** No `await` inside a `db.transaction(...)` body. Awaits happen between transactions, never inside one.
- **Error logging is `err.message` only.** Never `console.error(err)`. Verified on Node 24: `console.error(e)` appends own enumerable properties, so a `GaxiosError`'s `response.headers` (containing `From` addresses under `format=metadata`) and `config.url` land in the log. `console.error(e.stack)` does not.
- **A regression test that cannot fail is worthless.** Every task's mutate step is mandatory. Three checks in the previous draft of the spec could not fail; do not add a fourth.
- **Run the full suite and `npm run typecheck` before each commit.** Commit after every task, no batching.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/db/time.ts` (new) | `toSqlTime`, `fromInternalDate`, `addHours` | 1 |
| `src/db/schema.sql` | `sent_threads`, `replies`, `reply_poll_state` | 1 |
| `src/sender/gmailReader.ts` (new) | `GmailReader` seam, boundary projection, error classification | 2 |
| `src/pipeline/replyClassify.ts` (new) | RFC 5322 mailbox extraction, `human`/`auto_reply`/`bounce` | 3 |
| `src/approval/channel.ts` | notification formatters, coalescing, name cap, `replyNoticeTapbackHint` | 4 |
| `src/approval/photonChannel.ts` | hint branch for a tapback on a reply notification | 5 |
| `src/pipeline/sentThreads.ts` (new) | `recordSentThread`, `adoptOrphanedSends`, Gmail-shape guard, cadence | 6 |
| `src/sender/types.ts`, `src/sender/gmail-api.ts`, `src/approval/ledger.ts`, `src/pipeline/loop.ts`, `src/cli.ts` | widen the sender seam, `markSent`'s 4th param, both call sites | 7 |
| `src/pipeline/replyState.ts` (new) | lease, failure taxonomy, `consecutive_cycle_failures`, the alarm | 8 |
| `src/pipeline/replies.ts` (new) | `runReplyCycle`, the per-thread transaction, notification delivery | 9 |
| `src/cli.ts` | `cmdReplies`, flags, hardened top-level catch | 10 |
| `scripts/gmail-auth.ts` | optional scope argument, scope-following output, safer advice | 11 |
| `scripts/com.aditya.outreach-replies.plist` (new) | the third launchd job | 12 |
| (none) | live demonstration | 13 |

**Dependency order.** 1 → 6, 8. 4 → 5, 9. 6 → 7, 9. 1, 2, 3, 4, 6, 8 → 9. 9 → 10 → 12 → 13.

**Parallel waves:**
- **Wave A (no dependencies):** Tasks 1, 2, 3, 4, 11.
- **Wave B (needs A):** Task 5 (needs 4), Task 6 (needs 1), Task 8 (needs 1).
- **Wave C (needs B):** Task 7 (needs 6), Task 9 (needs 1, 2, 3, 4, 6, 8).
- **Wave D (needs C):** Task 10 (needs 9).
- **Wave E (serial, live):** Task 12 (needs 10), then Task 13.

**Tasks that CANNOT run offline and need live Google credentials:**
- **Task 11's Step 6** (minting a real `gmail.metadata` refresh token) and **spec Verifications 0, 0b, 0c**. Everything else in Task 11 is offline.
- **Task 12** (loading a launchd job on this machine).
- **Task 13** entirely.

Everything in Tasks 1 through 10 runs offline against an injected `GmailReader`. **No test in this plan may touch the network.** If a test needs a real Gmail response, it needs a fixture instead.

**Do spec Verifications 0b, then 0, then 0c BEFORE starting Task 1.** If Google refuses to grant `gmail.metadata` to this OAuth client, Tasks 2, 9, 12 and 13 are all blocked and the spec needs revision rather than a workaround. Verification 0b (the console's user type) comes first because it changes what 0 is likely to find: an **Internal** consent screen makes a restricted scope straightforward, while **External + Published (unverified)** makes it hardest.

If you work in a git worktree, `git merge main` FIRST and re-measure the baseline.

---

### Task 1: The canonical timestamp and the three tables

**Why:** This is the foundation everything else writes through, and it is where the single most dangerous bug in the feature lives. The spec's earlier draft said to store `received_at` "as an ISO UTC string to match every other timestamp in the schema". No other timestamp in this schema is ISO-Z: every one is `datetime('now')`, space-separated, no `Z`. Written the ISO way, `next_poll_at <= datetime('now')` is false forever for any past due time, the poller stops after one cycle, and there is no error, no failed cycle and no notification to tell anyone.

**Files:**
- Create: `src/db/time.ts`
- Modify: `src/db/schema.sql`
- Test: `test/reply-time.test.ts` (new)

**Interfaces produced:**

```ts
export function toSqlTime(d: Date): string;
export function fromInternalDate(internalDateMs: string): string;
export function addHours(from: Date, hours: number): string;
export const SQL_TIME_SHAPE: RegExp;   // /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
```

- [ ] **Step 1: Write the failing tests**

Create `test/reply-time.test.ts`:

```ts
// The bug this file exists to make impossible, measured on this machine
// 2026-08-04 against the live database:
//
//   sqlite> SELECT '2026-08-04T10:00:00Z' <= datetime('now'),
//      ...>        '2026-08-04 10:00:00'  <= datetime('now'), datetime('now');
//   0|1|2026-08-04 21:03:34
//
// A due time eleven hours in the past compares as NOT YET DUE in the ISO-Z
// form, because SQLite compares TEXT bytewise and 'T' (0x54) sorts above ' '
// (0x20). Written that way, next_poll_at <= datetime('now') is false forever,
// every row is selected exactly once from its DEFAULT and never again, and the
// poller goes permanently silent with no error and no notification.
//
// julianday() parses BOTH forms identically (2461256.91666667 for each), so a
// cadence test written with julianday passes under the bug and proves nothing.
// The round-trip test below therefore uses the REAL selection query.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { toSqlTime, fromInternalDate, addHours, SQL_TIME_SHAPE } from '../src/db/time.js';

describe('the one canonical timestamp form', () => {
  it('emits the datetime(\'now\') shape, with no T and no Z', () => {
    const s = toSqlTime(new Date(Date.UTC(2026, 7, 4, 10, 0, 0)));
    expect(s).toBe('2026-08-04 10:00:00');
    expect(SQL_TIME_SHAPE.test(s)).toBe(true);
    expect(s).not.toContain('T');
    expect(s).not.toContain('Z');
  });

  it('converts Gmail internalDate epoch milliseconds', () => {
    // internalDate arrives as a STRING of epoch ms, not a number.
    expect(fromInternalDate('1785931200000')).toBe(toSqlTime(new Date(1785931200000)));
    expect(SQL_TIME_SHAPE.test(fromInternalDate('1785931200000'))).toBe(true);
  });

  it('addHours stays in the canonical form across a day boundary', () => {
    expect(addHours(new Date(Date.UTC(2026, 7, 4, 22, 0, 0)), 4)).toBe('2026-08-05 02:00:00');
  });

  // THE test. Not julianday, not a shape check: the real predicate the poller
  // uses to decide what is due. This is the only assertion that can catch the
  // ISO-Z bug end to end.
  it('a past due time actually selects, through the real query', () => {
    const db = openDb(':memory:');
    const past = toSqlTime(new Date(Date.now() - 3600_000));
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, sent_at, next_poll_at)
       VALUES (1, 1, 'abc123', ?, ?)`,
    ).run(past, past);
    const due = db
      .prepare("SELECT draft_id FROM sent_threads WHERE watch_state = 'open' AND next_poll_at <= datetime('now')")
      .all();
    expect(due).toHaveLength(1);
  });

  it('a future due time does not select, so the predicate is not vacuously true', () => {
    const db = openDb(':memory:');
    const now = toSqlTime(new Date());
    const future = toSqlTime(new Date(Date.now() + 3600_000));
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, sent_at, next_poll_at)
       VALUES (1, 1, 'abc123', ?, ?)`,
    ).run(now, future);
    expect(
      db.prepare("SELECT draft_id FROM sent_threads WHERE watch_state = 'open' AND next_poll_at <= datetime('now')").all(),
    ).toHaveLength(0);
  });
});

describe('the three new tables reach a live database', () => {
  it('creates all three, and reply_poll_state has exactly one row', () => {
    const db = openDb(':memory:');
    const names = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    expect(names.has('sent_threads')).toBe(true);
    expect(names.has('replies')).toBe(true);
    expect(names.has('reply_poll_state')).toBe(true);
    expect((db.prepare('SELECT count(*) AS n FROM reply_poll_state').get() as { n: number }).n).toBe(1);
  });

  it('is idempotent, because openDb execs schema.sql on EVERY open', () => {
    const db = openDb(':memory:');
    // Simulate the second open on a live file: re-running the singleton insert
    // must not produce a second row or throw.
    db.exec("INSERT OR IGNORE INTO reply_poll_state (id) VALUES (1)");
    expect((db.prepare('SELECT count(*) AS n FROM reply_poll_state').get() as { n: number }).n).toBe(1);
  });

  it('rejects a second reply row for the same gmail_message_id', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO replies (draft_id, person_id, gmail_message_id, thread_id, from_address, received_at, kind)
       VALUES (1, 1, 'msg1', 't1', 'a@b.edu', '2026-08-04 10:00:00', 'human')
       ON CONFLICT(gmail_message_id) DO NOTHING`,
    );
    expect(ins.run().changes).toBe(1);
    expect(ins.run().changes).toBe(0);   // a repeat sighting is a NO-OP, not a throw
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/reply-time.test.ts`
Expected: FAIL, cannot resolve `../src/db/time.js`, and `no such table: sent_threads`.

- [ ] **Step 3: Create `src/db/time.ts`**

```ts
// The ONE timestamp format this codebase stores. Everything already in the
// schema is datetime('now'), which is 'YYYY-MM-DD HH:MM:SS' UTC: a space
// separator, no T, no Z, no fractional seconds, no offset.
//
// Getting this wrong does not throw and does not fail a test that uses
// julianday(). Measured on this machine 2026-08-04:
//
//   SELECT '2026-08-04T10:00:00Z' <= datetime('now')  ->  0
//   SELECT '2026-08-04 10:00:00'  <= datetime('now')  ->  1
//   SELECT julianday('2026-08-04T10:00:00Z')          ->  2461256.91666667
//   SELECT julianday('2026-08-04 10:00:00')           ->  2461256.91666667
//
// SQLite compares TEXT bytewise. 'T' is 0x54, ' ' is 0x20, so an ISO-Z string
// sorts ABOVE datetime('now') for every hour of the same day, a past due time
// reads as not-yet-due forever, and the poller stops after one cycle in total
// silence. julianday parses both, which is why the round-trip test in
// test/reply-time.test.ts runs the real selection query instead.
export const SQL_TIME_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function toSqlTime(d: Date): string {
  // toISOString is always UTC and always 'YYYY-MM-DDTHH:mm:ss.sssZ'. Slicing at
  // 19 drops '.sssZ'; replacing 'T' gives the datetime('now') form exactly.
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Gmail hands internalDate back as a STRING of epoch milliseconds, not a
// number. It is Gmail's own receive time; the Date: header is written by the
// sender's mail client and is routinely wrong by hours or years, and
// time-to-reply is one of the metrics this feature exists to produce.
export function fromInternalDate(internalDateMs: string): string {
  return toSqlTime(new Date(Number(internalDateMs)));
}

// Cadence arithmetic lives here rather than in SQL's datetime('now', '+4
// hours') because the cycle injects `now` so the age tiers and the 60 day close
// are testable without waiting. Both mistakes have already been made and fixed
// once in listen.ts.
export function addHours(from: Date, hours: number): string {
  return toSqlTime(new Date(from.getTime() + hours * 3600_000));
}
```

- [ ] **Step 4: Append the three tables to `src/db/schema.sql`**

Append at the end of the file, after the `seen_papers` indexes. Copy the DDL from the spec's Change 3 verbatim, comments included: they carry the reason each column exists and the reason its format is not negotiable. In particular keep the comment on `next_poll_at` about the ISO-Z hazard and the comment on `poll_failures` about thread-scope versus cycle-scope, because those are the two blockers this schema encodes.

`openDb` (`db.ts:19`) execs this file on every open and `CREATE TABLE IF NOT EXISTS` reaches a live database, so no guarded ALTER is needed. The guarded-ALTER hazard documented in `db.ts:24-37` applies only to new **columns on existing tables**, which this task does not add. `INSERT OR IGNORE INTO reply_poll_state (id) VALUES (1)` is likewise idempotent on every open.

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/reply-time.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → 641 tests, still exactly 2 failures, both in `test/draft.test.ts`
Run: `npm run typecheck`

- [ ] **Step 6: Mutate to prove the tests can fail**

**Mandatory, and this is the single most important mutation in the plan.** Change `toSqlTime` to `return d.toISOString();`.

Confirm: the shape test goes RED **and** `a past due time actually selects` goes RED. If only the shape test goes red, the round-trip test is not running the real query and must be fixed before continuing. Then, to see the trap for yourself, temporarily rewrite the round-trip assertion to use `julianday(next_poll_at) <= julianday('now')` and confirm it goes GREEN under the broken `toSqlTime`. That is the test that would have shipped this bug. Restore both.

- [ ] **Step 7: Commit**

```bash
git add src/db/time.ts src/db/schema.sql test/reply-time.test.ts
git commit -m "Add the reply-tracking tables and one canonical SQL timestamp form"
```

---

### Task 2: The `GmailReader` seam and the boundary projection

**Why:** This is where the privacy line is enforced as code structure rather than as discipline, and it is where a failure gets classified before anything downstream can mis-attribute it. Everything above this layer sees `{ id, threadId, internalDate, headers }` and cannot see a body or a snippet even if it tries. `gmail.metadata` also makes this enforceable by Google: it is structurally incapable of returning a body, so even a buggy implementation cannot fetch a researcher's reply text.

**Files:**
- Create: `src/sender/gmailReader.ts`
- Test: `test/gmail-reader.test.ts` (new)

**Interfaces produced:**

```ts
export interface ThreadMessage {
  id: string;
  threadId: string;
  internalDate: string;
  headers: Record<string, string>;   // lowercased names, ONLY the five requested
}
export interface GmailReader {
  threadIdForMessage(messageId: string): Promise<string | null>;
  getThreadMetadata(threadId: string): Promise<ThreadMessage[]>;
}
export type FailureScope = 'thread' | 'cycle';
export function classifyFailure(err: unknown): FailureScope;
export function projectMessage(raw: unknown): ThreadMessage | null;
export function createGmailReader(opts?: { clientId?: string; clientSecret?: string; refreshToken?: string }): GmailReader;
export const METADATA_HEADERS: readonly string[];
```

- [ ] **Step 1: Write the failing tests**

Create `test/gmail-reader.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { projectMessage, classifyFailure, METADATA_HEADERS } from '../src/sender/gmailReader.js';

// Whether Gmail returns a snippet under format=metadata is ASSUMED, not
// documented: no Google documentation says so either way. The design behaves as
// though one is always present. This fixture therefore carries a snippet AND a
// body payload, so the test does not depend on the assumption either.
const RAW = {
  id: '19fca6e82b8956ad',
  threadId: '19fca6e82b8956aa',
  internalDate: '1785931200000',
  snippet: 'Thanks Aditya, I would be glad to chat about the olfactory work',
  labelIds: ['INBOX', 'IMPORTANT'],
  sizeEstimate: 4821,
  payload: {
    mimeType: 'text/plain',
    body: { size: 812, data: 'SSB3b3VsZCBiZSBnbGFkIHRvIGNoYXQ=' },
    headers: [
      { name: 'From', value: 'Daniel Kepple <dkepple@example.edu>' },
      { name: 'Date', value: 'Tue, 4 Aug 2026 10:00:00 -0700' },
      { name: 'Subject', value: 'Re: your work on olfactory embeddings' },
      { name: 'Auto-Submitted', value: 'no' },
      { name: 'To', value: 'apgupta3@asu.edu' },
    ],
  },
};

describe('the boundary projection', () => {
  it('returns only id, threadId, internalDate and headers', () => {
    const m = projectMessage(RAW)!;
    expect(Object.keys(m).sort()).toEqual(['headers', 'id', 'internalDate', 'threadId']);
  });

  // THE privacy assertion. Serialize the whole projection and assert the
  // researcher's text is nowhere in it, rather than checking field by field:
  // a field-by-field check passes if a sixth field is added later.
  it('carries no snippet, no body, no subject, and no label anywhere in it', () => {
    const serialized = JSON.stringify(projectMessage(RAW));
    expect(serialized).not.toContain('glad to chat');
    expect(serialized).not.toContain('SSB3b3VsZCBiZSBnbGFk');
    expect(serialized).not.toContain('olfactory embeddings');
    expect(serialized).not.toContain('IMPORTANT');
    expect(serialized).not.toContain('snippet');
  });

  it('lowercases header names and keeps ONLY the five requested', () => {
    const m = projectMessage(RAW)!;
    expect(m.headers.from).toBe('Daniel Kepple <dkepple@example.edu>');
    expect(m.headers['auto-submitted']).toBe('no');
    // Requested but absent on this message: simply not present, not undefined-y.
    expect(Object.keys(m.headers).sort()).toEqual(['auto-submitted', 'date', 'from']);
    // Present on the wire and deliberately dropped.
    expect(m.headers.subject).toBeUndefined();
    expect(m.headers.to).toBeUndefined();
  });

  it('drops a message missing the fields the poller cannot work without', () => {
    expect(projectMessage({ threadId: 't', internalDate: '1' })).toBeNull();
    expect(projectMessage({ id: 'a', threadId: 't' })).toBeNull();
    expect(projectMessage(null)).toBeNull();
  });

  it('requests exactly the five headers the classifier needs', () => {
    expect([...METADATA_HEADERS].sort()).toEqual(
      ['Auto-Submitted', 'Date', 'From', 'Precedence', 'X-Autoreply'].sort(),
    );
  });
});

// The blocker-2 classifier. An expired GMAIL_OAUTH_READ_REFRESH_TOKEN, a 429, a
// 5xx or a SQLITE_BUSY hits EVERY selected row in the same cycle. Counting any
// of those against a single thread marks the entire watch set unresolvable in
// five cycles, which at four runs a day is about 30 hours.
describe('failure scope classification', () => {
  const gaxios = (status: number, message = 'boom') => Object.assign(new Error(message), { status });

  it('treats a 404 as thread-scoped: that one thread is gone', () => {
    expect(classifyFailure(gaxios(404))).toBe('thread');
  });

  it('treats an unrelated per-thread 4xx as thread-scoped', () => {
    expect(classifyFailure(gaxios(400))).toBe('thread');
  });

  it('treats auth, rate limit and server failures as CYCLE-scoped', () => {
    for (const s of [401, 403, 429, 500, 502, 503]) {
      expect(classifyFailure(gaxios(s))).toBe('cycle');
    }
    expect(classifyFailure(new Error('invalid_grant'))).toBe('cycle');
    expect(classifyFailure(Object.assign(new Error('db is locked'), { code: 'SQLITE_BUSY' }))).toBe('cycle');
    expect(classifyFailure(Object.assign(new Error('readonly'), { code: 'SQLITE_READONLY' }))).toBe('cycle');
    expect(classifyFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe('cycle');
  });

  // The safe direction: stop the run and raise the alarm, rather than quietly
  // blaming whichever thread happened to be in hand for an unknown fault.
  it('treats an unclassifiable throw as cycle-scoped', () => {
    expect(classifyFailure(new Error('who knows'))).toBe('cycle');
    expect(classifyFailure('a string')).toBe('cycle');
    expect(classifyFailure(undefined)).toBe('cycle');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/gmail-reader.test.ts`
Expected: FAIL, cannot resolve `../src/sender/gmailReader.js`.

- [ ] **Step 3: Create `src/sender/gmailReader.ts`**

```ts
// The read seam, and the privacy boundary stated as code structure.
//
// Everything above this file sees ThreadMessage and nothing else. It cannot see
// a body, a snippet, a subject, or a label, because they are not in the type
// and not in the object. That is the whole defence, together with the scope
// itself: gmail.metadata "View your email message metadata such as labels and
// headers, but not the email body" is structurally incapable of returning a
// body, so even a buggy implementation here cannot fetch a researcher's reply
// text. Google enforces it, not our restraint.
//
// This module has NO Sender dependency and must never be given one. It reads
// Gmail; it does not write email of any kind.
import { google } from 'googleapis';

export interface ThreadMessage {
  id: string;
  threadId: string;
  internalDate: string;      // epoch ms, as a string, exactly as Gmail sends it
  headers: Record<string, string>;
}

export interface GmailReader {
  // Do NOT assume the first message in a thread has id == threadId. It is
  // widely observed and nowhere documented, and the check costs 20 quota units.
  threadIdForMessage(messageId: string): Promise<string | null>;
  getThreadMetadata(threadId: string): Promise<ThreadMessage[]>;
}

// The five the classifier in replyClassify.ts needs, and no more. Subject is
// deliberately absent: it is the researcher's text, it is almost always 'Re:'
// our own subject, and it buys nothing.
export const METADATA_HEADERS = ['From', 'Date', 'Auto-Submitted', 'Precedence', 'X-Autoreply'] as const;
const WANTED = new Set(METADATA_HEADERS.map((h) => h.toLowerCase()));

// Project at the boundary, unconditionally. Whether format=metadata actually
// returns a snippet is ASSUMED, not documented, and this drops one either way:
// it costs nothing if the assumption is wrong and is the whole defence if it is
// right.
export function projectMessage(raw: unknown): ThreadMessage | null {
  const m = raw as {
    id?: string; threadId?: string; internalDate?: string;
    payload?: { headers?: { name?: string; value?: string }[] };
  } | null;
  if (!m?.id || !m.threadId || !m.internalDate) return null;
  const headers: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const name = (h.name ?? '').toLowerCase();
    if (WANTED.has(name) && h.value != null) headers[name] = h.value;
  }
  return { id: m.id, threadId: m.threadId, internalDate: m.internalDate, headers };
}

export type FailureScope = 'thread' | 'cycle';

// Blocker 2. A per-thread failure and a cycle-wide one are different animals,
// and the earlier design had one counter for both. An expired refresh token, a
// 429, a 5xx or a SQLITE_BUSY fails EVERY row selected in that cycle at once;
// counting five of those against each row marks the entire watch set
// unresolvable in about 30 hours, and unresolvable had no recovery path.
//
// Only a failure attributable to ONE thread may increment that thread's
// counter. Everything else aborts the cycle without touching any row.
export function classifyFailure(err: unknown): FailureScope {
  const e = err as { status?: number; code?: string | number; message?: string } | null;
  const status = typeof e?.status === 'number' ? e.status : undefined;

  // 404: this thread was deleted. Genuinely about this thread.
  if (status === 404) return 'thread';
  // 401/403 are credentials or scope, 429 is quota: all cycle-wide by nature.
  if (status === 401 || status === 403 || status === 429) return 'cycle';
  if (status !== undefined && status >= 500) return 'cycle';
  // Any other 4xx is a malformed request about this specific id.
  if (status !== undefined && status >= 400) return 'thread';

  const code = typeof e?.code === 'string' ? e.code : '';
  if (code.startsWith('SQLITE_')) return 'cycle';          // BUSY, READONLY, FULL
  if (/^(ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)$/.test(code)) return 'cycle';
  if (typeof e?.message === 'string' && /invalid_grant|invalid_client|unauthorized/i.test(e.message)) return 'cycle';

  // Unknown. Stop the run and raise the alarm rather than blaming whichever
  // thread happened to be in hand. Failing loud beats failing wide.
  return 'cycle';
}

export function createGmailReader(opts?: {
  clientId?: string; clientSecret?: string; refreshToken?: string;
}): GmailReader {
  const clientId = opts?.clientId ?? process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = opts?.clientSecret ?? process.env.GMAIL_OAUTH_CLIENT_SECRET;
  // A SEPARATE token from GMAIL_OAUTH_REFRESH_TOKEN, carrying gmail.metadata
  // only. The read path is structurally unable to send and the send path is
  // structurally unable to read.
  const refreshToken = opts?.refreshToken ?? process.env.GMAIL_OAUTH_READ_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    // Fail loud with the remedy, in the style of createGmailApiSender
    // (gmail-api.ts:33-37). Never degrade to a silent no-op: a reply poller
    // that reports nothing is indistinguishable from nobody having replied.
    throw new Error(
      'GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_READ_REFRESH_TOKEN missing. ' +
        'Run: npx tsx --env-file=.env scripts/gmail-auth.ts --scope=gmail.metadata',
    );
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });

  return {
    async threadIdForMessage(messageId) {
      const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata' });
      return res.data.threadId ?? null;
    },
    async getThreadMetadata(threadId) {
      // users.messages.list explicitly rejects `q` under gmail.metadata
      // ("Parameter cannot be used when accessing the api using the
      // gmail.metadata scope"). This design never needs it: threads.get takes
      // an id, and it touches only threads this system started, so the code
      // never enumerates Aditya's inbox at all.
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: [...METADATA_HEADERS],
      });
      return (res.data.messages ?? []).map(projectMessage).filter((m): m is ThreadMessage => m !== null);
    },
  };
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/gmail-reader.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → still exactly 2 pre-existing failures
Run: `npm run typecheck`

- [ ] **Step 5: Mutate to prove the tests can fail**

Two mutations, both mandatory:
1. Add `snippet: (raw as { snippet?: string }).snippet` to `projectMessage`'s return. Confirm the key-set test and the "no snippet anywhere" test both go RED. Restore.
2. Change `classifyFailure`'s `if (status === 401 || status === 403 || status === 429) return 'cycle';` to `return 'thread';`. Confirm the cycle-scope test goes RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/sender/gmailReader.ts test/gmail-reader.test.ts
git commit -m "Add the gmail.metadata reader seam, its boundary projection, and failure scoping"
```

---

### Task 3: Mailbox extraction and reply classification

**Why:** `From` is an RFC 5322 mailbox, not a bare address. Gmail returns `Aditya Gupta <apgupta3@asu.edu>`, and a naive `header.from !== process.env.SENDER_EMAIL` compare is **always true**, which would classify Aditya's own follow-up in a thread as an inbound reply, notify him about himself, close the thread, and write fabricated ground truth into the exact table the whole evaluation section depends on.

**Files:**
- Create: `src/pipeline/replyClassify.ts`
- Test: `test/reply-classify.test.ts` (new)

**Interfaces produced:**

```ts
export type ReplyKind = 'human' | 'auto_reply' | 'bounce';
export function extractAddress(mailbox: string): string;
export function isOurs(mailbox: string, senderEmail: string): boolean;
export function classifyKind(headers: Record<string, string>): ReplyKind;
```

- [ ] **Step 1: Write the failing tests**

Create `test/reply-classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractAddress, isOurs, classifyKind } from '../src/pipeline/replyClassify.js';

describe('RFC 5322 mailbox extraction', () => {
  it.each([
    ['Aditya Gupta <apgupta3@asu.edu>', 'apgupta3@asu.edu'],
    ['<apgupta3@asu.edu>', 'apgupta3@asu.edu'],
    ['apgupta3@asu.edu', 'apgupta3@asu.edu'],
    ['  apgupta3@asu.edu  ', 'apgupta3@asu.edu'],
    ['"Gupta, Aditya" <apgupta3@asu.edu>', 'apgupta3@asu.edu'],
    // A display name that itself contains angle brackets. Taking the LAST
    // group is what makes this right; taking the first reads the display name.
    ['"a <fake@evil.com>" <real@asu.edu>', 'real@asu.edu'],
  ])('extracts %s', (raw, expected) => {
    expect(extractAddress(raw)).toBe(expected);
  });
});

describe('is this message ours', () => {
  // THE test that stops the system fabricating its own ground truth. Before
  // extraction, `'Aditya Gupta <apgupta3@asu.edu>' !== 'apgupta3@asu.edu'` is
  // true, so every one of Aditya's own follow-ups reads as an inbound reply.
  it('recognises our own mailbox in every shape Gmail sends it', () => {
    for (const raw of [
      'Aditya Gupta <apgupta3@asu.edu>',
      '<APGUPTA3@ASU.EDU>',
      'apgupta3@asu.edu',
      '"Gupta, Aditya" <ApGupta3@Asu.Edu>',
    ]) {
      expect(isOurs(raw, 'apgupta3@asu.edu')).toBe(true);
    }
  });

  it('does not swallow a different address, including a near miss', () => {
    expect(isOurs('Daniel Kepple <dkepple@example.edu>', 'apgupta3@asu.edu')).toBe(false);
    expect(isOurs('<apgupta3@asu.edu.evil.com>', 'apgupta3@asu.edu')).toBe(false);
    expect(isOurs('<notapgupta3@asu.edu>', 'apgupta3@asu.edu')).toBe(false);
  });

  it('compares against SENDER_EMAIL and against nothing else', () => {
    expect(isOurs('<apgupta3@asu.edu>', 'other@gmail.com')).toBe(false);
  });
});

describe('classification, from headers only', () => {
  it('classifies a bounce from the daemon addresses', () => {
    expect(classifyKind({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' })).toBe('bounce');
    expect(classifyKind({ from: '<postmaster@example.edu>' })).toBe('bounce');
    expect(classifyKind({ from: 'MAILER-DAEMON@EXAMPLE.EDU' })).toBe('bounce');
  });

  it('classifies an out-of-office from any of the three signals', () => {
    expect(classifyKind({ from: 'a@b.edu', 'auto-submitted': 'auto-replied' })).toBe('auto_reply');
    expect(classifyKind({ from: 'a@b.edu', precedence: 'bulk' })).toBe('auto_reply');
    expect(classifyKind({ from: 'a@b.edu', 'x-autoreply': 'yes' })).toBe('auto_reply');
  });

  // 'Auto-Submitted: no' is the value a NORMAL message carries. Treating
  // "header present" as auto would classify most real replies as noise and
  // notify about none of them.
  it('does not treat Auto-Submitted: no as an auto-reply', () => {
    expect(classifyKind({ from: 'a@b.edu', 'auto-submitted': 'no' })).toBe('human');
  });

  it('defaults to human', () => {
    expect(classifyKind({ from: 'Daniel Kepple <dkepple@example.edu>' })).toBe('human');
    expect(classifyKind({})).toBe('human');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/reply-classify.test.ts`
Expected: FAIL, cannot resolve `../src/pipeline/replyClassify.js`.

- [ ] **Step 3: Create `src/pipeline/replyClassify.ts`**

```ts
// From is an RFC 5322 mailbox, not a bare address. Gmail returns
// 'Aditya Gupta <apgupta3@asu.edu>', so a naive
// `header.from !== process.env.SENDER_EMAIL` compare is ALWAYS true. That would
// classify Aditya's own follow-up in a thread as an inbound reply, notify him
// about himself, close the thread, and write fabricated ground truth into the
// exact table the whole evaluation section depends on.
export type ReplyKind = 'human' | 'auto_reply' | 'bounce';

// The LAST <...> group, because a display name may legitimately contain angle
// brackets and an adversarial one certainly will:
// '"a <fake@evil.com>" <real@asu.edu>' must yield real@asu.edu.
export function extractAddress(mailbox: string): string {
  const groups = [...mailbox.matchAll(/<([^<>]*)>/g)];
  const raw = groups.length > 0 ? groups[groups.length - 1]![1]! : mailbox;
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

// Case-insensitive on both sides, and compared against SENDER_EMAIL and
// nothing else. If SENDER_EMAIL is unset the CALLER refuses to start rather
// than defaulting, which is why this takes it as a parameter instead of
// reading process.env: a default here would silently make every message
// inbound.
export function isOurs(mailbox: string, senderEmail: string): boolean {
  return extractAddress(mailbox).toLowerCase() === senderEmail.trim().toLowerCase();
}

const AUTO_PRECEDENCE = new Set(['auto_reply', 'bulk', 'junk']);

// Header-only. Misclassification is cheap by construction: it can change a
// notification and a metric slice, never an outbound action, and the row is
// reclassifiable by hand because from_address and kind are both stored.
export function classifyKind(headers: Record<string, string>): ReplyKind {
  const from = extractAddress(headers.from ?? '').toLowerCase();
  if (/^(mailer-daemon|postmaster)@/.test(from)) return 'bounce';

  const autoSubmitted = (headers['auto-submitted'] ?? '').trim().toLowerCase();
  // 'no' is what a normal message carries; presence alone means nothing.
  if (autoSubmitted && autoSubmitted !== 'no') return 'auto_reply';
  if (AUTO_PRECEDENCE.has((headers.precedence ?? '').trim().toLowerCase())) return 'auto_reply';
  if ((headers['x-autoreply'] ?? '').trim().toLowerCase() === 'yes') return 'auto_reply';

  return 'human';
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/reply-classify.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 5: Mutate to prove the tests can fail**

Two mutations:
1. Change `extractAddress` to `groups[0]![1]!`. Confirm the adversarial display-name case goes RED. Restore.
2. Change `if (autoSubmitted && autoSubmitted !== 'no')` to `if (autoSubmitted)`. Confirm `does not treat Auto-Submitted: no as an auto-reply` goes RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/replyClassify.ts test/reply-classify.test.ts
git commit -m "Extract the bare address from an RFC 5322 From, and classify a reply from headers"
```

---

### Task 4: Notification formats, coalescing, the name cap, and the tapback recognizer

**Why:** Two independent problems land here. First, `d19: Daniel Kepple replied` matches `/^\s*(d\d+):/`, which is exactly how `draftIdFromReactedText` (`photonChannel.ts:135-138`) resolves which draft a tapback means, so a thumbs up on good news would decode to `d19 y` and send something. Second, a tapback on a correctly-formatted notification currently produces **total silence**, which is indistinguishable from a dead listener and is the exact failure the needs-address hint branch was added to fix.

These live in `channel.ts` for the same reason `formatNeedsAddressMessage` does: the sender and the reaction decoder both need them and must not drift.

**Files:**
- Modify: `src/approval/channel.ts`
- Test: `test/reply-notify.test.ts` (new)

**Interfaces produced:**

```ts
export interface ReplyNotice { shortId: string; personName: string; ageText: string; }
export const MAX_NAMES_PER_NOTICE = 5;
export function formatHumanReplyNotice(rs: ReplyNotice[]): string;
export function formatBounceNotice(rs: ReplyNotice[]): string;
export function formatPollFailureNotice(cycles: number, message: string): string;
export function replyNoticeTapbackHint(text: string | undefined): string | null;
```

- [ ] **Step 1: Write the failing tests**

Create `test/reply-notify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  formatHumanReplyNotice, formatBounceNotice, formatPollFailureNotice,
  replyNoticeTapbackHint, MAX_NAMES_PER_NOTICE, type ReplyNotice,
} from '../src/approval/channel.js';

const n = (shortId: string, personName: string): ReplyNotice => ({ shortId, personName, ageText: '2h ago' });

// THE safety property. test/notify-tapback-safety.test.ts CANNOT cover this:
// its predicate is /notify\(\s*\n?\s*`\$\{[A-Za-z.]*[sS]hortId\}:/, which
// matches only an INLINE template literal at a notify( call site. Every format
// here is produced by a function and passed to notify as a variable, so that
// scan is structurally blind to it and would pass whatever these returned.
// This is the direct test on the formatter output itself.
describe('no reply notification can be mistaken for a draft message', () => {
  const ALL_FORMATS: Array<[string, string]> = [
    ['one reply', formatHumanReplyNotice([n('d19', 'Daniel Kepple')])],
    ['several replies', formatHumanReplyNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')])],
    ['capped replies', formatHumanReplyNotice(Array.from({ length: 12 }, (_, i) => n(`d${i}`, `P${i}`)))],
    ['one bounce', formatBounceNotice([n('d19', 'Daniel Kepple')])],
    ['several bounces', formatBounceNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')])],
    ['poll failure', formatPollFailureNotice(3, 'invalid_grant')],
  ];

  it.each(ALL_FORMATS)('%s does not begin with a draft id and a colon', (_label, text) => {
    expect(/^\s*(d\d+):/.test(text)).toBe(false);
    for (const line of text.split('\n')) expect(/^\s*d\d+:/.test(line)).toBe(false);
  });
});

describe('coalescing and the name cap', () => {
  it('names the person on a single reply, because he needs to know who', () => {
    const t = formatHumanReplyNotice([n('d19', 'Daniel Kepple')]);
    expect(t).toBe('Reply from Daniel Kepple (d19), 2h ago. Read it in Gmail.');
  });

  it('coalesces several into ONE message', () => {
    expect(formatHumanReplyNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')]))
      .toBe('2 replies: Daniel Kepple (d19), Ada Chen (d22). Read them in Gmail.');
  });

  // Coalescing bounds the COUNT of messages and says nothing about the LENGTH
  // of one. A burst day would otherwise produce a single text listing thirty
  // names, which is unreadable on a phone and is its own kind of noise.
  it('caps the names shown at 5 and reports the rest as a count', () => {
    const t = formatHumanReplyNotice(Array.from({ length: 12 }, (_, i) => n(`d${i}`, `P${i}`)));
    expect(t).toContain('12 replies:');
    expect(t).toContain('and 7 more');
    expect(t.match(/\(d\d+\)/g)).toHaveLength(MAX_NAMES_PER_NOTICE);
  });

  it('has no tail when the list fits', () => {
    expect(formatHumanReplyNotice([n('d1', 'A'), n('d2', 'B')])).not.toContain('more');
  });

  // MTAs routinely emit several DSNs per message (a delay warning, then a hard
  // failure, sometimes one per hop), each a distinct gmail_message_id and so
  // each a distinct row. Uncoalesced, one bad address is three or four texts.
  it('coalesces bounces the same way, which the earlier design did not', () => {
    expect(formatBounceNotice([n('d19', 'Daniel Kepple')]))
      .toBe('Bounced: d19 to Daniel Kepple did not deliver.');
    expect(formatBounceNotice([n('d19', 'Daniel Kepple'), n('d22', 'Ada Chen')]))
      .toBe('2 bounced: Daniel Kepple (d19), Ada Chen (d22).');
  });

  it('carries only err.message on the failure line, never an object', () => {
    expect(formatPollFailureNotice(3, 'invalid_grant'))
      .toBe('Reply polling has failed 3 cycles running: invalid_grant.');
  });

  it('returns empty string for an empty list, so the caller sends nothing', () => {
    expect(formatHumanReplyNotice([])).toBe('');
    expect(formatBounceNotice([])).toBe('');
  });
});

// A tapback on one of these used to produce TOTAL SILENCE: no dN: header so
// draftIdFromReactedText returns null, and no NEEDS ADDRESS header so
// needsAddressDraftId returns null too. It fell straight into the "reaction on
// a non-draft message, ignoring" branch. That is indistinguishable from a dead
// listener, and it is the exact failure the needs-address hint branch exists to
// fix.
describe('the reply-notice tapback recognizer', () => {
  it('recognises every notification format this feature sends', () => {
    for (const t of [
      formatHumanReplyNotice([n('d19', 'Daniel Kepple')]),
      formatHumanReplyNotice([n('d19', 'A'), n('d22', 'B')]),
      formatBounceNotice([n('d19', 'Daniel Kepple')]),
      formatBounceNotice([n('d19', 'A'), n('d22', 'B')]),
      formatPollFailureNotice(3, 'boom'),
    ]) {
      expect(replyNoticeTapbackHint(t)).not.toBeNull();
    }
  });

  it('recognises nothing else, because the line may be shared', () => {
    expect(replyNoticeTapbackHint('d25 sent to jiaruizhao@cuhk.edu.hk.')).toBeNull();
    expect(replyNoticeTapbackHint('d70: Xiyu Zhang (a@b.edu)')).toBeNull();
    expect(replyNoticeTapbackHint('NEEDS ADDRESS for d70')).toBeNull();
    expect(replyNoticeTapbackHint(undefined)).toBeNull();
    expect(replyNoticeTapbackHint('')).toBeNull();
  });

  it('is not itself an approval button', () => {
    const hint = replyNoticeTapbackHint(formatHumanReplyNotice([n('d19', 'Daniel Kepple')]))!;
    expect(/^\s*d\d+:/.test(hint)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/reply-notify.test.ts`
Expected: FAIL, `formatHumanReplyNotice is not a function`.

- [ ] **Step 3: Append to `src/approval/channel.ts`**

Add after the needs-address block:

```ts
// --- Reply-tracking notifications ----------------------------------------
// Here, not in replies.ts, for the same reason formatNeedsAddressMessage is
// here: the job that SENDS these and the channel that must recognise a TAPBACK
// on them both need them, and they must not drift.
//
// Every one of these begins with literal text and cannot parse as a draft id.
// draftIdFromReactedText (photonChannel.ts:135-138) turns any message whose
// text starts /^\s*(d\d+):/ into a tapback-approvable draft, so `d19: Daniel
// Kepple replied` would make a thumbs up on good news decode to `d19 y`. This
// project has been bitten by that shape twice.
export interface ReplyNotice {
  shortId: string;
  personName: string;
  ageText: string;
}

// Coalescing bounds the message COUNT (at most 3 per cycle: replies, bounces,
// failure). It does nothing about the LENGTH of one, and a burst day would
// otherwise produce a single text listing thirty names. The caller must set
// notified_at on EVERY covered row, including the ones folded into the tail,
// or a 12-reply cycle re-notifies the unnamed 7 forever.
export const MAX_NAMES_PER_NOTICE = 5;

function nameList(rs: ReplyNotice[]): string {
  const shown = rs.slice(0, MAX_NAMES_PER_NOTICE).map((r) => `${r.personName} (${r.shortId})`).join(', ');
  const hidden = rs.length - Math.min(rs.length, MAX_NAMES_PER_NOTICE);
  return hidden > 0 ? `${shown} and ${hidden} more` : shown;
}

export function formatHumanReplyNotice(rs: ReplyNotice[]): string {
  if (rs.length === 0) return '';
  if (rs.length === 1) {
    const r = rs[0]!;
    return `Reply from ${r.personName} (${r.shortId}), ${r.ageText}. Read it in Gmail.`;
  }
  return `${rs.length} replies: ${nameList(rs)}. Read them in Gmail.`;
}

export function formatBounceNotice(rs: ReplyNotice[]): string {
  if (rs.length === 0) return '';
  if (rs.length === 1) return `Bounced: ${rs[0]!.shortId} to ${rs[0]!.personName} did not deliver.`;
  return `${rs.length} bounced: ${nameList(rs)}.`;
}

// err.message only. Never the error object: a GaxiosError carries its response
// and request config as own enumerable properties, so console.error(e) prints
// header values (From addresses, under format=metadata) and the full URL.
export function formatPollFailureNotice(cycles: number, message: string): string {
  return `Reply polling has failed ${cycles} cycles running: ${message}.`;
}

// A tapback on one of the above used to produce total silence: no `dN:` header
// so draftIdFromReactedText returns null, and no NEEDS ADDRESS header so
// needsAddressDraftId returns null too. Reacting to good news is the most
// natural thing a human does with these messages, and silence is
// indistinguishable from a dead listener.
//
// Unlike a needs-address message there is no typed command that would help, so
// the hint says exactly that and stops. It begins with a letter, so it cannot
// itself become an approval button.
const REPLY_NOTICE = /^(Reply from |\d+ replies: |Bounced: |\d+ bounced: |Reply polling has failed )/;

export function replyNoticeTapbackHint(text: string | undefined): string | null {
  if (!REPLY_NOTICE.test((text ?? '').trim())) return null;
  return 'Nothing to approve on a reply notification. Open Gmail to read it.';
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/reply-notify.test.ts` → PASS
Run: `npx vitest run test/channel.test.ts` → PASS unchanged
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 5: Mutate to prove the tests can fail, and prove the OTHER test cannot**

Three mutations:
1. Change `formatHumanReplyNotice`'s single-reply branch to `` `${r.shortId}: reply from ${r.personName}` ``. Confirm the direct format test in `test/reply-notify.test.ts` goes RED. **Then run `npx vitest run test/notify-tapback-safety.test.ts` and confirm it stays GREEN.** That is the demonstration that the SOURCES scan was never sufficient for this feature. Restore.
2. Remove the `and N more` tail from `nameList`. Confirm the cap test goes RED on the tail assertion while the `toHaveLength(5)` assertion stays green, which is why both are asserted. Restore.
3. Change `REPLY_NOTICE` to also match `^d\d+`. Confirm `recognises nothing else` goes RED on the `d25 sent to ...` case. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/approval/channel.ts test/reply-notify.test.ts
git commit -m "Add coalesced reply notifications that no tapback can approve, capped at 5 names"
```

---

### Task 5: Answer a tapback on a reply notification instead of ignoring it

**Requires:** Task 4.

**Why:** The usability half of Task 4. `reactionToDecoded` (`photonChannel.ts:150-...`) already has the three-way `Decoded` shape from the address-correction work, so this is one branch, wired into both the batch and push paths, which the existing structure already shares.

**Files:**
- Modify: `src/approval/photonChannel.ts`
- Test: `test/photonChannel.test.ts`

**Interfaces produced:** none exported. Internal to `createPhotonChannel`.

- [ ] **Step 1: Write the failing tests**

Append to `test/photonChannel.test.ts`, reusing the file's existing `reaction()` and `channelFor()` helpers:

```ts
describe('a tapback on a reply notification', () => {
  const NOTICE = formatHumanReplyNotice([{ shortId: 'd19', personName: 'Daniel Kepple', ageText: '2h ago' }]);

  // The safety half. This message names a draft, so if it ever became
  // approvable a thumbs up on good news would send something.
  it('never becomes an approval', async () => {
    const { channel } = await channelFor([reaction('\u{1F44D}', NOTICE)]);
    expect(await channel.captureReplies(200)).toEqual([]);
  });

  // The usability half. Silence here is indistinguishable from a dead listener,
  // which is the exact failure the needs-address hint branch was added to fix.
  it('answers on-channel instead of going silent', async () => {
    const { channel, dmSend } = await channelFor([reaction('\u{1F44D}', NOTICE)]);
    await channel.captureReplies(200);
    expect(dmSend).toHaveBeenCalledTimes(1);
    const sent = String(dmSend.mock.calls[0]![0]);
    expect(sent).toContain('Nothing to approve');
    expect(/^\s*d\d+:/.test(sent)).toBe(false);
  });

  it('hints on the push path too, so batch and listener cannot drift', async () => {
    const { channel, dmSend } = await channelFor([reaction('\u{1F44E}', NOTICE)]);
    const seen: string[] = [];
    await channel.streamReplies(async (r) => { seen.push(r.text); });
    expect(seen).toEqual([]);
    expect(dmSend).toHaveBeenCalledTimes(1);
  });

  // Unchanged, and it matters: the line may be shared, so a reaction on
  // anything that is not one of ours must never be reflected back.
  it('still reflects nothing for a reaction on an ordinary status line', async () => {
    const { channel, dmSend } = await channelFor([reaction('\u{1F44D}', 'd25 sent to jiaruizhao@cuhk.edu.hk.')]);
    expect(await channel.captureReplies(200)).toEqual([]);
    expect(dmSend).not.toHaveBeenCalled();
  });
});
```

Add `formatHumanReplyNotice` to that file's import from `../src/approval/channel.js`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/photonChannel.test.ts -t 'answers on-channel instead'`
Expected: FAIL, `dmSend` was never called.

- [ ] **Step 3: Add the branch to `src/approval/photonChannel.ts`**

Extend the import from `./channel.js` with `replyNoticeTapbackHint`, then add one branch to `reactionToDecoded`, immediately after the `needsAddressDraftId` check and before the ignore branch:

```ts
    const replyHint = replyNoticeTapbackHint(targetText);
    if (replyHint) {
      // Informational message: there is nothing to approve and, unlike a
      // needs-address message, no typed command that would help either. Say so
      // rather than going silent, because silence reads as a dead listener.
      console.log('photonChannel: reaction on a reply notification, replying with a no-op hint');
      return { kind: 'hint', text: replyHint };
    }
```

Nothing else changes: `Decoded`'s `hint` variant, the `await dm.send(d.text)` handling in `captureReplies`, and the equivalent in `streamReplies` all already exist from the address-correction work, which is why both paths get this for free.

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/photonChannel.test.ts` → PASS, all pre-existing reaction tests unchanged
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 5: Mutate to prove the tests can fail**

Change the new branch to `return { kind: 'ignore' };`. Confirm the two hint tests go RED and `never becomes an approval` stays GREEN. It must stay green: silence is still safe, just useless, and conflating the two is how this defect survived the first time. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/approval/photonChannel.ts test/photonChannel.test.ts
git commit -m "Answer a tapback on a reply notification instead of going silent"
```

---

### Task 6: The watch set: `recordSentThread`, the adopt anti-join, and the cadence

**Requires:** Task 1.

**Why:** This is the projection of `draft_events` into a polling index, and it is where the self-healing actually has to live. The spec's earlier draft called a missing watch row "recoverable at zero cost by the backfill" and then put the backfill behind a `--backfill` flag the plist never passes, so a swallowed failure would have meant a thread never polled and nothing counting the gap.

**Files:**
- Create: `src/pipeline/sentThreads.ts`
- Test: `test/sent-threads.test.ts` (new)

**Interfaces produced:**

```ts
export function isGmailShapedId(sentId: string): boolean;
export function recordSentThread(db: DB, draftId: number, personId: number, sentId: string, threadId?: string): void;
export function adoptOrphanedSends(db: DB): number;
export function nextPollAt(sentAt: Date, now: Date): { next: string } | { close: true };
export interface DueThread { draftId: number; personId: number; threadId: string; sentMessageId: string; sentAt: string; }
export function selectDueThreads(db: DB, limit: number): DueThread[];
export function rearmUnresolvable(db: DB, draftIds?: number[]): number;
```

- [ ] **Step 1: Write the failing tests**

Create `test/sent-threads.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { persistDraft, logEvent } from '../src/approval/ledger.js';
import {
  isGmailShapedId, recordSentThread, adoptOrphanedSends, nextPollAt,
  selectDueThreads, rearmUnresolvable,
} from '../src/pipeline/sentThreads.js';
import { toSqlTime } from '../src/db/time.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Daniel Kepple', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 's', body: 'b', grounded: true, wordCount: 1, notes: [] };

function seedSent(sentId: string, threadId?: string) {
  const db = openDb(':memory:');
  const personId = upsertPerson(db, { name: 'Daniel Kepple', openalexId: 'A-dk', email: 'dk@example.edu' });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  logEvent(db, p.draftId, 'sent', threadId ? { sentId, threadId } : { sentId });
  return { db, personId, draftId: p.draftId };
}

describe('the Gmail-shape guard', () => {
  it('accepts the shape all 56 real sent ids have', () => {
    expect(isGmailShapedId('19fca6e82b8956ad')).toBe(true);
  });

  // A non-Gmail send path must never make the poller spin.
  it('rejects an SMTP Message-ID and both fallback timestamp forms', () => {
    expect(isGmailShapedId('smtp-1785931200000')).toBe(false);
    expect(isGmailShapedId('gmail-1785931200000')).toBe(false);
    expect(isGmailShapedId('<abc@mail.example.com>')).toBe(false);
    expect(isGmailShapedId('abc@example.com')).toBe(false);
    expect(isGmailShapedId('19FCA6E82B8956AD')).toBe(false);   // lowercase hex only
    expect(isGmailShapedId('')).toBe(false);
  });
});

describe('adoptOrphanedSends', () => {
  // This runs at the head of EVERY cycle with zero API calls, so a swallowed
  // recordSentThread failure heals itself on the next run instead of leaving a
  // thread permanently unpolled with nothing counting the gap.
  it('projects a sent event with no watch row, and reports how many it adopted', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad', '19fca6e82b8956aa');
    expect(adoptOrphanedSends(db)).toBe(1);
    const row = db.prepare('SELECT * FROM sent_threads WHERE draft_id = ?').get(draftId) as Record<string, unknown>;
    expect(row.sent_message_id).toBe('19fca6e82b8956ad');
    expect(row.thread_id).toBe('19fca6e82b8956aa');
    expect(row.watch_state).toBe('open');
  });

  // It runs every cycle over an append-only log, so it MUST be idempotent.
  it('is a no-op on the second run', () => {
    const { db } = seedSent('19fca6e82b8956ad', '19fca6e82b8956aa');
    expect(adoptOrphanedSends(db)).toBe(1);
    expect(adoptOrphanedSends(db)).toBe(0);
    expect((db.prepare('SELECT count(*) AS n FROM sent_threads').get() as { n: number }).n).toBe(1);
  });

  // The 56 historical sent events have no threadId: the field is new. The
  // backfill fills sent_threads.thread_id for them, not the event rows, because
  // draft_events is append-only.
  it('adopts a legacy send with no threadId, leaving thread_id NULL', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad');
    expect(adoptOrphanedSends(db)).toBe(1);
    expect((db.prepare('SELECT thread_id AS t FROM sent_threads WHERE draft_id = ?').get(draftId) as { t: null }).t)
      .toBeNull();
  });

  it('marks a non-Gmail id unresolvable rather than queueing it forever', () => {
    const { db, draftId } = seedSent('smtp-1785931200000');
    adoptOrphanedSends(db);
    expect((db.prepare('SELECT watch_state AS w FROM sent_threads WHERE draft_id = ?').get(draftId) as { w: string }).w)
      .toBe('unresolvable');
  });

  it('writes sent_at in the canonical form, so the cadence can compare it', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad', 't1');
    adoptOrphanedSends(db);
    const at = (db.prepare('SELECT sent_at AS a FROM sent_threads WHERE draft_id = ?').get(draftId) as { a: string }).a;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('recordSentThread', () => {
  it('writes the watch row after a send', () => {
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 't1');
    recordSentThread(db, draftId, personId, '19fca6e82b8956ad', 't1');
    expect((db.prepare('SELECT count(*) AS n FROM sent_threads').get() as { n: number }).n).toBe(1);
  });

  it('is idempotent, so it cannot collide with the adopt that runs every cycle', () => {
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 't1');
    recordSentThread(db, draftId, personId, '19fca6e82b8956ad', 't1');
    expect(() => recordSentThread(db, draftId, personId, '19fca6e82b8956ad', 't1')).not.toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM sent_threads').get() as { n: number }).n).toBe(1);
  });
});

// The tiers are aligned to the ACTUAL fire times (07:30/12:30/17:30/21:30). A
// +6h tier under that schedule gives the newest threads about 2 polls a day,
// not the 4 the quota arithmetic assumed: 07:30 -> due 13:30 misses 12:30 and
// waits for 17:30. +4h is the largest interval that lands inside every gap
// (the gaps are 5h, 5h, 4h, 10h).
describe('the age-tiered cadence', () => {
  const now = new Date(Date.UTC(2026, 7, 4, 7, 30, 0));
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000);

  it('polls a fresh send every 4 hours', () => {
    expect(nextPollAt(daysAgo(1), now)).toEqual({ next: toSqlTime(new Date(now.getTime() + 4 * 3600_000)) });
  });

  it('drops to daily between 3 and 14 days', () => {
    expect(nextPollAt(daysAgo(5), now)).toEqual({ next: toSqlTime(new Date(now.getTime() + 24 * 3600_000)) });
  });

  it('drops to every third day between 14 and 60', () => {
    expect(nextPollAt(daysAgo(30), now)).toEqual({ next: toSqlTime(new Date(now.getTime() + 72 * 3600_000)) });
  });

  // 60 days, not 30. Academics answer cold email on week-to-month timescales,
  // and a 30 day close stops watching exactly where the slower half lands.
  it('closes at 60 days', () => {
    expect(nextPollAt(daysAgo(61), now)).toEqual({ close: true });
    expect(nextPollAt(daysAgo(59), now)).not.toEqual({ close: true });
  });
});

describe('selectDueThreads', () => {
  it('returns overdue open threads oldest-due first, and respects the limit', () => {
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 't1');
    adoptOrphanedSends(db);
    const older = toSqlTime(new Date(Date.now() - 7200_000));
    db.prepare('UPDATE sent_threads SET next_poll_at = ? WHERE draft_id = ?').run(older, draftId);
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, next_poll_at)
       VALUES (?, ?, 'aa11', 't2', ?, ?)`,
    ).run(draftId + 1000, personId, older, toSqlTime(new Date(Date.now() - 3600_000)));
    const due = selectDueThreads(db, 10);
    expect(due.map((d) => d.threadId)).toEqual(['t1', 't2']);
    expect(selectDueThreads(db, 1)).toHaveLength(1);
  });

  it('skips a row with no thread_id, because there is nothing to poll', () => {
    const { db } = seedSent('19fca6e82b8956ad');
    adoptOrphanedSends(db);
    expect(selectDueThreads(db, 10)).toEqual([]);
  });

  it('polls each DISTINCT thread once, even when two drafts share it', () => {
    // Gmail threads on subject plus participants, so two --to-self sends land
    // in one thread and a --force second email to one person can too.
    const { db, draftId, personId } = seedSent('19fca6e82b8956ad', 'shared');
    adoptOrphanedSends(db);
    db.prepare(
      `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, next_poll_at)
       VALUES (?, ?, 'bb22', 'shared', datetime('now'), datetime('now'))`,
    ).run(draftId + 1000, personId);
    const due = selectDueThreads(db, 10);
    expect(due).toHaveLength(1);
    // Attributed to the LOWEST open draft_id carrying that thread.
    expect(due[0]!.draftId).toBe(draftId);
  });
});

describe('rearmUnresolvable', () => {
  it('returns a failed thread to open at zero failures', () => {
    const { db, draftId } = seedSent('19fca6e82b8956ad', 't1');
    adoptOrphanedSends(db);
    db.prepare("UPDATE sent_threads SET watch_state='unresolvable', poll_failures=5 WHERE draft_id=?").run(draftId);
    expect(rearmUnresolvable(db)).toBe(1);
    const r = db.prepare('SELECT watch_state AS w, poll_failures AS f, rearmed_at AS r FROM sent_threads WHERE draft_id=?')
      .get(draftId) as { w: string; f: number; r: string | null };
    expect(r).toMatchObject({ w: 'open', f: 0 });
    expect(r.r).not.toBeNull();
  });

  // The guard that keeps --rearm all from resurrecting a genuinely unpollable
  // row into a permanent spin.
  it('leaves a row with no thread_id unresolvable', () => {
    const { db } = seedSent('smtp-1785931200000');
    adoptOrphanedSends(db);
    expect(rearmUnresolvable(db)).toBe(0);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/sent-threads.test.ts`
Expected: FAIL, cannot resolve `../src/pipeline/sentThreads.js`.

- [ ] **Step 3: Create `src/pipeline/sentThreads.ts`**

```ts
// sent_threads is a PROJECTION of draft_events, not a second source of truth.
// draft_events is append-only and authoritative and should stay a log, not a
// polling index; this table is where the mutable polling state lives so that no
// volatile column lands next to the frozen approval state in drafts.
import type { DB } from '../db/db.js';
import { toSqlTime, addHours } from '../db/time.js';

// Only a Gmail-shaped sentId is pollable: lowercase hex, no '@', no fallback
// prefix. All 56 current ids pass (16 lowercase hex chars, newest
// 19fca6e82b8956ad). Anything else is an SMTP Message-ID or one of the two
// synthesized fallbacks (gmail-${Date.now()} at gmail-api.ts:52,
// smtp-${Date.now()} at gmail.ts:31) and is recorded once as unresolvable and
// never retried, so a non-Gmail send path can never make the poller spin.
export function isGmailShapedId(sentId: string): boolean {
  return /^[0-9a-f]+$/.test(sentId) && !sentId.includes('@');
}

// Called by the CALLER, AFTER markSent returns, and wrapped by the caller so
// any throw is logged and swallowed. Never inside markSent's transaction: that
// transaction exists so the status UPDATE and the audit record of an
// irreversible email are one unit (ledger.ts:117-118), and an INSERT here would
// give it a brand new way to abort AFTER Gmail already accepted the message,
// rolling back both and leaving a genuinely sent email recorded as
// approved-and-unsent. stalledApprovals would then report it and a human would
// be steered toward sending a second cold email to a stranger.
//
// ON CONFLICT DO NOTHING because adoptOrphanedSends runs every cycle over the
// same log and the two must not race each other into a primary-key throw.
export function recordSentThread(
  db: DB, draftId: number, personId: number, sentId: string, threadId?: string,
): void {
  db.prepare(
    `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, watch_state)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(draft_id) DO NOTHING`,
  ).run(draftId, personId, sentId, threadId ?? null, isGmailShapedId(sentId) ? 'open' : 'unresolvable');
}

// Head of EVERY cycle. Zero API calls: a pure SQL anti-join against the log.
// This is what makes recordSentThread's swallow actually self-healing. The
// earlier design put the only recovery behind an explicit --backfill flag that
// the plist never passes, so a swallowed throw meant a thread that was never
// polled and nothing that counted the gap. The caller logs the return value on
// every run, including 0: a persistently non-zero N is the signal that
// recordSentThread is failing.
export function adoptOrphanedSends(db: DB): number {
  const res = db.prepare(
    `INSERT INTO sent_threads (draft_id, person_id, sent_message_id, thread_id, sent_at, watch_state)
     SELECT e.draft_id, d.person_id,
            json_extract(e.detail_json, '$.sentId'),
            json_extract(e.detail_json, '$.threadId'),
            e.created_at,
            CASE WHEN json_extract(e.detail_json, '$.sentId') GLOB '[0-9a-f]*'
                  AND json_extract(e.detail_json, '$.sentId') NOT GLOB '*[^0-9a-f]*'
                 THEN 'open' ELSE 'unresolvable' END
       FROM draft_events e
       JOIN drafts d ON d.id = e.draft_id
       LEFT JOIN sent_threads st ON st.draft_id = e.draft_id
      WHERE e.type = 'sent'
        AND st.draft_id IS NULL
        AND json_extract(e.detail_json, '$.sentId') IS NOT NULL
     ON CONFLICT(draft_id) DO NOTHING`,
  ).run();
  // e.created_at is already datetime('now') format, which is exactly why
  // sent_at uses that form and not ISO. See src/db/time.ts.
  return res.changes;
}

const DAY_MS = 86400_000;

// Aligned to the ACTUAL fire times: 07:30, 12:30, 17:30, 21:30. The gaps are
// 5h, 5h, 4h, 10h, so +4h is the largest interval that lands inside every one
// of them. A +6h tier (the earlier draft) gives the newest and most valuable
// threads about 2 polls a day, not the 4 the quota arithmetic assumed:
// 07:30 -> due 13:30 misses the 12:30 run and waits for 17:30.
export function nextPollAt(sentAt: Date, now: Date): { next: string } | { close: true } {
  const ageDays = (now.getTime() - sentAt.getTime()) / DAY_MS;
  // 60 days, not 30. Academics answer cold email on week-to-month timescales,
  // and a 30 day close stops watching exactly where the slower half lands.
  if (ageDays >= 60) return { close: true };
  if (ageDays < 3) return { next: addHours(now, 4) };
  if (ageDays < 14) return { next: addHours(now, 24) };
  return { next: addHours(now, 72) };
}

export interface DueThread {
  draftId: number;
  personId: number;
  threadId: string;
  sentMessageId: string;
  sentAt: string;
}

// One row per DISTINCT thread_id: one thread can map to more than one draft
// (two --to-self sends, or a --force second email to one person), and polling
// it twice would double the quota spend for one answer. Any reply found is
// attributed to the lowest open draft_id carrying that thread; replies still
// has UNIQUE(gmail_message_id), so the same inbound message can never produce
// two rows regardless.
//
// Oldest-due first so nothing starves under the per-cycle cap, and overflow
// simply waits for the next run.
export function selectDueThreads(db: DB, limit: number): DueThread[] {
  return db.prepare(
    `SELECT min(draft_id) AS draftId, min(person_id) AS personId, thread_id AS threadId,
            min(sent_message_id) AS sentMessageId, min(sent_at) AS sentAt
       FROM sent_threads
      WHERE watch_state = 'open'
        AND thread_id IS NOT NULL
        AND next_poll_at <= datetime('now')
      GROUP BY thread_id
      ORDER BY min(next_poll_at) ASC
      LIMIT ?`,
  ).all(limit) as DueThread[];
}

// unresolvable MUST be re-armable. Under the failure taxonomy in
// gmailReader.ts this should now be reachable only one thread at a time, but
// the recovery has to exist: the earlier design could reach it wholesale and
// terminally, and a terminal state with no recovery path is how a feature
// deletes its own reason to exist.
//
// thread_id IS NOT NULL is what keeps --rearm all from resurrecting a genuinely
// unpollable row (an SMTP Message-ID, a fallback timestamp) into a permanent
// spin. Re-arming loses nothing: the polls are idempotent and replies is keyed
// on gmail_message_id.
export function rearmUnresolvable(db: DB, draftIds?: number[]): number {
  const scope = draftIds?.length ? ` AND draft_id IN (${draftIds.map(() => '?').join(',')})` : '';
  return db.prepare(
    `UPDATE sent_threads
        SET watch_state = 'open', poll_failures = 0,
            next_poll_at = datetime('now'), rearmed_at = datetime('now')
      WHERE watch_state = 'unresolvable' AND thread_id IS NOT NULL${scope}`,
  ).run(...(draftIds ?? [])).changes;
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/sent-threads.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

If the `GLOB` expression in `adoptOrphanedSends` proves awkward, replace it with a two-step approach (adopt everything as `open`, then a second `UPDATE ... SET watch_state='unresolvable' WHERE sent_message_id LIKE '%@%' OR sent_message_id GLOB '*[^0-9a-f]*'`). Keep the assertion, not the implementation.

- [ ] **Step 5: Mutate to prove the tests can fail**

Three mutations:
1. Remove `ON CONFLICT(draft_id) DO NOTHING` from `adoptOrphanedSends`. Confirm `is a no-op on the second run` goes RED with a constraint error. Restore.
2. Change `nextPollAt`'s fresh tier to `addHours(now, 6)`. Confirm the fresh-send cadence test goes RED. Restore.
3. Change `selectDueThreads` to drop `GROUP BY thread_id`. Confirm `polls each DISTINCT thread once` goes RED with 2 rows. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/sentThreads.ts test/sent-threads.test.ts
git commit -m "Project sent_threads from draft_events, adopt orphans every cycle, tier the cadence"
```

---

### Task 7: Wire the send path, without adding a way for a send to fail

**Requires:** Task 6.

**Why:** This is the one task that touches the irreversible path, and the constraint on it is absolute: **nothing here may add a new way for a send to abort, and nothing here may make a successful send look like a failed one.** In `performApprovedSend` the network `try` spans `loop.ts:224-232` and covers `sender.send`, `markSent` and the `SENT ...` notify. A `recordSentThread` throw inside that block lands in the catch at :232, which calls `markSendFailed` (writing a `send_failed` event) and texts `"${shortId} failed to send: ..."` **for an email that already went out**.

**Files:**
- Modify: `src/sender/types.ts`, `src/sender/gmail-api.ts`, `src/approval/ledger.ts`, `src/pipeline/loop.ts`, `src/cli.ts`
- Test: `test/send-path-thread-capture.test.ts` (new)

**Interfaces produced:**

```ts
// src/sender/types.ts
export interface Sender { send(email: OutboundEmail): Promise<{ sentId: string; threadId?: string }>; }
// src/approval/ledger.ts
export function markSent(db: DB, draftId: number, sentId: string, threadId?: string): void;
```

Both additions are **optional**, so every existing implementation, stub and test literal still satisfies them and `npm run typecheck` is the real assertion that they did.

- [ ] **Step 1: Write the failing tests**

Create `test/send-path-thread-capture.test.ts`. Build the `LoopDeps` literal the way `test/loop.test.ts` already does; adapt to that file's helpers rather than inventing new ones.

```ts
describe('threadId capture on the send path', () => {
  it('stores the threadId the sender returned', async () => {
    // ... approve a draft, run performApprovedSend with a stub sender
    //     returning { sentId: '19fca6e82b8956ad', threadId: '19fca6e82b8956aa' }
    expect(threadRow.thread_id).toBe('19fca6e82b8956aa');
    // The sent event carries it going forward. The 56 existing ones will not,
    // and every reader must tolerate its absence.
    expect(JSON.parse(sentEvent.detail_json).threadId).toBe('19fca6e82b8956aa');
  });

  it('sends normally when the sender returns no threadId, which the SMTP sender never will', async () => {
    // stub returns { sentId: 'abc123' } only
    expect(draft.status).toBe('sent');
    expect(threadRow.thread_id).toBeNull();
  });
});

// THE test this task exists for.
describe('a recordSentThread failure cannot make a sent email look unsent', () => {
  it('leaves the draft sent, the event present, and NO send_failed written', async () => {
    // Inject a recordSentThread that throws, via the deps seam.
    // Assertion 1: the draft is 'sent'.
    expect(draft.status).toBe('sent');
    // Assertion 2: the sent event is present.
    expect(events.filter((e) => e.type === 'sent')).toHaveLength(1);
    // Assertion 3: THE ONE THAT MATTERS, and the one the earlier draft of the
    // spec omitted. If recordSentThread sits inside the network try (loop.ts
    // 224-232), assertions 1 and 2 BOTH stay green, because markSent's
    // transaction already committed. Only this one goes red, and without it
    // the whole test is decorative.
    expect(events.filter((e) => e.type === 'send_failed')).toHaveLength(0);
    expect(notifications.filter((t) => t.includes('failed to send'))).toHaveLength(0);
    // And the human still gets the truth.
    expect(notifications.some((t) => t.startsWith('SENT '))).toBe(true);
  });
});
```

**Note on the trigger.** The spec's earlier draft said to force this with "a duplicate `thread_id` from two `--to-self` sends". That trigger is **dead**: Change 3 dropped the UNIQUE on `thread_id`, so that insert no longer throws and the test could never fail. The throws that actually remain on `recordSentThread` are a foreign-key violation on `person_id` or `draft_id` (`foreign_keys = ON`, `db.ts:18`), `SQLITE_BUSY` from the concurrent batch or listener process, `SQLITE_READONLY`, and `no such table` on a stale connection, which is the case Deploy step 3 exists to prevent and is the most likely one in practice. Test it at the **seam**, by injecting a thrower, rather than by contriving a database fault.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/send-path-thread-capture.test.ts`
Expected: FAIL, no `sent_threads` row and `threadId` absent from the event.

- [ ] **Step 3: Widen the sender seam**

`src/sender/types.ts`:

```ts
export interface Sender {
  // threadId is OPTIONAL, so the SMTP sender (src/sender/gmail.ts) and every
  // test stub compile unchanged. The SMTP sender never sets it, which is
  // correct: it has no Gmail ids.
  send(email: OutboundEmail): Promise<{ sentId: string; threadId?: string }>;
}
```

`src/sender/gmail-api.ts:53`: `users.messages.send` returns a `Message` resource carrying `threadId` alongside `id`, so change the return to:

```ts
      return { sentId: res.data.id ?? `gmail-${Date.now()}`, threadId: res.data.threadId ?? undefined };
```

- [ ] **Step 4: Add the optional fourth parameter to `markSent`**

`src/approval/ledger.ts:119`:

```ts
export function markSent(db: DB, draftId: number, sentId: string, threadId?: string): void {
  const txn = db.transaction((): void => {
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftId);
    // A change to the PAYLOAD of an INSERT that already happens inside this
    // transaction, so it adds no new way for the transaction to fail. The watch
    // row is deliberately NOT written here: see recordSentThread.
    logEvent(db, draftId, 'sent', threadId ? { sentId, threadId } : { sentId });
  });
  txn();
}
```

Keep the `threadId ?` conditional rather than always writing the key: the 56 historical events have no such key, and matching their shape when there is nothing to record keeps the log honest.

- [ ] **Step 5: Wire both call sites, OUTSIDE the network try**

`src/pipeline/loop.ts`. The network try currently ends at :232 with `} catch (e) {`. Change the try body's send line to destructure `threadId`, and add the record call **after the closing brace of the catch**:

```ts
  let sentThreadInfo: { sentId: string; threadId?: string } | null = null;
  try {
    const { sentId, threadId } = await deps.sender.send(outbound);
    markSent(deps.db, draftId, sentId, threadId);
    sentThreadInfo = { sentId, threadId };
    summary.sent++;
    await deps.channel.notify(`SENT ${shortId} to ${lookup.personName} <${outbound.to}>.`);
  } catch (e) {
    // ... unchanged ...
  }

  // OUTSIDE the try, deliberately, and swallowed. Inside it, a throw here would
  // land in the catch above, which calls markSendFailed and texts "failed to
  // send" for an email that WENT OUT. A missing watch row is recoverable at
  // zero cost by adoptOrphanedSends at the head of the next cycle; a
  // send_failed event about a delivered email is not recoverable at all. The
  // asymmetry decides it.
  if (sentThreadInfo) {
    try {
      recordSentThread(deps.db, draftId, lookup.personId, sentThreadInfo.sentId, sentThreadInfo.threadId);
    } catch (e) {
      console.warn(`recordSentThread failed for ${shortId}: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  }
```

If `loadApprovedSend`'s result does not already carry `personId`, read it with a small query rather than widening that type: this call must not be able to change what `loadApprovedSend` returns.

`src/cli.ts:405-413`, the `add` path, gets the identical treatment: destructure `threadId`, pass it to `markSent`, and put the swallowed `recordSentThread` after the existing `catch` block closes. Note that this path bypasses `beginSendAttempt` entirely (the measured 5-row gap between 56 `sent` and 51 `send_attempted` events); its at-most-one-send property comes from `decide`'s `UNIQUE(draft_id)` (`schema.sql:96`) at `cli.ts:398-402`. `recordSentThread` must not assume either invariant, which is why it is `ON CONFLICT DO NOTHING`.

- [ ] **Step 6: Run the tests, the full suite, and typecheck**

Run: `npx vitest run test/send-path-thread-capture.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck` → **the real assertion that both new fields stayed optional.** Every existing `Sender` stub in `test/` must compile untouched. If any test file needs editing, a field became required; fix the type, not the test.

- [ ] **Step 7: Mutate to prove the test can fail**

Two mutations, both mandatory:
1. **Move the `recordSentThread` call inside the network `try`**, right after `markSent`. Confirm assertion 3 (`no send_failed`, no "failed to send" notify) goes RED **while assertions 1 and 2 stay GREEN**. That divergence is the whole point: the two assertions the earlier spec asked for cannot detect this bug. Restore.
2. **Move `recordSentThread` into `markSent`'s transaction.** Confirm assertions 1 and 2 go RED, which is the rolled-back-sent-event failure Change 2 exists to prevent. Restore, confirm GREEN.

- [ ] **Step 8: Commit**

```bash
git add src/sender/types.ts src/sender/gmail-api.ts src/approval/ledger.ts src/pipeline/loop.ts src/cli.ts test/send-path-thread-capture.test.ts
git commit -m "Capture threadId at send time without adding a way for a send to fail"
```

---

### Task 8: Cycle state: the lease, the failure counter, and the alarm

**Requires:** Task 1.

**Why:** Blocker 3. The job is `StartCalendarInterval` with no `KeepAlive`, so **every cycle is a fresh short-lived process**. Change 6 promises to notify "after 3 consecutive failed cycles". Without a durable counter that promise is not merely untested, it is unimplementable: a whole-cycle failure that records nothing before exiting resets the count to zero on every run, the alarm can never fire, and the silent-death mode it exists to catch is exactly the mode it misses. The same table carries the run lease, because launchd cannot see a hand-run `outreach replies`.

**Files:**
- Create: `src/pipeline/replyState.ts`
- Test: `test/reply-state.test.ts` (new)

**Interfaces produced:**

```ts
export const LEASE_MS = 15 * 60_000;
export const FAILURE_ALARM_CYCLES = 3;
export function acquireLease(db: DB, pid: number, now: Date): boolean;
export function releaseLease(db: DB): void;
export function recordCycleSuccess(db: DB): void;
export function recordCycleFailure(db: DB, message: string): { consecutive: number; shouldNotify: boolean };
export function markFailureNotified(db: DB): void;
export function pollState(db: DB): { consecutiveCycleFailures: number; lastError: string | null; lastSuccessAt: string | null; failureNotifiedAt: string | null };
```

- [ ] **Step 1: Write the failing tests**

Create `test/reply-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.js';
import {
  acquireLease, releaseLease, recordCycleSuccess, recordCycleFailure,
  markFailureNotified, pollState, LEASE_MS,
} from '../src/pipeline/replyState.js';

// An ON-DISK database, deliberately, not ':memory:'. The whole point of this
// table is that state survives PROCESS EXIT, and two ':memory:' handles share
// nothing, which is the same thing two processes do not share. A test that
// passed on ':memory:' would prove the opposite of what is needed here.
function diskDb() {
  return join(mkdtempSync(join(tmpdir(), 'reply-state-')), 'test.db');
}

describe('the 3-cycle alarm survives process exit', () => {
  it('fires on the third failure across three separate opens, not the first', () => {
    const path = diskDb();
    const results = [1, 2, 3].map(() => {
      const db = openDb(path);         // a fresh "process"
      const r = recordCycleFailure(db, 'invalid_grant');
      db.close();
      return r;
    });
    expect(results.map((r) => r.consecutive)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.shouldNotify)).toEqual([false, false, true]);
  });

  // Without the durable row the counter resets every run and this is [1,1,1].
  it('does not re-notify on the fourth failure', () => {
    const path = diskDb();
    for (let i = 0; i < 3; i++) { const db = openDb(path); recordCycleFailure(db, 'x'); db.close(); }
    { const db = openDb(path); markFailureNotified(db); db.close(); }
    const db = openDb(path);
    expect(recordCycleFailure(db, 'x').shouldNotify).toBe(false);
    expect(pollState(db).consecutiveCycleFailures).toBe(4);
  });

  it('a success resets the counter and re-arms the alarm', () => {
    const path = diskDb();
    for (let i = 0; i < 3; i++) { const db = openDb(path); recordCycleFailure(db, 'x'); db.close(); }
    { const db = openDb(path); markFailureNotified(db); recordCycleSuccess(db); db.close(); }
    { const db = openDb(path); const s = pollState(db);
      expect(s.consecutiveCycleFailures).toBe(0);
      expect(s.failureNotifiedAt).toBeNull();
      expect(s.lastSuccessAt).not.toBeNull();
      db.close(); }
    const results = [1, 2, 3].map(() => {
      const db = openDb(path); const r = recordCycleFailure(db, 'y'); db.close(); return r;
    });
    expect(results[2]!.shouldNotify).toBe(true);   // a SECOND alarm
  });

  it('stores err.message only, never an object', () => {
    const db = openDb(diskDb());
    recordCycleFailure(db, 'invalid_grant');
    expect(pollState(db).lastError).toBe('invalid_grant');
  });
});

describe('the run lease', () => {
  it('is exclusive: the second caller loses', () => {
    const db = openDb(diskDb());
    const now = new Date();
    expect(acquireLease(db, 111, now)).toBe(true);
    expect(acquireLease(db, 222, now)).toBe(false);
  });

  it('is released explicitly', () => {
    const db = openDb(diskDb());
    acquireLease(db, 111, new Date());
    releaseLease(db);
    expect(acquireLease(db, 222, new Date())).toBe(true);
  });

  // A process killed hard between taking the lease and its finally must block
  // at most one cycle, not forever.
  it('expires, so a crashed process cannot wedge the job permanently', () => {
    const db = openDb(diskDb());
    const t0 = new Date();
    expect(acquireLease(db, 111, t0)).toBe(true);
    expect(acquireLease(db, 222, new Date(t0.getTime() + LEASE_MS - 1000))).toBe(false);
    expect(acquireLease(db, 222, new Date(t0.getTime() + LEASE_MS + 1000))).toBe(true);
  });

  it('writes the lease expiry in the canonical form', () => {
    const db = openDb(diskDb());
    acquireLease(db, 111, new Date());
    const exp = (db.prepare('SELECT lock_expires_at AS e FROM reply_poll_state WHERE id = 1').get() as { e: string }).e;
    expect(exp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/reply-state.test.ts`
Expected: FAIL, cannot resolve `../src/pipeline/replyState.js`.

- [ ] **Step 3: Create `src/pipeline/replyState.ts`**

```ts
// Cycle-level state that MUST outlive the process.
//
// com.aditya.outreach-replies is StartCalendarInterval with no KeepAlive, so
// every cycle is a fresh short-lived process with no memory of the last one.
// "Notify after 3 consecutive failed cycles" is therefore unimplementable in
// process memory, not merely untested: the count would reset on every run, the
// alarm could never fire, and the silent-death mode it exists to catch is
// exactly the mode it would miss.
import type { DB } from '../db/db.js';
import { toSqlTime } from '../db/time.js';

export const LEASE_MS = 15 * 60_000;
export const FAILURE_ALARM_CYCLES = 3;

// launchd will not start a second copy of a job that has not exited, so the
// SCHEDULED runs cannot collide. But every live verification in the spec
// hand-runs `outreach replies` from a terminal, and that process is invisible
// to launchd's scheduler. Two cycles would select the same due rows under the
// same next_poll_at <= datetime('now') predicate and both spend 40 units each.
//
// One conditional UPDATE, the same shape as beginSendAttempt
// (ledger.ts:219-250): SQLite serializes writers and the WHERE clause carries
// the whole precondition, so there is no read-then-write gap to lose.
export function acquireLease(db: DB, pid: number, now: Date): boolean {
  const res = db.prepare(
    `UPDATE reply_poll_state
        SET lock_pid = ?, lock_expires_at = ?
      WHERE id = 1
        AND (lock_expires_at IS NULL OR lock_expires_at <= ?)`,
  ).run(pid, toSqlTime(new Date(now.getTime() + LEASE_MS)), toSqlTime(now));
  return res.changes === 1;
}

// Called from a finally, so a crashed process blocks at most one cycle rather
// than forever. The expiry above is the backstop for a hard kill.
export function releaseLease(db: DB): void {
  db.prepare('UPDATE reply_poll_state SET lock_pid = NULL, lock_expires_at = NULL WHERE id = 1').run();
}

export function recordCycleSuccess(db: DB): void {
  db.prepare(
    `UPDATE reply_poll_state
        SET last_cycle_at = datetime('now'), last_success_at = datetime('now'),
            consecutive_cycle_failures = 0, last_error = NULL, failure_notified_at = NULL
      WHERE id = 1`,
  ).run();
}

// MUST be called outside any aborted transaction, or the counter rolls back
// with it and the bug returns in a new shape. err.message only: a GaxiosError
// carries its response headers (From addresses, under format=metadata) and its
// request URL as own enumerable properties.
export function recordCycleFailure(db: DB, message: string): { consecutive: number; shouldNotify: boolean } {
  db.prepare(
    `UPDATE reply_poll_state
        SET last_cycle_at = datetime('now'),
            consecutive_cycle_failures = consecutive_cycle_failures + 1,
            last_error = ?
      WHERE id = 1`,
  ).run(message);
  const s = pollState(db);
  return {
    consecutive: s.consecutiveCycleFailures,
    // One text per OUTAGE, not one per cycle for as long as it lasts.
    // recordCycleSuccess clears failure_notified_at, which re-arms the alarm.
    shouldNotify: s.consecutiveCycleFailures >= FAILURE_ALARM_CYCLES && s.failureNotifiedAt === null,
  };
}

export function markFailureNotified(db: DB): void {
  db.prepare("UPDATE reply_poll_state SET failure_notified_at = datetime('now') WHERE id = 1").run();
}

export function pollState(db: DB): {
  consecutiveCycleFailures: number; lastError: string | null;
  lastSuccessAt: string | null; failureNotifiedAt: string | null;
} {
  return db.prepare(
    `SELECT consecutive_cycle_failures AS consecutiveCycleFailures, last_error AS lastError,
            last_success_at AS lastSuccessAt, failure_notified_at AS failureNotifiedAt
       FROM reply_poll_state WHERE id = 1`,
  ).get() as ReturnType<typeof pollState>;
}
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/reply-state.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 5: Mutate to prove the tests can fail**

Two mutations:
1. **Replace the durable counter with a module-level variable** (`let failures = 0;` at module scope, incremented and read in place of the column). Confirm `fires on the third failure across three separate opens` goes RED with `[1,1,1]` and zero notifications. This is the exact bug blocker 3 describes, reproduced. Restore.
2. Change `acquireLease`'s `WHERE` to drop the `lock_expires_at` predicate. Confirm `is exclusive` goes RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/replyState.ts test/reply-state.test.ts
git commit -m "Add durable cycle state so the 3-cycle alarm can fire across process exits"
```

---

### Task 9: The cycle itself

**Requires:** Tasks 1, 2, 3, 4, 6, 8.

**Why:** Everything above is a part; this is the machine. It owns the failure-scope decision, the per-thread transaction, the conflict-ignoring insert, and the notify-then-mark ordering that makes "exactly one notification" implementable.

**Files:**
- Create: `src/pipeline/replies.ts`
- Modify: `test/notify-tapback-safety.test.ts` (extend `SOURCES` by one entry)
- Test: `test/replies-cycle.test.ts` (new)

**Interfaces produced:**

```ts
export interface ReplyDeps {
  db: DB;
  reader: GmailReader;
  channel?: ApprovalChannel;          // absent on a quiet cycle: never constructed
  senderEmail: string;                // REQUIRED. Never defaulted. See below.
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  maxThreadsPerCycle?: number;        // default 400
  maxCallsPerMinute?: number;         // default 100
  dryRun?: boolean;
}
export interface ReplyCycleSummary {
  adopted: number; polled: number; newReplies: number; alreadyKnown: number;
  notified: number; unresolvable: number; skippedNoLease: boolean;
  cycleFailure?: string;
}
export async function runReplyCycle(deps: ReplyDeps): Promise<ReplyCycleSummary>;
```

`senderEmail` is **required and never defaulted**. If it were optional and defaulted, an unset `SENDER_EMAIL` would make `isOurs` false for every message and every one of Aditya's own follow-ups would be recorded as an inbound reply from a stranger. The CLI refuses to start without it, in the style of `createGmailApiSender`'s missing-credential error (`gmail-api.ts:33-37`).

- [ ] **Step 1: Write the failing tests**

Create `test/replies-cycle.test.ts`. Cover, at minimum, every case in spec Verifications 3, 3a, 3b, 3c, 3d, 3e, 4, 4a, 5, 5a and 6. The load-bearing ones, with the reasoning that makes each non-optional:

```ts
// Blocker 1, in test form. An auto_reply keeps the thread OPEN by design, so
// the SAME gmail_message_id is fetched again every cycle forever. Under a plain
// INSERT that throws inside the per-thread transaction, rolling back
// last_polled_at, next_poll_at, watch_state and poll_failures with it: the row
// stays due, throws again, and is unresolvable in five cycles. A single Monday
// out-of-office would blind the thread in about 30 hours, which is VERBATIM the
// outcome keeping it open exists to prevent.
it('sees an auto-reply three times as a NO-OP, then still detects the human reply', async () => {
  // cycles 1..3 with the same auto-reply fixture:
  //   exactly 1 replies row, kind 'auto_reply'
  //   watch_state still 'open'
  //   poll_failures still 0
  //   last_polled_at and next_poll_at ADVANCE every cycle
  //   zero notifications
  // cycle 4 with a human reply added: detected, thread now 'replied', 1 notify
});

// Blocker 2, in test form.
it('a cycle-wide failure touches NO row and destroys nothing', async () => {
  // 10 due threads, reader throws 401 on the first call.
  // Assert: every poll_failures is 0, every watch_state is 'open',
  //         consecutiveCycleFailures is 1, the cycle returned early.
  // Repeat 5 times: still 10 rows open. Under the old design all 10 are
  // unresolvable and the feature has deleted its own reason to exist.
});

it('a 404 on ONE thread is charged to that thread and to nothing else', async () => {
  // thread 3 404s, the other 9 succeed.
  // Assert: thread 3 unresolvable, the other 9 polled, cycle failures 0.
});

it('five consecutive thread-scoped failures mark that row unresolvable, and a success resets', async () => {});

// The ordering that makes exactly-once implementable at all. Inserting then
// notifying loses the notification on a crash between the two; notifying then
// inserting repeats it forever on the same crash.
it('does not set notified_at when notify throws, and notifies exactly once across both runs', async () => {});

it('never constructs a channel on a quiet cycle', async () => {
  // deps.channel is a getter that throws if read. A quiet cycle must not touch
  // it: on a quiet night the job never connects to Spectrum at all.
});

it('writes nothing at all under --dry-run, but still reports what it WOULD do', async () => {
  // Both halves. A dry run that reports nothing passes the "wrote nothing"
  // half trivially, which is why spec Verification 2b was rewritten.
});

it('logs no address, no subject and no snippet, even when the reader throws a Gaxios-shaped error', async () => {
  // Capture the injected log. Assert it contains neither the address nor
  // 'googleapis.com'.
});

it('paces at maxCallsPerMinute using the INJECTED sleep, so the suite stays fast', async () => {});

it('honours maxThreadsPerCycle, and the overflow is simply due next run', async () => {});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/replies-cycle.test.ts` → FAIL, module not found.

- [ ] **Step 3: Create `src/pipeline/replies.ts`**

The structure, with the invariants that must not be reorganised away:

```ts
export async function runReplyCycle(deps: ReplyDeps): Promise<ReplyCycleSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));

  // 1. Lease. A loser exits 0 and is NEITHER a success NOR a failure: it must
  //    not touch consecutive_cycle_failures or the 3-cycle alarm would fire on
  //    three hand-runs during a scheduled cycle.
  if (!acquireLease(deps.db, process.pid, now())) {
    log('another reply cycle holds the lease; exiting');
    return { ...empty, skippedNoLease: true };
  }
  try {
    // 2. Adopt, at the head of every cycle, zero API calls. Logged even at 0:
    //    a persistently non-zero N means recordSentThread is failing.
    const adopted = deps.dryRun ? 0 : adoptOrphanedSends(deps.db);
    log(`adopted ${adopted} sends with no watch row`);
    log(`unresolvable: ${countUnresolvable(deps.db)}`);

    // 3. Poll. ONE await per thread, then ONE synchronous transaction for that
    //    thread. Per-thread rather than per-cycle, so a failure on thread 200
    //    cannot discard the 199 already resolved. better-sqlite3 transactions
    //    are synchronous: a db.transaction() whose body awaits does not hold
    //    the transaction across the await, so wrapping network I/O in one is a
    //    category error, not a slow path.
    for (const t of selectDueThreads(deps.db, deps.maxThreadsPerCycle ?? 400)) {
      let messages: ThreadMessage[];
      try {
        messages = await deps.reader.getThreadMetadata(t.threadId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown error';   // NEVER the object
        if (classifyFailure(e) === 'cycle') {
          // ABORT. Touch no row's poll_failures. Record OUTSIDE any aborted
          // transaction, or the counter rolls back with it.
          const { shouldNotify, consecutive } = recordCycleFailure(deps.db, msg);
          if (shouldNotify) { await notifyFailure(consecutive, msg); markFailureNotified(deps.db); }
          return { ...summary, cycleFailure: msg };
        }
        bumpThreadFailure(deps.db, t.draftId, now());   // per-thread only; 5 -> unresolvable
        continue;
      }
      if (!deps.dryRun) persistThread(deps.db, t, messages, deps.senderEmail, now());
      await pace();
    }

    // 4. Notify, then mark. A crash between them re-notifies AT MOST ONCE on
    //    the next cycle, which is the correct direction: a duplicate text about
    //    a real reply is recoverable, a silently dropped one is not.
    //    notified_at is set on EVERY covered row, including the ones folded
    //    into the `and N more` tail, or a 12-reply cycle re-notifies the
    //    unnamed 7 forever.
    const pending = selectUnnotified(deps.db);   // notified_at IS NULL AND kind IN ('human','bounce')
    if (pending.length && !deps.dryRun) {
      for (const [text, ids] of buildNotices(pending)) {
        await deps.channel!.notify(text);
        markNotified(deps.db, ids);
      }
    }

    recordCycleSuccess(deps.db);
    return summary;
  } finally {
    releaseLease(deps.db);
    // A leaked Photon connection means the process never exits and launchd
    // never schedules this job again: a leak does not degrade the feature, it
    // silently stops it forever. close() is on ApprovalChannel
    // (channel.ts:51), implemented at photonChannel.ts:373.
    await deps.channel?.close?.();
  }
}
```

`persistThread` is the one synchronous transaction:

```ts
const persistThread = db.transaction((t, messages, senderEmail, now) => {
  for (const m of messages) {
    if (m.id === t.sentMessageId) continue;                  // our own message
    if (isOurs(m.headers.from ?? '', senderEmail)) continue;  // our own follow-up
    // ON CONFLICT DO NOTHING: a repeat sighting is a NORMAL no-op. It is the
    // expected steady state for every thread carrying an auto-reply, forever.
    const res = db.prepare(
      `INSERT INTO replies (draft_id, person_id, gmail_message_id, thread_id, from_address, received_at, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(gmail_message_id) DO NOTHING`,
    ).run(t.draftId, t.personId, m.id, m.threadId,
          extractAddress(m.headers.from ?? ''), fromInternalDate(m.internalDate),
          classifyKind(m.headers));
    if (res.changes === 1) summary.newReplies++; else summary.alreadyKnown++;
  }
  // ONLY a human reply may close a thread. An auto_reply or a bounce leaves it
  // OPEN: if a Monday out-of-office moved the row out of 'open', the real reply
  // arriving the following week would never be seen.
  const tier = nextPollAt(new Date(t.sentAt + 'Z'), now);
  db.prepare(
    `UPDATE sent_threads
        SET last_polled_at = ?, poll_failures = 0, next_poll_at = ?, watch_state = ?
      WHERE draft_id = ?`,
  ).run(toSqlTime(now), 'next' in tier ? tier.next : toSqlTime(now),
        sawHuman ? 'replied' : 'close' in tier ? 'closed_no_reply' : 'open', t.draftId);
});
```

- [ ] **Step 4: Extend `test/notify-tapback-safety.test.ts`'s `SOURCES`**

Add `'src/pipeline/replies.ts'` to the array at line 21. **Necessary and not sufficient**, which Task 4's mutation already demonstrated: that test's predicate matches only an inline template literal at a `notify(` call site, and every format here arrives as a variable.

- [ ] **Step 5: Run the tests, the full suite, and typecheck**

Run: `npx vitest run test/replies-cycle.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → still exactly 2 pre-existing failures
Run: `npm run typecheck`

- [ ] **Step 6: Mutate to prove the tests can fail**

Five mutations, all mandatory. Each maps to a blocker or a must-fix:
1. Remove `ON CONFLICT(gmail_message_id) DO NOTHING`. Confirm the auto-reply repeat test goes RED on cycle 2, with `next_poll_at` still at the cycle-1 value and `poll_failures` at 1. That rollback IS blocker 1. Restore.
2. Classify a 401 as thread-scoped (in the cycle, not in `classifyFailure`, so Task 2's test cannot cover it). Confirm 10 rows go `unresolvable` and the cycle-wide test goes RED. Restore.
3. Swap step 4 to mark-then-notify. Confirm the crash test goes RED (`notified_at` set with no notification delivered). Restore.
4. Mark `notified_at` only on the named rows, not the tail. Confirm the "next cycle sends nothing" assertion goes RED. Restore.
5. Change the per-thread `catch` to log `console.error(e)`. Confirm the privacy log test goes RED. Restore, confirm GREEN.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/replies.ts test/replies-cycle.test.ts test/notify-tapback-safety.test.ts
git commit -m "Add the reply poll cycle: lease, adopt, per-thread transaction, notify-then-mark"
```

---

### Task 10: The CLI command, and the error path that currently leaks

**Requires:** Task 9.

**Why:** `cli.ts:431` is `main().catch((e) => { console.error(e); process.exit(1); })`. Verified on Node 24: `console.error(err)` appends the error's own enumerable properties, so a `GaxiosError`'s `response.headers` (containing `From` addresses under `format=metadata`) and `config.url` land in `data/replies.err.log`, bypassing the "err.message only" rule that the entire privacy argument rests on. `console.error(e.stack)` prints the stack and nothing else.

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli-error-shape.test.ts` (new, small)

- [ ] **Step 1: Write the failing test**

The top-level handler is module-level code with no export, so test the shape rather than the wiring: assert that `src/cli.ts` contains no bare `console.error(e)` / `console.error(err)` on an error binding, the same static-scan approach `test/notify-tapback-safety.test.ts` uses and for the same reason (the failure is a FORMAT, and new call sites get added over time).

```ts
it('never prints a bare error object, which would dump a GaxiosError response', () => {
  const src = readFileSync(join(here, '..', 'src/cli.ts'), 'utf8');
  // console.error(e) and console.error(err) append own enumerable properties.
  expect(/console\.error\(\s*(e|err|error)\s*\)/.test(src)).toBe(false);
});
```

- [ ] **Step 2: Run and confirm failure** → FAIL, `cli.ts:432` matches today.

- [ ] **Step 3: Add `cmdReplies` and harden the handler**

```ts
// `replies [--dry-run] [--backfill] [--rearm all|<draftId>...]`
async function cmdReplies(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const senderEmail = process.env.SENDER_EMAIL;
  // Fail loud, with the remedy, exactly like createGmailApiSender
  // (gmail-api.ts:33-37). Never degrade to a silent no-op: without this the
  // job would treat every message as inbound, including Aditya's own
  // follow-ups, and write fabricated ground truth.
  if (!senderEmail) throw new Error('SENDER_EMAIL is not set; the reply poller refuses to start without it');

  const db = openDb(DB_PATH);
  if (argv.includes('--rearm')) { console.log(`re-armed ${rearmUnresolvable(db, parseRearmIds(argv))} threads`); return; }

  const reader = createGmailReader();
  if (argv.includes('--backfill')) await backfillThreadIds(db, reader);

  // A dry run constructs NO channel at all, and a quiet cycle never connects to
  // Spectrum either: the channel is created lazily, only when there is
  // something to say.
  let channel: ApprovalChannel | undefined;
  try {
    const summary = await runReplyCycle({
      db, reader, senderEmail, dryRun,
      channel: dryRun ? undefined : await lazyChannel(),
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    // cmdReplies owns its own catch and never lets a Gaxios error reach the
    // top-level handler, where console.error(e) would print the response
    // headers and the request URL into data/replies.err.log.
    console.error(e instanceof Error ? e.message : 'unknown error');
    process.exitCode = 1;
  } finally {
    await channel?.close?.();
  }
}
```

Register it in `main`'s dispatch beside `loop`, `listen` and `stranded`, and add it to the `usage:` string. Then harden the top-level handler:

```ts
main().catch((e) => {
  // .stack, not the object. console.error(e) appends own enumerable
  // properties, which on a GaxiosError means response.headers (From addresses
  // under format=metadata) and config.url. Verified on Node 24. Keeping the
  // stack preserves what every other command relies on for debugging and drops
  // only the appended dump.
  console.error(e instanceof Error ? (e.stack ?? e.message) : 'unknown error');
  process.exit(1);
});
```

- [ ] **Step 4: Run the tests, the full suite, and typecheck**

- [ ] **Step 5: Mutate**

Restore `console.error(e)` and confirm the shape test goes RED. Restore.

Then verify the leak claim by hand, once, so the reasoning is not taken on faith:

```bash
node -e "const e=new Error('boom'); e.response={headers:{from:'X <secret@uni.edu>'}}; e.config={url:'https://gmail.googleapis.com/x'}; console.error(e); console.error('---'); console.error(e.stack)"
```

The first print must contain `secret@uni.edu`; the second must not. Paste both into the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli-error-shape.test.ts
git commit -m "Add outreach replies, and stop the CLI printing a bare error object"
```

---

### Task 11: `scripts/gmail-auth.ts` gains a scope argument, without a footgun

**Why:** Three changes, not one. The earlier draft of the spec said only that the script "gains an optional scope argument", which would have left a live footgun: a user who completes a `gmail.metadata` consent and then follows the script's own printed instruction overwrites **the only working send credential** with a token that cannot send.

**Files:**
- Modify: `scripts/gmail-auth.ts`
- Test: none. `tsconfig.json` includes only `src/**` and `test/**`, and this file is top-level module code with no exports. Verify by demonstration instead, exactly as Tasks 9 and 10 of the address-correction plan did.

- [ ] **Step 1: Add the scope argument (`gmail-auth.ts:26`)**

```ts
// Default unchanged, so the documented invocation keeps working verbatim.
const SCOPES: Record<string, string> = {
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'gmail.metadata': 'https://www.googleapis.com/auth/gmail.metadata',
};
const requested = (process.argv.find((a) => a.startsWith('--scope='))?.split('=')[1]) ?? 'gmail.send';
const scope = SCOPES[requested];
if (!scope) throw new Error(`unknown scope ${requested}; expected one of ${Object.keys(SCOPES).join(', ')}`);
// A read scope must never be pasted over the send credential.
const envVar = requested === 'gmail.send' ? 'GMAIL_OAUTH_REFRESH_TOKEN' : 'GMAIL_OAUTH_READ_REFRESH_TOKEN';
```

- [ ] **Step 2: Make the printed variable name follow the scope (`gmail-auth.ts:52`)**

Line 52 currently prints a hardcoded `GMAIL_OAUTH_REFRESH_TOKEN=`. Replace with `envVar`, and print the scope actually obtained on the same screen so the paste is self-checking:

```ts
    console.log(`\nSuccess. Scope granted: ${scope}`);
    console.log(`Add this line to outreach/.env:\n`);
    console.log(`${envVar}=${tokens.refresh_token}\n`);
    if (envVar !== 'GMAIL_OAUTH_REFRESH_TOKEN') {
      console.log('Do NOT paste this over GMAIL_OAUTH_REFRESH_TOKEN. This token cannot send.\n');
    }
```

- [ ] **Step 3: Fix the "revoke and re-run" advice (`gmail-auth.ts:47`)**

"Revoke the app at myaccount.google.com/permissions and re-run" revokes the OAuth **client** for the **account**, killing `GMAIL_OAUTH_REFRESH_TOKEN` as collateral. `prompt: 'consent'` is already set (`gmail-auth.ts:25`) and is what actually forces a refresh token, so the correct remedy is to re-run:

```ts
      console.error(
        'No refresh token returned. Re-run this script: prompt=consent is already set, which is what forces one. ' +
          'Do NOT revoke the app at myaccount.google.com/permissions: that revokes the OAuth client for the whole ' +
          'account and kills GMAIL_OAUTH_REFRESH_TOKEN with it, which is the only working send path (ASU Workspace ' +
          'blocks SMTP app passwords). If you revoke anyway, re-mint the send token first.',
      );
```

- [ ] **Step 4: Update the header comment**, which currently documents `gmail.send` as the only scope, and note the new invocation `npx tsx --env-file=.env scripts/gmail-auth.ts --scope=gmail.metadata`.

- [ ] **Step 5: Offline verification**

Run `npx tsx scripts/gmail-auth.ts --scope=gmail.bogus` and confirm it throws with the list of valid scopes. Run `npx tsx --env-file=.env scripts/gmail-auth.ts --scope=gmail.metadata` and **read the printed auth URL without opening it**: confirm it contains `scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.metadata` and `prompt=consent`. Ctrl-C. Paste the URL's scope parameter into the commit body. `npm run typecheck` must stay clean.

- [ ] **Step 6 (LIVE, needs Google credentials): actually mint the token**

This is spec Verifications 0, 0b and 0c, and it is **the only part of Tasks 1 to 11 that cannot run offline**. In order:
- **0b first.** Read the OAuth consent screen's user type and publishing status in the Google Cloud Console and record both in the spec. It comes first because it changes what 0 is likely to find: an **Internal** user type (ASU is a Workspace org) makes a restricted scope straightforward, while **External + Published (unverified)** makes it hardest.
- **0.** Complete the `gmail.metadata` consent, confirm a refresh token comes back, confirm it can call `users.threads.get` on one real thread, and confirm it is **refused** on `users.messages.send`. If Google refuses the grant, Tasks 12 and 13 are blocked and the spec needs revision, not a workaround.
- **0c.** With the new token in `.env` and `GMAIL_OAUTH_REFRESH_TOKEN` byte-identical to before, run one real `outreach add <arxiv-id> --to-self` and confirm it sends. The two refresh tokens are separate strings but are issued by the same OAuth client to the same account, so the consent grant is shared state. This is the single check the whole "cannot break sending" claim rests on.

- [ ] **Step 7: Commit**

```bash
git add scripts/gmail-auth.ts
git commit -m "Let gmail-auth.ts mint a read token without overwriting the send credential"
```

---

### Task 12: The third launchd job

**Requires:** Task 10. **Needs this machine; cannot be verified in CI.**

**Files:**
- Create: `scripts/com.aditya.outreach-replies.plist`

- [ ] **Step 1: Write the plist**

Model it on `scripts/com.aditya.outreach.plist` exactly: absolute node path (`REPLACE_WITH_NODE_PATH`), `node_modules/tsx/dist/cli.mjs` directly rather than the `.bin` shim, `--env-file=.env`, `src/cli.ts`, `replies`, `WorkingDirectory`, `PATH` including `/opt/homebrew/bin`, `Umask` 63, `data/replies.log` and `data/replies.err.log`, and `RunAtLoad` **false**.

The `.bin` shim and the missing Homebrew PATH are not hypothetical: the listener job hit exactly that, exiting 127 with no PID, which is why both existing plists invoke node absolutely.

`RunAtLoad` is false so that installing the plist does not immediately fire a live Gmail read.

The schedule is an **array** of `StartCalendarInterval` dictionaries:

```xml
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>30</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>30</integer></dict>
  </array>
```

Add a comment recording **why this key and not `StartInterval`**, quoted from `man 5 launchd.plist`: `StartInterval` says "If the system is asleep during the time of the next scheduled interval firing, that interval will be missed due to shortcomings in kqueue(3)", while `StartCalendarInterval` says "Unlike cron which skips job invocations when the computer is asleep, launchd will start the job the next time the computer wakes up." On a laptop that sleeps overnight, a 4-hour `StartInterval` silently drops most of its night cycles.

Add a second comment recording that the **array** form is documented but is **not** proven in this repo: `com.aditya.outreach.plist:29-35` uses a single dictionary. Step 2 is what proves it.

- [ ] **Step 2: Install, load, and READ THE SCHEDULE BACK**

```bash
sed -e "s|REPLACE_WITH_NODE_PATH|$(which node)|" \
    -e "s|REPLACE_WITH_ABSOLUTE_PATH|$(cd .. && pwd)|" \
    scripts/com.aditya.outreach-replies.plist > ~/Library/LaunchAgents/com.aditya.outreach-replies.plist
launchctl load ~/Library/LaunchAgents/com.aditya.outreach-replies.plist
launchctl print gui/$(id -u)/com.aditya.outreach-replies | grep -i -A 20 'calendar'
```

**Do not proceed until all four fire times appear.** `launchctl` is quiet about a plist it half-understood, and if only one interval registered, the job runs once a day while the `+4 hours` age tier assumes it runs four times. Paste the output into the commit body.

- [ ] **Step 3: Run the rest of the deploy checklist**

Spec Deploy steps 1, 2, 3 and 5, in order:
1. `GMAIL_OAUTH_READ_REFRESH_TOKEN` in `.env`; `GMAIL_OAUTH_REFRESH_TOKEN` unchanged; `SENDER_EMAIL` set.
2. `npx tsx --env-file=.env src/cli.ts stranded` to reopen the database, then `sqlite3 data/outreach.db ".tables"` must list all three new tables and `SELECT count(*) FROM reply_poll_state` must be 1.
3. **`npx tsx scripts/check-listener-fresh.ts --restart`.** Not optional and not deferrable. `com.aditya.outreach-listen` is `KeepAlive` true and holds its process for days; it executes `performApprovedSend`, which Task 7 modified, and `openDb` execs `schema.sql` only at open (`db.ts:19`), so `sent_threads` does not exist on that connection. Without the restart the listener runs the old code AND, once restarted into new code without a reopen, would throw `no such table` into the swallow. Re-run without `--restart` and confirm it reports fresh and exits 0. **This exact failure already happened once**, on 2026-08-04: three tasks shipped, 606 tests passed, and a live probe returned the old behavior.
5. One hand-run cycle, then read `data/replies.log`: the adopt count (`adopted 56 sends with no watch row` on the first run), the unresolvable count, an empty `data/replies.err.log`, `last_success_at` set and `consecutive_cycle_failures` 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/com.aditya.outreach-replies.plist
git commit -m "Add the reply-polling launchd job on a four-a-day calendar schedule"
```

---

### Task 13: Demonstrate the whole path against the live system

**Requires:** Tasks 1 to 12 merged and deployed. **Needs live Google credentials, a second Gmail account, and this machine.**

**Why:** Project rule: verification by demonstration, not assertion. This repo has shipped a green test suite that agreed with wrong code more than once. The Semantic Scholar source returned zero for its entire life because the fixture wrote the same wrong key the implementation read. A one-year timeout silently became 1ms. Batch-versus-push delivery semantics were invisible to the suite. A launchd PATH failure was invisible and obvious within seconds of a live run.

- [ ] **Step 1: Back up the database**

```bash
cp data/outreach.db data/outreach.backup-prereplies-$(date +%H%M%S).db
```

- [ ] **Step 2: Confirm the suite**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
npm run typecheck
```

Exactly the 2 pre-existing `test/draft.test.ts` failures. No others.

- [ ] **Step 3: Live end-to-end (spec Verification 1)**

The earlier draft of the spec said to send via `--to-self` and reply "from a different Gmail account", which is not executable: `--to-self` sends to `SENDER_EMAIL` (`cli.ts:391-392`), so the second account was never a participant and has nothing to reply to. Gmail threads on `In-Reply-To`/`References`, not on address. The executable sequence, one thread:

1. `npx tsx --env-file=.env src/cli.ts add <arxiv-id> --to-self`
2. `npx tsx --env-file=.env src/cli.ts replies`. Assert a `sent_threads` row with a non-NULL `thread_id` and **no** `replies` row: the only message in the thread is ours.
3. In that mailbox, hit **Reply** on the message and **add a second Gmail address as a recipient**. This does two things at once: it puts a `From: Aditya Gupta <apgupta3@asu.edu>` message into the thread, and it seeds the `References` chain into the second account.
4. From the second account, **Reply** to what it received. That reply carries the chain and lands in the original thread.
5. `npx tsx --env-file=.env src/cli.ts replies` again. Assert **exactly one** `replies` row, `from_address` is the second account and **not** `SENDER_EMAIL`, the thread is now `replied`. Show the actual iMessage text.

Step 3's self-sent message is the old Verification 1b, folded in and made strictly stronger: both messages are now in the same `threads.get` response, so the poller has to tell them apart in one pass. **That single row count of 1 is the assertion that the system is not fabricating its own ground truth.**

- [ ] **Step 4: Tapback the notification (Task 5, live)**

Thumbs up the `Reply from ...` message and confirm the hint arrives. Silence here means the branch is not wired into the **listener**, which is a different process from the one that just ran, and the most likely cause is a missed restart.

- [ ] **Step 5: Live backfill (spec Verification 2)**

```bash
npx tsx --env-file=.env src/cli.ts replies --backfill
```

Report the actual numbers: how many of the 56 resolved to a `threadId`, how many threads already contain an inbound message, and the `kind` breakdown. **This is the payoff.** It either answers the motivating question immediately or proves nobody has answered yet.

Read the result out loud with the caveat attached: the oldest send is about 7.7 days old and academics answer cold email on week-to-month timescales, so an early zero is not evidence that the hooks do not work. That is also why the close window is 60 days rather than 30.

- [ ] **Step 6: Live dry run against a thread known to contain a reply (spec Verification 2b)**

Reset the Verification 1 row, then dry-run it, and assert **both halves**:

```bash
sqlite3 data/outreach.db "UPDATE sent_threads SET watch_state='open', next_poll_at=datetime('now') WHERE draft_id=$D; DELETE FROM replies WHERE draft_id=$D;"
sqlite3 data/outreach.db "SELECT count(*) FROM replies; SELECT last_polled_at FROM sent_threads WHERE draft_id=$D;"
npx tsx --env-file=.env src/cli.ts replies --dry-run
sqlite3 data/outreach.db "SELECT count(*) FROM replies; SELECT last_polled_at FROM sent_threads WHERE draft_id=$D;"
```

The stdout must say it **would** record one human reply from the second account, **and** the before/after must be byte-identical. Asserting only "nothing changed" passes trivially if the command reads nothing, finds nothing, or crashes early, which is why the spec's earlier version of this check could not fail.

- [ ] **Step 7: Dump the state**

```bash
sqlite3 -header -column data/outreach.db "
  SELECT watch_state, count(*), min(last_polled_at), max(next_poll_at) FROM sent_threads GROUP BY watch_state;
  SELECT kind, count(*), sum(notified_at IS NOT NULL) AS notified FROM replies GROUP BY kind;
  SELECT draft_id, from_address, received_at, kind, notified_at FROM replies ORDER BY id DESC LIMIT 10;
  SELECT * FROM reply_poll_state;"
```

Assert by eye: every `next_poll_at` and `received_at` matches `YYYY-MM-DD HH:MM:SS` with **no `T` and no `Z`**. This is the last line of defence on the timestamp bug, and it is visible in one glance.

- [ ] **Step 8: Confirm the poller is actually scheduled**

Wait for one scheduled fire time and confirm `data/replies.log` gained a cycle without anyone running anything. A poller that only works when run by hand is the silent-death mode this whole design is built against, and it is the one thing no test can prove.

---

## Self-Review

**Spec coverage.** Change 1 → Task 11 (all three script changes) and Task 2 (`GMAIL_OAUTH_READ_REFRESH_TOKEN` consumption). Change 2 → Task 6 (`recordSentThread`, `adoptOrphanedSends`, the Gmail-shape guard) and Task 7 (the sender seam, `markSent`, both call sites, the placement outside the try). Change 3 → Task 1 (all three tables, the canonical timestamp) and Task 8 (`reply_poll_state`'s semantics). Change 4 → Task 3 (extraction and classification), Task 2 (`classifyFailure`), Task 6 (cadence, `rearmUnresolvable`), Task 9 (the conflict-ignoring insert, the per-thread transaction). Change 5 → Task 9 (lease, injected seams, dry-run, per-thread persistence), Task 10 (the error path), Task 12 (the plist). Change 6 → Task 4 (formats, coalescing, the name cap, the recognizer), Task 5 (the hint branch), Task 9 (notify-then-mark, the alarm). Change 7 → Task 2 (the boundary projection) and Task 9 (the logging rule). Verifications 0/0b/0c → Task 11 Step 6. Deploy 1 to 5 → Task 12 Steps 2 and 3. Verifications 1, 2, 2b → Task 13. Verifications 3 through 8 → Tasks 1 through 9's test steps. No spec section is unimplemented.

**The five blockers, and where each is closed.**
1. Conflict-ignoring insert → Task 1 (the constraint plus a `changes === 0` test), Task 9 (the statement, mutation 1).
2. Failure scope → Task 2 (`classifyFailure` plus its test), Task 9 (the abort path, mutation 2), Task 6 (`rearmUnresolvable`).
3. The unimplementable alarm → Task 8, on an **on-disk** database across three separate opens, with the module-variable mutation reproducing the bug.
4. The timestamp format → Task 1, with the round-trip test through the real selection query and the explicit demonstration that a `julianday` test passes under the bug.
5. The stale listener → Task 12 Step 3, and recorded as a behavioral change and a risk in the spec.

**Placeholders.** Task 9's code block is a structural sketch rather than a full file, deliberately: it is the only module long enough that transcribing it here would obscure the invariants, which are called out inline instead. Every other code step carries real code. Task 11 has no automated test because `tsconfig.json` includes only `src/**` and `test/**` and the file is top-level module code with no exports; it gets an offline demonstration (the auth URL's scope parameter) plus a live one.

**Type consistency.** `ThreadMessage` / `GmailReader` / `FailureScope` are defined in Task 2 and consumed in Task 9. `ReplyKind` / `extractAddress` / `isOurs` / `classifyKind` are defined in Task 3 and consumed in Task 9. `ReplyNotice` / the three formatters / `replyNoticeTapbackHint` are defined in Task 4 and consumed in Tasks 5 and 9. `toSqlTime` / `fromInternalDate` / `addHours` are defined in Task 1 and consumed in Tasks 6, 8 and 9. `DueThread` / `nextPollAt` / `recordSentThread` are defined in Task 6 and consumed in Tasks 7 and 9. Everything in Task 8 is consumed only by Task 9. `Sender.send`'s `threadId` and `markSent`'s fourth parameter are both **optional**, and `npm run typecheck` in Task 7 Step 6 is the real assertion that they stayed that way.

**Known risks to watch during implementation.**
- **Task 7 is the only task that touches the irreversible path.** If any existing send test needs editing, something became required that should have stayed optional. Fix the type, not the test.
- **Task 9's `persistThread` must stay synchronous.** better-sqlite3 transactions do not hold across an `await`, so an `await` inside that function is silently not transactional. If a reviewer suggests awaiting inside it, that is the category error the spec names.
- **Task 8's tests must not be moved to `':memory:'`.** They would pass and prove the opposite of what is needed: two `':memory:'` handles share nothing, which is exactly the property being tested for, so the test would go green under the module-variable bug.
- **`sent_at` is read back into a `Date` in Task 9's cadence call.** `new Date('2026-08-04 10:00:00')` is parsed as **local time** by V8, not UTC. Append `'Z'` or parse explicitly; getting this wrong shifts every age tier by the local offset (7 hours in Arizona) and would not fail any test that also builds its expectation the same way. Assert one tier boundary against a hardcoded string, not against a round trip.
- **The 2 pre-existing `test/draft.test.ts` failures.** Do not fix them here and do not let them mask a new one. Count failures, not just the pass total.
