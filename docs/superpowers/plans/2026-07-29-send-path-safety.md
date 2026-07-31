# Send Path Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the one irreversible action this system can take, sending a real cold email from Aditya's ASU account, at-most-once, to the address a human actually approved, with headers that cannot be forged.

**Architecture:** Every send is now a two-phase operation. Phase one is a durable claim (`drafts.send_attempted_at`, written and committed BEFORE the network call, in one conditional UPDATE that is atomic across the batch process and the listener daemon). Phase two is the network call. Nothing automatically retries a claimed send, ever: an unconfirmed send is reported to Aditya once and waits for a human. The recipient is frozen into `drafts.to_email` at draft creation, next to the already-frozen subject and body, and a send refuses if the person's current address has drifted away from that snapshot. Both senders validate outbound headers and reject, rather than strip, anything containing CR, LF, or NUL.

**Tech Stack:** TypeScript ESM on Node, better-sqlite3 (synchronous, WAL, busy_timeout 5000ms), vitest.

**Defect source:** independent review of the send path, defects D1 through D7 (reproduced verbatim in each task below).

---

## Global Constraints

These are hard. An implementer who is unsure should stop and ask rather than choose.

- **No em dashes.** The character U+2014 must not appear in any file, comment, commit message, test string, or notification text this plan produces. Use commas, colons, or parentheses. This is hook-enforced and will fail the commit.
- **Explicit `.js` import extensions** on every relative import (`import { openDb } from '../db/db.js'`), matching the existing ESM codebase.
- **better-sqlite3 is synchronous.** Never `await` a statement. Never hold a `db.transaction(...)` across an `await`. Every transaction in this plan is a pure synchronous function; the network call always happens OUTSIDE any transaction, after the claiming transaction has committed.
- **No test may touch the network or call a real LLM.** Senders in tests are `vi.fn()` fakes, or real sender factories fed fake credentials whose `send` throws before any transport call.
- **`noUncheckedIndexedAccess` is on.** Index access yields `T | undefined`; handle it or use a non-null assertion only where the surrounding code proves it.
- **331 tests pass today.** Do not weaken any of them. Exactly one existing test asserts the defective behavior this plan removes (`test/loop.test.ts`, "retries an approved-but-unsent draft on the next run"); Task 6 replaces it with a test of the corrected behavior and explains why. No other existing test may be edited, deleted, or loosened.
- **Run `npm test` and `npm run typecheck` from `outreach/`.**
- **Commit after every task.**

### Safety invariants that must visibly hold at the end of every task

| Invariant | Where this plan holds it |
| --- | --- |
| Nothing sends without an explicit human approval | `beginSendAttempt` only claims a draft already at `status = 'approved'`, which only `decide(..., 'send', ...)` produces, which only a human reply or a human CLI answer calls. No code path in this plan promotes a draft into `approved`. |
| Never email the same person twice | Untouched: `priorThreads` (F9) still runs before drafting and before every emit. This plan adds no new path that can create a second thread. |
| **Never send the same email twice** | Task 2: the `send_attempted_at` claim is committed before the network call, and Task 4 deletes the only automatic retry in the system. |
| A dry run sends nothing and texts nothing | Task 5: the `dryRun` check moves ahead of `decide`, so a dry run writes no decision, claims no send, and calls no sender. |
| Ambiguity resolves toward doing nothing | Every new refusal path (recipient drift, missing snapshot, unsafe header, already-attempted) refuses, records why, notifies, and waits for a human. None of them guesses. |

### Scope

**Files this plan changes:** `outreach/src/db/schema.sql`, `outreach/src/db/db.ts`, `outreach/src/approval/ledger.ts`, `outreach/src/sender/types.ts`, `outreach/src/sender/gmail-api.ts`, `outreach/src/sender/gmail.ts` (two lines, see below), and `outreach/src/pipeline/loop.ts` (only `handleReply`, the deleted `retryApprovedUnsent`, `LoopSummary`, and the `runLoop` call site).

**`gmail.ts` scope note.** `gmail.ts` (the SMTP sender) is not in the reviewer's owned-file list, but D3 requires BOTH senders to be covered and no other plan owns it. The change to it is exactly one import and one call, no behavior change other than the refusal. If a concurrent plan is editing `gmail.ts`, coordinate; otherwise proceed.

**Files this plan must NOT change:** `src/pipeline/listen.ts`, `src/approval/photonChannel.ts`, `src/pipeline/research.ts`, `src/pipeline/intersect.ts`, `src/discovery/relevanceGate.ts`, `src/discovery/sources/**`, `src/cli.ts`. Other plans own them.

**Two consequences of not owning those files, which the implementer must respect:**

1. `listen.ts` builds a `LoopSummary` object literal (`freshSummary()`, line 47). Any **required** new field on `LoopSummary` breaks its compile. The new `stalled` counter is therefore declared **optional** (`stalled?: number`). Do not make it required.
2. `cli.ts` (the `outreach add` one-off) calls `sender.send` directly without the new claim. That is acceptable for this plan: `add` is interactive, synchronous, and human-supervised end to end, and it never runs concurrently with itself. It still gets the recipient snapshot for free (Task 3 puts the snapshot inside `persistDraft`, which `add` calls) and the header validation for free (Task 1 puts it inside the senders). Wiring `add` through `beginSendAttempt` belongs to whichever plan owns `cli.ts`. Note it, do not do it here.
3. `loop.ts`'s `emit`, `loadSendableDraft`, and the queued flush still read `people.email` for the address shown in the **iMessage to Aditya's phone**. This plan does not change them (they are outside the owned region of `loop.ts`). The consequence is covered, not ignored: if `people.email` drifts between the phone message and the approval, the send-time snapshot comparison in Task 3 refuses the send and notifies, rather than silently mailing either address. Whoever owns the messaging path should later switch it to `drafts.to_email`; until then the refusal is the backstop.

### The design decisions, stated once

**D1, at-most-once.** A new column `drafts.send_attempted_at` is the claim. `beginSendAttempt` sets it with a single conditional UPDATE (`WHERE id = ? AND status = 'approved' AND send_attempted_at IS NULL`) inside a transaction, and that transaction commits before any `await`. Whoever gets `changes === 1` owns the send; everyone else, in this process or the other one, gets `changes === 0` and refuses. This closes interleaving (a) (daemon and batch racing) and interleaving (b) (a send that times out after Gmail accepted it), because the claim is written before the network call and never cleared by a failure.

`retryApprovedUnsent` is deleted outright. It is replaced by `reportStalledApprovals`, which sends no email and only texts Aditya, at most once per attempt count.

**The tradeoff, stated explicitly.** A genuinely transient failure (Gmail 503, laptop offline mid-call) now needs a human to re-arm. The alternative, an automatic retry, cannot distinguish "Gmail never got it" from "Gmail got it, accepted it, and the response was lost", because `createGmailApiSender.send` has no idempotency key. One of those two outcomes is recoverable by hand in thirty seconds. The other one is a second real cold email to a stranger, which cannot be recovered at all. Aditya has consistently preferred doing nothing over acting wrongly, so the retry goes.

**Re-arming is a human action, and there are two levels of it.**
- Level 1, the common case: a send that failed **before** the claim (no grounded revision, recipient drift, unsafe subject, or the process died between `decide` and `beginSendAttempt`). The draft sits at `approved` with `send_attempted_at IS NULL`. Aditya simply texts `dN y` again. `handleReply` treats a repeat approval of an unclaimed approved draft as an explicit human re-approval and sends. This is the re-arm button, and it needs no new CLI surface.
- Level 2, the ambiguous case: a claim exists but no `sent` event. Nobody knows whether Gmail delivered it. Texting `dN y` again is refused. The human must check the Gmail Sent folder, and only then run the documented SQL in Task 8. This is deliberately more friction than a text message.

**D2, where the snapshot lives.** A `to_email` column on `drafts`, not on `revisions`. The recipient is a property of the outreach, not of a wording revision; a future edit path (F5) creates a new revision but must not create a new recipient. It is written by `persistDraft`, so every creator (loop and `outreach add`) gets it with no call-site change.

**If `people.email` differs from the snapshot at send time: refuse and notify, do not send.** Sending to the snapshot would honor what Aditya saw but mail an address the system now believes is wrong. Sending to the current address would mail an address no human ever approved. Both are actions taken under ambiguity. Refusing is the third option and the correct one: the draft stays `approved`, unclaimed, and one human decision resolves it.

**D3, strip versus reject: reject.** A subject containing CR or LF means something upstream is broken (prompt injection through an arXiv abstract is the known live vector). Stripping produces a plausible-looking email that hides the compromise. Rejecting produces a text message to Aditya saying a draft was refused as unsafe, which is exactly the signal wanted. The check lives in `src/sender/types.ts` as `assertSafeOutbound`, called by **both** `gmail-api.ts` and `gmail.ts` (so `cli.ts` and any future sender are covered too), and called a second time in `loop.ts` **before** the claim, so a poisoned subject does not burn the one-and-only send attempt.

**Schema constraint.** SQLite cannot ALTER a CHECK, and `openDb` applies `schema.sql` with `CREATE TABLE IF NOT EXISTS` on every open, so an edited CREATE TABLE body never reaches the live database. Nothing in this plan adds a `drafts.status` value; the five existing literals (`awaiting_approval`, `approved`, `sent (stubbed)`, `sent`, `skipped`) are untouched. All new state lives in new columns added by a guarded `ALTER TABLE ADD COLUMN`, following the worked example in `docs/spec-candidate-stranding.md` (CS10.1) exactly.

### File and symbol map

