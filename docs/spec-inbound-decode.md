# Technical Spec: Observable Inbound Decode

> Scope: the inbound decode step of `outreach/src/approval/photonChannel.ts`. Implements the
> allowlist half of [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md)
> (AL3 allowlist, AL11 inbound ingress) for the batch loop that exists today.
>
> This spec addresses exactly one problem: **every inbound message this system rejects is
> rejected silently and unnamed, so "the reply never arrived" and "the reply arrived and was
> discarded" are indistinguishable after the fact.** It does not fix message delivery, dedup,
> the transport injection seam, or the reply grammar. See "What This Spec Does Not Fix" below,
> and read that section before concluding anything about approval-path reliability.

## Overview

`captureReplies` in `outreach/src/approval/photonChannel.ts` accepts inbound messages through
this function:

```ts
const acceptIfAllowed = (value: [unknown, RawMessage]) => {
  const [, message] = value;
  if (message.sender?.id !== opts.approverPhone) return;   // allowlist
  if (message.content?.type !== 'text' || !message.content.text) return;
  out.push({ text: message.content.text, messageId: message.id });
};
```

Both guards `return` with no log line, no counter, and no persisted record. A rejected message
leaves the process in exactly the state a nonexistent message leaves it in: `out` is empty and
nothing was written anywhere.

### The incident this spec exists because of

Aditya texted `d8 y`. The following run recorded nothing and sent nothing. Because both
rejection paths are silent, it was impossible to determine from any artifact the system
produced whether the message had arrived and been rejected by a guard, or had never been
delivered to the process at all. Diagnosis required attaching a separate diagnostic listener
and asking him to send a fresh test message.

The root cause turned out to be elsewhere (Spectrum does not queue messages for a disconnected
client, specced separately as `docs/spec-approval-listener-daemon.md`). That does not retire
this problem. The system's highest-stakes input path produced no evidence about its own
behavior, and that is a defect independent of what any particular investigation concluded.

### Verified gaps in the current decode

Each was checked against the code in this repository, not assumed:

1. **One sender field is read, two exist.** The decode reads `message.sender?.id` only. The live
   message shape observed on the incident date was:

   ```
   sender: {"id":"+15555550123","address":"+15555550123","country":"US","service":"iMessage","__platform":"iMessage"}
   ```

   Both fields were populated and identical, so this was not the incident's cause. Reading one
   of two fields that can disagree, on the guard that decides whether a stranger may send a cold
   email, is a latent safety defect regardless.

2. **Only `content.type === 'text'` is accepted.** Every other content shape is dropped with no
   trace. The sibling project's decode (see below) handles a `'group'` shape that carries an
   `items` array, which is how a captioned attachment arrives. This project has never observed
   what a captioned reply does here, because a dropped one leaves no evidence.

3. **`messageId` is captured and read by nothing.** Verified by grep across `outreach/src`:
   `messageId` is declared on `InboundReply` (`src/approval/channel.ts:16`), populated in
   `photonChannel.ts:64` and in `createStubChannel` (`channel.ts:77`), and asserted once in
   `test/channel.test.ts:48`. No consumer reads it. It is a correct field waiting for
   [`docs/spec-inbound-dedup.md`](./spec-inbound-dedup.md) to consume it. This spec keeps it and
   does not repurpose it.

4. **No record exists of messages from non-approver senders.** The Photon line may be shared, so
   strangers can text it. If someone probed or abused the line there would be no evidence of it
   anywhere in the database, the logs, or the run summary.

### The reference implementation

`/Users/apgupta/Documents/Coding/new/daily-prompts/src/channel/spectrum.ts` (same author,
production, working) already solved the structural half of this. `decodeInbound` there is a pure
function, factored out of `handleMessage` explicitly so every guard is testable without a live
connection, returning a named union (`deliver` / `unknown` / `drop` / `ignore`). `handleMessage`
switches on it: `deliver` invokes the handler, `unknown` logs and calls an `onUnknown` callback
that records the sender, `drop` logs its specific reason, `ignore` is silent by design. It reads
both `sender.address` and `sender.id`, and it handles the `'group'` content shape with a
documented fallback for a flattened variant "so a shape mismatch never silently drops a photo".

This spec adopts that structure and re-derives the policy for this domain, which differs in one
decisive way: in `daily-prompts` a misattributed message mislabels a journal entry, and here an
accepted message sends an irreversible cold email to a real researcher. Every place the two
projects diverge below, that asymmetry is the reason.

