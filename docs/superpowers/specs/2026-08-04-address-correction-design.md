> **REVIEWED 2026-08-04, revised the same day.** Two reviewers ran. Both
> safety-critical arguments (the two-write transaction, and the `dN:` tapback
> hazard) were independently CONFIRMED, so the design survives. One nuance the
> review added: `recipient_changed` is not strictly inert today either, because
> `upsertPerson` uses `email = coalesce(?, email)`, so a later run that
> rediscovers the original address closes the mismatch on its own and makes a
> stale tapback live.
>
> **The reword shipped ahead of this spec, in commit 733c3c9.** All three
> offending `dN:` notify strings in `loop.ts` were reworded
> (`already_attempted`, `recipient_changed`, and the dry-run notice), and
> `test/notify-tapback-safety.test.ts` now enforces the invariant at source
> level: no `notify()` in `loop.ts`, `listen.ts`, or `cli.ts` may begin with a
> draft id and a colon. Baseline is now **48 test files, 559 tests, all
> passing** (measured with `npx vitest run --reporter=dot`). Change 4 below is
> therefore a record of what landed plus one new obligation (the tapback hint),
> not work still to do.
>
> The blocker this revision closes: a one-digit typo in the draft id. See
> "Change 5a: the three refusals".

# Address Correction: ask the human for the address instead of dropping the person

**Date:** 2026-08-04
**Status:** Reviewed and revised; ready to plan
**Problem owner:** cold emails reaching the wrong human, and the people silently dropped by the fix for that

## Problem

Seven cold emails went to a person who did not write the paper being discussed.
Verified against the arXiv author lists: none of these recipients appears
anywhere on the paper. Read live from `data/outreach.db` (`drafts` joined to
`people`), all seven at `status = 'sent'`:

| draft | intended person | address actually emailed | how it was found |
| --- | --- | --- | --- |
| d19 | Daniel Kepple | daniel.lee@dlapiper.com (a law firm) | directory |
| d27 | Hongkun Yang | yangbaoquan@sjtu.edu.cn | directory |
| d37 | MD Wahiduzzaman Khan | jawairia.khan@uts.edu.au | homepage |
| d51 | Sicheng Yu | lanyu@cqu.edu.cn | directory |
| d52 | Ziheng Xu | xuhuaping@buaa.edu.cn | directory |
| d60 | Xianliang Huang | huangbo@njust.edu.cn | homepage |
| d69 | Xiyu Zhang | zhangyanghui@tongji.edu.cn | homepage |

`nameMatches` (`src/pipeline/contacts.ts:340`) was tightened today in commits
50da553 (residue rule: the local part with the surname removed must echo the
target's given name) and 5c105c6 (a tokenized local part that names neither the
surname nor the given name is rejected). It now rejects all seven, plus
`l.zhang.16@bham.ac.uk` matched to "Zhisheng Han", where h-a-n sits inside
z-h-a-n-g.

**Detection is not the fix.** A rejected candidate scores 0 in `scoreCandidate`
(`contacts.ts:40`), falls below `CONFIDENCE_THRESHOLD` in `selectEmail`, and
disappears. `extractContact` returns `null`, `processCandidate` writes
`drafted_unsendable / 'no email resolved'` (`loop.ts:382-386`), and nothing
revisits that row. So the fix for "we emailed the wrong person" is "we email
nobody", and it is silent.

**Measurement snapshot, `data/outreach.db`, 2026-08-04.** These move every run;
they were read in one pass.

| metric | value |
| --- | --- |
| people rows / with an email | 234 / 180 |
| stored addresses the tightened `nameMatches` now rejects | **40 of 180 (22%)** |
| `email_source` distribution | pdf 111, homepage 45, directory 20, github_profile 3, **user_provided 1** |
| distinct registrable domains among the 111 pdf-verified addresses | **88** (93 distinct hostnames; `tldts.parse().domain` collapses `cs.njust.edu.cn` and `njust.edu.cn`) |
| `seen_papers` by status | drafted_unsendable 252, filtered_low_relevance 176, messaged 63, discovered 7 |
| `drafted_unsendable` reasons | no grounded hook 99, identity unconfirmed 78, **no email resolved 50**, prior thread 5, identity collision 19, grounding failed (OpenRouter 429) 1 |
| of those 252 rows, how many `outreach stranded` prints | **0** |
| drafts by status | sent 56, skipped 12, awaiting_approval 1 |

The last row is measured, not asserted: `strandedReport`
(`src/discovery/seenLedger.ts:178-194`) selects `drafted_unsendable` rows only
where `reason LIKE 'abandoned after%' OR reason LIKE 'ambiguous orphan
drafts%'`, and zero of the 252 match. The bucket is terminal and invisible at
the same time.

The 40 rejections are not all wrong-person cases. `ishen@stu.hit.edu.cn` for
Xiongri Shen and `zydu.disens@gmail.com` for Zhiying Du look like real addresses
that the tightened rule cannot confirm from the name text alone, which the rule's
own comment (`contacts.ts:334-339`) admits it accepts as the cost of precision.
That is exactly the population this spec exists for: the machine is right to
refuse, and the person is still worth emailing.

### What the owner decided

Surface the failure and let him supply the address. In his words: "let me know
about that and we would maybe have to have me find the email so that we can
learn how to find it for the future." A draft whose address fails the identity
check is not presented as an approvable draft. He is texted a distinct "needs
address" message, replies with the right address, and the draft becomes
sendable. Approval stays a separate act.

## Design

### Change 1: surface the rejected candidate out of `contacts.ts`

Today the rejection is unobservable outside `scoreCandidate`. Add a detailed
entry point beside the existing one:

```ts
export interface RejectedCandidate {
  email: string;
  source: DiscoveredEmailSource;
  reason: 'identity_mismatch';
}
export interface ContactResult {
  selected: SelectedEmail | null;
  rejected: RejectedCandidate[];
}
export async function extractContactDetailed(...): Promise<ContactResult>
export async function extractContact(...): Promise<SelectedEmail | null>  // = (await detailed(...)).selected
```

- `rejected` contains **only** candidates where `nameMatches(localPart, name)`
  is false. A `github_commit` candidate that matches the name but scores 0.55
  is a low-confidence failure, not a wrong-person failure, and must not produce
  a needs-address text. The `noreply.github.com` discard is likewise excluded.