| File | Change |
| --- | --- |
| `src/sender/types.ts` | Add `UnsafeOutboundEmailError`, `assertSafeOutbound` |
| `src/sender/gmail-api.ts` | Call `assertSafeOutbound` first in `send` |
| `src/sender/gmail.ts` | Call `assertSafeOutbound` first in `send` |
| `src/db/schema.sql` | `drafts` gains `to_email`, `send_attempted_at`, `send_attempts` |
| `src/db/db.ts` | Add `migrateDrafts` guarded ALTER plus one-time backfill; call it from `openDb` |
| `src/approval/ledger.ts` | `persistDraft` snapshots `to_email`; add `loadApprovedSend`, `beginSendAttempt`, `stalledApprovals`, `stallAlreadyReported`, `markStallReported`; wrap `markSent`/`markSendFailed` in transactions |
| `src/pipeline/loop.ts` | `handleReply` dry-run guard first, single `performApprovedSend` helper, re-approval path; delete `retryApprovedUnsent`, add `reportStalledApprovals`; `LoopSummary.stalled?` |
| `test/send-path.test.ts` (new) | All new behavior |
| `test/loop.test.ts` | Replace the one test that asserts auto-retry (Task 6) |

---

### Task 1: Reject unsafe outbound headers (D3)

> **D3 [CRITICAL] EMAIL HEADER INJECTION VIA THE LLM-WRITTEN SUBJECT.** `gmail-api.ts:12` builds `` `Subject: ${email.subject}` `` and joins headers with `\r\n`. Nothing strips CR or LF from the subject. The subject is model output, and attacker-influenceable arXiv abstract text reaches that model. A `\r\nBcc: ...` in a subject silently adds headers to a real email.

**Files:**
- Modify: `outreach/src/sender/types.ts`
- Modify: `outreach/src/sender/gmail-api.ts`
- Modify: `outreach/src/sender/gmail.ts`
- Test: `outreach/test/send-path.test.ts` (create)

**Interfaces:**
- Produces: `UnsafeOutboundEmailError`, `assertSafeOutbound(email: OutboundEmail): void`

- [ ] **Step 1: Write the failing test**

Create `outreach/test/send-path.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assertSafeOutbound, UnsafeOutboundEmailError, type OutboundEmail } from '../src/sender/types.js';
import { createGmailApiSender } from '../src/sender/gmail-api.js';
import { createGmailSmtpSender } from '../src/sender/gmail.js';

const good = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  to: 'jane@uni.edu',
  from: 'apgupta3@asu.edu',
  subject: 'quick question on your rss-gap work',
  body: 'a body\nwith newlines, which are fine',
  draftShortId: 'd7',
  ...over,
});

describe('assertSafeOutbound', () => {
  it('accepts a normal email, including newlines in the body', () => {
    expect(() => assertSafeOutbound(good())).not.toThrow();
  });

  it('rejects a subject containing CRLF (header injection)', () => {
    expect(() => assertSafeOutbound(good({ subject: 'hi\r\nBcc: attacker@evil.example' }))).toThrow(
      UnsafeOutboundEmailError,
    );
  });

  it('rejects a subject containing a bare LF', () => {
    expect(() => assertSafeOutbound(good({ subject: 'hi\nBcc: attacker@evil.example' }))).toThrow(/newline/);
  });

  it('rejects a subject containing NUL', () => {
    expect(() => assertSafeOutbound(good({ subject: 'hi\u0000there' }))).toThrow(UnsafeOutboundEmailError);
  });

  it('rejects a newline in the recipient or the sender address', () => {
    expect(() => assertSafeOutbound(good({ to: 'jane@uni.edu\r\nBcc: x@y.z' }))).toThrow(UnsafeOutboundEmailError);
    expect(() => assertSafeOutbound(good({ from: 'a@b.c\nX-Spoof: 1' }))).toThrow(UnsafeOutboundEmailError);
  });

  it('rejects an address that is not a single plain address', () => {
    expect(() => assertSafeOutbound(good({ to: 'jane@uni.edu, other@uni.edu' }))).toThrow(/single address/);
    expect(() => assertSafeOutbound(good({ to: 'Jane <jane@uni.edu>' }))).toThrow(/single address/);
    expect(() => assertSafeOutbound(good({ to: 'not-an-address' }))).toThrow(/single address/);
  });

  it('rejects an empty subject and an absurdly long one', () => {
    expect(() => assertSafeOutbound(good({ subject: '   ' }))).toThrow(/empty/);
    expect(() => assertSafeOutbound(good({ subject: 'x'.repeat(501) }))).toThrow(/too long/);
  });

  it('rejects an empty body', () => {
    expect(() => assertSafeOutbound(good({ body: '' }))).toThrow(/empty/);
  });
});

// Both senders are constructed with fake credentials. assertSafeOutbound throws
// before either transport is touched, so these tests never reach the network.
describe('sender-level header guard', () => {
  it('the Gmail API sender refuses an injected subject before any network call', async () => {
    const sender = createGmailApiSender({ clientId: 'fake', clientSecret: 'fake', refreshToken: 'fake' });
    await expect(sender.send(good({ subject: 'hi\r\nBcc: attacker@evil.example' }))).rejects.toThrow(
      UnsafeOutboundEmailError,
    );
  });

  it('the SMTP sender refuses an injected subject before any network call', async () => {
    const sender = createGmailSmtpSender({ user: 'apgupta3@asu.edu', appPassword: 'fake fake fake' });
    await expect(sender.send(good({ subject: 'hi\r\nBcc: attacker@evil.example' }))).rejects.toThrow(
      UnsafeOutboundEmailError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/send-path.test.ts`
Expected: FAIL, `assertSafeOutbound` is not exported from `../src/sender/types.js`.

- [ ] **Step 3: Write the guard**

Replace `outreach/src/sender/types.ts` with:

```typescript
// Sender seam (spec AL11): the approval flow calls this interface; swapping the
// implementation (stub, Gmail SMTP, Gmail API) never touches approval code.
export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  body: string;
  draftShortId: string;
}

export interface Sender {
  send(email: OutboundEmail): Promise<{ sentId: string }>;
}

// D3. The subject is model output, and attacker-influenceable text (an arXiv
// abstract) reaches that model. A CR or LF in a header value ends the header
// and starts another one, so a subject of "hi\r\nBcc: x@y.z" silently adds a
// Bcc to a real, irreversible email.
//
// Reject, never strip. A newline in a subject means something upstream is
// wrong, and stripping it produces a plausible-looking email that hides the
// compromise. Refusing produces a notification, which is the signal wanted.
export class UnsafeOutboundEmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeOutboundEmailError';
  }
}

// CR, LF, NUL. Anything that can terminate or truncate a header line.
const HEADER_CONTROL = /[\r\n\u0000]/;

// Deliberately narrow: exactly one bare address, no display name, no comma, no
// angle brackets, no quoting. This system only ever sends to a single resolved
// academic address, so anything richer than that is a bug, not a feature.
const SINGLE_ADDRESS = /^[^\s<>,;:\\"]+@[^\s<>,;:\\"]+\.[^\s<>,;:\\"]+$/;

const MAX_SUBJECT_LENGTH = 500;

// Throws UnsafeOutboundEmailError rather than returning a boolean: every caller
// must fail closed, and a boolean invites an ignored return value.
export function assertSafeOutbound(email: OutboundEmail): void {
  const headerFields: ReadonlyArray<readonly [string, string]> = [
    ['to', email.to],
    ['from', email.from],
    ['subject', email.subject],
  ];
  for (const [field, value] of headerFields) {
    if (HEADER_CONTROL.test(value)) {
      throw new UnsafeOutboundEmailError(
        `refusing to send ${email.draftShortId}: ${field} contains a newline or NUL (header injection risk)`,
      );
    }
  }
  for (const [field, value] of [['to', email.to], ['from', email.from]] as const) {
    if (!SINGLE_ADDRESS.test(value)) {
      throw new UnsafeOutboundEmailError(
        `refusing to send ${email.draftShortId}: ${field} is not a single address (${value})`,
      );
    }
  }
  if (email.subject.trim().length === 0) {
    throw new UnsafeOutboundEmailError(`refusing to send ${email.draftShortId}: subject is empty`);
  }
  if (email.subject.length > MAX_SUBJECT_LENGTH) {
    throw new UnsafeOutboundEmailError(
      `refusing to send ${email.draftShortId}: subject is too long (${email.subject.length} > ${MAX_SUBJECT_LENGTH})`,
    );
  }
  // The body is not header context (it follows the blank line), so newlines in
  // it are legitimate. An empty body is still never intentional.
  if (email.body.trim().length === 0) {
    throw new UnsafeOutboundEmailError(`refusing to send ${email.draftShortId}: body is empty`);
  }
}
```

- [ ] **Step 4: Call it from both senders**

In `outreach/src/sender/gmail-api.ts`, change the import line and the first line of `send`:

```typescript
import { assertSafeOutbound, type OutboundEmail, type Sender } from './types.js';
```

```typescript
    async send(email: OutboundEmail): Promise<{ sentId: string }> {
      // D3: fail closed before building the raw RFC 2822 message, which is
      // where a CR or LF in the subject would become a real extra header.
      assertSafeOutbound(email);
      const res = await gmail.users.messages.send({
```

In `outreach/src/sender/gmail.ts`, the same two edits:

```typescript
import { assertSafeOutbound, type OutboundEmail, type Sender } from './types.js';
```

```typescript
    async send(email: OutboundEmail): Promise<{ sentId: string }> {
      // D3: nodemailer does its own header sanitation, but the guard belongs at
      // the seam so every present and future sender is covered identically.
      assertSafeOutbound(email);
      const info = await transport.sendMail({
```