## What This Spec Does Not Fix

Stated first, not last, because a reader who stops after the Resolved Decisions must not
conclude the approval path is now reliable. It is not.

- **It does not make a disconnected client receive messages.** Spectrum does not queue for a
  disconnected client. If the process is not connected when Aditya texts, the message is not
  delivered to it, and no amount of decode observability changes that. That is the entire
  subject of `docs/spec-approval-listener-daemon.md`. **This spec cannot have prevented the
  incident that motivated it.** What it changes is that the same incident would now leave a
  record saying "this window saw zero inbound items", which is the evidence that was missing.
- **It does not deduplicate.** A redelivered message is decoded and returned twice.
  [`docs/spec-inbound-dedup.md`](./spec-inbound-dedup.md) (currently NEEDS REVISION) owns that,
  and consumes the `messageId` this spec preserves.
- **It does not build the transport injection seam.**
  [`docs/spec-photon-channel-testing.md`](./spec-photon-channel-testing.md) (also NEEDS
  REVISION) proposes `PhotonConnect` and a fake session for the surrounding channel. This spec
  references that design and does not redesign or pre-empt it. The pure function specified here
  is testable with no seam at all (IB8), so the two specs are independently landable in either
  order.
- **It does not change the reply grammar.** `parseReply` in `src/approval/channel.ts` is
  untouched. Ambiguity resolution stays where it lives.
- **It does not weaken the allowlist.** Every change here either holds the allowlist constant or
  tightens it (IB3).
- **It cannot make a send happen.** Every code path added is a classification, a log line, or an
  insert. There is no branch in this spec that reaches the sender.

## Architecture

```
outreach/src/approval/
├── channel.ts          # CHANGED (additive): InboundReply gains `undecodable`
├── decodeInbound.ts    # NEW: the pure function and its union. Imports nothing from spectrum-ts.
├── photonChannel.ts    # CHANGED: acceptIfAllowed becomes a switch over decodeInbound's result
└── ledger.ts           # CHANGED (additive): recordInboundRejection, recordInboundUndecodable

outreach/test/
└── decodeInbound.test.ts   # NEW: pure, no fake, no timers, no SDK import
```

`decodeInbound.ts` is a separate module rather than an export of `photonChannel.ts` for one
reason: `photonChannel.ts` imports `spectrum-ts` today, so a test importing it opens a path to
the SDK. A separate module means the decode tests can land before the injection seam of
`spec-photon-channel-testing.md` exists, and cannot dial Photon even by accident.

## Resolved Decisions

### IB1. The outcome union

```ts
/** A shape summary of a message, computed without retaining any message text.
 *  Safe to persist for a message from any sender (IB6). */
export interface InboundShape {
  contentType: string;      // message.content.type, or 'absent'
  partCount: number;        // 1 for a scalar content, items.length for a group, 0 if unreadable
  textLength: number;       // total length of text parts, characters. Never the text itself.
  hasAttachment: boolean;
}

export type DecodedInbound =
  /** Approver text we can read. `reply.text` is verbatim. Goes to parseReply. */
  | { kind: 'accept'; reply: InboundReply }
  /** A message from a sender that is not the approver. A SECURITY event, not a bug. */
  | { kind: 'unauthorized'; reason: string; fingerprint: string; shape: InboundShape }
  /** The approver sent something whose content shape we cannot turn into reply text. */
  | { kind: 'undecodable'; reason: string; messageId: string; shape: InboundShape }
  /** Not attributable to anyone and not a reply. Stream noise. */
  | { kind: 'ignore'; reason: string };

export function decodeInbound(item: unknown, approverPhone: string): DecodedInbound;
```

Four outcomes, each with a distinct owner and a distinct response:

| Outcome | Means | Response (IB6, IB7) |
|---|---|---|
| `accept` | The approver said something we can read | Returned to the loop, parsed, acted on |
| `unauthorized` | Someone who is not the approver texted the shared line | Counted and fingerprinted in the ledger. **Never replied to.** |
| `undecodable` | The approver replied and we cannot read the shape | Recorded, and he is told (IB5). This is the silent-drop case the incident named. |
| `ignore` | Nothing attributable happened | Logged in the census only, not persisted (IB6) |

