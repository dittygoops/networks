# Technical Spec: Photon Channel Testability and Safety Coverage

> Scope: `outreach/src/approval/photonChannel.ts` only. Implements a subset of
> [`docs/spec-imessage-approval-loop.md`](./spec-imessage-approval-loop.md) (AL3 allowlist, AL12
> trust assumption). This spec addresses exactly one problem: the real iMessage channel is
> untestable and untested, and it sits on the send path. It does not redesign the channel, the
> outbox, reconnect behavior, inbound dedup, or the edit path.

## Overview

`photonChannel.ts` is the only module in `outreach/` with zero test coverage, and it is the
module that decides which inbound text messages are allowed to reach `parseReply`. Everything
downstream of it (`parseReply`, `runLoop`, the sender) is unit tested against
`createStubChannel`, so the entire tested surface begins one layer below the layer that
enforces the safety boundary. A defect in this file is a safety defect: an approval is an
irreversible cold email to a real researcher, and a shared Photon line means strangers' texts
arrive on the same stream this file reads.

The file is untestable for one structural reason: `createPhotonChannel` constructs its own
`Spectrum(...)` instance internally, so a test has no way to supply inbound messages, and any
attempt to exercise it would open a real gRPC connection to Photon. Every other subsystem in
this codebase already solved this with constructor injection (`fetchArxivPaper({ fetchFn })`,
`OrchestrateDeps`, `LoopDeps`, `IntersectDeps`). This spec applies the same pattern here, then
specifies the tests that the seam makes possible.

Three properties are currently verified by nobody:

1. **The sender allowlist** (`message.sender?.id !== opts.approverPhone`). If this regressed,
   any stranger on the shared line could approve a cold email and the system becomes an open
   reflector.
2. **The grace-period drain.** `captureReplies` races `iterator.next()` against a timeout and
   holds the pending promise across iterations so a reply arriving at the window boundary is
   not discarded, then drains it during a short grace period. Messages drained during grace
   must pass the same allowlist and text-type checks as the main loop.
3. **Stream error handling.** A stream error warns and returns the replies collected so far
   rather than throwing, so a transport hiccup does not abort an unattended scheduled run.

There is also a proven precedent for the class of defect this spec targets. The shipped code
called `app.close?.()` through an `as unknown as` cast. `SpectrumInstance` exposes `stop()`,
not `close()`. The cast suppressed the compile error, the optional call silently no-opped, the
resumable stream reconnected forever, the process never exited, and a launchd-scheduled loop
would therefore have run exactly once. Nothing but a human reading the SDK `.d.ts` caught it.
PC2 and T16 below make that class of defect mechanically detectable.

## Architecture

### Module layout change

```
outreach/src/approval/
├── channel.ts          # unchanged: ApprovalChannel, parseReply, createStubChannel
├── photonChannel.ts    # CHANGED: pure logic + injected transport. Imports nothing from spectrum-ts.
└── photonConnect.ts    # NEW: the only file that imports spectrum-ts and calls Spectrum(...)

outreach/test/
└── photonChannel.test.ts   # NEW: imports photonChannel.ts and a local fake. Never imports spectrum-ts.
```

The split is the network guarantee (PC5): the unit test file has no import path that reaches
the SDK, so it cannot open a connection even by mistake.

## Resolved Decisions

### PC1. The injected transport interface (the seam)

The channel needs exactly six capabilities from the SDK. They are declared as narrow,
non-optional structural types in `photonChannel.ts`:

```ts
// A single inbound message as this channel reads it. Deliberately narrow: the channel
// reads exactly these three fields and nothing else.
export interface PhotonMessage {
  id: string;
  sender?: { id?: string };
  content?: { type?: string; text?: string };
}

// A DM space we can send text into.
export interface PhotonSpace {
  send(text: string): Promise<unknown>;
}

// The app-level surface: the inbound stream and shutdown.
export interface PhotonApp {
  readonly messages: AsyncIterable<unknown>;   // yields [space, message] tuples
  stop(): Promise<void>;                       // NOT optional, NOT close()
}

// The iMessage provider narrower, i.e. the value `imessage(app)` returns.
export interface PhotonMessenger {
  user(handle: string): Promise<unknown>;
  space: { create(user: unknown): Promise<PhotonSpace> };
}

export interface PhotonSession {
  app: PhotonApp;
  im: PhotonMessenger;
}

export type PhotonConnect = (opts: PhotonOptions) => Promise<PhotonSession>;
```

Notes on the shape choices, each deliberate:

- `messages` is typed `AsyncIterable<unknown>` rather than
  `AsyncIterable<[unknown, PhotonMessage]>` because the real `SpectrumInstance.messages` is
  `AsyncIterable<[Space, Message]>`, whose `Message.content` is the SDK's `Content` union and is
  not guaranteed structurally assignable to `{ type?: string; text?: string }`. The channel
  already narrows the tuple internally (`RawMessage` in the current code); that narrowing stays
  where it is, is now reachable from a test, and gains a defensive guard (PC4). Widening at the
  iterable and narrowing in one audited place beats a cast that hides an incompatibility. If a
  `tsc --noEmit` check (PC2) shows the tighter form does compile against the real SDK, use the
  tighter form: the decision is made by the compiler, never by a cast.
- Everything the channel actually calls (`stop`, `send`, `user`, `space.create`) is declared
  **required**. An optional member in this interface would let a nonexistent SDK method type
  check and silently no-op, which is precisely the `close?.()` bug.
- The interface is deliberately not the full `ChannelProvider` of AL3. That interface belongs to
  the future daemon. This spec does not expand scope; it types only what this file uses.

### PC2. Compile-time conformance assertion (no casts allowed)

`photonConnect.ts` is the only module importing `spectrum-ts`. It contains the real connect plus
a pure type-level assertion that the real SDK satisfies PC1:

```ts
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';
import type { PhotonApp, PhotonConnect, PhotonMessenger, PhotonSession } from './photonChannel.js';

// Type-level only: no value, no runtime cost, no connection. If SpectrumInstance ever stops
// satisfying PhotonApp (a renamed or removed method, a changed signature), `npm run typecheck`
// fails here instead of the failure being discovered live at 3am by a daemon that never exits.
type Conforms<Shape, Actual extends Shape> = Actual;
type _AppConforms = Conforms<PhotonApp, Awaited<ReturnType<typeof Spectrum>>>;
type _ImConforms = Conforms<PhotonMessenger, ReturnType<typeof imessage>>;

export const connectSpectrum: PhotonConnect = async (opts) => {
  const app = await Spectrum({
    projectId: opts.projectId,
    projectSecret: opts.projectSecret,
    platforms: [imessage.config()],
  });
  return { app, im: imessage(app) };
};
```

