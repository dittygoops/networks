> **REVIEWED 2026-08-04.** Two reviewers ran. Both safety-critical arguments
> (the two-write transaction, and the `dN:` tapback hazard) were independently
> CONFIRMED. Factual corrections applied below. One nuance the review added:
> `recipient_changed` is not strictly inert today either, because
> `upsertPerson` uses `email = coalesce(?, email)`, so a later run that
> rediscovers the original address closes the mismatch on its own and makes a
> stale tapback live. **That reword shipped separately and ahead of this spec**
> (all three `dN:` notify strings, guarded by test/notify-tapback-safety.test.ts).

# Address Correction: ask the human for the address instead of dropping the person

**Date:** 2026-08-04
**Status:** Draft, not yet reviewed
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
| distinct registrable domains among the 111 pdf-verified addresses | 93 |
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

`OrchestrateResult` gains `rejectedEmails: RejectedCandidate[]` (default `[]`).
`runContactExtraction` (`orchestrate.ts:140`) returns the pair; the
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
  if (result.rejectedEmails.length === 0)  -> 'no email resolved'   (unchanged)
  if (priorThreads(personId).length > 0)   -> 'prior thread exists (dN)'
  if (dryRun)                              -> 'discovered', reason 'dry run: would request address', wouldMessage++
  else                                     -> the needs-address path below
}
```

The `priorThreads` check is duplicated here rather than moved above the email
gate. Moving it would relabel every candidate that fails both checks from
`no email resolved` to `prior thread exists`, and the hook-first spec's own
history (its Change 2) is the record of what a gate reorder does to the status
buckets. Duplicating a free, read-only query is cheaper than that.

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

2. **Text the needs-address message** (Change 4), counted against
   `max_messages_per_run` (`config/watchlist.yaml:67`, currently 10). It spends
   the same attention budget a draft message does.

3. **Record the row** as `drafted_unsendable` with reason
   `awaiting address correction (dN): rejected <address>`, and log a
   `draft_events` row of type `address_requested` (Change 6).

   The state is encoded in `reason`, not in a new `status` value, because
   `seen_papers.status` carries a `CHECK` constraint baked into the table
   (`schema.sql:119-120`) and `openDb` applies the schema with
   `CREATE TABLE IF NOT EXISTS`, so a new status value would need a full table
   rebuild on a live database.

4. **If the per-run cap is already spent**, do not text. Record the row with
   reason `address correction not yet requested (dN): rejected <address>` and
   leave it. `queued_for_message` is the wrong resting place and must not be
   used: `runLoop`'s queued flush calls `resolveSendableDraft`, which hits
   `loadSendableDraft`'s `no_email` branch (`loop.ts:520-526`) and **retires the
   draft with `decide(skip)`** (`loop.ts:608-622`), destroying the very draft
   the correction is waiting for. Verified by reading both functions.

5. **Both new reasons are added to `strandedReport`'s terminalStranded
   predicate** (`seenLedger.ts:186-190`), so `outreach stranded` prints them.
   This is a two-pattern addition to one `LIKE` clause, deliberately scoped to
   the reasons this spec creates. Making the other 252 rows visible is a
   separate spec (see Out of scope).

6. **`scripts/flush-queued-drafts.ts` gains a second pass** that delivers rows
   at reason `address correction not yet requested%`, uncapped, and flips their
   reason to `awaiting address correction%` on success. That script already
   exists for exactly this failure (drafts created but never texted), is
   uncapped, spends zero Tavily credits, and needs no new config. It only reads
   `getQueued` today, so this is an addition, not a change to its existing pass.

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

**Three existing notify strings already match the forbidden pattern**, and one of
them becomes dangerous because of this spec:

- `loop.ts:141`, the `already_attempted` refusal, renders as
  `d70: a send attempt was already recorded ...`. A tapback on it decodes to
  `d70 y` and re-reaches `already_attempted`, which refuses. It stays inert
  under this design, because a send claim is never cleared by any path here.
- `loop.ts:159`, the `recipient_changed` refusal, renders as
  `d70: the address changed since you approved it ...`. Today a tapback on it
  re-reaches the same refusal. **After Change 5 it does not**: correcting the
  address makes `to_email == people.email` again, so a thumbs up on that older,
  still-scrollable message would decode to `d70 y` and send. This spec must
  reword it so it does not start with `dN:`.
- `loop.ts:251`, the dry-run notice, also matches, but is **not** reachable on
  the phone: `cmdLoop` builds `createStubChannel()` for a dry run
  (`cli.ts:135`), so it never reaches iMessage. Reworded anyway for consistency,
  with no safety claim attached.

Every new string this spec adds must also avoid the pattern. In particular the
correction acknowledgement is `Recorded d70 to x@y.edu. Nothing sent yet.`, not
`d70: address recorded`.

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
-- plus a draft_events row of type 'address_corrected'
```

Both writes are mandatory and neither alone works:

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
(`Recorded d70 to x@y.edu. Nothing sent yet.`), then present the draft with
`channel.sendDraftMessage`, so it arrives in the standard
`d70: Name (address)` format and tapback works on it as on any other draft. The
presentation is **not** counted against `max_messages_per_run`: it is one message
per reply he typed, so it is self-limiting, and a run's cap has no meaning inside
`outreach listen`, which has no run.

**Dry run.** `handleReply`'s D4 rule puts the dry-run check before any mutation
(`loop.ts:249`). A correction is a mutation, so a dry run reports what it would
have recorded and writes nothing.