Every non-`accept` outcome carries a `reason` string written for a human reading a log or an
audit row. Reasons are fixed literal strings from a closed set (IBT13), never interpolated with
message content, so a reason can never smuggle attacker text into a log or a database row.

`accept` deliberately carries no reason. The absence of a reason field on exactly one arm is how
the type system makes "why was this not accepted" unanswerable-by-omission impossible.

**Decode order is fixed and tested (IBT14):** shape guard, then sender, then content. Sender
before content means no non-approver text is ever extracted, parsed, or held in a variable that
could later be logged. The `unauthorized` arm carries only `shape`, which is computed from the
structure and lengths, never from the characters.

### IB2. `captureReplies` becomes a switch, and always emits a census

`acceptIfAllowed` is replaced by a handler that switches on the union, exactly as
`handleMessage` does in the reference implementation. Both call sites (the main loop and the
grace-period drain) call the same handler, so the grace path applies identical policy. That
property is currently untested and stays a stated requirement here (IBT16 and
`spec-photon-channel-testing.md` T11 and T12 cover it once the seam exists).

The single most important behavioral change in this spec is not the switch, it is this:

**Every `captureReplies` call emits exactly one census line before returning, including when it
saw nothing at all.**

```
inbound census: window=90000ms items=0 accepted=0 unauthorized=0 undecodable=0 ignored=0
```

This is the direct repair of the incident. With this line, "the message arrived and was
rejected" and "the message never arrived" are different observations rather than the same
absence of observation. `items=0` is a positive claim about the transport that the old code
could not make.

The census counters are also returned to the caller so the run summary can carry them:

```ts
export interface CaptureResult {
  replies: InboundReply[];
  census: { items: number; accepted: number; unauthorized: number; undecodable: number; ignored: number };
}
```

`ApprovalChannel.captureReplies` changes return type from `Promise<InboundReply[]>` to
`Promise<CaptureResult>`. `createStubChannel` is updated in step. `drainApprovals` in
`src/pipeline/loop.ts` reads `.replies` and folds the census into `LoopSummary`.

### IB3. Which sender field, and what to do when they disagree

**Decision: read both. Accept only if at least one field is present and every present field
equals `approverPhone` exactly. If the two fields are both present and disagree, classify
`unauthorized` with reason `sender fields disagree`. Fail closed.**

The reasoning, in order.

*Is disagreement possible?* Nothing in the SDK's public surface guarantees the two are the same
string. `id` and `address` are separate fields on a sender object that also carries `service`
and `country`, which is the shape of a record where `id` is a provider-side identity and
`address` is a transport handle. An iMessage account can be reached by phone number or by Apple
ID email, and a sender that has both can plausibly report one in each field. The single live
observation on record has them identical. One observation of one sender on one day is not a
contract.

*If they disagree, which is authoritative?* Unknowable from here, and that is the point. Neither
field is documented as the authenticated one. The sibling project resolves this with
`msg.sender.address ?? msg.sender.id`, which silently trusts `address` whenever it is present.
That is the correct call in `daily-prompts`, where the cost of a wrong attribution is a journal
entry filed under the wrong person and the cost of over-strictness is a lost answer to a daily
question.

*Why this project must go the other way.* The two directions have asymmetric costs here:

| Policy | Cost when the fields disagree |
|---|---|
| Fail open (`address ?? id`, accept if either matches) | If the matching field is the forgeable or the incidental one, a stranger on a shared line approves a cold email to a real researcher. Irreversible. |
| Fail closed (accept only if all present fields match) | Aditya's approval is ignored. He is told why (IB5), the disagreement is recorded, and he resends. Reversible, and costs one text. |

The project rule is that ambiguity must never resolve toward sending. Two identity fields
disagreeing about who sent a message is the definition of ambiguity about the sender, and the
allowlist is the one non-negotiable guard in the system. Fail closed.

*What this costs today: nothing.* On the observed shape both fields are present and identical,
so the strict rule accepts exactly what the current rule accepts. The change is not a
restriction of today's traffic, it is a specification of behavior on an input that has never
been observed and would otherwise be resolved by an accident of which field the code happened to
read first.

*Absent sender.* If neither field is a non-empty string, the outcome is `ignore` with reason
`sender absent`, not `unauthorized`. The distinction is honest: there is nothing to fingerprint,
so no security record can be written, and asserting an attack we cannot attribute would pollute
the count that IB6 exists to make meaningful. It is still not accepted, which is the property
that matters.