- [ ] **Step 5: Run the tests**

Run: `cd outreach && npx vitest run test/send-path.test.ts`
Expected: PASS, 10 tests.

Run: `cd outreach && npm test && npm run typecheck`
Expected: `Tests  341 passed (341)`, typecheck silent (exit 0).

- [ ] **Step 6: Commit**

```
git add outreach/src/sender/types.ts outreach/src/sender/gmail-api.ts outreach/src/sender/gmail.ts outreach/test/send-path.test.ts
git commit -m "Reject, never strip, CR/LF in outbound email headers

The subject is model output and attacker-influenceable arXiv text reaches
that model, so a subject of \"hi\\r\\nBcc: x@y.z\" would have added a real
header to a real email. assertSafeOutbound lives at the Sender seam so both
gmail-api.ts and gmail.ts (and cli.ts through them) fail closed identically."
```

---

### Task 2: Schema and migration for the recipient snapshot and the send claim (D1, D2)

**Files:**
- Modify: `outreach/src/db/schema.sql`
- Modify: `outreach/src/db/db.ts`
- Test: `outreach/test/send-path.test.ts`

**Interfaces:**
- Produces: `drafts.to_email`, `drafts.send_attempted_at`, `drafts.send_attempts`; `migrateDrafts` (private to `db.ts`)

**Why an ALTER and not just the schema edit:** `openDb` runs `schema.sql` on every open with `CREATE TABLE IF NOT EXISTS`, which is a no-op against the existing `outreach/data/outreach.db`. An edit to the CREATE TABLE body therefore only ever reaches a fresh database. The guarded `ALTER TABLE ADD COLUMN` is the only thing that reaches the live one. This is the same mechanism documented in `docs/spec-candidate-stranding.md` CS10.1, and the reason the `drafts.status` CHECK cannot be extended (so nothing here adds a status value).

- [ ] **Step 1: Write the failing test**

Append to `outreach/test/send-path.test.ts` (and add the imports shown):

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertPerson } from '../src/db/db.js';
```

```typescript
// The live database predates these columns, and schema.sql cannot reach it
// (CREATE TABLE IF NOT EXISTS is a no-op on an existing table). This test
// builds a pre-migration drafts table by hand in a temp file, then opens it
// with openDb and asserts the guarded ALTER plus one-time backfill landed.
const LEGACY_DRAFTS_DDL = `
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  short_id TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  paper_arxiv_id TEXT,
  paper_title TEXT,
  intent TEXT,
  gist TEXT NOT NULL DEFAULT '',
  draft_input_json TEXT NOT NULL,
  sendable_revision_id INTEGER REFERENCES revisions(id),
  status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN
    ('awaiting_approval','approved','sent (stubbed)','sent','skipped')),
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);`;