Hard rule for both files: **no `as unknown as`, no `as any`, and no optional-call (`?.()`) on a
transport method.** If the real SDK does not satisfy PC1, the interface is wrong and gets fixed;
a cast is never the fix. This rule is what makes the `close` versus `stop` class of bug
impossible to reintroduce silently. If `Conforms` cannot express a needed relation (for example
if `imessage(app)`'s return type is too generic to constrain), the fallback is a value-level
assignment without a cast (`const _check: PhotonMessenger = imessage(app)` inside
`connectSpectrum`), which still fails the build on mismatch.

### PC3. Factory signature

```ts
export interface PhotonChannelDeps {
  connect: PhotonConnect;          // REQUIRED: no default, so a test cannot fall through to the SDK
  graceMs?: number;                // default 500, overridable so tests do not depend on wall clock
  now?: () => number;              // default Date.now
  warn?: (msg: string) => void;    // default console.warn, so T13 can assert the warning
}

export async function createPhotonChannel(
  opts: PhotonOptions,
  deps: PhotonChannelDeps,
): Promise<ApprovalChannel>;
```

`connect` is required rather than defaulted (a departure from the optional-dep style of
`fetchArxivPaper({ fetchFn })`), because a default here is a live gRPC connection. An optional
dep would mean a test that forgot to inject silently dials Photon. Required means the mistake is
a compile error.

`src/cli.ts` changes one line:

```ts
const channel = dryRun
  ? createStubChannel()
  : await createPhotonChannel(photonOptionsFromEnv(), { connect: connectSpectrum });
```

`photonOptionsFromEnv` stays in `photonChannel.ts` (it reads env, it does not connect) and gains
its own tests (T22).

Behavior is unchanged in every other respect. No safety property is relaxed by this refactor:
the allowlist comparison, the text-type check, the grace period, the error swallow, and the
shutdown call all keep their current semantics. The refactor only changes where the transport
comes from.

### PC4. Defensive narrowing at the tuple boundary

Because `messages` yields `unknown`, the internal `acceptIfAllowed` gains an explicit guard
before the existing checks: the yielded value must be an array of length at least 2 whose second
element is a non-null object; otherwise the item is ignored (not thrown on). Order of checks,
which the tests assert:

1. shape guard (a malformed payload is ignored)
2. allowlist: `message.sender?.id === opts.approverPhone`, exact string equality
3. content type: `message.content?.type === 'text'` and `message.content.text` non-empty
4. push `{ text, messageId }` with `text` **verbatim** (no trim, no lowercase, no normalization)

Point 4 is a safety requirement, not a style preference. Interpretation of reply text belongs to
`parseReply`, which is where the "ambiguity never resolves toward sending" rule lives (a bare
unprefixed digit is `unparseable`, not `approve`). If the channel normalized text on the way
through, it could turn an ambiguous string into a parseable approval. The channel reports what
arrived; it never improves it.

Exact string equality on the phone number is retained and made explicit in a test (T5). It is
strict: `15555550100` does not match `+15555550100`. Strict is the safe direction, and the
configured `APPROVER_PHONE` is the same E.164 string the SDK reports (verified by the Jul 17
spike). Any future loosening toward normalized comparison is a safety change that needs its own
review, so the test pins the current behavior deliberately.

### PC5. No test may open a network or gRPC connection

Constraint: **no test in this suite may open a network socket or a gRPC connection, to Photon or
anywhere else.** This is guaranteed structurally, not by convention:

- `photonChannel.ts` imports nothing from `spectrum-ts` after the refactor. The SDK import lives
  only in `photonConnect.ts`.
- `test/photonChannel.test.ts` imports `photonChannel.ts` and its own local fake. It never
  imports `photonConnect.ts` or `spectrum-ts`, so the module that calls `Spectrum(...)` is never
  even loaded into the test process.
- `connect` is a required dep with no default (PC3), so there is no fallback path a forgetful
  test could take.
- The only network-capable code, `connectSpectrum`, is a six-line function with no branching and
  no logic worth testing. It is covered by the compile-time assertion (PC2) and the manual
  checklist (M1 to M6), not by unit tests.

### PC6. Test harness: the fake session

One fake, roughly 40 lines, lives in the test file (not in `src/`, since nothing in production
needs it). It gives the test full control over the stream:

```ts
function fakeSession() {
  const sent: string[] = [];
  const queue: Array<{ kind: 'msg'; value: unknown } | { kind: 'err'; error: Error } | { kind: 'end' }> = [];
  let waiter: ((v: IteratorResult<unknown>) => void) | undefined;
  let rejecter: ((e: Error) => void) | undefined;
  let stopCalls = 0;
  let nextCalls = 0;
  // messages: an async iterable whose next() parks until the test calls deliver/fail/end
  // deliver(msg) resolves a parked next(), or queues if none is parked
  // fail(err)    rejects a parked next()
  // end()        resolves { done: true }
  // app.stop()   increments stopCalls
  // im.user()    returns a marker; im.space.create() returns { send: t => { sent.push(t) } }
  ...
}
```

The fake is typed as `PhotonSession`, so it **cannot** define a `close()` method that the channel
would call: `PhotonApp` has no such member. Timing is driven by `vi.useFakeTimers()` plus
`vi.advanceTimersByTimeAsync(ms)`, so the whole suite runs in milliseconds and never depends on
wall clock. `deps.graceMs` is injected explicitly in tests rather than relying on the 500ms
default, and a separate test pins that the default is 500 when not supplied.

### PC7. `formatDraftMessage` deserves its own tests: yes

It is the only user-facing text this module produces, it is generated from data about a real
person, and it is what Aditya reads on a phone screen before approving an irreversible email.
Three distinct reasons, beyond general coverage:

1. **The em dash rule.** The project forbids the character in user-facing text. The formatter's
   own template must not introduce one, and the test pins that (T19). The test asserts on the
   template, not on the interpolated `body`, since the body comes from the drafter and is that
   subsystem's responsibility.
2. **Grammar round trip.** The formatter advertises a reply grammar (`Reply "d7 y" to send, "d7
   n" to skip.`). If that advertised string ever drifts from what `parseReply` accepts, the user
   is told to type something that will be classified `unparseable` and their approval silently
   does nothing (or worse, a future grammar change makes the advertised skip string parse as
   something else). A test that feeds the exact advertised strings back through `parseReply` and
   asserts `approve` and `skip` closes that gap across the two modules (T20).
3. **No fabrication and no truncation.** The message must carry the recipient's real name and
   real email address verbatim so the human approving can catch a wrong recipient, and the body
   must pass through unmodified so what is approved is what was drafted (T21).

## Test Requirements

Numbered so implementation and tests trace to them. All live in
`outreach/test/photonChannel.test.ts` unless noted. T1 to T18 use the PC6 fake; T19 to T22 are
pure functions and need no fake.

### Allowlist (the open-reflector guard)

| # | Requirement |
|---|---|
| **T1** | A text message from a sender that is not `approverPhone` is not returned by `captureReplies`, and produces **no observable effect at all**: `sent` on the fake DM space is empty (no reply, no ack, no help text) and the returned array is empty. This is the open-reflector test. |
| **T2** | A text message from `approverPhone` is returned as `{ text, messageId }` with `messageId` equal to the SDK message `id`. |
| **T3** | A batch containing approver and non-approver messages returns only the approver's, in arrival order, with the non-approver's message absent from the result and from the state the channel keeps. |
| **T4** | A message whose `sender` is `undefined`, or whose `sender.id` is `undefined`, is ignored (the SDK types `sender` as possibly absent per AL3). |
| **T5** | Sender matching is exact string equality: `'15555550100'` and `' +15555550100 '` are both ignored when `approverPhone` is `'+15555550100'`. Pins the strict-is-safe direction against an accidental future loosening. |

### Content type and passthrough

| # | Requirement |
|---|---|
| **T6** | A message from the approver whose `content.type` is not `'text'` (for example `'image'`, or `content` absent entirely) is ignored. |
| **T7** | A message from the approver with `content.type === 'text'` but empty or missing `text` is ignored. |
| **T8** | Reply text is returned verbatim: leading and trailing whitespace, casing, and punctuation are preserved exactly (PC4 point 4). Asserted with an input like `'  YeS   d7 '`. |
| **T9** | A malformed stream item (not an array, an array of length 1, or a second element that is `null` or a primitive) is ignored without throwing, and does not stop the drain: a valid approver message delivered after it is still returned. |

### Grace-period drain

| # | Requirement |
|---|---|
| **T10** | A message from the approver that arrives after `windowMs` has elapsed but within `graceMs` is returned. Drive it by advancing fake timers past `windowMs` with no delivery, then delivering during grace. This is the boundary-reply-not-lost property. |
| **T11** | A message arriving during the grace period from a **non-approver** is ignored, with no reply and an empty result. The grace path must apply the identical allowlist check to the main loop, and this test is the only thing that says so. |
| **T12** | A non-text message arriving during the grace period is ignored (identical content check to the main loop). |
| **T13** | If the grace period expires with nothing delivered, `captureReplies` resolves with what it had, and does not hang past `windowMs + graceMs` of virtual time. |
| **T14** | The pending `iterator.next()` promise is not double-issued: across a window in which the timeout fires once and a message then arrives during grace, the fake records exactly one `next()` call per delivered message plus at most one outstanding call. Pins the "hold the pending promise across iterations" behavior that prevents a dropped reply. |
| **T15** | A pending `next()` that **rejects after** `captureReplies` has returned does not surface as an unhandled rejection. Implementation note: attach a no-op catch to the abandoned pending promise before returning. Asserted by registering a `process.on('unhandledRejection')` spy for the duration of the test. |

### Stream errors

| # | Requirement |
|---|---|
| **T16** | The stream rejects mid-window after two approver messages have been delivered: `captureReplies` resolves with those two replies, does **not** throw, and calls the injected `warn` exactly once with a message naming the count collected. Partial results plus survival is the whole point: an unattended scheduled run must not die on a transport hiccup. |
| **T17** | The stream rejects before any message: resolves with `[]`, does not throw. |
| **T18** | The iterator returning `{ done: true }` ends the drain promptly and returns what was collected. |

### Shutdown, sends, and construction

| # | Requirement |
|---|---|
| **T19** | `close()` calls `app.stop()` exactly once and awaits it (the fake's `stop` returns a promise the test resolves late; the test asserts `close()` has not resolved before then). See "How this catches the close versus stop bug" below. |
| **T20** | `sendDraftMessage(msg)` sends exactly `formatDraftMessage(msg)` through the DM space, once. `notify(text)` sends `text` verbatim, once. |
| **T21** | The channel resolves the approver user and creates the DM space exactly once at construction, not once per send: two `sendDraftMessage` calls yield one `im.user` call and one `im.space.create` call. |
| **T22** | After a `captureReplies` call that ends via the timeout path, `vi.getTimerCount()` is `0`: both the per-iteration race timer and the grace timer are cleared. A leaked timer keeps the Node event loop alive and is the same failure signature as the `close` bug (a scheduled run that never exits). |

### `formatDraftMessage` and `photonOptionsFromEnv` (pure)

| # | Requirement |
|---|---|
| **T23** | `formatDraftMessage` output contains no em dash character, for a message whose own fields contain none. Asserted against the template, complementing the repo-wide style rule. |
| **T24** | Grammar round trip: the exact approve string and the exact skip string the formatted message advertises, extracted from the rendered output rather than hardcoded in the test, parse via `parseReply` to `{ kind: 'approve', shortId }` and `{ kind: 'skip', shortId }` respectively. Fails if the formatter and the parser ever drift apart. |
| **T25** | The rendered message contains the recipient's name, the recipient's email address, the subject, and the body **verbatim and untruncated** (nothing about a real person is dropped, reworded, or invented on the way to the phone). A multi-line body with blank lines survives intact. |
| **T26** | `photonOptionsFromEnv` throws a message naming all three variables when any of `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `APPROVER_PHONE` is missing or empty, and returns all three when present. Uses `vi.stubEnv`. |

Total: 26 numbered test requirements.

## How This Catches the `close` Versus `stop` Bug

The shipped defect was `app.close?.()` where the SDK exposes `stop()`, reachable only through an
`as unknown as` cast, silently no-opping, leaving a resumable stream reconnecting forever so the
process never exited and a launchd run happened exactly once. Four independent mechanisms in this
spec catch it, and any one of them is sufficient:

1. **T19 fails outright.** The fake's `PhotonApp` implements `stop()` and nothing else, and
   records calls. Code calling `close?.()` increments nothing, so `expect(fake.stopCalls).toBe(1)`
   fails. The optional-call operator, which is what made the bug silent in production, is exactly
   what makes it loud here: `undefined?.()` returns `undefined` instead of throwing, so a test
   asserting the **positive** effect (stop was called) is the only kind that catches it. This is
   why T19 asserts a call count rather than merely that `close()` resolves.
2. **The fake cannot be written wrong.** The fake is typed `PhotonSession`. `PhotonApp` has no
   `close` member, so a test author cannot accidentally add one to make a broken implementation
   pass. The type drives the fake, and the type is derived from the real SDK by PC2.
3. **`npm run typecheck` fails.** With the cast banned (PC2) and `stop` declared required and
   non-optional in `PhotonApp`, writing `app.close()` is a compile error in `photonChannel.ts`,
   and if someone "fixed" it by renaming the interface member to `close`, the `_AppConforms`
   assertion in `photonConnect.ts` fails because `SpectrumInstance` has no `close`. The error
   points at the SDK boundary, which is where the truth is.
4. **T22 catches the symptom class.** The observable production symptom was a process that never
   exits. T22 asserts zero outstanding timers after the timeout path, which is the unit-testable
   half of "nothing is keeping the event loop alive." The other half, the stream itself keeping
   the loop alive after `stop()`, is not unit-testable and is R1 plus M4 below.

Generalized rule this spec establishes: **an SDK boundary is described by a hand-written
interface that the SDK is asserted to satisfy at compile time, never by a cast, and every method
the code calls on that boundary is non-optional and is asserted called by a test.** Casts and
optional calls together are what turned a name mismatch into a silent runtime no-op.

## Residual Risk

Unit tests with a fake verify the channel's logic against an assumed SDK contract. They cannot
verify the contract itself. Named honestly:

- **R1. Shutdown actually terminates the process.** T19 proves `stop()` is called. It cannot
  prove that the real `stop()` tears down the resumable gRPC stream and lets Node exit. That is
  the precise gap the original bug lived in, and it needs M4.
- **R2. Field shapes are assumed.** That `sender.id` is the E.164 string matching
  `APPROVER_PHONE`, that `content.type` is literally `'text'`, that `id` is the stable dedup key,
  and that `messages` yields `[space, message]` tuples all come from the Jul 17 spike, not from
  the tests. PC2 catches renames that the types express; it does not catch a value-level change
  (for example Photon starting to report a display handle instead of E.164, which would make the
  allowlist reject every legitimate reply, failing safe, or a formatting change that made it
  match too loosely, failing open). M2 and M3 cover it.
- **R3. Provider honesty.** Command authenticity rests entirely on Photon truthfully reporting
  `sender.id`. A compromised or buggy provider could forge `APPROVER_PHONE`. No test can cover
  this. It is the AL12 residual trust assumption, and it is why AL12 requires revisiting before a
  real send path is enabled.
- **R4. Grace-period message loss beyond the window.** Each `captureReplies` call creates a fresh
  iterator from `app.messages`, and an outstanding `next()` is abandoned when grace expires.
  Whether the message that promise would have delivered is redelivered to the next run's iterator
  (Photon's replay behavior, verified for disconnects but not for abandoned iterators) or is lost
  permanently is unknown. A fake answers whatever the fake was written to answer, so this is not
  a unit-testable question. M5 covers it. If M5 shows loss, the fix is a single long-lived
  iterator held across calls for the channel's lifetime, which is a design change outside this
  spec's scope.
- **R5. Real-world message rendering.** No test says the formatted message reads well in an
  iMessage bubble, that a long body is not visually truncated by the client, or that the reply
  instruction is legible. M1 covers it.
- **R6. Timing under load.** Fake timers make the race deterministic, which is the point, and
  also means the tests say nothing about behavior when a real stream delivers slowly or in
  bursts. Accepted: the batch loop tolerates a missed reply (it is picked up next run), so this
  is a latency concern, not a safety one.

### Manual verification checklist (covers R1, R2, R4, R5)

Run once against the live service after the refactor lands, and again after any `spectrum-ts`
major upgrade. Record results in this section.

| # | Check | Pass condition |
|---|---|---|
| **M1** | Run one real draft through `sendDraftMessage` to Aditya's phone. | The text arrives, the name and email are correct and complete, the body is not truncated, and the reply instruction is legible on a phone screen. |
| **M2** | Reply with the exact approve string the message advertises. | `captureReplies` returns it, `parseReply` classifies it `approve`, and the loop proceeds. |
| **M3** | Have a second number text the shared line during a capture window. | The message is ignored, nothing is sent back to that number, and the run's result contains no trace of it. This is the live open-reflector check. |
| **M4** | Run the loop to completion under `time` with no `SIGKILL`. | The process exits on its own within seconds of `close()`. Confirms R1. Re-run under launchd and confirm the job completes and the next scheduled run fires. |
| **M5** | Text a reply within a second of the capture window closing, then run the loop again. | The reply is drained either in the grace period of the first run or by the second run. If it is lost in both, R4 is real and needs the long-lived-iterator fix. |
| **M6** | Disable the network mid-window (turn Wi-Fi off during a capture). | The run logs the warning, returns any replies already collected, does not throw, and completes the rest of the run normally. Live confirmation of T16. |

## Implementation Plan

Each step ends with a human-verifiable checkpoint.

1. **Extract the seam.** Create `photonConnect.ts` with `connectSpectrum` and the PC2 conformance
   assertions. Change `photonChannel.ts` to the PC1 interfaces and the PC3 signature, remove the
   `spectrum-ts` imports from it, add the PC4 shape guard and the T15 abandoned-promise catch, and
   update the one call site in `cli.ts`. No behavior change.
   ✅ *Human: `npm run typecheck` passes with zero casts in either file (`grep -n 'as unknown as\|as any' src/approval/photon*.ts` returns nothing), and `outreach loop` still texts your phone exactly as before.*
2. **Write the fake and the safety tests** (T1 to T9): allowlist, content type, verbatim
   passthrough, malformed items.
   ✅ *Human: read T1, T3, and T5 line by line against the "stranger cannot approve" claim, then temporarily invert the allowlist comparison in the source and confirm T1, T3, T4, and T5 all go red. A safety test that does not fail when the safety check is removed is not a safety test.*
3. **Timing tests** (T10 to T15, T22): grace-period drain with the allowlist reapplied, pending
   promise held across iterations, timers cleared.
   ✅ *Human: delete the grace-period block from the source and confirm T10 fails; delete the allowlist call from inside the grace block only and confirm T11 fails while T1 still passes.*
4. **Error, shutdown, and send tests** (T16 to T21).
   ✅ *Human: change `app.stop()` back to `app.close?.()` through a cast and confirm both `npm run typecheck` and T19 fail. This is the regression test for the bug that shipped.*
5. **Pure-function tests** (T23 to T26) and the manual checklist run (M1 to M6), with results
   recorded in the Residual Risk section.
   ✅ *Human: every M row has a recorded pass, or a recorded failure with a follow-up issue. M3 and M4 are non-negotiable before the loop runs unattended on a schedule.*

## Open Questions

1. **Tighter `messages` typing** (PC1): whether `AsyncIterable<readonly [unknown, PhotonMessage]>`
   compiles against the real `SpectrumInstance`. Decided in Step 1 by the compiler, not by
   judgment. Tighter is preferred if it compiles without a cast.
2. **Abandoned-iterator replay** (R4): resolved by M5. If replay does not cover it, a follow-up
   spec covers holding one iterator for the channel's lifetime.
3. **Whether the fake graduates to `src/`**: not now. It stays in the test file until a second
   test file needs it, at which point it moves to `test/fakes/photon.ts`. Production code never
   imports it.