*Matching is exact string equality, with no normalization.* `'15555550123'` and
`' +15555550123 '` do not match `'+15555550123'`. This preserves the current behavior
deliberately (`spec-photon-channel-testing.md` PC4 and T5 pin the same property). Strict is the
safe direction; any future loosening toward normalized comparison is a safety change that needs
its own review.

### IB4. Content shapes

Shape handling, applied only after the sender has been confirmed to be the approver:

| `content.type` | Handling |
|---|---|
| `'text'` with non-empty `text` | `accept`, text **verbatim**: no trim, no lowercase, no normalization |
| `'text'` with empty or missing `text` | `undecodable`, reason `empty text` |
| `'group'` with an `items` array | Extract parts (below). Exactly one non-blank text part: `accept` that text verbatim. Zero text parts: `undecodable`, reason `attachment with no caption`. Two or more: `undecodable`, reason `multiple text parts` |
| `'group'` with no `items` array | `undecodable`, reason `group with no items` |
| anything else, or `content` absent | `undecodable`, reason `unsupported content type: <type>` |

Group part extraction follows the reference implementation exactly, including its fallback: each
item is a Message wrapper whose real part lives at `item.content`, and an item that is already
flat is used as the part itself. The fallback exists in `daily-prompts` so a shape mismatch
never silently drops a photo; it exists here so a shape mismatch never silently drops an
approval.

Two deliberate positions:

**A caption is a valid reply.** A single non-blank text part inside a group is accepted as reply
text. Only the approver can reach this branch (sender is checked first), so the text is
something Aditya typed, and `parseReply` still applies the full grammar to it including the rule
that a bare unprefixed digit is `unparseable`. Rejecting it would create a class of reply that
looks sent and does nothing, which is the failure this spec exists to eliminate.

**More than one text part is `undecodable`, not a guess.** Picking "the first" text part out of
several would be the channel choosing which of Aditya's words to treat as a command. The channel
reports what arrived and never improves it.

**Reactions and tapbacks are `undecodable`, never approvals.** Whatever content type a tapback
arrives as, it falls through to the default row and is classified `undecodable`, so a thumbs-up
on a draft message produces the IB5 notice rather than either a send or silence. This is a
foreseeable user action with a catastrophic failure mode if guessed at, and it is called out
here so nobody adds a convenience mapping later without reading this paragraph.

Text is returned verbatim in every accept path. Interpretation belongs to `parseReply`, which is
where the ambiguity rule lives. A channel that normalized text could turn an ambiguous string
into a parseable approval, which is a send-path change disguised as a formatting change.

### IB5. `undecodable` reuses the existing `unparseable` response path

Silently discarding an unreadable message from the approver reproduces the exact failure this
spec exists to prevent: he replies, nothing happens, and nothing says why. He must be told.

`parseReply` already returns `{ kind: 'unparseable' }`, and `handleReply` in
`src/pipeline/loop.ts:63` already answers it with a notice. That path is reused rather than a
second one invented.

`InboundReply` gains one optional field:

```ts
export interface InboundReply {
  text: string;
  messageId: string;
  undecodable?: string;   // NEW: the IB1 reason, present only on an undecodable message
}
```

A `undecodable` decode is mapped to `{ text: '', messageId, undecodable: reason }`.
`parseReply('')` returns `{ kind: 'unparseable' }` deterministically (its first line returns
`unparseable` on an empty token list), so an undecodable message always lands in the one branch
that already exists. No new branch, no second notification path, no possibility of an
undecodable message reaching the decision code.

The only change in `handleReply` is the wording of that existing notice:

```ts
if (parsed.kind === 'unparseable') {
  await deps.channel.notify(
    reply.undecodable
      ? `I could not read your last message (${reply.undecodable}). Reply like "d7 y" or "d7 n".`
      : `Could not read "${reply.text}". Reply like "d7 y" or "d7 n".`,
  );
  return;
}
```

The `undecodable` branch must not quote message text, because there is none worth quoting and
the empty-string case would render `Could not read ""`.

Carrying a real `messageId` on the synthetic reply is intentional: it keeps the undecodable
message eligible for the dedup claim of `spec-inbound-dedup.md` ID1, so a redelivered
undecodable message does not produce a second notice.

### IB6. Where rejection records land