describe('drafts migration', () => {
  it('adds the send-path columns to a pre-migration database and backfills them', async () => {
    const Database = (await import('better-sqlite3')).default;
    const path = join(mkdtempSync(join(tmpdir(), 'outreach-migrate-')), 'legacy.db');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, openalex_id TEXT UNIQUE,
        email TEXT, email_confidence REAL, email_source TEXT, affiliation TEXT, role TEXT,
        scholar_url TEXT, homepage_url TEXT, github_url TEXT, profile_summary TEXT,
        created_at TEXT, updated_at TEXT);
      ${LEGACY_DRAFTS_DDL}
      INSERT INTO people (id, name, email) VALUES (1, 'Jane Doe', 'jane@uni.edu');
      INSERT INTO drafts (id, short_id, person_id, draft_input_json, status, decided_at)
        VALUES (1, 'd1', 1, '{}', 'sent', '2026-07-01 12:00:00');
      INSERT INTO drafts (id, short_id, person_id, draft_input_json, status)
        VALUES (2, 'd2', 1, '{}', 'awaiting_approval');
    `);
    legacy.close();

    const db = openDb(path);
    const rows = db
      .prepare('SELECT id, to_email AS toEmail, send_attempts AS attempts, send_attempted_at AS attemptedAt FROM drafts ORDER BY id')
      .all() as { id: number; toEmail: string | null; attempts: number; attemptedAt: string | null }[];

    // Both drafts get the snapshot; only the already-sent one is recorded as
    // having consumed its send attempt.
    expect(rows[0]).toMatchObject({ toEmail: 'jane@uni.edu', attempts: 1 });
    expect(rows[0]?.attemptedAt).toBe('2026-07-01 12:00:00');
    expect(rows[1]).toMatchObject({ toEmail: 'jane@uni.edu', attempts: 0, attemptedAt: null });

    // Idempotent: opening again must not throw and must not re-backfill.
    db.close();
    const again = openDb(path);
    expect(
      (again.prepare('SELECT send_attempts AS a FROM drafts WHERE id = 1').get() as { a: number }).a,
    ).toBe(1);
    again.close();
  });

  it('a fresh database already has the columns from schema.sql', () => {
    const db = openDb(':memory:');
    const cols = new Set((db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((c) => c.name));
    expect(cols.has('to_email')).toBe(true);
    expect(cols.has('send_attempted_at')).toBe(true);
    expect(cols.has('send_attempts')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/send-path.test.ts`
Expected: FAIL, `no such column: to_email`.

- [ ] **Step 3: Add the columns to `schema.sql`**

In `outreach/src/db/schema.sql`, inside `CREATE TABLE IF NOT EXISTS drafts`, insert these three columns immediately after the `status` column and before `decided_at`:

```sql
  -- The approved recipient, frozen at draft creation next to the already-frozen
  -- subject and body in revisions (D2). people.email is mutable: upsertPerson
  -- coalesces a new non-null value in every time another paper by the same
  -- author is discovered, so resolving the address fresh at send time can mail
  -- an address no human ever approved. Guarded ALTER in db.ts covers a database
  -- created before this column existed.
  to_email TEXT,
  -- At-most-once send claim (D1). Written and COMMITTED BEFORE the network
  -- call, so a send that times out after Gmail accepted it still leaves the
  -- claim behind and no automatic path can re-send it. Never cleared by a
  -- failure; clearing it is a deliberate human act (see the send-path plan).
  send_attempted_at TEXT,
  send_attempts INTEGER NOT NULL DEFAULT 0,
```

Do not touch the `status` CHECK. No new status literal is introduced anywhere in this plan.

- [ ] **Step 4: Add the guarded migration to `db.ts`**

In `outreach/src/db/db.ts`, call the new migration from `openDb`:

```typescript
  db.exec(readFileSync(schemaPath, 'utf8'));
  migrateSeenPapers(db);
  migrateDrafts(db);
  return db;
```

and add, directly below `migrateSeenPapers`:

```typescript
// Same mechanism as migrateSeenPapers, for the send-path columns (D1/D2).
// schema.sql cannot reach an existing database, so this guarded ALTER is the
// only way to_email / send_attempted_at / send_attempts land on the live file.
// Idempotent, so it is safe on every open.
//
// The backfills run exactly once each, inside the branch that adds the column,
// so a later change to people.email can never silently rewrite a snapshot.
function migrateDrafts(db: DB): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has('to_email')) {
    db.exec('ALTER TABLE drafts ADD COLUMN to_email TEXT');
    // Pre-migration drafts were messaged to Aditya's phone with whatever
    // people.email held at message time, and nothing has changed those
    // addresses since (there is no address history to consult, so this is the
    // only defensible snapshot). Adopting the current value now is exactly the
    // behavior these drafts already had, and from this point on it is frozen.
    db.exec(
      'UPDATE drafts SET to_email = (SELECT email FROM people WHERE people.id = drafts.person_id) WHERE to_email IS NULL',
    );
  }
  // send_attempts must exist before the send_attempted_at backfill below sets
  // it, so keep this ALTER first.
  if (!cols.has('send_attempts')) {
    db.exec('ALTER TABLE drafts ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('send_attempted_at')) {
    db.exec('ALTER TABLE drafts ADD COLUMN send_attempted_at TEXT');
    // An already-sent draft did consume its one attempt. Recording that keeps
    // the audit trail honest and is defense in depth: status alone already
    // blocks a re-claim.
    db.exec(
      "UPDATE drafts SET send_attempted_at = coalesce(decided_at, created_at, datetime('now')), send_attempts = 1 WHERE status LIKE 'sent%'",
    );
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd outreach && npx vitest run test/send-path.test.ts`
Expected: PASS, 12 tests.

Run: `cd outreach && npm test && npm run typecheck`
Expected: `Tests  343 passed (343)`, typecheck exit 0.

- [ ] **Step 6: Commit**

```
git add outreach/src/db/schema.sql outreach/src/db/db.ts outreach/test/send-path.test.ts
git commit -m "Add the recipient snapshot and send-claim columns to drafts

schema.sql cannot reach an existing database (CREATE TABLE IF NOT EXISTS is a
no-op), so the live file gets these through a guarded ALTER, same pattern as
the candidate-stranding migration. No status literal is added: the CHECK on
drafts.status cannot be altered, so all new state lives in new columns."
```

---

### Task 3: Snapshot the recipient at draft creation (D2)

> **D2 [CRITICAL] THE APPROVED RECIPIENT IS NOT SNAPSHOTTED.** The send resolves the address fresh via `getPerson(db, row.personId).email`. `upsertPerson` overwrites `email` with `coalesce(?, email)`, and `processPaper` calls it for the same person whenever another paper by that author is discovered. Between "Aditya reads `d7: Name (a@x.edu)`" and "Aditya replies `d7 y`", a later run can silently repoint that person at a different address.

**Files:**
- Modify: `outreach/src/approval/ledger.ts`
- Test: `outreach/test/send-path.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `outreach/test/send-path.test.ts` (adding the imports):

```typescript
import { persistDraft } from '../src/approval/ledger.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Jane Doe', paperTitle: 'A Paper' },
  hooks: [],
  intent: 'seeking direction',
  senderName: 'Aditya Gupta',
};

const groundedDraft: Draft = {
  subject: 'quick question on your rss-gap work',
  body: 'body text',
  grounded: true,
  wordCount: 2,
  notes: [],
};

function seed(db: ReturnType<typeof openDb>, email: string | null = 'jane@uni.edu') {
  const personId = upsertPerson(db, { name: 'Jane Doe', openalexId: 'A1', email });
  const p = persistDraft(db, {
    personId,
    paperArxivId: '2601.00001',
    paperTitle: 'A Paper',
    intent: 'seeking direction',
    draftInput,
    draft: groundedDraft,
    contextJson: {},
  });
  return { personId, ...p };
}
```

```typescript
describe('recipient snapshot', () => {
  it('persistDraft freezes the recipient address on the draft', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const row = db.prepare('SELECT to_email AS toEmail FROM drafts WHERE id = ?').get(p.draftId) as {
      toEmail: string | null;
    };
    expect(row.toEmail).toBe('jane@uni.edu');
  });

  it('a later upsertPerson that repoints the address does not move the snapshot', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    upsertPerson(db, { name: 'Jane Doe', openalexId: 'A1', email: 'attacker@evil.example' });
    const row = db.prepare('SELECT to_email AS toEmail FROM drafts WHERE id = ?').get(p.draftId) as {
      toEmail: string | null;
    };
    expect(row.toEmail).toBe('jane@uni.edu');
    const person = db.prepare('SELECT email FROM people WHERE id = ?').get(p.personId) as { email: string };
    expect(person.email).toBe('attacker@evil.example');
  });

  it('records a null snapshot when the person has no address yet (the add manual-lookup queue)', () => {
    const db = openDb(':memory:');
    const p = seed(db, null);
    const row = db.prepare('SELECT to_email AS toEmail FROM drafts WHERE id = ?').get(p.draftId) as {
      toEmail: string | null;
    };
    expect(row.toEmail).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/send-path.test.ts -t "recipient snapshot"`
Expected: FAIL, `expected null to be 'jane@uni.edu'`.

- [ ] **Step 3: Snapshot inside `persistDraft`**

In `outreach/src/approval/ledger.ts`, inside the `persistDraft` transaction, look up the address and include it in the INSERT. Putting it here rather than at the call sites means every creator (the loop and `outreach add`) gets the snapshot with no call-site change, and no future creator can forget it.

```typescript
export function persistDraft(db: DB, input: PersistDraftInput): PersistedDraft {
  const txn = db.transaction((): PersistedDraft => {
    // D2: freeze the recipient here, next to the subject and body that
    // revisions already freezes. people.email is mutable (upsertPerson
    // coalesces a new non-null value in on every re-discovery of the same
    // author), so an address resolved fresh at send time can be one no human
    // ever approved. NULL is legitimate: `outreach add` deliberately parks a
    // draft with no address as a manual-lookup queue, and the send path
    // refuses such a draft rather than guessing.
    const person = db.prepare('SELECT email FROM people WHERE id = ?').get(input.personId) as
      | { email: string | null }
      | undefined;
    const res = db
      .prepare(
        `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, intent, gist, draft_input_json, to_email)
         VALUES ('', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.personId,
        input.paperArxivId,
        input.paperTitle,
        input.intent,
        input.draft.subject,
        JSON.stringify(input.draftInput),
        person?.email ?? null,
      );
```

The rest of `persistDraft` is unchanged.

- [ ] **Step 4: Run the tests**

Run: `cd outreach && npm test && npm run typecheck`
Expected: `Tests  346 passed (346)`, typecheck exit 0. In particular `test/listen.test.ts` and `test/approval.test.ts` still pass unchanged.

- [ ] **Step 5: Commit**

```
git add outreach/src/approval/ledger.ts outreach/test/send-path.test.ts
git commit -m "Freeze the approved recipient on the draft at creation

The subject and body were already immutable in revisions; the recipient was
not, and upsertPerson coalesces a new address in every time another paper by
the same author is discovered. Snapshotting inside persistDraft means the
loop and outreach add both get it and no future creator can forget it."
```

---

### Task 4: The at-most-once send claim (D1, D7)

> **D1 [CRITICAL] DOUBLE-SEND OF A REAL EMAIL.** `markSendFailed` deliberately leaves the row `approved`, and `retryApprovedUnsent` selects every `approved` draft with a sendable revision and sends it. Two interleavings both send the same cold email twice: (a) the daemon commits an approval at 08:59:58 with the Gmail call in flight, and the 09:00 batch sees `approved` and sends again; (b) within one process, a send that times out AFTER Gmail accepted it leaves the row `approved` and `retryApprovedUnsent` runs a few lines later.
>
> **D7 [WARNING]** `markSent` and `markSendFailed` each issue an UPDATE and then a separate `logEvent` INSERT with no transaction.

**Files:**
- Modify: `outreach/src/approval/ledger.ts`
- Test: `outreach/test/send-path.test.ts`

**Interfaces:**
- Produces: `loadApprovedSend(db, draftId): ApprovedSendLookup`, `beginSendAttempt(db, draftId): SendClaim`, `stalledApprovals(db)`, `stallAlreadyReported(db, draftId, attempts)`, `markStallReported(db, draftId, attempts)`

**Why two functions and not one.** `loadApprovedSend` is read-only and answers "should this send happen, and with what payload". `beginSendAttempt` is the atomic claim. The caller runs the read-only checks first (including `assertSafeOutbound`), so a refusal for a bad subject or a drifted address does **not** consume the one-and-only attempt, and only then claims. The claim re-checks the same conditions inside its own UPDATE, so the gap between the two reads is not a hole.

- [ ] **Step 1: Write the failing test**

Append to `outreach/test/send-path.test.ts`:

```typescript
import { beginSendAttempt, decide, loadApprovedSend, markSendFailed, markSent } from '../src/approval/ledger.js';

describe('beginSendAttempt', () => {
  it('claims an approved, unattempted draft exactly once', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');

    expect(beginSendAttempt(db, p.draftId)).toEqual({ ok: true });

    const second = beginSendAttempt(db, p.draftId);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toMatch(/already recorded/);

    const row = db
      .prepare('SELECT send_attempts AS attempts, send_attempted_at AS attemptedAt FROM drafts WHERE id = ?')
      .get(p.draftId) as { attempts: number; attemptedAt: string | null };
    expect(row.attempts).toBe(1);
    expect(row.attemptedAt).not.toBeNull();
  });

  it('refuses to claim a draft that is not approved', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const claim = beginSendAttempt(db, p.draftId);
    expect(claim.ok).toBe(false);
    expect(claim.ok === false && claim.reason).toMatch(/awaiting_approval/);
  });

  it('a failed send does not release the claim (interleaving b)', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    beginSendAttempt(db, p.draftId);
    markSendFailed(db, p.draftId, 'socket hang up');

    // The row is still approved (unchanged, deliberate) but the claim stands,
    // so nothing can send it again without a human clearing the claim.
    const row = db
      .prepare('SELECT status, send_attempted_at AS attemptedAt FROM drafts WHERE id = ?')
      .get(p.draftId) as { status: string; attemptedAt: string | null };
    expect(row.status).toBe('approved');
    expect(row.attemptedAt).not.toBeNull();
    expect(beginSendAttempt(db, p.draftId).ok).toBe(false);
  });

  it('logs one send_attempted event per successful claim', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    beginSendAttempt(db, p.draftId);
    beginSendAttempt(db, p.draftId);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM draft_events WHERE draft_id = ? AND type = 'send_attempted'")
      .get(p.draftId) as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('loadApprovedSend', () => {
  it('returns the frozen payload for an approved, unattempted, unchanged draft', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    const lookup = loadApprovedSend(db, p.draftId);
    expect(lookup).toMatchObject({
      kind: 'ok',
      shortId: p.shortId,
      toEmail: 'jane@uni.edu',
      subject: groundedDraft.subject,
      body: groundedDraft.body,
    });
  });

  it('refuses when the person address has drifted away from the snapshot', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    upsertPerson(db, { name: 'Jane Doe', openalexId: 'A1', email: 'other@uni.edu' });
    expect(loadApprovedSend(db, p.draftId)).toMatchObject({
      kind: 'recipient_changed',
      snapshot: 'jane@uni.edu',
      current: 'other@uni.edu',
    });
  });

  it('refuses when there is no snapshot, no grounded revision, or no draft', () => {
    const db = openDb(':memory:');
    const noEmail = seed(db, null);
    decide(db, noEmail.draftId, 'send', 'imessage');
    expect(loadApprovedSend(db, noEmail.draftId).kind).toBe('no_snapshot');

    const db2 = openDb(':memory:');
    const p = seed(db2);
    db2.prepare('UPDATE drafts SET sendable_revision_id = NULL WHERE id = ?').run(p.draftId);
    decide(db2, p.draftId, 'send', 'imessage');
    expect(loadApprovedSend(db2, p.draftId).kind).toBe('not_grounded');

    expect(loadApprovedSend(db2, 999).kind).toBe('unknown_draft');
  });

  it('refuses a draft whose attempt was already claimed', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    beginSendAttempt(db, p.draftId);
    expect(loadApprovedSend(db, p.draftId).kind).toBe('already_attempted');
  });
});

describe('markSent and markSendFailed are atomic', () => {
  it('markSent flips the status and writes the event in one transaction', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    markSent(db, p.draftId, 'gmail-123');
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('sent');
    const ev = db
      .prepare("SELECT detail_json AS d FROM draft_events WHERE draft_id = ? AND type = 'sent'")
      .get(p.draftId) as { d: string };
    expect(JSON.parse(ev.d)).toMatchObject({ sentId: 'gmail-123' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/send-path.test.ts -t "beginSendAttempt"`
Expected: FAIL, `beginSendAttempt` is not exported from `../src/approval/ledger.js`.

- [ ] **Step 3: Write the ledger functions**

In `outreach/src/approval/ledger.ts`, replace `markSent` and `markSendFailed` and add the new exports:

```typescript
// D7: the UPDATE and the audit record are one unit. A crash between them would
// lose the only durable record of an irreversible email.
export function markSent(db: DB, draftId: number, sentId: string): void {
  const txn = db.transaction((): void => {
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draftId);
    logEvent(db, draftId, 'sent', { sentId });
  });
  txn();
}

// The draft stays 'approved' and, critically, the send claim stays in place.
// Nothing automatic retries it (D1: retryApprovedUnsent is gone). A failure and
// a timeout are indistinguishable from here, and only one of them is safe to
// repeat, so a human decides. See docs/superpowers/plans/2026-07-29-send-path-safety.md.
export function markSendFailed(db: DB, draftId: number, error: string): void {
  const txn = db.transaction((): void => {
    const row = db.prepare('SELECT send_attempts AS attempts FROM drafts WHERE id = ?').get(draftId) as
      | { attempts: number }
      | undefined;
    logEvent(db, draftId, 'send_failed', { error, attempt: row?.attempts ?? null });
  });
  txn();
}

export type ApprovedSendLookup =
  | { kind: 'ok'; draftId: number; shortId: string; toEmail: string; subject: string; body: string }
  | { kind: 'unknown_draft' }
  | { kind: 'not_approved'; status: string }
  | { kind: 'already_attempted'; attempts: number; attemptedAt: string }
  | { kind: 'not_grounded' }
  | { kind: 'no_snapshot' }
  | { kind: 'recipient_changed'; snapshot: string; current: string | null };

// Read-only. Answers "should this send happen, and with exactly what payload",
// so the caller can refuse for a bad payload BEFORE claiming the one and only
// send attempt. Everything it returns comes from frozen state: the subject and
// body from revisions, the recipient from drafts.to_email.
export function loadApprovedSend(db: DB, draftId: number): ApprovedSendLookup {
  const row = db
    .prepare(
      `SELECT d.short_id AS shortId, d.status AS status, d.to_email AS toEmail,
              d.send_attempts AS attempts, d.send_attempted_at AS attemptedAt,
              d.sendable_revision_id AS revisionId,
              p.email AS currentEmail, r.subject AS subject, r.body AS body
         FROM drafts d
         JOIN people p ON p.id = d.person_id
         LEFT JOIN revisions r ON r.id = d.sendable_revision_id
        WHERE d.id = ?`,
    )
    .get(draftId) as
    | {
        shortId: string;
        status: string;
        toEmail: string | null;
        attempts: number;
        attemptedAt: string | null;
        revisionId: number | null;
        currentEmail: string | null;
        subject: string | null;
        body: string | null;
      }
    | undefined;

  if (!row) return { kind: 'unknown_draft' };
  if (row.status !== 'approved') return { kind: 'not_approved', status: row.status };
  if (row.attemptedAt !== null) {
    return { kind: 'already_attempted', attempts: row.attempts, attemptedAt: row.attemptedAt };
  }
  if (row.revisionId === null || row.body === null) return { kind: 'not_grounded' };
  if (!row.toEmail) return { kind: 'no_snapshot' };
  // D2. Refuse rather than choose. Sending to the snapshot mails an address the
  // system now believes is wrong; sending to the current address mails one no
  // human approved. Both act under ambiguity, so do neither and ask.
  if (row.toEmail !== row.currentEmail) {
    return { kind: 'recipient_changed', snapshot: row.toEmail, current: row.currentEmail };
  }
  return {
    kind: 'ok',
    draftId,
    shortId: row.shortId,
    toEmail: row.toEmail,
    subject: row.subject ?? '',
    body: row.body,
  };
}

export type SendClaim = { ok: true; attempt: number } | { ok: false; reason: string };

// D1. The at-most-once mechanism. One conditional UPDATE, inside a transaction,
// committed BEFORE the caller touches the network. Exactly one caller can see
// changes === 1, in this process or in the other one: SQLite serializes writers
// and the WHERE clause carries the whole precondition, so there is no
// read-then-write gap to lose. Everyone else refuses.
//
// The claim is never released by a failure. A send that times out after Gmail
// accepted the message looks identical to one Gmail never saw (there is no
// idempotency key on gmail.users.messages.send), and re-sending the second is
// harmless while re-sending the first is an unrecoverable second cold email to
// a stranger. So a claimed draft waits for a human.
export function beginSendAttempt(db: DB, draftId: number): SendClaim {
  const txn = db.transaction((): SendClaim => {
    const res = db
      .prepare(
        `UPDATE drafts
            SET send_attempted_at = datetime('now'), send_attempts = send_attempts + 1
          WHERE id = ? AND status = 'approved' AND send_attempted_at IS NULL`,
      )
      .run(draftId);
    if (res.changes === 0) {
      const row = db
        .prepare(
          'SELECT status, send_attempts AS attempts, send_attempted_at AS attemptedAt FROM drafts WHERE id = ?',
        )
        .get(draftId) as { status: string; attempts: number; attemptedAt: string | null } | undefined;
      if (!row) return { ok: false, reason: 'draft does not exist' };
      if (row.attemptedAt !== null) {
        return {
          ok: false,
          reason: `a send attempt was already recorded at ${row.attemptedAt} (attempt ${row.attempts})`,
        };
      }
      return { ok: false, reason: `draft is ${row.status}, not approved` };
    }
    const after = db.prepare('SELECT send_attempts AS attempts FROM drafts WHERE id = ?').get(draftId) as {
      attempts: number;
    };
    logEvent(db, draftId, 'send_attempted', { attempt: after.attempts });
    return { ok: true, attempt: after.attempts };
  });
  return txn();
}

export interface StalledApproval {
  draftId: number;
  shortId: string;
  attempts: number;
  attemptedAt: string | null;
  toEmail: string | null;
}

// D5. Every draft resting at 'approved' is, by definition, an approved email
// that has not gone out. Reported, never auto-sent.
export function stalledApprovals(db: DB): StalledApproval[] {
  return db
    .prepare(
      `SELECT id AS draftId, short_id AS shortId, send_attempts AS attempts,
              send_attempted_at AS attemptedAt, to_email AS toEmail
         FROM drafts WHERE status = 'approved' ORDER BY id`,
    )
    .all() as StalledApproval[];
}

// Bounded reporting: keyed on the attempt count, so one stall produces exactly
// one text, and a human re-arm (which leads to a new attempt number) produces
// exactly one more. Without this, a draft approved against a permanently bad
// address texts Aditya the same failure every single morning forever.
export function stallAlreadyReported(db: DB, draftId: number, attempts: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM draft_events
          WHERE draft_id = ? AND type = 'stall_reported'
            AND json_extract(detail_json, '$.attempts') = ?`,
      )
      .get(draftId, attempts) !== undefined
  );
}

export function markStallReported(db: DB, draftId: number, attempts: number): void {
  logEvent(db, draftId, 'stall_reported', { attempts });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd outreach && npx vitest run test/send-path.test.ts`
Expected: PASS, 24 tests.

Run: `cd outreach && npm test && npm run typecheck`
Expected: `Tests  355 passed (355)`, typecheck exit 0.

- [ ] **Step 5: Commit**

```
git add outreach/src/approval/ledger.ts outreach/test/send-path.test.ts
git commit -m "Make a send claimable exactly once, before the network call

beginSendAttempt writes and commits drafts.send_attempted_at with a single
conditional UPDATE before anything touches Gmail, so the daemon and the 09:00
batch cannot both send the same cold email, and a send that times out after
Gmail accepted it cannot be repeated. loadApprovedSend runs the read-only
refusals first so a bad payload never burns the one attempt. markSent and
markSendFailed are now transactions (D7)."
```

---

### Task 5: Rewrite `handleReply` (D1, D2, D3, D4, D6)

> **D4 [WARNING] `handleReply` MUTATES BEFORE CHECKING dryRun.** `decide(..., 'send', ...)` runs before the `if (opts.dryRun)` check, permanently recording the decision and consuming the one-and-only decision slot. `resolveSendableDraft` elsewhere in the same file states the opposite rule explicitly ("A dry run must never call decide").
>
> **D6 [WARNING] DUPLICATED SEND-AND-RECORD BLOCK.** The never-send-without-approval accounting is encoded twice.

**Files:**
- Modify: `outreach/src/pipeline/loop.ts` (`handleReply` and a new private `performApprovedSend`)
- Test: `outreach/test/send-path.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `outreach/test/send-path.test.ts`:

```typescript
import { vi } from 'vitest';
import { handleReply, type LoopSummary } from '../src/pipeline/loop.js';
import { createStubChannel } from '../src/approval/channel.js';

const freshSummary = (dryRun: boolean): LoopSummary => ({
  dryRun,
  sent: 0,
  seen: 0,
  filtered: 0,
  unsendable: 0,
  messaged: 0,
  queued: 0,
  resumed: 0,
  retryable: 0,
  stranded: 0,
  errors: [],
});

function replyDeps(db: ReturnType<typeof openDb>, send = vi.fn().mockResolvedValue({ sentId: 'gmail-1' })) {
  const channel = createStubChannel();
  return { deps: { db, channel, sender: { send }, senderEmail: 'apgupta3@asu.edu' }, channel, send };
}

describe('handleReply send path', () => {
  it('sends once on an approval, using the frozen recipient', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const { deps, channel, send } = replyDeps(db);
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: 'jane@uni.edu',
      from: 'apgupta3@asu.edu',
      subject: groundedDraft.subject,
      draftShortId: p.shortId,
    });
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('sent');
    expect(channel.notices.join(' ')).toContain('sent to jane@uni.edu');
  });

  it('a second approval after a successful send does not send again', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const { deps, channel, send } = replyDeps(db);
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });
    expect(send).toHaveBeenCalledTimes(1);
    expect(channel.notices.join(' ')).toContain('already');
  });

  it('a second approval after a FAILED send does not send again (the claim stands)', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const send = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const { deps, channel } = replyDeps(db, send);
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });
    expect(send).toHaveBeenCalledTimes(1);
    expect(channel.notices.join(' ')).toMatch(/already recorded/);
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('approved');
  });

  it('re-approving an approved draft that never got a claim sends it (the re-arm button)', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    // Simulate a crash between decide and beginSendAttempt.
    decide(db, p.draftId, 'send', 'imessage');
    const { deps, send } = replyDeps(db);
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses to send when the address drifted after approval, and does not consume the attempt', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    upsertPerson(db, { name: 'Jane Doe', openalexId: 'A1', email: 'attacker@evil.example' });
    const { deps, channel, send } = replyDeps(db);
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });

    expect(send).not.toHaveBeenCalled();
    expect(channel.notices.join(' ')).toMatch(/address changed/);
    const row = db
      .prepare('SELECT status, send_attempts AS attempts FROM drafts WHERE id = ?')
      .get(p.draftId) as { status: string; attempts: number };
    expect(row).toMatchObject({ status: 'approved', attempts: 0 });
  });

  it('refuses to send an injected subject and does not consume the attempt', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    db.prepare('UPDATE revisions SET subject = ? WHERE draft_id = ?').run(
      'hi\r\nBcc: attacker@evil.example',
      p.draftId,
    );
    const { deps, channel, send } = replyDeps(db);
    await handleReply(deps, { dryRun: false }, freshSummary(false), { text: `${p.shortId} y` });

    expect(send).not.toHaveBeenCalled();
    expect(channel.notices.join(' ')).toMatch(/unsafe/i);
    const row = db.prepare('SELECT send_attempts AS attempts FROM drafts WHERE id = ?').get(p.draftId) as {
      attempts: number;
    };
    expect(row.attempts).toBe(0);
  });

  it('a dry run records no decision, claims nothing, and sends nothing (D4)', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const { deps, send } = replyDeps(db);
    await handleReply(deps, { dryRun: true }, freshSummary(true), { text: `${p.shortId} y` });

    expect(send).not.toHaveBeenCalled();
    const n = db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(n.n).toBe(0);
    const row = db
      .prepare('SELECT status, send_attempts AS attempts FROM drafts WHERE id = ?')
      .get(p.draftId) as { status: string; attempts: number };
    expect(row).toMatchObject({ status: 'awaiting_approval', attempts: 0 });
  });

  it('a dry run records no skip decision either (D4)', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const { deps } = replyDeps(db);
    await handleReply(deps, { dryRun: true }, freshSummary(true), { text: `${p.shortId} n` });
    const n = db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(n.n).toBe(0);
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('awaiting_approval');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/send-path.test.ts -t "handleReply send path"`
Expected: FAIL on the dry-run tests (a decision is recorded) and on the drift and injection tests (the send goes out).

- [ ] **Step 3: Rewrite `handleReply` and add the single send helper**

In `outreach/src/pipeline/loop.ts`, update the ledger import:

```typescript
import {
  beginSendAttempt,
  decide,
  loadApprovedSend,
  markSendFailed,
  markSent,
  markStallReported,
  persistDraft,
  priorThreads,
  logEvent,
  stallAlreadyReported,
  stalledApprovals,
  type PersistedDraft,
} from '../approval/ledger.js';
```

and add the sender-seam import:

```typescript
import { assertSafeOutbound, type Sender } from '../sender/types.js';
```

(replacing the existing `import type { Sender } from '../sender/types.js';`).

Replace the whole of `handleReply` (lines 94 to 170) with:

```typescript
// D6: the one and only place that turns an approval into a real email. Both
// callers of handleReply (the batch loop and the listener daemon) reach it,
// and after D1 nothing else in the system sends at all, so the
// never-send-without-approval accounting exists exactly once.
async function performApprovedSend(
  deps: ReplyDeps,
  summary: LoopSummary,
  draftId: number,
  shortId: string,
): Promise<void> {
  // Phase 0, read-only. Refusing here costs nothing: no claim is consumed, so
  // a human can fix the cause and re-approve by texting "dN y" again.
  const lookup = loadApprovedSend(deps.db, draftId);
  switch (lookup.kind) {
    case 'ok':
      break;
    case 'unknown_draft':
      await deps.channel.notify(`No draft found for ${shortId}. Ignoring that reply.`);
      return;
    case 'not_approved':
      await deps.channel.notify(`${shortId} is ${lookup.status}, not approved. Nothing sent.`);
      return;
    case 'already_attempted':
      // D1. The ambiguous case: Gmail may or may not have delivered it. Never
      // guess, and never let a text message resolve it.
      logEvent(deps.db, draftId, 'send_refused', { reason: 'already_attempted', attempts: lookup.attempts });
      await deps.channel.notify(
        `${shortId}: a send attempt was already recorded at ${lookup.attemptedAt} and never confirmed. ` +
          `Nothing sent. Check the Gmail Sent folder before re-arming it by hand.`,
      );
      return;
    case 'not_grounded':
      await deps.channel.notify(`${shortId} has no grounded revision to send.`);
      return;
    case 'no_snapshot':
      await deps.channel.notify(`${shortId} has no recipient address on record. Nothing sent.`);
      return;
    case 'recipient_changed':
      // D2. Refuse, do not choose. Neither address can be sent to safely.
      logEvent(deps.db, draftId, 'send_refused', {
        reason: 'recipient_changed',
        snapshot: lookup.snapshot,
        current: lookup.current,
      });
      await deps.channel.notify(
        `${shortId}: the address changed since you approved it (approved ${lookup.snapshot}, ` +
          `now ${lookup.current ?? 'none'}). Nothing sent.`,
      );
      return;
  }

  const outbound = {
    to: lookup.toEmail,
    from: deps.senderEmail ?? process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
    subject: lookup.subject,
    body: lookup.body,
    draftShortId: shortId,
  };

  // D3. Validate before claiming, so a poisoned subject does not burn the one
  // and only send attempt. The senders validate again, which is the backstop
  // that also covers `outreach add`.
  try {
    assertSafeOutbound(outbound);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent(deps.db, draftId, 'send_refused', { reason: 'unsafe_outbound', error: msg });
    summary.errors.push(`${shortId}: ${msg}`);
    await deps.channel.notify(`${shortId} refused as unsafe: ${msg}`);
    return;
  }

  // Phase 1, the claim. Synchronous and committed before the await below, so a
  // concurrent process (the 09:00 batch versus the listener) loses this race
  // instead of sending a second copy.
  const claim = beginSendAttempt(deps.db, draftId);
  if (!claim.ok) {
    await deps.channel.notify(`${shortId} not sent: ${claim.reason}.`);
    return;
  }

  // Phase 2, the network. From here on, a failure is NOT retried automatically:
  // a timeout after Gmail accepted the message is indistinguishable from a
  // message Gmail never saw, and only one of those is safe to repeat.
  try {
    const { sentId } = await deps.sender.send(outbound);
    markSent(deps.db, draftId, sentId);
    summary.sent++;
    await deps.channel.notify(`${shortId} sent to ${outbound.to}.`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markSendFailed(deps.db, draftId, msg);
    summary.errors.push(`${shortId}: send failed: ${msg}`);
    await deps.channel.notify(
      `${shortId} failed to send: ${msg}. Not retried automatically; check the Gmail Sent folder.`,
    );
  }
}

export async function handleReply(
  deps: ReplyDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  reply: { text: string },
): Promise<void> {
  const parsed = parseReply(reply.text);
  if (parsed.kind === 'unparseable') {
    await deps.channel.notify(`Could not read "${reply.text}". Reply like "d7 y" or "d7 n".`);
    return;
  }
  const draftId = parseShortId(parsed.shortId);
  if (draftId === null) return;

  if (!draftExists(deps.db, draftId)) {
    await deps.channel.notify(`No draft found for ${parsed.shortId}. Ignoring that reply.`);
    return;
  }

  if (parsed.kind === 'unsupported') {
    // Edits are F5 territory (docs/spec-imessage-approval-loop.md).
    if (!opts.dryRun) logEvent(deps.db, draftId, 'edit_reply_unsupported', { text: reply.text });
    await deps.channel.notify(`Edits are not yet supported for ${parsed.shortId}. Reply "y" to send or "n" to skip.`);
    return;
  }

  // D4. The dry-run check comes BEFORE any mutation. `decide` is first-write-
  // wins on UNIQUE(draft_id), so recording a decision during a rehearsal
  // permanently consumes the one and only decision slot for that draft. This is
  // the same rule resolveSendableDraft states below ("A dry run must never call
  // decide"); it now holds in the code rather than being held by the stub
  // channel happening to yield no replies.
  if (opts.dryRun) {
    await deps.channel.notify(
      `${parsed.shortId}: dry run, nothing recorded and nothing sent (would ${parsed.kind}).`,
    );
    return;
  }

  if (parsed.kind === 'skip') {
    const res = decide(deps.db, draftId, 'skip', 'imessage');
    await deps.channel.notify(
      res.applied ? `${parsed.shortId} skipped.` : `${parsed.shortId} was already ${res.existing.action}.`,
    );
    return;
  }

  const res = decide(deps.db, draftId, 'send', 'imessage');
  if (!res.applied) {
    if (res.existing.action !== 'send') {
      await deps.channel.notify(`${parsed.shortId} was already ${res.existing.action}.`);
      return;
    }
    // A repeat approval of a draft already decided 'send'. This is the re-arm
    // button for the common failure (a refusal or a crash before the claim):
    // it is an explicit human approval, and performApprovedSend still refuses
    // if a claim exists or the draft has already gone out, so it can never
    // become a second send.
    logEvent(deps.db, draftId, 're_approval', { via: 'imessage' });
  }
  await performApprovedSend(deps, summary, draftId, parsed.shortId);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd outreach && npx vitest run test/send-path.test.ts`
Expected: PASS, 32 tests.

Run: `cd outreach && npm test`
Expected: one failure only, `test/loop.test.ts > retries an approved-but-unsent draft on the next run`, because `retryApprovedUnsent` still exists and still auto-sends. Task 6 removes it. If anything else fails, stop and investigate before continuing.

- [ ] **Step 5: Commit**

```
git add outreach/src/pipeline/loop.ts outreach/test/send-path.test.ts
git commit -m "Route every approval through one claim-then-send helper

handleReply now checks dryRun before it mutates anything (a rehearsal used to
consume the one and only decision slot), sends to the frozen recipient rather
than a freshly resolved one, refuses an address that drifted after approval,
refuses an unsafe subject before the claim so it does not burn the attempt,
and claims the send before the network call. A repeat 'dN y' on an approved
draft with no claim is the human re-arm path."
```

---

### Task 6: Delete the automatic retry, report stalls instead (D1, D5)

> **D5 [WARNING] `retryApprovedUnsent` HAS NO ATTEMPT BOUND AND NO PRIOR-THREAD RE-CHECK.** A draft approved against a permanently bad address is retried every single day forever, texting Aditya the same failure each time.

**Should `retryApprovedUnsent` exist at all in its current form? No.** Its premise, that `approved` plus a sendable revision means "safe to send", is exactly the premise D1 disproves. There is no bound, attempt count, or prior-thread re-check that makes an automatic re-send of a possibly-already-delivered cold email safe, because the ambiguity is unresolvable from inside the process. The function is deleted. What survives is its useful half: noticing that an approved draft has not gone out, and telling Aditya once.

**Files:**
- Modify: `outreach/src/pipeline/loop.ts`
- Modify: `outreach/test/loop.test.ts` (replace one test)
- Test: `outreach/test/send-path.test.ts`

- [ ] **Step 1: Replace the test that asserts the defective behavior**

This is the one existing test this plan changes. It asserts `expect(deps.sender.send).toHaveBeenCalledTimes(1)` for an approved-but-unsent draft on a plain `runLoop`, which is the D1 double-send path itself: nothing in that scenario proves the previous attempt did not already deliver. Replacing it is a deliberate correction of asserted behavior, not a weakening; the replacement makes a strictly stronger claim (zero sends, plus a bounded notification). Every other existing test stays exactly as it is, including "does not retry an approved-but-unsent draft under dry run", which still passes.

In `outreach/test/loop.test.ts`, replace the test named `retries an approved-but-unsent draft on the next run` with:

```typescript
  // Was "retries an approved-but-unsent draft on the next run". That behavior
  // was defect D1: an approved draft whose send outcome is unknown must never
  // be re-sent automatically, because a send that timed out after Gmail
  // accepted it is indistinguishable from one Gmail never received.
  // docs/superpowers/plans/2026-07-29-send-path-safety.md.
  it('never auto-sends an approved-but-unsent draft, and reports it once', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00024',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'approved' WHERE id = ?").run(p.draftId);
    const { deps, channel } = baseDeps(db);

    const first = await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(first.sent).toBe(0);
    expect(first.stalled).toBe(1);
    expect(channel.notices.join(' ')).toContain(p.shortId);

    // The second run must not text the same stall again.
    const noticesAfterFirst = channel.notices.length;
    const second = await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(second.stalled).toBe(0);
    // Only the end-of-run summary line was added.
    expect(channel.notices.length).toBe(noticesAfterFirst + 1);

    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('approved');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/loop.test.ts -t "never auto-sends"`
Expected: FAIL, `expected "send" not to be called` (`retryApprovedUnsent` still sends).

- [ ] **Step 3: Delete `retryApprovedUnsent` and add the report step**

In `outreach/src/pipeline/loop.ts`, delete the entire `retryApprovedUnsent` function (the old lines 632 to 669, comment block included) and put this in its place:

```typescript
// D1/D5. What used to be retryApprovedUnsent. It no longer sends: an approved
// draft whose send outcome is unknown can never be safely re-sent from inside
// the process (there is no idempotency key on the Gmail send, so a timeout
// after acceptance looks exactly like a failure before it). It reports instead,
// at most once per attempt count, so a draft approved against a permanently bad
// address does not text Aditya the same failure every morning forever.
//
// Recovery is a human act, by design. See
// docs/superpowers/plans/2026-07-29-send-path-safety.md, "Re-arming".
async function reportStalledApprovals(deps: LoopDeps, summary: LoopSummary): Promise<void> {
  for (const row of stalledApprovals(deps.db)) {
    if (stallAlreadyReported(deps.db, row.draftId, row.attempts)) continue;
    const detail =
      row.attemptedAt === null
        ? `approved but never attempted. Reply "${row.shortId} y" again to send it.`
        : `one send attempt recorded at ${row.attemptedAt}, never confirmed. Not retried automatically: ` +
          `check the Gmail Sent folder for ${row.toEmail ?? 'the recipient'} before re-arming it.`;
    markStallReported(deps.db, row.draftId, row.attempts);
    summary.stalled = (summary.stalled ?? 0) + 1;
    await deps.channel.notify(`${row.shortId} is approved and unsent: ${detail}`);
  }
}
```

Add the counter to `LoopSummary`. It must be **optional**, because `src/pipeline/listen.ts` builds a `LoopSummary` literal and this plan may not modify that file:

```typescript
  stranded: number;
  // Approved drafts that have not gone out, reported by this run (D5).
  // Optional so listen.ts's LoopSummary literal still compiles; this plan does
  // not own that file.
  stalled?: number;
  errors: string[];
```

In `runLoop`, initialize it and swap the call site:

```typescript
    resumed: 0,
    retryable: 0,
    stranded: 0,
    stalled: 0,
    errors: [],
  };
```

```typescript
    // D1: an approved-but-unsent draft is reported, never re-sent. The user's
    // approval already happened, but a second send of a cold email cannot be
    // taken back, and nothing here can tell a failed send from a delivered one.
    // Never runs in a dry run: a dry run writes nothing and texts nothing.
    if (!opts.dryRun) {
      try {
        await reportStalledApprovals(deps, summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push(`stalled approval report failed: ${msg}`);
      }
    }
```

Extend the summary line so a stall is visible in the daily text:

```typescript
      `resumed ${summary.resumed}` +
      (summary.retryable ? `, retryable ${summary.retryable}` : '') +
      (summary.stranded ? `, stranded ${summary.stranded}` : '') +
      (summary.stalled ? `, stalled approvals ${summary.stalled}` : '') +
      (summary.errors.length ? `, errors: ${summary.errors.join(' | ')}` : '');
```

- [ ] **Step 4: Add the end-to-end double-send test**

Append to `outreach/test/send-path.test.ts`:

```typescript
import { runLoop } from '../src/pipeline/loop.js';

describe('no path re-sends an email (D1, both interleavings)', () => {
  it('interleaving b: a send that fails after the claim is never re-sent by the same run', async () => {
    const db = openDb(':memory:');
    const p = seed(db);
    const send = vi.fn().mockRejectedValue(new Error('ETIMEDOUT after Gmail accepted it'));
    const channel = createStubChannel();
    channel.queueReply(`${p.shortId} y`);
    const deps = {
      db,
      channel,
      sender: { send },
      config: { queries: [], authors: [], seeds: [], gate: { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3, maxResumePerRun: 10, maxResumeAttempts: 3 } },
      sources: [],
      terms: [],
      processPaper: vi.fn(),
      generateDraft: vi.fn(),
      buildDraftInput: vi.fn(),
    };
    const summary = await runLoop(deps as never, { dryRun: false });

    // One attempt, from the reply. The stall report that runs a few lines later
    // in the same run must not turn into a second send.
    expect(send).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(0);
  });

  it('interleaving a: a second process cannot claim a send already in flight', () => {
    const db = openDb(':memory:');
    const p = seed(db);
    decide(db, p.draftId, 'send', 'imessage');
    // The listener claims at 08:59:58 and its Gmail call is still in flight.
    expect(beginSendAttempt(db, p.draftId).ok).toBe(true);
    // The 09:00 batch, in the other process, sees the same row.
    expect(beginSendAttempt(db, p.draftId).ok).toBe(false);
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `cd outreach && npm test && npm run typecheck`
Expected: `Tests  365 passed (365)`, typecheck exit 0 (331 original, with one loop.test.ts test replaced one for one, plus the 34 in test/send-path.test.ts).

- [ ] **Step 6: Commit**

```
git add outreach/src/pipeline/loop.ts outreach/test/loop.test.ts outreach/test/send-path.test.ts
git commit -m "Delete the automatic re-send; report stalled approvals instead

retryApprovedUnsent assumed status 'approved' plus a sendable revision means
safe to send. It does not: markSendFailed leaves that exact state behind after
a send that may already have been delivered. Nothing in the process can tell
the two apart, so the retry is gone and an approved-but-unsent draft is now
reported to Aditya once per attempt count and waits for a human."
```

---

### Task 7: Verify the invariants end to end

No production code changes. This task is evidence.

- [ ] **Step 1: Full suite and typecheck**

Run: `cd outreach && npm test && npm run typecheck`
Expected: `Test Files  44 passed (44)`, `Tests  365 passed (365)`, typecheck exit 0.

- [ ] **Step 2: Prove there is exactly one call site that can send**

Run: `cd outreach && grep -rn "sender.send\|\.send(outbound)" src/ | grep -v node_modules`
Expected exactly two lines: `src/pipeline/loop.ts` (inside `performApprovedSend`) and `src/cli.ts` (the interactive `outreach add`). Any third line means a send path escaped the claim, and the task is not done.

- [ ] **Step 3: Prove the claim precedes the network call**

Run: `cd outreach && grep -n "beginSendAttempt\|await deps.sender.send" src/pipeline/loop.ts`
Expected: the `beginSendAttempt` line number is lower than the `await deps.sender.send` line number, with no `await` between them other than the notify on the refusal branch.

- [ ] **Step 4: Prove no status literal was added**

Run: `cd outreach && grep -n "CHECK(status IN" src/db/schema.sql`
Expected: the `drafts` line still reads exactly `('awaiting_approval','approved','sent (stubbed)','sent','skipped')`.

- [ ] **Step 5: Prove there are no em dashes**

Run: `cd outreach && grep -rn "$(printf '\u2014')" src/ test/ ../docs/superpowers/plans/2026-07-29-send-path-safety.md`

(The character is written as a `printf` escape on purpose, so this document does not fail its own check.)

Expected: no output (exit 1).

- [ ] **Step 6: Commit (only if anything moved)**

If steps 1 through 5 all pass with no edits, there is nothing to commit. Do not create an empty commit.

---

### Task 8: Migrate and redeploy the live system

**This task touches the real database and the real daemon. Every step is ordered. Do not reorder.**

Measured state of `outreach/data/outreach.db` on 2026-07-30, immediately before writing this plan (re-measure, do not trust these numbers):

| drafts.status | count |
| --- | --- |
| `awaiting_approval` | 13 |
| `sent` | 5 |
| `skipped` | 6 |
| `approved` | 0 |

All 24 drafts belong to a person with a non-null `people.email`, so the `to_email` backfill covers every row and leaves no NULL snapshot behind. There are zero `approved` rows, which means **there is no stalled send to resolve and the first run will report nothing**. The 13 `awaiting_approval` drafts are live: Aditya can reply `dN y` to any of them at any moment, including while the migration is running.

- [ ] **Step 1: Re-measure**

Run:
```
cd outreach && sqlite3 data/outreach.db "SELECT status, COUNT(*) FROM drafts GROUP BY 1; SELECT COUNT(*) FROM drafts d JOIN people p ON p.id = d.person_id WHERE p.email IS NULL;"
```
Record the output in the commit message for this task. If the second query returns anything other than `0`, stop: those drafts will get a NULL snapshot and will refuse to send with `no snapshot on record` until a human fills in the address. That is safe but must be known before arming.

- [ ] **Step 2: Back up**

Run:
```
cd outreach && cp data/outreach.db "data/outreach.backup-$(date +%Y%m%d-%H%M%S)-pre-send-path.db"
```
Expected: a new file next to the existing `outreach.backup-*.db` files. Verify with `ls -la outreach/data/`.

- [ ] **Step 3: Run the migration by opening the database read-only-ish**

The migration runs inside `openDb`, so any command that opens the database applies it. Use the cheapest one:

Run: `cd outreach && npx tsx -e "import('./src/db/db.js').then(m => { const db = m.openDb('data/outreach.db'); console.log(db.prepare('SELECT COUNT(*) AS n, COUNT(to_email) AS withEmail, SUM(send_attempts) AS attempts FROM drafts').get()); db.close(); })"`

Expected output shape: `{ n: 24, withEmail: 24, attempts: 5 }` (n and withEmail equal, attempts equal to the number of `sent` rows).

- [ ] **Step 4: Eyeball the snapshots before anything can send**

Run:
```
cd outreach && sqlite3 -header -column data/outreach.db "SELECT d.short_id, d.status, d.to_email, p.email AS current FROM drafts d JOIN people p ON p.id = d.person_id ORDER BY d.id;"
```
Expected: `to_email` equals `current` on every row (the backfill just copied it, so any inequality means concurrent writes and should be investigated). Show this table to Aditya before Step 5. These are the addresses that 13 live drafts will send to if he replies `y`.

- [ ] **Step 5: Restart the listener**

**This is mandatory and easy to forget.** `com.aditya.outreach-listen` is a KeepAlive daemon that is running right now with the OLD `handleReply` loaded in memory. Until it restarts, an approval reply takes the pre-fix path: no snapshot, no claim, no header validation. The new columns do not change its behavior, because old code never reads them.

Run:
```
launchctl kickstart -k gui/501/com.aditya.outreach-listen
launchctl list | grep outreach
```
Expected: a new PID for `com.aditya.outreach-listen` and exit status `0`. (`launchctl unload` is blocked by the permission classifier; `kickstart -k` is the verified working form.)

Then confirm the restarted daemon actually took the new code by checking its log for a startup line, and by sending one harmless malformed reply from Aditya's phone (for example `d0 y`), which must come back with `No draft found for d0. Ignoring that reply.` and must write nothing.

- [ ] **Step 6: First loop run is a dry run**

Run: `cd outreach && npx tsx src/cli.ts loop --dry-run`

Expected: a summary line ending in `sent 0`, with no `stalled approvals` segment (there are zero `approved` rows). Confirm with:
```
cd outreach && sqlite3 data/outreach.db "SELECT COUNT(*) FROM decisions; SELECT SUM(send_attempts) FROM drafts;"
```
Expected: the decision count is unchanged from before the dry run, and the attempt sum is still 5. A dry run that moved either number is a bug in Task 5; stop and fix it.

- [ ] **Step 7: Commit the measurements**

```
git commit --allow-empty -m "Migrate the live database to the send-path columns

Backed up to data/outreach.backup-<stamp>-pre-send-path.db. 24 drafts, 24
snapshots backfilled, 0 rows with a NULL snapshot, 5 sent rows recorded as
having consumed their attempt, 0 approved rows (nothing stalled). Listener
restarted with launchctl kickstart -k; dry run wrote no decisions and claimed
no sends."
```

---

## Re-arming a stalled send (the documented human procedure)

This is the only way a claimed send is ever retried. It is deliberately not a text message and deliberately not a CLI command that exists today.

**Level 1, no claim exists** (the draft is `approved` and `send_attempted_at IS NULL`; the morning text says "approved but never attempted"). Aditya texts `dN y` again. Nothing else is needed.

**Level 2, a claim exists** (the morning text says "one send attempt recorded ... never confirmed"). Nobody knows whether Gmail delivered it.

1. Open the Gmail Sent folder for `apgupta3@asu.edu` and search for the recipient address printed in the notification.
2. **If the email IS there:** it was delivered. Record that and stop. Do not re-send.
   ```
   sqlite3 outreach/data/outreach.db "BEGIN; UPDATE drafts SET status = 'sent' WHERE id = <ID> AND status = 'approved'; INSERT INTO draft_events (draft_id, type, detail_json) VALUES (<ID>, 'sent', json_object('sentId','manual-confirmed-in-gmail')); COMMIT;"
   ```
3. **If the email is NOT there:** it never went out, and re-arming is safe.
   ```
   sqlite3 outreach/data/outreach.db "BEGIN; UPDATE drafts SET send_attempted_at = NULL WHERE id = <ID> AND status = 'approved'; INSERT INTO draft_events (draft_id, type, detail_json) VALUES (<ID>, 'send_rearmed', json_object('by','human','checkedGmailSent',1)); COMMIT;"
   ```
   Then text `dN y`. `send_attempts` is not reset, so the next attempt is number 2 and a future stall produces exactly one new report.

`<ID>` is the numeric draft id, which is the short id without the leading `d` (`d7` is id 7).

---

## What this plan deliberately does not do

- **It does not add an idempotency key to the Gmail send.** Gmail's API has no client-supplied idempotency token, so the ambiguity is inherent, not an implementation shortcut. A self-managed `Message-Id` header plus a Sent-folder search before each retry could narrow it, but that is a network read on the recovery path and a new failure mode of its own. The human check does the same job with no new code.
- **It does not wire `outreach add` through the claim.** `cli.ts` belongs to another plan. `add` is interactive, single-threaded, human-supervised, and gets the snapshot and the header guard for free.
- **It does not switch the iMessage-to-phone path to `drafts.to_email`.** `emit`, `loadSendableDraft`, and the queued flush are outside the owned region of `loop.ts`. The send-time snapshot comparison refuses rather than mails the wrong address in the meantime.
- **It does not add a `send_failed` draft status.** `drafts.status` is CHECK-constrained and SQLite cannot ALTER a CHECK, so a new literal would never reach the live database. The claim columns carry the state instead.