- Deduped by address, ordered by the `SOURCE_CONFIDENCE` the candidate would
  have had if the name had matched, so the message shows the machine's own
  ranking. Cap the list at 3.
- Cost, verified by grep: `extractContact` has exactly two production callers,
  `orchestrate.ts:157` and `intake.ts:53`, and five test files plus scripts/smoke-contact.ts
  (`extract-contact`, `paper-context`, `two-pass`, `reconcile`, `snippet-scan`,
  plus `scripts/smoke-contact.ts`). Keeping `extractContact`'s signature as a
  wrapper means **only `orchestrate.ts` changes** and no existing test moves.
  `intake.ts`'s `resolveAndExtractContact` is not called from `src/` at all
  (only `test/intake.test.ts`, `test/resilience.test.ts`, and
  `scripts/smoke-intake.ts`), so it is deliberately left alone.

`OrchestrateResult` gains **`rejectedEmails?: RejectedCandidate[]`**, and every
read site uses `(result.rejectedEmails ?? [])`. The field must be OPTIONAL:
`test/loop.test.ts:53` and `test/stranding.test.ts:66` both build an
`OrchestrateResult` literal behind an explicit `: OrchestrateResult` return
annotation, so a required field breaks `npm run typecheck` in two files this
spec has no business editing. The same rule applies to any new `LoopSummary`
field, because `listen.ts:79-93` builds a `LoopSummary` literal the same way
(and `stalled?` is already precedent).

`runContactExtraction` (`orchestrate.ts:140-162`) returns the pair; the
already-on-record shortcut at `:150-155` returns `{ selected, rejected: [] }`
unchanged, because nothing was looked up.

**No paid call moves.** Contact extraction is already step 6, the last step of
`processPaper`, behind the free hook gate installed on 2026-08-02. This change
adds no Tavily call and reorders nothing. The only new spend is one draft LLM
call per needs-address candidate (Change 3), and those candidates are by
construction past the hook gate, so they are exactly the population the system
already considers worth drafting.

### Change 2: type a human-supplied address without corrupting the confidence table

`email_source = 'user_provided'` already exists in the database (1 row, person 1,
P. Zanineli, confidence 1.0) but is not a member of `EmailSource`
(`contacts.ts:5`), and `SOURCE_CONFIDENCE` is a `Record<EmailSource, number>`
that must stay exhaustive. Split the union:

```ts
export type DiscoveredEmailSource = 'pdf' | 'homepage' | 'directory' | 'github_profile' | 'github_commit';
export type EmailSource = DiscoveredEmailSource | 'user_provided';
const SOURCE_CONFIDENCE: Record<DiscoveredEmailSource, number> = { /* unchanged */ };
```

- `EmailCandidate.source` and `RejectedCandidate.source` narrow to
  `DiscoveredEmailSource`. Candidates only ever come from discovery, so
  `scoreCandidate` keeps its exhaustive lookup and a future sixth discovery
  source still fails typecheck if its confidence is not declared.
- `SelectedEmail.source` widens to `EmailSource`, because
  `runContactExtraction`'s on-record shortcut reads a stored `email_source`
  back off the person row and casts it (`orchestrate.ts:153`). Today that cast
  is a lie for the one `user_provided` row; after this change it is honest.
- `extractWebEmailCandidates`'s `const source: EmailSource = cls`
  (`contacts.ts:159`) becomes `DiscoveredEmailSource`; `cls` is already narrowed
  to homepage / directory / github_profile by the aggregator `continue` above it.
- Confidence for a corrected address is **1.0**, matching the existing row. It
  is never fed to `scoreCandidate` or compared against `CONFIDENCE_THRESHOLD`,
  because a human-supplied address does not enter the discovery scoring path at
  all.

**A corrected address is sticky for free.** `runContactExtraction` returns early
whenever `people.email` is already set (`orchestrate.ts:150-155`), so once a
correction lands, no later run re-extracts and no later `upsertPerson` coalesce
can overwrite it with a machine guess. Verified by reading the shortcut; no new
mechanism needed.

### Change 3: the needs-address branch in `processCandidate`

Insert inside the existing email gate (`loop.ts:382`), strictly additive so no
existing verdict is relabelled:

```
if (!result.email) {
  const rejected = result.rejectedEmails ?? [];
  if (rejected.length === 0)                    -> 'no email resolved'   (unchanged)
  if (priorThreads(personId).length > 0)        -> 'prior thread exists (dN)'
  if (addressRequestDeclined(db, personId))     -> 'address correction declined for this person'
  if (dryRun)                                   -> 'discovered', reason 'dry run: would request address', wouldMessage++
  else                                          -> the needs-address path below
}
```

The `priorThreads` check is duplicated here rather than moved above the email
gate. Moving it would relabel every candidate that fails both checks from
`no email resolved` to `prior thread exists`, and the hook-first spec's own
history (its Change 2) is the record of what a gate reorder does to the status
buckets. Duplicating a free, read-only query is cheaper than that.

**`addressRequestDeclined` is new and is not optional.** `d70 n` today calls
`decide(skip)`, which sets `drafts.status = 'skipped'`, and `priorThreads`
(`ledger.ts:310-320`) matches only `sent%`, `approved`, and
`awaiting_approval`. So skipping a needs-address draft **unblocks** the person
while leaving `people.email` NULL, and the next paper by that author re-drafts
them and re-asks for the address, forever. The saved-query and recommend
sources both surface papers by arbitrary authors, so a second paper by the same
person is a normal event, not an edge case. (`deriveWatchAuthors`,
`authorWatch.ts:12-21`, watches only people with a `sent%` or `approved` draft,
so a skip does not put them on the author watchlist; the recurrence comes from
ordinary keyword discovery instead.)

The suppression record is a `draft_events` row of type
`address_request_declined` carrying `{ personId }`, written in `handleReply`'s
skip branch when the skipped draft has an `address_requested` event on record.
It is queried per person, not per draft, because the re-ask arrives on a
different draft id:

```sql
SELECT 1 FROM draft_events
 WHERE type = 'address_request_declined'
   AND json_extract(detail_json, '$.personId') = ?
```

No migration is needed and the shape is already proven here:
`stallAlreadyReported` (`ledger.ts:276-286`) queries `draft_events` by
`json_extract(detail_json, ...)` exactly this way.

The needs-address path:

1. **Draft first, then ask.** Run `generateDraft` and `persistDraft` exactly as
   the sendable path does. `persistDraft` reads `people.email` (NULL here) into
   `drafts.to_email`, which is the shape `outreach add` already parks as a
   manual-lookup queue and which `loadApprovedSend` already refuses as
   `no_snapshot` (`ledger.ts:188`). Nothing new is invented.

   Drafting first is forced, not preferred. The correction reply is handled by
   `handleReply`, whose dependency set is `ReplyDeps` (`db`, `channel`,
   `sender`, `senderEmail`). That split exists specifically so `outreach listen`
   does not fabricate drafting dependencies it never uses (`loop.ts:45-50`).
   Drafting inside the reply handler would put `llm`, `buildDraftInput`, and an
   OpenRouter key into the listener daemon. Drafting up front also gives the
   correction a `dN` to name, which is what makes the reply syntax work.

2. **Text the needs-address message** (Change 4), counted against its **own**
   budget, never against `max_messages_per_run`. See "The message budget"
   below.

3. **Record the row** as `drafted_unsendable` with reason
   `awaiting address correction (dN): rejected <address>`, **passing the draft
   id to `setStatus`**, and log a `draft_events` row of type
   `address_requested` (Change 6).

   The state is encoded in `reason`, not in a new `status` value, because
   `seen_papers.status` carries a `CHECK` constraint baked into the table
   (`schema.sql:119-120`) and `openDb` applies the schema with
   `CREATE TABLE IF NOT EXISTS`, so a new status value would need a full table
   rebuild on a live database.

   **Passing `draftId` is load-bearing, not tidiness.** `strandedReport`'s
   `orphanDrafts` query (`seenLedger.ts:195-208`) selects
   `awaiting_approval` drafts where `p.email IS NOT NULL`, a `seen_papers` row
   exists for the paper, and **no** `seen_papers` row points at the draft. A
   needs-address draft is invisible to it today only because `people.email` is
   NULL. The moment a correction succeeds, `people.email` becomes non-NULL, and
   if `seen_papers.draft_id` were still NULL the draft would appear as an
   orphan and `outreach stranded` would raise that alarm forever. `setStatus`
   COALESCEs `draft_id`, so writing it once at request time is enough.

4. **If the per-run address budget is already spent**, do not text. Record the
   row with reason `address correction not yet requested (dN): rejected
   <address>` (again with the draft id) and leave it. `queued_for_message` is
   the wrong resting place and must not be used: `runLoop`'s queued flush calls
   `resolveSendableDraft`, which hits `loadSendableDraft`'s `no_email` branch
   (`loop.ts:520-526`) and **retires the draft with `decide(skip)`**
   (`loop.ts:608-622`), destroying the very draft the correction is waiting
   for. Verified by reading both functions.

5. **Both new reasons are added to `strandedReport`'s terminalStranded
   predicate** (`seenLedger.ts:185-193`), so `outreach stranded` prints them.
   This is a two-pattern addition to one `LIKE` clause, deliberately scoped to
   the reasons this spec creates. Making the other 252 rows visible is a
   separate spec (see Out of scope).

6. **The deferred backlog is drained by `runLoop`, not by a script.** A step
   at the top of a real run selects `drafted_unsendable` rows whose reason
   matches `address correction not yet requested%` and whose draft is still
   `awaiting_approval` with the person still having no address, oldest first,
   bounded by the same per-run address budget. For each it reads the
   `address_request_deferred` event's `detail_json` (Change 6), rebuilds the
   message from that structured payload rather than parsing the reason string,
   texts it, and rewrites the reason to `awaiting address correction (dN):
   rejected <address>`. Without this the deferred rows are terminal and nothing
   ever asks about them.

   **`scripts/flush-queued-drafts.ts` is deliberately left alone.** The review
   proposed giving it a second pass. Rejected, for three reasons, each checked
   against the file:

   - Its only outbound call is `channel.sendDraftMessage` (line 80), which
     renders `formatDraftMessage`'s `dN: Name (to)` header
     (`photonChannel.ts:25-34`). That header **is** the tapback-approval token
     this spec's whole safety argument turns on, so the needs-address text can
     never go out through it. It would also render `(undefined)` for a null
     address.
   - Its guard at line 54 (`if (!person?.email) { skipped.push(...); continue; }`)
     skips exactly the rows a needs-address pass would target, so the pass
     would have to bypass the script's own safety filter.
   - The file is top-level module code with **zero exports** and no test file,
     so a `notify`-based pass added there would be untestable. Putting the
     drain in `runLoop` instead gives it the same bound, the same counter, the
     same `notify` path, and real vitest coverage.

**The message budget.** The needs-address text gets its own bound and its own
counter, and is never conflated with `summary.messaged`:

- `GateConfig` gains **`maxAddressRequestsPerRun?: number`** (optional, default
  3), read from `gate.max_address_requests_per_run`. Optional because
  `test/loop.test.ts:11`, `test/stranding.test.ts:23`, and
  `test/relevanceGate.test.ts:7` each build a `GateConfig`-shaped literal, and
  a required field breaks all three at the call site.
- `LoopSummary` gains **`addressRequested?: number`** and
  **`addressesPending?: number`**, both optional for the `listen.ts:79-93`
  reason above.
- The needs-address text does **not** increment `summary.messaged` and is
  **not** checked against `maxMessagesPerRun`. Sharing the cap would let an
  address request silently displace an approvable draft, which is a strictly
  worse trade: a draft message can be approved with one tap, an address request
  costs a human lookup. Total texts per run stay bounded at
  `maxMessagesPerRun + maxAddressRequestsPerRun` (10 + 3 today).
- Sizing note. The review flagged the earlier claim that the cap is saturated
  daily as **overstated**. Measured on `data/outreach.db`, drafts created per
  day were 11 (2026-08-01), 6 (2026-08-02), and 7 (2026-08-03), against a
  `max_messages_per_run` of 10. The 18-message day on 2026-08-04 was the
  one-off uncapped flush. So this is hygiene, not an emergency, and 3 is a
  deliberately small starting bound.

**The backlog must be visible without going anywhere.** Pending address
requests appear only in `outreach stranded`, a CLI command, and the owner
demonstrably does not read things that require going somewhere: 18 drafts sat
undelivered until a script was written to push them. So the run summary line
(`loop.ts:894-906`) gains `, address requests N` when any were sent and
`, addresses pending N` whenever the pending count is non-zero, counted as:

```sql
SELECT COUNT(*) FROM seen_papers
 WHERE status = 'drafted_unsendable'
   AND (reason LIKE 'awaiting address correction%'
     OR reason LIKE 'address correction not yet requested%')
```

### Change 4: the message, and why its prefix is load-bearing

Tapback approval resolves a reaction by parsing `/^\s*(d\d+):/` off the text of
the reacted-to message (`draftIdFromReactedText`, `photonChannel.ts:134-137`)
and converting a thumbs up into `dN y`. A needs-address message beginning
`d70:` would therefore let one thumbs up **send the very email that was flagged
as going to the wrong person**.

The regex has no `m` flag, so only the start of the whole message text matters.
The message must begin with the literal `NEEDS ADDRESS`, and no line of it may
begin with `dN:` (a belt-and-braces rule, since a future refactor could add the
flag).

```
NEEDS ADDRESS for d70
Xiyu Zhang (Tongji University)
Paper: <title>
Rejected: zhangyanghui@tongji.edu.cn (homepage) because the local part names a different person
Reply "d70 to their@address.edu" with the right address, or "d70 n" to skip.
```

Note the header is `NEEDS ADDRESS for d70` with no colon after the id, so even a
tolerant future parser finds nothing to bind.

**The three offending notify strings are already fixed.** Commit 733c3c9
reworded all of them and added `test/notify-tapback-safety.test.ts`, which reads
`loop.ts`, `listen.ts`, and `cli.ts` as text and asserts that no `notify()` call
begins with a draft id followed by a colon. The history, kept because it is the
reason the guard exists:

- `loop.ts:140-143`, the `already_attempted` refusal, used to render as
  `d70: a send attempt was already recorded ...`. Inert (a send claim is never
  cleared by any path here) but reworded anyway. Now `d70 NOT SENT: ...`.
- `loop.ts:158-161`, the `recipient_changed` refusal, was the dangerous one and
  was already reachable before this spec: `upsertPerson` uses
  `email = coalesce(?, email)`, so a later run that rediscovers the original
  address closes the mismatch on its own, and a thumbs up on the old refusal
  becomes a live send. This spec would have made it reachable a second way.
  Now `d70 NOT SENT: the address changed ...`.
- `loop.ts:250-252`, the dry-run notice, is not reachable on the phone
  (`cmdLoop` builds `createStubChannel()` for a dry run), and was reworded for
  consistency with no safety claim attached. Now `d70 DRY RUN: ...`.

**What this spec still owes.** Every new string it adds must avoid the pattern,
and the source-level test must be EXTENDED, not re-created, to cover the new
source file the correction logic lands in. In particular the correction
acknowledgement is `Recorded alice@x.edu for Xiyu Zhang (d70). Nothing sent
yet.`, never `d70: address recorded`.

### Change 4a: a tapback on a NEEDS ADDRESS message must not be silence