**Decision: `draft_events` with `draft_id = NULL`. No new table.**

Verified that this is permitted, not assumed:

- `schema.sql:90-97` declares `draft_events.draft_id INTEGER REFERENCES drafts(id)`, nullable,
  under the comment "Append-only event log (A6). `draft_id` NULL for non-draft events." The
  convention already exists and is documented in the schema itself.
- `logEvent` in `src/approval/ledger.ts:24` is typed `draftId: number | null` and passes the
  value straight into the insert. A NULL foreign key does not violate the reference.

A new table would buy a typed schema for two event types that carry four scalar fields between
them, at the cost of DDL, a migration note, and a second place to look when reconstructing an
incident. The event log is where the reconstruction already starts. Weighed and rejected.

**What is recorded, and what is deliberately not.**
[`docs/spec-inbound-dedup.md`](./spec-inbound-dedup.md) ID4 argued that rejected senders should
be counted but that neither their text nor their phone number should be stored, because the line
is a shared service number, the stored text is attacker-controlled, and the same database is
rendered into iMessage summaries today and a review page later, so storing it buys a
stored-injection surface in exchange for text the system never acts on. **This spec adopts that
argument unchanged and extends it to content shape.** Superseding F5 AL3, which would have
recorded rejected messages with `accepted = 0` and the text included.

| Event | `draft_id` | `detail_json` |
|---|---|---|
| `inbound_rejected` | NULL | `{ fingerprint, reason, contentType, partCount, textLength, hasAttachment }` |
| `inbound_undecodable` | NULL | `{ messageId, reason, contentType, partCount, textLength, hasAttachment }` |

No phone number, no message text, and no substring of message text is written by either. The
`reason` values are closed-set literals (IB1), and lengths and counts are integers, so nothing
attacker-controlled reaches the column.

**The fingerprint, and an honest correction to the companion spec.**
`spec-inbound-dedup.md` ID4 proposed `first 12 hex of sha256(sender)`. Unsalted SHA-256 of a
phone number is not anonymization: the space of E.164 numbers is small enough to enumerate
exhaustively in seconds, so the digest is trivially reversible and is therefore a stored phone
number wearing a hat. Use a keyed digest instead:

```
fingerprint = first 12 hex of HMAC-SHA256(key = SPECTRUM_PROJECT_SECRET, msg = senderString)
```

The key is an existing required secret (`photonOptionsFromEnv` already demands it), so no new
configuration is introduced. This preserves the only audit question worth answering, "is this
one stranger five times or five strangers", while making the value useless to anyone who reads
the database without the secret. Rotating the project secret rotates all future fingerprints and
breaks correlation across the rotation. That is accepted, and noted here so a future reader is
not confused by a discontinuity in the counts.

**Volume cap.** A shared line means a stranger controls how many `inbound_rejected` rows exist.
Cap persisted rejection rows at 20 per `captureReplies` call; beyond the cap, write one
`inbound_rejected_truncated` event carrying the suppressed count and stop. The census counters
(IB2) remain exact regardless, because they are integers in memory, not rows.

**`ignore` is logged, never persisted.** It is the one outcome with no reason string in the
database. An unattributable malformed stream item cannot be tied to a sender, carries no
security signal, and can be produced in unbounded volume by anyone on the shared line or by a
provider regression. Persisting it would turn the event log into a sink whose growth is
controlled by an attacker, and the census (IB2) already reports the count for the window, which
is the number a human actually needs. The counter-argument, that a burst of `ignore` could be a
provider shape change worth investigating, is answered by the census: a run whose census shows
`ignored` climbing while `accepted` sits at zero is exactly the visible signal that was missing
in the incident, and it appears in the run summary without a single row.

### IB7. `unauthorized` never produces an outbound message