### Change 6: what must be recorded now for the pattern-learning spec

Two `draft_events` types, both with `draft_id` set:

- `address_requested`, written when the needs-address message is texted:
  `{ personId, personName, affiliation, rejected: [{ email, source, reason }], via: 'loop' }`.
  An unanswered request is data too.
- `address_corrected`, written inside the correction transaction:
  `{ personId, personName, affiliation, rejectedEmail, rejectedSource, rejectionReason, correctedEmail, correctedHost, correctedDomain, priorDraftStatus, via: 'imessage' }`.

`correctedHost` is the full hostname and `correctedDomain` is the registrable
domain from `tldts.parse` (already a dependency, used at `contacts.ts:192`).
Both are stored because institutional patterns differ between `njust.edu.cn` and
`cs.njust.edu.cn`.

This satisfies the minimum the follow-on spec needs: the rejected address, the
corrected address, the domain, and the reason for rejection, joinable to
`people` for the 111 pdf-verified addresses across 93 domains that would seed
the same pattern table.

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
  the exit is `d70 n`, or a correction. `outreach stranded` is what makes it
  visible.
- **`email_source` becomes a two-tier concept**: five discovered sources scored
  by a table, plus `user_provided` which is not scored at all.
- **`recipient_changed`'s notify text changes** (Change 4). Anything that greps
  the iMessage thread for it will miss.
- **One extra draft LLM call per needs-address candidate**, on OpenRouter, not
  Tavily. Zero change to Tavily spend or to `processPaper`'s order.

## Verification

Per the project rule, demonstrate against reality, not artifacts. Baseline
measured today: **47 test files, 556 tests, all passing**.

1. **The tapback regression, which is the whole point of Change 4.** Feed
   `createPhotonChannel` a `content.type === 'reaction'` message whose
   `target.content.text` is the exact needs-address string, and assert
   `captureReplies` returns `[]`. Then, at the `handleReply` level with a real
   in-memory DB and a sender spy, assert zero rows in `decisions`, zero
   `draft_events` of type `decision` or `send_attempted`, and zero calls to
   `sender.send`. **Mutate**: change the header to `d70: needs address`, confirm
   the test goes red, restore.
2. **The recipient-changed pair.** After a correction, `loadApprovedSend`
   returns `ok` for that draft. Then call `upsertPerson` with a different
   address and assert it returns `recipient_changed`. Both assertions in one
   test, because either alone can pass for the wrong reason.
3. **At-most-once survives correction.** correct, `d70 y` (sends once), `d70 y`
   again (`already_attempted`, nothing sent). Assert `send_attempts == 1`.
4. **`assertSafeOutbound` still gates.** Correct with an address carrying a CR
   and a `Bcc:` continuation, and assert no send with either a correction-time
   refusal or a send-time `send_refused` event.
5. **Refusal matrix**, one test per row of the Change 5 table, asserting no
   write on each refused row.
6. **Parser tests**: `d70 to a@b.edu` -> address; `d70 to the point` ->
   unsupported; `d70 a@b.edu` -> unparseable; `d70 to A.B@Uni.EDU` preserves
   `A.B` and lowercases `Uni.EDU`.
7. **Loop fixtures**, fresh `:memory:` DB per case: `{ email: null,
   rejectedEmails: [one] }` produces a draft, one needs-address message, and the
   `awaiting address correction` reason; `{ email: null, rejectedEmails: [] }`
   still produces `no email resolved`; the cap-spent case produces no message
   and the `not yet requested` reason.
8. **Live demonstration, required before this is called done.** On a copy of
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
| `test/photonChannel.test.ts` (27 tests) | **Add** the needs-address reaction case from Verification 1. Existing tapback tests keep passing unchanged. |
| `test/channel.test.ts` | **Add** the parser cases from Verification 6. |
| `test/approval.test.ts`, `test/send-path.test.ts` | **Add** Verifications 2 to 5. |
| `test/loop.test.ts` | **Add** the three fixtures from Verification 7. |
| `test/extract-contact.test.ts`, `two-pass`, `reconcile`, `snippet-scan`, `paper-context` | **Unchanged.** `extractContact` keeps its signature; only the new `extractContactDetailed` is added. |
| `test/name-match.test.ts` | **Unchanged.** This spec does not touch `nameMatches`. |
| `test/stranding.test.ts` | **Add** a case asserting `strandedReport` prints both new reasons. |
| `test/orchestrate.test.ts` | **Add** a case asserting `rejectedEmails` is populated and that the paid-call ordering assertions still hold. |

## Risks

- **The human is the only check on the corrected address.** Nothing validates
  that `someone@uni.edu` belongs to the person; a mistyped-but-valid address
  sends a cold email to a stranger, which is the failure this spec exists to
  reduce. Accepted deliberately: he is the identity authority, and the
  echo-back plus the separate `d70 y` are the only mitigations.
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
- **The `recipient_changed` notify reword is load-bearing** (Change 4). If it
  ships without the reword, a tapback on an older refusal message becomes a live
  send once the address is corrected. This is the one ordering dependency inside
  the change.
- **Both the batch loop and `outreach listen` handle corrections**, through the
  single shared `handleReply`, so they cannot drift. That is the same argument
  the tapback path rests on, and it holds only as long as no correction logic is
  added outside `handleReply`.

## Out of scope

- **Learning per-institution address patterns.** The obvious follow-on: mine the
  `address_corrected` events plus the 111 pdf-verified addresses (93 distinct
  registrable domains) so a future lookup for `@tongji.edu.cn` generates and
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