`reactionToCommand` (`photonChannel.ts:140-147`) returns `null` and only
`console.log`s when the reacted-to text carries no `dN:` header. That is correct
for a status line, and wrong here. The owner's trained reflex on a message about
a draft is a tapback: it is the interaction this codebase deliberately built,
and its comment says so ("Approving 48 drafts by typing `d25 y` each time is
slow enough that it stops happening"). On a NEEDS ADDRESS message a tapback now
produces **total silence**, which is indistinguishable from a broken listener.

So the channel replies on-channel instead of only logging. `decodeReply` stops
returning `InboundReply | null` and returns a small union:

```ts
type Decoded =
  | { kind: 'reply'; reply: InboundReply }
  | { kind: 'hint'; text: string }   // send this back, act on nothing
  | { kind: 'ignore' };
```

Both `captureReplies` and `streamReplies` already live inside
`createPhotonChannel`, where `dm` is in scope, so both can send the hint from
the single shared decode and cannot drift. The hint fires only when the
reacted-to text matches `/^NEEDS ADDRESS for (d\d+)\b/`:

```
d70 needs a typed address, not a tapback. Reply "d70 to their@address.edu", or "d70 n" to skip.
```

That string begins with `d70 ` and no colon, so it is not itself an approval
button. A reaction on anything else keeps today's behaviour exactly: log and
ignore, with no reflected message, which matters because the line may be shared
and must never become an open reflector.

### Change 5: the reply syntax and the exact state transition

**Syntax:** `d70 to someone@uni.edu`. Verified against the current parser by
running it: `parseReply('d70 to someone@uni.edu')` returns
`{ kind: 'unsupported', shortId: 'd70' }` today, so `handleReply` answers "Edits
are not yet supported" and logs `edit_reply_unsupported`. `parseReply` gains a
new kind ahead of that fallthrough:

```ts
| { kind: 'address'; shortId: string; email: string }
```

- Matches only when exactly two tokens follow the id, the first is `to`, and the
  second is a syntactically valid single address. `d70 to the point` still
  returns `unsupported`, so the future edit path (F5) loses almost nothing.
- A bare `d70 someone@uni.edu` is **not** accepted. One advertised form, matching
  the existing `d70 y` shape, keeps the grammar as small as the codebase's own
  "an approval must contain a verb" rule (`channel.ts:71-78`) implies.
- `parseReply` lowercases its input at `channel.ts:57`. The address must be read
  from the **raw** text, since a local part is not formally case-insensitive.
  Lowercase the domain, preserve the local part, and echo the whole thing back
  so a phone autocorrect is visible.

**Two parser traps, both verified by running the current parser.**

1. **`rest` is not positionally aligned with the input.** The id-stripping loop
   at `channel.ts:62-69` removes the id token wherever it appears, not only at
   position 0. Measured: `parseReply('to d70 a@b.edu')` yields
   `rest = ['to', 'a@b.edu']`, identical to `parseReply('d70 to a@b.edu')`.
   So recovering the original-case address by indexing the raw split at
   `rest`'s index is off by one for that input, and would read `'d70'` as the
   address. The implementation must record, for each token pushed into `rest`,
   its index in the ORIGINAL split, and index the raw split by that.
2. **iOS inserts a period on double-space.** `d70 to a@b.edu.` must work.
   Strip one run of trailing sentence punctuation (`.,;:!?`) from the address
   token before validating. A real address never ends in one, so this cannot
   corrupt a good address.

Measured baselines, from running `parseReply` today, all of which the new kind
must change or preserve deliberately:

| input | today |
| --- | --- |
| `d70 to someone@uni.edu` | `unsupported` (becomes `address`) |
| `to d70 a@b.edu` | `unsupported` (becomes `address`; harmless, and refusing it would cost more logic than accepting it) |
| `d70 a@b.edu` | **`unsupported`**, not `unparseable` (stays `unsupported`) |
| `d70 to a@b.edu.` | `unsupported` (becomes `address`) |
| `d70 to the point` | `unsupported` (unchanged) |
| `a@b.edu` (bare address) | `unparseable` (unchanged) |

### Change 5a: the three refusals, and why a one-digit typo is the real blocker

The reply is typed on a phone. `d17` and `d70` are one keystroke apart. Traced
through the code as originally specced, `d17 to alice@x.edu` when `d70` was
meant would:

1. overwrite person 17's verified `people.email` at `confidence 1.0,
   email_source 'user_provided'`;
2. make that permanent, because `runContactExtraction`'s on-record shortcut
   (`orchestrate.ts:150-155`) returns early forever once `people.email` is set,
   and `upsertPerson`'s `email = coalesce(?, email)` (`db.ts:107`) cannot
   displace a non-NULL value;
3. rewrite `drafts.to_email` for d17 so `loadApprovedSend` returns `ok`
   (`ledger.ts:192`);
4. re-present d17 as a normal, tapback-approvable draft;
5. and then one thumbs up sends a real, irreversible cold email to the wrong
   human.

The acknowledgement as originally written (`Recorded d70 to x@y.edu.`) named the
id and the address but **not the person**, so every step of that is invisible.
Three changes close it, and all three are required together.

**Refusal 1: the acknowledgement names the person.**

```
Recorded alice@x.edu for Xiyu Zhang (d70). Nothing sent yet.
```

The name is the only token in that sentence the owner can check against what he
intended. `SENT ${shortId} to ${personName} <${to}>` (`loop.ts:206`) already
made exactly this argument for the send confirmation; this extends it one step
earlier, to where the mistake is still reversible.

**Refusal 2: never overwrite a machine-verified address.** A correction whose
target person has a non-NULL `people.email` whose `email_source` is anything
other than `'user_provided'` is REFUSED, with:

```
d70 not changed: Xiyu Zhang already has zhangyanghui@tongji.edu.cn on record (homepage). Did you mean a different draft? Nothing recorded.
```

Both intended uses still work, by construction:

- the needs-address flow, where `people.email` is NULL because nothing resolved;
- re-correcting your own typo, where the stored value is already
  `'user_provided'` and may be overwritten freely.

Only the third case, aiming at a person the machine already resolved, is
refused, and that case is either a typo or a job for a separate "the machine was
wrong about a resolved address" flow that this spec does not own.

**Refusal 3: no address was asked for, and none is missing.** A correction is
refused when the named draft has **no `address_requested` event on record** AND
its person already has an address. This catches the residual case Refusal 2
lets through: aiming at a person whose stored address is already
`'user_provided'` from an earlier correction. The check is one query:

```sql
SELECT 1 FROM draft_events WHERE draft_id = ? AND type = 'address_requested'
```

A draft with no request and a person with NO address is still allowed, because
that is exactly `outreach add`'s manual-lookup queue (`cli.ts:365-368`), which
this spec deliberately serves.

**An advisory name check, adopted.** `nameMatches` is still not a gate on a
human-supplied address: gating on the check that just failed would be circular,
and it would block the unusual-but-correct addresses this feature exists to
rescue (`ishen@stu.hit.edu.cn` for Xiongri Shen is the measured example). But
running it as an ECHO costs nothing and surfaces the same typo class from a
second direction:

```
Recorded alice@x.edu for Xiyu Zhang (d70). The local part does not name that person. Nothing sent yet.
```

Adopted. The correction still lands; the sentence appears only when
`nameMatches(localPart, personName)` is false.

**Which drafts may be corrected.** Decided by what the send path can still
refuse:

| draft state | correction | why |
| --- | --- | --- |
| `awaiting_approval` | **allowed**, whether or not the person has an email | covers the needs-address flow, `outreach add`'s manual-lookup queue, a re-correction after a typo, and a draft presented with a wrong-but-name-matching address |
| `approved`, `send_attempted_at IS NULL` | **allowed** | this is the remedy for the `no_snapshot` and `recipient_changed` refusals, both of which return before the claim (`ledger.ts:184-193`); a further explicit `d70 y` is still required |
| `approved`, `send_attempted_at` set | refused | the one send attempt is spent and Gmail's outcome is unknown; nothing here may resolve that |
| `sent`, `sent (stubbed)`, `skipped` | refused | never rewrite the recipient of a decided draft |

**The transaction.** One `db.transaction`, on the draft's person and on that one
draft:

```sql
UPDATE people SET email = ?, email_confidence = 1.0, email_source = 'user_provided',
                  updated_at = datetime('now')            WHERE id = ?;
UPDATE drafts SET to_email = ?                             WHERE id = ?;
-- and, when a seen_papers row points at this draft, clear the stale reason:
UPDATE seen_papers SET reason = 'address corrected (dN)', updated_at = datetime('now')
                                                           WHERE draft_id = ?
                                                             AND status = 'drafted_unsendable'
                                                             AND (reason LIKE 'awaiting address correction%'
                                                               OR reason LIKE 'address correction not yet requested%');
-- plus a draft_events row of type 'address_corrected'
```

The `seen_papers` write is the third one the review found missing. Without it,
the row keeps reading `awaiting address correction (dN)` after the draft has
been corrected, approved, and sent, and `outreach stranded` prints a resolved
item forever, which is the same "loud channel that cries wolf" failure the
stranding spec exists to avoid. The two `LIKE` patterns are spelled out in
full and are the same pair added to `strandedReport` in Change 3, so the
predicate that makes a row stranded and the predicate that un-strands it cannot
drift. (A single collapsed pattern such as `'a%address correction%'` looks
tempting and is wrong: it does not match `address correction not yet
requested`, because there is no second occurrence of the literal after the
leading `a`.) The row deliberately STAYS at `drafted_unsendable`: the paper was not
messaged as a draft candidate, and promoting it to `messaged` would claim
something that has not happened yet. It simply stops being stranded.

Both `people` and `drafts` writes are mandatory and neither alone works:

- Writing only `drafts.to_email` leaves `people.email` NULL, and
  `loadApprovedSend` compares `row.toEmail !== row.currentEmail`
  (`ledger.ts:192`), so `'x@y.edu' !== null` returns **`recipient_changed`** and
  the send is refused forever. This is the subtle failure the constraint names.
- Writing only `people.email` leaves the frozen snapshot NULL and returns
  `no_snapshot` (`ledger.ts:188`).

Writing both keeps them equal, so the D2 check passes for this draft. It still
fires for a genuine mismatch, because any later divergence (a correction on a
different draft for the same person, or an `upsertPerson` coalesce) moves
`people.email` away from this draft's frozen snapshot. Other drafts for the same
person keep their own older snapshots and will be refused, which is correct:
they were never approved against the new address. In practice `priorThreads`
makes multiple concurrent `awaiting_approval` drafts per person rare.

Setting `people.email` also un-strands three other paths that key off that column
being non-NULL: `loadSendableDraft` (`loop.ts:520`), `findAdoptableOrphans`
(`loop.ts:645-656`), and `flush-queued-drafts.ts:54`.

**Every existing safety gate still applies, unchanged.** The correction writes
state; it does not send. A later `d70 y` runs the identical path: `decide`
first-write-wins, then `loadApprovedSend` (status, attempt, grounding, snapshot,
recipient-changed), then `assertSafeOutbound`, then `beginSendAttempt`'s
conditional UPDATE, then `markSent`. Nothing is bypassed and no new send path is
created. A cheap shape check at correction time (reject an address containing
whitespace, CR, LF, a comma, or angle brackets) exists only so a malformed reply
is refused with a useful message instead of at send time; `assertSafeOutbound`
remains the real gate.

**`nameMatches` is deliberately not run on a corrected address.** The human is
the identity authority here; running the check that just failed would be
circular.

**After a successful correction**, in order: acknowledge
(`Recorded alice@x.edu for Xiyu Zhang (d70). Nothing sent yet.`, plus the
advisory sentence when the name check fails), then present the draft with
`channel.sendDraftMessage`, so it arrives in the standard
`d70: Name (address)` format and tapback works on it as on any other draft. The
presentation is **not** counted against `max_messages_per_run`: it is one message
per reply he typed, so it is self-limiting, and a run's cap has no meaning inside
`outreach listen`, which has no run.

**Dry run.** `handleReply`'s D4 rule puts the dry-run check before any mutation
(`loop.ts:249`). A correction is a mutation, so a dry run reports what it would
have recorded and writes nothing.

### Change 6: what must be recorded now for the pattern-learning spec

Three `draft_events` types, all with `draft_id` set:

- `address_requested`, written when the needs-address message is texted:
  `{ personId, personName, affiliation, rejected: [{ email, source, reason }], via: 'loop' }`.
  An unanswered request is data too. This event is also load-bearing at
  runtime: Refusal 3 and the eval rule in Change 8 both key off it.
- `address_corrected`, written inside the correction transaction:
  `{ personId, personName, affiliation, rejectedEmail, rejectedSource, rejectionReason, correctedEmail, correctedHost, correctedDomain, priorDraftStatus, nameMatched, via: 'imessage' }`.
  `nameMatched` records the advisory check's verdict, so the follow-on spec can
  tell how often a human-supplied address fails the machine's own rule.
- `address_request_declined`, written when `dN n` retires a draft that has an
  `address_requested` event: `{ personId }`. This is the durable suppression
  record; see Change 3.
- `address_request_deferred`, written when the per-run address budget is spent
  or the text fails to send: the same payload as `address_requested`. It exists
  so the backlog drain (Change 3, item 6) can rebuild the exact message later
  from structured data instead of parsing the address back out of a
  `seen_papers.reason` string, which would couple the drain to reason wording
  this spec changes twice.

`correctedHost` is the full hostname and `correctedDomain` is the registrable
domain from `tldts.parse` (already a dependency, used at `contacts.ts:192`).
Both are stored because institutional patterns differ between `njust.edu.cn` and
`cs.njust.edu.cn`.

This satisfies the minimum the follow-on spec needs: the rejected address, the
corrected address, the domain, and the reason for rejection, joinable to
`people` for the 111 pdf-verified addresses across 88 registrable domains that
would seed the same pattern table.

### Change 7: the two help strings that currently give wrong advice

The two most likely replies to a NEEDS ADDRESS message from someone who has not
memorised the syntax are a bare address and `dN addr` without the `to`. Both
were run against the current parser. Both land on a help string that is now
actively wrong:

- `parseReply('alice@x.edu')` returns `unparseable`, reaching `loop.ts:225`:
  `Could not read "...". Reply like "d7 y" or "d7 n".` It advertises the two
  forms that are useless here.
- `parseReply('d70 alice@x.edu')` returns `unsupported`, reaching
  `loop.ts:239`: `Edits are not yet supported for d70. Reply "y" to send or
  "n" to skip.` Worse: it tells him to approve a draft the system has just
  flagged as going to the wrong person, and a tapback on any message is one
  gesture away from doing it.

Both strings must advertise `dN to addr`. Neither may begin with `dN:`. The
`unsupported` string in particular becomes:

```
Edits are not yet supported for d70. Reply "d70 to their@address.edu" to set the address, "d70 y" to send, or "d70 n" to skip.
```

### Change 8: keep the trust-and-safety eval honest

`scripts/eval-trust-safety.ts:83-85` emits a hard `TS2` **fail** for any draft
at the queried status with no `to_email`. Needs-address drafts have exactly that
shape by construction, so shipping this spec without a rule turns that eval
permanently red, and an eval that is always red is an eval nobody reads.

Rule: a draft with no `to_email` that has an `address_requested` `draft_events`
row is scored **`review`**, not `fail`, with detail `awaiting a human-supplied
address (requested <timestamp>)`. Any other draft with no `to_email` stays a
hard `fail`, unchanged. Keying on the event rather than on the `seen_papers`
reason text keeps the eval independent of reason-string wording, which this spec
changes twice.

### Change 9: `outreach add` should say a candidate was rejected

`cli.ts:367` prints `no email found: draft stays awaiting_approval in the
manual-lookup queue`. After Change 1, "no email found" can mean two different
things, and one of them is actionable. One extra line when
`(r.rejectedEmails ?? []).length > 0`:

```
  rejected candidate(s): zhangyanghui@tongji.edu.cn (homepage) did not name this person
```

No behaviour change, no new gate. It exists because the operator surface should
not report a rejection as an absence.

## Behavioral changes to acknowledge

- **`no email resolved` shrinks.** Candidates that produced a rejected
  candidate now land at `awaiting address correction` instead. The 50 existing
  rows are not migrated; only new runs split.
- **`outreach stranded` gains two reason patterns** and stops printing zero
  rows for this class. The other 252 `drafted_unsendable` rows stay invisible.
- **`drafts` accumulates rows with `to_email` NULL** on the loop path, a shape
  only `outreach add` produced before. `loadApprovedSend` already refuses them
  (`no_snapshot`) and `findAdoptableOrphans` already excludes them.
- **A needs-address draft blocks its person from every future candidate** via
  `priorThreads`, permanently, because the `seen_papers` row is terminal and the
  exhaustion sweep only touches rows resting at `discovered`. That is correct
  behaviour (do not ask twice about one person) but it has no automatic exit:
  the exit is `d70 n`, or a correction. `outreach stranded` and the run-summary
  pending count are what make it visible.
- **`d70 n` is now permanent for that person, not just for that draft.** Today a
  skip unblocks the person; after Change 3 it also writes
  `address_request_declined`, which suppresses every future needs-address text
  for them. That is the point (the alternative is asking forever) but it means
  a mis-tapped thumbs down is unrecoverable from the phone. The remedy is
  `outreach add` on a later paper, which does not consult the flag.
- **`email_source` becomes a two-tier concept**: five discovered sources scored
  by a table, plus `user_provided` which is not scored at all.
- **A tapback on a NEEDS ADDRESS message now produces an outbound message**
  (Change 4a) where today it produces nothing. This is the only new case in
  which the channel replies to a reaction it does not act on.
- **`recipient_changed`'s notify text already changed** (commit 733c3c9).
  Anything that greps the iMessage thread for the old form will miss.
- **One extra draft LLM call per needs-address candidate**, on OpenRouter, not
  Tavily. Zero change to Tavily spend or to `processPaper`'s order.
- **Total texts per run rise** from at most `max_messages_per_run` (10) to at
  most `10 + max_address_requests_per_run` (13).

## Verification

Per the project rule, demonstrate against reality, not artifacts. Baseline
measured today, after commit 733c3c9: **48 test files, 559 tests, all passing**.

1. **The tapback regression, which is the whole point of Change 4.** Feed
   `createPhotonChannel` a `content.type === 'reaction'` message whose
   `target.content.text` is the exact needs-address string, and assert
   `captureReplies` returns `[]` **and** that exactly one hint was sent on the
   channel (Change 4a). Then, at the `handleReply` level with a real in-memory
   DB and a sender spy, assert zero rows in `decisions`, zero `draft_events` of
   type `decision` or `send_attempted`, and zero calls to `sender.send`.
   **Mutate**: change the header to `d70: needs address`, confirm the test goes
   red, restore. The source-level guard in
   `test/notify-tapback-safety.test.ts` is EXTENDED to cover the new module,
   not re-created.
2. **The recipient-changed pair.** After a correction, `loadApprovedSend`
   returns `ok` for that draft. Then call `upsertPerson` with a different
   address and assert **`loadApprovedSend`** now returns `recipient_changed`.
   (The earlier draft of this spec said "assert `upsertPerson` returns
   `recipient_changed`", which is nonsense: `upsertPerson` returns a person id.)
   Both assertions in one test, because either alone can pass for the wrong
   reason.
3. **At-most-once survives correction.** correct, `d70 y` (sends once), `d70 y`
   again (`already_attempted`, nothing sent). Assert `send_attempts == 1`.
4. **`assertSafeOutbound` still gates.** The test **calls the correction
   function directly**, not through `parseReply`, with an address carrying a CR
   and a `Bcc:` continuation. Stated explicitly because `parseReply` splits on
   `/\s+/` (`channel.ts:57`), so no whitespace-bearing address can ever reach
   the correction path through it, and a test written through `parseReply`
   could not fail. Assert the correction is refused by the cheap shape check
   and that `people.email` and `drafts.to_email` are both unchanged.
5. **Refusal matrix**: one test per row of the Change 5 draft-state table, plus
   one each for Refusal 2 (a person with a `homepage`-sourced address) and
   Refusal 3 (a person with a `user_provided` address and no
   `address_requested` event on the named draft). Each asserts zero writes to
   `people`, `drafts`, and `decisions`. Refusal 2's test is the typo-blocker
   regression and is the single most important test in this spec.
6. **Parser tests**: `d70 to a@b.edu` -> address; `d70 to the point` ->
   unsupported; `d70 a@b.edu` -> **unsupported** (measured, not `unparseable`);
   `d70 to a@b.edu.` -> address with the trailing period stripped;
   `to d70 a@b.edu` -> address `a@b.edu` and NOT `d70` (the index-mapping
   regression); `d70 to A.B@Uni.EDU` preserves `A.B` and lowercases `Uni.EDU`.
7. **Loop fixtures**, fresh `:memory:` DB per case: `{ email: null,
   rejectedEmails: [one] }` produces a draft, one needs-address message, the
   `awaiting address correction` reason, and a `seen_papers.draft_id` that is
   NOT NULL; `{ email: null, rejectedEmails: [] }` still produces
   `no email resolved`; the address-budget-spent case produces no message and
   the `not yet requested` reason; a full `max_messages_per_run` of approvable
   drafts still gets messaged in the same run as a needs-address candidate
   (the budget-separation regression); and a person with an
   `address_request_declined` event produces no message at all.
8. **The resolved-row test.** After a successful correction, assert
   `strandedReport(db, n).terminalStranded` no longer contains that arxiv id
   and `orphanDrafts` is empty. **Mutate**: drop the `seen_papers` write from
   the transaction, confirm red; then separately drop the `draftId` argument
   from the needs-address `setStatus`, confirm `orphanDrafts` goes non-empty.
9. **Eval rule.** Run `npx tsx scripts/eval-trust-safety.ts` against a copy of
   `data/outreach.db` seeded with one needs-address draft and confirm the hard
   gate still reads PASS with that draft listed as `review`, not `fail`.
10. **Live demonstration, required before this is called done.** On a copy of
   `data/outreach.db`, run the real path against a paper whose author's address
   the tightened rule rejects (the audit script names candidates: person 12
   Xiongri Shen / `ishen@stu.hit.edu.cn`, person 222 Zhisheng Han /
   `l.zhang.16@bham.ac.uk`). Show the actual iMessage text that arrives, reply
   with a real address, show the acknowledgement and the presented draft, then
   dump the `people` row, the `drafts.to_email` value, and both `draft_events`
   rows. Screenshots or transcript, not a description.

### Test dispositions

| File | Disposition |
| --- | --- |
| `test/photonChannel.test.ts` | **Add** the needs-address reaction case from Verification 1, asserting both `[]` and the one hint message. Existing tapback tests keep passing unchanged. |
| `test/channel.test.ts` | **Add** the parser cases from Verification 6, including the `to d70 a@b.edu` index-mapping case and the trailing-period case. |
| `test/notify-tapback-safety.test.ts` | **Extend** its `SOURCES` array with the new module. Do NOT write a second copy of this test. |
| `test/approval.test.ts`, `test/send-path.test.ts` | **Add** Verifications 2 to 5. |
| `test/loop.test.ts` | **Add** the five fixtures from Verification 7. Its `resolvedResult` literal (`:53`) must keep compiling, which is why `rejectedEmails` is optional. |
| `test/extract-contact.test.ts`, `two-pass`, `reconcile`, `snippet-scan`, `paper-context` | **Unchanged.** `extractContact` keeps its signature; only the new `extractContactDetailed` is added. Verified: those five files plus `scripts/smoke-contact.ts` are every non-production caller. |
| `test/name-match.test.ts` | **Unchanged.** This spec does not touch `nameMatches`; it only reads it advisorily. |
| `test/stranding.test.ts` | **Add** cases asserting `strandedReport` prints both new reasons and drops a corrected row (Verification 8). Its `resolvedResult` literal (`:66`) and its `GATE` literal (`:23`) must keep compiling. |
| `test/orchestrate.test.ts` | **Add** a case asserting `rejectedEmails` is populated and that the paid-call ordering assertions still hold. |
| `scripts/flush-queued-drafts.ts` | **Unchanged**, deliberately. See Change 3, item 6. |

## Risks

- **The human is the only check on the corrected address.** Nothing validates
  that `someone@uni.edu` belongs to the person; a mistyped-but-valid address
  sends a cold email to a stranger, which is the failure this spec exists to
  reduce. Accepted deliberately: he is the identity authority. The mitigations
  are the echo-back naming the person, the advisory `nameMatches` sentence, and
  the separate `d70 y`.
- **A mistyped-but-valid address permanently strands the draft AND the person,
  even when nothing is sent.** A hard 550 from a plausible domain leaves the
  draft at `approved` with `send_attempted_at` set, because `markSendFailed`
  (`ledger.ts:131-139`) writes only a `send_failed` event and deliberately never
  clears the claim. `loadApprovedSend` then returns `already_attempted` forever,
  a further correction is refused by the Change 5 table's third row, and
  `priorThreads` matches `approved`, so the person is uncontactable too. This is
  a real second failure mode alongside the send-to-a-stranger one, it is
  reachable through this spec's new path, and nothing here resolves it: recovery
  is a human act by design (see `docs/superpowers/plans/2026-07-29-send-path-safety.md`).
  `reportStalledApprovals` at least makes it loud once per attempt count.
- **The typo blocker is closed by three checks, not one.** Refusals 1, 2, and 3
  are independent, and shipping only some of them leaves the wrong-person send
  reachable. Any implementation plan must land them together.
- **Volume.** 40 of 180 stored addresses (22%) fail the tightened rule. If that
  rate holds, roughly one in five hooked candidates produces a needs-address
  text. At the recent rate that is a handful a day, which the
  `max_messages_per_run` cap bounds, but an unread queue is its own failure
  mode and this adds to the same queue tapback approval was built to shorten.
- **False rejections now cost human time instead of being silent.** That is the
  intended trade, not a side effect. If the rate is intolerable, the fix is to
  loosen `nameMatches`, not to re-hide the rejections.
- **Phone autocorrect** can mangle an address between his intent and the wire.
  Echo-back makes it visible; nothing makes it impossible.
- **Correcting an `approved` draft changes the recipient the approval covered.**
  Bounded to the never-attempted case and requires a second explicit `d70 y`,
  but it is a real widening of what a reply can do.
- **The `recipient_changed` notify reword is load-bearing** (Change 4) and has
  already shipped in commit 733c3c9. If this spec were somehow implemented on a
  tree without it, a tapback on an older refusal message would become a live
  send once the address is corrected. `test/notify-tapback-safety.test.ts` is
  what keeps that from regressing.
- **Both the batch loop and `outreach listen` handle corrections**, through the
  single shared `handleReply`, so they cannot drift. That is the same argument
  the tapback path rests on, and it holds only as long as no correction logic is
  added outside `handleReply`.

## Out of scope

- **Learning per-institution address patterns.** The obvious follow-on: mine the
  `address_corrected` events plus the 111 pdf-verified addresses (88 distinct
  registrable domains, 93 distinct hostnames) so a future lookup for
  `@tongji.edu.cn` generates and
  verifies `first.last@` candidates instead of paying a search engine. This spec
  records exactly what that one needs (Change 6) and designs none of it.
- **Extending needs-address to the "found nothing at all" case** (the other part
  of the 50 `no email resolved` rows). Same loop, different message, different
  volume. The gate is one condition (`rejectedEmails.length > 0`), so flipping it
  later is a one-line change once the volume of this spec is measured.
- **Making the other 252 `drafted_unsendable` rows visible or retryable in
  `outreach stranded`.** Only the two reasons this spec creates are added.
- **Any change to `nameMatches`, `scoreCandidate`, or the confidence values.**
  Detection shipped today; this is the recovery side.
- **Edit replies (F5)**, a web approval surface, and any non-iMessage channel.
- **Migrating the 40 already-stored rejected addresses.** They are reported by
  `scripts/audit-name-match-tightening.ts` today; deciding what to do with the
  ones already sent is a separate call.
- **Clearing `send_attempted_at` so a 550 can be recovered from the phone.**
  Named in Risks, deliberately not solved here: it is a change to the
  at-most-once mechanism, which is the most safety-critical code in the repo and
  deserves its own spec.
- **Undoing an `address_request_declined`.** No reply syntax un-declines a
  person. `outreach add` remains the escape hatch.
- **Making `scripts/flush-queued-drafts.ts` testable.** It stays top-level
  module code with no exports. This spec routes around it rather than
  refactoring it (Change 3, item 6).