Restating the AL3 open-reflector property, because this spec adds two new places that produce
outbound text (IB5's notice) and the boundary must be unambiguous.

An `unauthorized` decode produces: one ledger row, one census increment, one log line. It
produces **no** reply, no acknowledgement, no error text, no read receipt, and no observable
response of any kind on the wire. Anything else makes a shared service line into a reflector
that a stranger can use to make the system text back on command. IBT6 asserts the absence
directly.

### IB8. Testability without a live connection

`decodeInbound` takes `(item: unknown, approverPhone: string)` and returns a value. It performs
no I/O, reads no environment, reads no clock, and imports nothing from `spectrum-ts`. Every
outcome in IB1 is reachable by constructing a plain object literal.

This is the whole reason the function is extracted, and it is the same reason the reference
implementation extracted its own: a guard that requires a gRPC connection to exercise is a guard
that never gets exercised, and both guards in the current code are on the send path.

`decodeInbound.ts` imports only from `channel.ts` (for `InboundReply`) and `node:crypto` (for
the IB6 fingerprint). `test/decodeInbound.test.ts` imports `decodeInbound.ts` and nothing else,
so no import path in the test process reaches the SDK.

The surrounding channel behavior (grace-period drain, stream errors, shutdown, the fake session)
remains untestable until the injection seam of
[`docs/spec-photon-channel-testing.md`](./spec-photon-channel-testing.md) lands. That is
referenced, not redesigned here. The split is deliberate: the decode tests below need no seam,
so they can land first and immediately, and the seam spec's T1 through T12 then exercise the
same policy through the channel.

### IB9. `messageId` stays, unread

`messageId` is preserved on every `accept` and on the synthetic `undecodable` reply, and this
spec adds no consumer for it. It is the dedup key that `spec-inbound-dedup.md` ID2 is written
around. Removing an unused field that a specced consumer is about to need would be churn, and
repurposing it here would collide with that spec. Noted so a future reader does not "clean it
up".

## Interfaces

| Interface | Shape | Consumer |
|---|---|---|
| `decodeInbound(item, approverPhone)` | `DecodedInbound` (IB1), pure | `photonChannel.captureReplies`, tests |
| `DecodedInbound` | 4-arm union, reason on every non-accept arm | the `captureReplies` switch |
| `InboundShape` | `{ contentType, partCount, textLength, hasAttachment }` | ledger records (IB6) |
| `CaptureResult` | `{ replies, census }` (IB2) | `drainApprovals` |
| `InboundReply` | `{ text, messageId, undecodable? }` (IB5) | channel adapters, loop, tests |
| `recordInboundRejection(db, fingerprint, reason, shape)` | void, `draft_events` NULL row | `captureReplies` |
| `recordInboundUndecodable(db, messageId, reason, shape)` | void, `draft_events` NULL row | `captureReplies` |

`ApprovalChannel.captureReplies` returns `Promise<CaptureResult>` instead of
`Promise<InboundReply[]>`. This is the only breaking signature change in the spec, and it has
two call sites: `createStubChannel` and `drainApprovals`.

The two `record*` helpers take a `DB`, which `photonChannel.ts` does not have today. Pass the
ledger writes in as an optional dep on the channel factory rather than importing the DB into the
transport:

```ts
export interface InboundRecorder {
  onUnauthorized(fingerprint: string, reason: string, shape: InboundShape): void;
  onUndecodable(messageId: string, reason: string, shape: InboundShape): void;
}
```

This mirrors the `onUnknown` callback in the reference implementation, keeps the transport free
of database knowledge, and makes the recording assertable in a test with a plain array. When the
recorder is absent (dry-run, tests), the census and the log line still happen: observability is
never conditional on persistence.

## Implementation Plan

Each step ends with a human-verifiable checkpoint. Steps 1 and 2 have no dependency on any other
spec.

1. **The pure function and its tests.** Create `decodeInbound.ts` with the IB1 union and the IB3,
   IB4 policy. Write `test/decodeInbound.test.ts` covering IBT1 through IBT15. Nothing else
   changes yet; `photonChannel.ts` is untouched and the function is not yet called.
   ✅ *Human: `npm test` passes. Then invert the sender comparison in `decodeInbound.ts` and
   confirm IBT2, IBT3, IBT4, and IBT5 all go red. A safety test that does not fail when the
   safety check is removed is not a safety test.*
2. **Wire the switch and the census.** Replace `acceptIfAllowed` with the IB2 switch over
   `decodeInbound`, applied at both the main-loop and grace-period call sites. Add the census
   line and `CaptureResult`. Update `createStubChannel` and `drainApprovals`. Add the
   `InboundRecorder` dep and the two `ledger.ts` helpers.
   ✅ *Human: run `outreach loop` with an empty reply window and read the census line in the
   output. It must print `items=0` rather than printing nothing. This one line is the fix for
   the incident; see it with your own eyes.*
3. **The notice path.** Add `undecodable` to `InboundReply` and the IB5 wording branch in
   `handleReply`.
   ✅ *Human: run the loop, then send a photo with no caption from your phone during the reply
   window. You receive "I could not read your last message (attachment with no caption)". Before
   this change that message produced nothing at all.*
4. **Live verification of the security path.**
   ✅ *Human: have a second number text the shared line during a capture window. Confirm three
   things: that number receives nothing back (IB7), the census reports `unauthorized=1`, and
   `sqlite3 outreach/data/outreach.db "select type, detail_json from draft_events where
   draft_id is null order by id desc limit 1"` shows an `inbound_rejected` row containing a
   fingerprint and no phone number and no text.*

## Test Requirements

Vitest, in `outreach/test/decodeInbound.test.ts` unless noted. Pure: no DB, no timers, no
network, no SDK import. Numbered so implementation and tests trace to them.

### The golden fixture

**IBT1.** The exact live message shape observed on the incident date decodes to `accept` with
`text` and `messageId` verbatim, when `approverPhone` is `'+15555550123'`:

```ts
const GOLDEN = {
  id: 'spc-msg-…',
  sender: { id: '+15555550123', address: '+15555550123', country: 'US', service: 'iMessage', __platform: 'iMessage' },
  content: { type: 'text', text: 'd8 y' },
};
```

This fixture is the only recorded ground truth about the real message shape. It is defined once
and reused by IBT2, IBT3, IBT8, and IBT14 as the base object each mutates, so every test is a
single documented deviation from a shape that was actually observed rather than one that was
imagined.

### Sender policy (the open-reflector guard)

| # | Requirement |
|---|---|
| **IBT2** | Both sender fields present and equal to `approverPhone`: `accept`. The golden case. |
| **IBT3** | Both fields present and equal to each other but not to `approverPhone`: `unauthorized`, reason names the allowlist, `fingerprint` is a 12-character lowercase hex string, and the result object contains **no substring of the sender number and no substring of the message text** (asserted with `JSON.stringify(result).includes(...)`, not by eyeballing fields). |
| **IBT4** | **The disagreement case (IB3).** `sender.id === approverPhone` but `sender.address` is a different non-empty string: `unauthorized`, reason `sender fields disagree`. And the mirror case, `address` matching and `id` differing: also `unauthorized`. Both directions, because a policy that only fails closed on one of them is an accident. |
| **IBT5** | Exactly one field present and equal to `approverPhone` (the other absent, or empty string): `accept`. Absence is not disagreement. |
| **IBT6** | For an `unauthorized` decode, no arm of the returned union can carry reply text: asserted at the type level by exhaustiveness plus at runtime by confirming the result has no `reply` key. Combined with the channel-level assertion (IBT16) this is the open-reflector property. |
| **IBT7** | `sender` absent, `sender` null, `sender` a primitive, or both fields empty strings: `ignore`, reason `sender absent`. Not `unauthorized`, and never `accept`. |
| **IBT8** | Matching is exact string equality: `'15555550123'`, `' +15555550123 '`, and `'+1 555 555 0123'` each decode to `unauthorized` when `approverPhone` is `'+15555550123'`. Pins strict-is-safe against an accidental future loosening. |

### Content shapes

| # | Requirement |
|---|---|
| **IBT9** | `content.type === 'text'` with text `'  YeS   d8 '` from the approver: `accept` with `reply.text` **byte-identical** to the input. Whitespace, casing, and punctuation all preserved. Normalization in the channel is a send-path change. |
| **IBT10** | `content.type === 'text'` with `text: ''`, `text` missing, or `content` absent entirely, from the approver: `undecodable` with reason `empty text` (or `unsupported content type: absent`), never `accept` and never `ignore`. |
| **IBT11** | Group with `items: [{ content: { type: 'attachment', … } }, { content: { type: 'text', text: 'd8 y' } }]`: `accept` with text `'d8 y'`. And the flattened variant, `items: [{ type: 'text', text: 'd8 y' }]`, also `accept`. Both shapes, because the reference implementation carries the fallback specifically so a shape mismatch never silently drops a message. |
| **IBT12** | Group with an attachment and no text part: `undecodable`, reason `attachment with no caption`, `shape.hasAttachment === true`. Group with two non-blank text parts: `undecodable`, reason `multiple text parts`. Group with no `items` array: `undecodable`, reason `group with no items`. A blank-only caption counts as no text part. |
| **IBT13** | An unrecognized `content.type` (use `'reaction'`, standing in for a tapback) from the approver: `undecodable`, never `accept`. Separately, every `reason` string the function can produce is drawn from an exported closed set, asserted by decoding one input per outcome and checking membership. Nothing attacker-controlled ever reaches a reason. |

### Order, shape summary, and the channel switch

| # | Requirement |
|---|---|
| **IBT14** | **Decode order (IB1).** A message from a non-approver whose content is also malformed decodes to `unauthorized`, not `undecodable` or `ignore`. Sender is evaluated before content, so a stranger's payload is never extracted. |
| **IBT15** | `InboundShape` is derived from structure only: for a text message of 400 characters, `textLength === 400`, `partCount === 1`, `hasAttachment === false`, and `JSON.stringify(shape)` contains no substring of the message text. |
| **IBT16** | *(`test/photonChannel.test.ts`, requires the `spec-photon-channel-testing.md` seam; specified here, implemented when that lands.)* A `captureReplies` window that receives one unauthorized message and nothing else returns zero replies, sends **nothing** to the DM space, emits a census reporting `items=1 accepted=0 unauthorized=1`, and calls the recorder exactly once. The same assertions hold for a message delivered during the grace period, which is what says the grace path applies identical policy. |
| **IBT17** | *(`test/loop.test.ts`)* A reply with `undecodable` set produces exactly one notify containing the reason text and containing no quoted empty string, no decision row, and no send. Asserts IB5 end to end through the existing `unparseable` branch. |

Total: 17 numbered requirements, 15 of which need no connection, no fake, and no seam.

## Residual Risk

- **R1. The transport is still the unsolved problem.** Everything here is downstream of a message
  being delivered to the process. A message never delivered is still invisible, and the census
  reporting `items=0` is a description of that invisibility, not a repair of it. The repair is
  `docs/spec-approval-listener-daemon.md`.
- **R2. Field semantics are assumed, not proven.** That `sender.id` and `sender.address` both
  carry an E.164 string matching `APPROVER_PHONE`, and that neither is a display name or a
  provider-internal handle, comes from one live observation. IB3 fails closed on disagreement, so
  the failure mode of a wrong assumption is a rejected approval and a recorded reason, not a
  wrongful send. The recorded reason is itself the instrument that would reveal it.
- **R3. Provider honesty.** Command authenticity rests entirely on Photon truthfully reporting the
  sender. A compromised or buggy provider could report `APPROVER_PHONE` for a message that did
  not come from that number. No decode can detect this. It is the AL12 residual trust assumption
  and it is unchanged by this spec.
- **R4. The fingerprint is a correlation handle, not anonymity.** HMAC with the project secret
  makes the value useless to a database reader without the secret. Anyone holding the secret can
  confirm a guessed number by recomputing the digest. That is the intended strength: enough to
  answer "one stranger or five", not a claim of unlinkability.
- **R5. Unobserved shapes remain unobserved.** The group handling is transcribed from a sibling
  project's observations of a different provider configuration. It has never been exercised
  against this project's line. The mitigation is structural rather than empirical: every shape
  this spec did not anticipate lands in `undecodable`, which is recorded and answered with a
  notice, so the next unknown shape announces itself instead of vanishing. That is the actual
  deliverable of this spec.

## Open Questions

1. **Can `sender.id` and `sender.address` ever disagree in practice, and if so on what?** IB3
   makes the answer safety-irrelevant (both directions fail closed), so this blocks nothing. It
   becomes answerable for free once IB6 lands: an `inbound_rejected` row with reason `sender
   fields disagree` is the first evidence either way. If such rows appear for Aditya's own
   number, IB3 is costing real approvals and the policy needs a documented revisit, not a quiet
   loosening.
2. **What content type does an iMessage tapback actually arrive as?** IBT13 pins the behavior for
   an unrecognized type, so a tapback is safely `undecodable` whatever it is. Worth confirming
   live only to make the IB5 notice wording specific ("a reaction is not an approval") rather
   than generic.
3. **Census destination.** This spec emits the census to the channel's log. Whether it should
   also land in `draft_events` as a per-run `inbound_census` row is deferred: it is one row per
   run with a bounded shape, so the IB6 volume argument does not apply to it, but it is
   redundant with the run summary until something reads the event log programmatically.
