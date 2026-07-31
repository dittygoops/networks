# Listener Reliability and Approval-Path Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `outreach listen` fail loudly instead of silently, make it structurally incapable of hot-spinning against the live Spectrum service, and remove three ways an approval can be silently lost or accidentally granted.

**Scope (files owned by this plan):** `outreach/src/pipeline/listen.ts`, `outreach/src/approval/photonChannel.ts`, `outreach/src/approval/channel.ts`, and their tests (`outreach/test/listen.test.ts`, `outreach/test/photonChannel.test.ts`, `outreach/test/channel.test.ts`).

**Explicitly out of scope (other plans own these):** `src/pipeline/loop.ts` send logic including `handleReply` itself, `src/approval/ledger.ts`, `src/research.ts`, `src/intersect.ts`, `src/discovery/**`, `src/discovery/relevanceGate.ts`, and `src/cli.ts`. This plan changes *how* `listen.ts` calls `handleReply`, never `handleReply`. It introduces no signature change that would force a `cli.ts` edit.

**Defects addressed:** D1 (dead failure ceiling and hot-spin), D2 (`captureReplies` consumes and drops a reply), D3 (allowlist string-equality silent failure), D4 (no non-empty `approverPhone` invariant), D5 (bare `d7` approves an irreversible send), D6 (fabricated `LoopSummary`).

## Global Constraints

- **No em dashes.** The character U+2014 must not appear in any file this plan touches, including comments, test strings, commit messages, and this document. Use commas, colons, or parentheses. This is a hook-enforced user rule.
- Every source import uses an explicit `.js` extension (`import { handleReply } from './loop.js'`).
- `tsconfig` has `noUncheckedIndexedAccess`. Any array index read is `T | undefined` and must be narrowed or defaulted.
- **No test may open a network or gRPC connection.** `createPhotonChannel(opts, connect)` already accepts an injectable `PhotonConnectFn`, and `test/photonChannel.test.ts` already uses it. No new injection machinery is built (see "Decision: no new test seam" below).
- Do not weaken an existing test. One existing assertion is *tightened* (Task 1, `parseReply('d7')` goes from `approve` to `unparseable`); that is a strengthening and is called out explicitly.
- Safety invariants that must visibly hold at every step, each pinned by at least one test:
  1. The allowlist holds. A non-approver never receives any outbound reply, ack, or error text.
  2. Ambiguity never resolves toward sending.
  3. Nothing sends without an explicit human approval.
- Run `npm test` and `npm run typecheck` from the `outreach/` directory.
- Commit after every task. Do not restart the live daemon until Task 8, and not unilaterally even then.

## Operational Context: the daemon is live right now

`com.aditya.outreach-listen` is loaded under launchd and running (`launchctl list | grep outreach-listen` reports PID 913 as of 2026-07-29). It holds an open iMessage stream, and an approval reply performs a **real, irreversible cold email send**.

Two consequences the implementer must internalize before writing a line of code:

- The job runs from source via `tsx` (see `outreach/scripts/com.aditya.outreach-listen.plist`). Editing and committing source files does **not** affect the running process. Only a restart picks up new code. So all of Tasks 1 to 7 are safe to perform with the daemon running.
- Spectrum does not deliver messages to a client that was disconnected when they were sent. A reply Aditya texts during the restart window is **lost permanently**. That is why Task 8 is a coordinated deployment and why **the implementer may not restart the daemon on their own initiative**.

## The Central Decisions

### D1. How the daemon distinguishes a healthy stream end from a failure

**Decision: `streamReplies` returns a typed outcome, and the listener additionally treats a session that ends too fast and delivered nothing as a failure. Every loop iteration is paced by a floor sleep.**

Three layers, because each alone leaves a hole:

1. **Typed outcome.** `streamReplies` returns `Promise<StreamOutcome>` where `StreamOutcome = { reason: 'ended' | 'error'; detail?: string }`. The real channel already catches its own errors (deliberately, so one bad session does not throw out of an unattended daemon), so it now *reports* what happened instead of erasing it. Rejection is still honored as a failure by the listener, so a channel that throws (the stub, a future adapter, a bug) is not silently treated as healthy.
   *Why not simply reject?* Rejecting is a strictly weaker fix: it does not distinguish "connected, ran ten hours, stream closed cleanly" from "connected, stream closed cleanly one millisecond later", and the second case is exactly the observed hot-spin shape (revoked auth, degraded Spectrum, network down). Both would still be `sessionOk`.
2. **Minimum healthy session.** `reason: 'ended'` counts as healthy only if the session lasted at least `minHealthySessionMs` (default 60000) **or** delivered at least one reply. A quiet night is the normal case for a listener and must stay healthy, so silence is never the failure signal. Duration is: a stream that survives a minute is a working connection; a stream that returns instantly is a broken one wearing a clean exit.
3. **Floor pacing.** Every iteration of the loop passes through a sleep of at least `minCycleIntervalMs` (default 1000). This is the belt to the braces: even if a future channel returns an outcome nobody anticipated, the loop cannot reach `connect()` more than once per second. This is the structural half of the fix, and it is what the regression test asserts against.

The precedent this guards against is on record: a 1 year timeout value overflowed Node's 32-bit timer field, silently became 1ms, and produced 4 client rebuilds in 45 seconds against the live service. A number-shaped bug defeated a logic-shaped guard. A floor sleep on the loop itself is the guard that survives the next number-shaped bug.

**How a test proves the hot-spin cannot recur** (Task 3, "hot-spin regression"): a fake channel whose `streamReplies` resolves *immediately* with `{ reason: 'ended' }`, which is precisely what the real implementation does today when Spectrum drops the stream on connect. Virtual time is advanced only by the injected `sleep`, and `now` is injected to read it. Over 20 cycles the test asserts:

- `slept.length === 20`: every single cycle slept, with no exceptions and no ordering assumption,
- `Math.min(...slept) >= 1000`: no cycle slept a token amount,
- the last wait is the 300000ms cap, so escalating backoff is actually applied rather than reset every cycle,
- `virtualNow > 3600000`: 20 immediate-end cycles cost more than an hour of wall clock instead of zero.

The last assertion is the one that matters. A call-count assertion would pass against the current hot-spinning code; a minimum-elapsed-time assertion cannot.

The fake used in tests must be able to reproduce the real contract, which is where the current suite failed: `test/listen.test.ts`'s `scriptedChannel.streamReplies` **throws** on failure, and the real implementation never throws. Task 2 rewrites the fake so its default path is "resolve with an outcome", and keeps a throwing script step as an additional defensive case rather than the only one.

### D3. Phone matching: validate the format at construction, never normalize for authorization

**Decision: keep exact string equality against `sender.id` alone. Assert at channel construction that `approverPhone` is exact E.164. Normalize only to produce a diagnostic log line, never to make an accept decision.**

Phone normalization is a trap: every normalization is a widening of the set of strings that can approve an irreversible email, and the correct normalization is locale-dependent and unknowable from inside this process. The verified live observation is that the provider emits `sender: {"id":"+15555550123","address":"+15555550123","country":"US","service":"iMessage"}` and the configured value is exactly `+15555550123`. Exact match is therefore known to work today.

The actual defect in D3 is not the comparison, it is that a misconfiguration is discovered at reply time as silence. So move the discovery to boot time: a value that is not exact E.164 could never match anything the provider emits, so it is a configuration error and the channel refuses to construct. Under launchd's `KeepAlive` this produces a crash-looping job with a named error in `listen.err.log`, which is loud, instead of a healthy-looking daemon that ignores every approval, which is silent.

Second half of the diagnostic: when a message is rejected by the allowlist, if the sender's digits equal the approver's digits but the strings differ, log a specific warning saying `APPROVER_PHONE` is misconfigured. Digits are compared **only to choose which log line to print**. No branch reachable from that comparison can accept a message. This is the "normalize for diagnosis, never for authorization" rule, stated in a comment at the call site.

**Position on `docs/spec-inbound-decode.md` IB3 (read both `id` and `address`, reject on disagreement): rejected.** Its own review is right. An iMessage account is routinely reachable by both a phone number and an Apple ID email, so `id` and `address` disagreeing is a plausible normal state, not evidence of an attack. A fail-closed rule on disagreement would silently reject every reply, which is the *same* all-quiet failure D3 exists to eliminate, merely triggered by a different input. The mirror policy (accept if *either* field matches) is worse: it widens the trusted surface to a second field whose semantics are unverified, in the fail-open direction, on the one control preventing an open reflector. So: one field, exact match, verified against a live observation, with a loud startup check and a loud near-miss log. If `sender.id` ever stops carrying E.164, the near-miss warning is the instrument that says so.

### D5. A bare `d7` no longer approves

**Decision: `parseReply('d7')` returns `{ kind: 'unparseable' }`. An approval requires an explicit keyword.**

The comment adjacent to the current code already argues that ambiguity must never resolve toward sending, then carves out the prefix. The carve-out does not survive contact with the facts: draft ids are global, permanent, and long-lived, so a stray `d3` typed months later approves whatever old `awaiting_approval` draft holds id 3. A prior fix removed bare-digit approval (`parseReply('7')` is already `unparseable`) for exactly this reason and left the prefixed twin in place.

Cost to Aditya: one character. He has already sent `d8 y` and `d7 y`, both with keywords, so the change costs his muscle memory nothing. The message `formatDraftMessage` puts on his phone already advertises only the keyword form (`Reply "d7 y" to send, "d7 n" to skip.`), so the removed grammar was never advertised in the first place.

Failure mode after the change is benign and self-correcting: `handleReply`'s existing `unparseable` branch replies `Could not read "d7". Reply like "d7 y" or "d7 n".`, so a bare id gets a prompt rather than either a send or silence.

### Decision: no new test seam is needed

`docs/spec-photon-channel-testing.md` is NEEDS REVISION and proposes extracting `photonConnect.ts` plus a required-injection factory. Checked against the code as it exists today: `createPhotonChannel(opts, connect: PhotonConnectFn = defaultConnect)` already takes an injectable connect function, and `test/photonChannel.test.ts` already drives the channel through a fake `PhotonApp` and `PhotonDm` without importing `spectrum-ts` transitively at the value level. **Every test in this plan is writable against the seam that exists.** Building new machinery here would be scope creep against a spec that is not approved.

One residual from that spec is noted and deliberately not taken: `connect` is defaulted rather than required, so a forgetful future test could fall through to a live gRPC dial. Making it required would force an edit to `src/cli.ts`, which this plan does not own. Recorded as a follow-up, not done here.

## File Structure

| File | Responsibility in this plan |
| --- | --- |
| `outreach/src/approval/channel.ts` (modify) | `StreamOutcome` type, `streamReplies` return type, `parseReply` keyword requirement, stub channel update |
| `outreach/src/approval/photonChannel.ts` (modify) | Return `StreamOutcome`, E.164 construction invariant, misconfiguration diagnostic, non-dropping `captureReplies` |
| `outreach/src/pipeline/listen.ts` (modify) | Outcome-based health, minimum healthy session, floor pacing, injected `now`, honest send counter |
| `outreach/test/channel.test.ts` (modify) | Keyword-required grammar, stub outcome |
| `outreach/test/photonChannel.test.ts` (modify) | Construction invariant, diagnostic, carryover instead of drop, iterator closed |
| `outreach/test/listen.test.ts` (modify) | Real-contract fake, hot-spin regression, ceiling reachable, summary probe |

---

### Task 1: An approval requires an explicit keyword (D5)

**Files:**
- Modify: `outreach/src/approval/channel.ts`
- Test: `outreach/test/channel.test.ts`

**Interfaces:** no signature change. `parseReply(text): ParsedReply` behavior narrows: a lone `d`-prefixed id becomes `unparseable` instead of `approve`.

- [ ] **Step 1: Tighten the existing test**

In `outreach/test/channel.test.ts`, replace the test at lines 17 to 19:

```typescript
  it('accepts a prefixed bare id as approval', () => {
    expect(parseReply('d7')).toEqual({ kind: 'approve', shortId: 'd7' });
  });
```

with:

```typescript
  // Tightened deliberately (D5). Draft ids are global and permanent, so a
  // stray "d3" typed months later would otherwise approve whatever old
  // awaiting_approval draft holds id 3, and an approval is an irreversible
  // cold email. The prefix is an id, not a verb. The keyword forms below are
  // what the outbound message advertises, and are what Aditya already types.
  it('rejects a bare prefixed id as unparseable, not approval', () => {
    expect(parseReply('d7')).toEqual({ kind: 'unparseable' });
    expect(parseReply('D12')).toEqual({ kind: 'unparseable' });
  });

  it('still approves and skips the advertised keyword forms', () => {
    expect(parseReply('d7 y')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('d7 n')).toEqual({ kind: 'skip', shortId: 'd7' });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/channel.test.ts`
Expected: FAIL, the bare-id test reports `{ kind: 'approve', shortId: 'd7' }` where `{ kind: 'unparseable' }` was expected.

- [ ] **Step 3: Make the change**

In `outreach/src/approval/channel.ts`, `parseReply` currently tracks `hadPrefix` and uses it once. Remove the tracking and the exception. Replace lines 47 to 64 with:

```typescript
  let shortId: string | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    const id = shortId === undefined ? parseShortId(t) : null;
    if (id !== null) {
      shortId = formatShortId(id);
    } else {
      rest.push(t);
    }
  }
  if (shortId === undefined) return { kind: 'unparseable' };

  // Ambiguity never resolves toward sending, with no exceptions. An id alone
  // is a noun: "d7" or "7" could be an accidental text, a year, a house
  // number, or a reply meant for another conversation, and ids are permanent
  // so a stale one still names a real draft. An approval must contain a verb.
  // This costs one character and the outbound message advertises exactly that
  // form ("Reply \"d7 y\" to send").
  if (rest.length === 0) return { kind: 'unparseable' };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/channel.test.ts && npm run typecheck`
Expected: 8 passed, typecheck clean. If typecheck reports `hadPrefix` unused, the removal in Step 3 was incomplete.

- [ ] **Step 5: Confirm nothing else depended on the old grammar**

Run: `cd outreach && npx vitest run && grep -rn "parseReply('d[0-9]*')" src test`
Expected: full suite green (331 tests, plus the one added test), and the grep returns only `test/channel.test.ts` lines.

- [ ] **Step 6: Commit**

```bash
git add outreach/src/approval/channel.ts outreach/test/channel.test.ts
git commit -m "Require an explicit keyword to approve, so a stray draft id cannot send"
```

---

### Task 2: `streamReplies` reports a typed outcome (D1, part 1)

**Files:**
- Modify: `outreach/src/approval/channel.ts`
- Modify: `outreach/src/approval/photonChannel.ts`
- Modify: `outreach/src/pipeline/listen.ts` (minimal, to keep the build green; the health logic lands in Task 3)
- Test: `outreach/test/channel.test.ts`, `outreach/test/listen.test.ts`, `outreach/test/photonChannel.test.ts`

**Interfaces:**
- Produces: `StreamOutcome` from `src/approval/channel.js`
- Changes: `ApprovalChannel.streamReplies(onReply): Promise<StreamOutcome>` (was `Promise<void>`)

**Context:** verified by grep that `streamReplies` appears in exactly four files (`src/approval/channel.ts`, `src/approval/photonChannel.ts`, `src/pipeline/listen.ts`, `test/listen.test.ts`). `src/cli.ts` and `src/pipeline/loop.ts` use `captureReplies` only, so this signature change touches nothing outside this plan's ownership.

- [ ] **Step 1: Write the failing tests**

Add to `outreach/test/channel.test.ts` inside `describe('createStubChannel')`:

```typescript
  it('reports a stream outcome so a caller can tell an end from a failure', async () => {
    const ch = createStubChannel();
    ch.queueReply('d7 y');
    const seen: string[] = [];
    const outcome = await ch.streamReplies(async (r) => {
      seen.push(r.text);
    });
    expect(seen).toEqual(['d7 y']);
    expect(outcome).toEqual({ reason: 'ended' });
  });
```

Add to `outreach/test/photonChannel.test.ts`:

```typescript
describe('createPhotonChannel streamReplies', () => {
  it('reports reason "ended" when the stream finishes cleanly', async () => {
    const { channel } = await channelFor([
      { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } },
    ]);
    const seen: string[] = [];
    const outcome = await channel.streamReplies(async (r) => {
      seen.push(r.text);
    });
    expect(seen).toEqual(['d7 y']);
    expect(outcome).toEqual({ reason: 'ended' });
  });

  // The defect this replaces: the whole for-await was wrapped in try/catch and
  // resolved normally on error, so the daemon inferring health from "did it
  // reject" always concluded healthy. The failure is now in the return value.
  it('reports reason "error" instead of resolving as if nothing happened', async () => {
    const failing: PhotonApp = {
      messages: (async function* () {
        yield [{ id: 'space-1' }, { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } }] as [
          unknown,
          RawMessage,
        ];
        throw new Error('stream died');
      })(),
      async stop() {},
    };
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: failing, dm: { send: vi.fn().mockResolvedValue(undefined) } }),
    );
    const seen: string[] = [];
    const outcome = await channel.streamReplies(async (r) => {
      seen.push(r.text);
    });
    expect(seen).toEqual(['d7 y']); // replies before the error are still delivered
    expect(outcome.reason).toBe('error');
    expect(outcome.detail).toContain('stream died');
  });

  it('survives a handler that throws and still reports the stream end', async () => {
    const { channel } = await channelFor([
      { id: 'm1', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } },
      { id: 'm2', sender: { id: APPROVER }, content: { type: 'text', text: 'd8 n' } },
    ]);
    const seen: string[] = [];
    const outcome = await channel.streamReplies(async (r) => {
      seen.push(r.text);
      if (r.messageId === 'm1') throw new Error('handler blew up');
    });
    expect(seen).toEqual(['d7 y', 'd8 n']);
    expect(outcome).toEqual({ reason: 'ended' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd outreach && npx vitest run test/channel.test.ts test/photonChannel.test.ts`
Expected: FAIL, the outcome assertions receive `undefined`.

- [ ] **Step 3: Add the type and change the interface**

In `outreach/src/approval/channel.ts`, above `ApprovalChannel`:

```typescript
// Why a returned value and not a rejection: the real channel deliberately does
// not throw out of an unattended daemon (one bad session must not kill the
// process), so before this type existed a stream failure and a clean end were
// literally the same observation, and the listener's failure ceiling and
// backoff were unreachable code. The outcome makes the difference data.
// `detail` is present only on 'error' and carries the stringified cause.
export interface StreamOutcome {
  reason: 'ended' | 'error';
  detail?: string;
}
```

Change the `ApprovalChannel` member:

```typescript
  // Push semantics: invoke onReply as each message arrives, and resolve only
  // when the underlying stream ends. This is what a long-lived listener needs.
  // A real approval sat unprocessed in captureReplies' array because the
  // daemon was waiting on a 24 day window to expire before seeing it.
  // Resolving with an outcome rather than throwing keeps a transport hiccup
  // from killing an unattended daemon while still telling it what happened.
  streamReplies(onReply: (reply: InboundReply) => Promise<void>): Promise<StreamOutcome>;
```

And in `createStubChannel`:

```typescript
    async streamReplies(onReply: (reply: InboundReply) => Promise<void>): Promise<StreamOutcome> {
      const batch = pending;
      pending = [];
      for (const r of batch) await onReply(r);
      return { reason: 'ended' };
    },
```

- [ ] **Step 4: Return the outcome from the real channel**

In `outreach/src/approval/photonChannel.ts`, import the type:

```typescript
import type { ApprovalChannel, InboundReply, OutboundDraftMessage, StreamOutcome } from './channel.js';
```

Replace the body of `streamReplies` (lines 165 to 183) with:

```typescript
    async streamReplies(onReply: (reply: InboundReply) => Promise<void>): Promise<StreamOutcome> {
      try {
        for await (const value of app.messages) {
          const reply = decodeReply(value as [unknown, RawMessage], opts.approverPhone);
          if (!reply) continue;
          try {
            await onReply(reply);
          } catch (err) {
            // One bad reply must not tear down the stream: an unattended
            // listener that dies on a single malformed approval is worse
            // than one that logs and keeps listening. A handler failure is
            // therefore not a session failure and does not colour the outcome.
            console.warn(`streamReplies: handler error, continuing: ${String(err)}`);
          }
        }
        console.log('streamReplies: message stream ended');
        return { reason: 'ended' };
      } catch (err) {
        const detail = String(err);
        console.warn(`streamReplies: message stream error: ${detail}`);
        return { reason: 'error', detail };
      }
    },
```

- [ ] **Step 5: Keep the listener compiling (health logic lands in Task 3)**

In `outreach/src/pipeline/listen.ts`, the existing `try`/`catch` around `streamReplies` now receives a value. Minimal change only, lines 128 to 141:

```typescript
    const liveChannel = channel;
    let outcome: StreamOutcome;
    try {
      outcome = await channel.streamReplies(async (reply) => {
        try {
          await handleReply(replyDepsFor(liveChannel), { dryRun: false }, summary, reply);
        } catch (e) {
          // One malformed or unlucky reply must never take the listener down.
          log(`listen: reply handling failed: ${String(e)}`);
        }
      });
    } catch (e) {
      // A channel that rejects instead of reporting is still a failed session.
      // The real channel does not do this; the stub and any future adapter
      // might, and treating a rejection as healthy is the original defect.
      outcome = { reason: 'error', detail: String(e) };
    }
    const sessionOk = outcome.reason === 'ended';
    if (outcome.reason === 'error') log(`listen: stream session failed: ${outcome.detail ?? 'no detail'}`);
```

Add `StreamOutcome` to the type import at line 15:

```typescript
import type { ApprovalChannel, InboundReply, StreamOutcome } from '../approval/channel.js';
```

Delete the now-unused `let sessionOk = true;` declaration and the `sessionOk = false;` assignment in the old catch.

- [ ] **Step 6: Update the test fake to reproduce the real contract**

This is the step that closes the gap where the suite validated a contract production violates. In `outreach/test/listen.test.ts`, replace `scriptedChannel` (lines 36 to 69) with:

```typescript
// A minimal ApprovalChannel scripted call-by-call, so each "session" (one
// call) can simulate replies, a clean end, a reported stream error, or a
// rejection. Critically, the default failure shape is a RESOLVED outcome of
// reason 'error', because that is what the real photonChannel does: it catches
// its own stream errors and never rejects. The previous version of this fake
// threw, so the suite proved a contract production did not implement, and the
// daemon's entire failure path was dead code nothing tested.
type Step = InboundReply[] | 'error' | 'throw';

function scriptedChannel(script: Step[]) {
  let call = 0;
  const notices: string[] = [];
  const sent: OutboundDraftMessage[] = [];
  let closeCount = 0;
  const channel: ApprovalChannel = {
    async sendDraftMessage(msg) {
      sent.push(msg);
    },
    async notify(text) {
      notices.push(text);
    },
    async captureReplies() {
      const step = script[call++];
      if (step === 'throw' || step === 'error' || step === undefined) throw new Error('stream broke');
      return step;
    },
    async streamReplies(onReply): Promise<StreamOutcome> {
      const step = script[call++];
      if (step === 'throw') throw new Error('stream broke');
      if (step === 'error' || step === undefined) return { reason: 'error', detail: 'stream broke' };
      for (const r of step) await onReply(r);
      return { reason: 'ended' };
    },
    async close() {
      closeCount++;
    },
  };
  return { channel, notices, sent, closeCount: () => closeCount, calls: () => call };
}
```

Add `StreamOutcome` to the type import on line 5, and update the one existing channel literal in `describe('runListenLoop delivery semantics')` so its `streamReplies` returns `{ reason: 'ended' }`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/channel.test.ts test/photonChannel.test.ts test/listen.test.ts && npm run typecheck`
Expected: all passed, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add outreach/src/approval/channel.ts outreach/src/approval/photonChannel.ts outreach/src/pipeline/listen.ts outreach/test/channel.test.ts outreach/test/photonChannel.test.ts outreach/test/listen.test.ts
git commit -m "Report a typed stream outcome so a failed session is distinguishable from a clean end"
```

---

### Task 3: The listener cannot hot-spin, and its failure ceiling is reachable (D1, part 2)

**Files:**
- Modify: `outreach/src/pipeline/listen.ts`
- Test: `outreach/test/listen.test.ts`

**Interfaces:**
- `ListenDeps` gains `now?: () => number`, `minHealthySessionMs?: number`, `minCycleIntervalMs?: number`. All optional, all test-facing, defaults are production values.

- [ ] **Step 1: Write the failing tests**

Append to `outreach/test/listen.test.ts`:

```typescript
// A channel matching the REAL photonChannel contract in the failure case the
// production defect lived in: the stream errors or ends the instant it is
// connected (revoked auth, degraded Spectrum, network down), and the channel
// resolves normally rather than throwing.
function instantEndChannel(reason: 'ended' | 'error' = 'ended') {
  let connects = 0;
  const channel: ApprovalChannel = {
    sendDraftMessage: async () => {},
    notify: async () => {},
    captureReplies: async () => [],
    streamReplies: async (): Promise<StreamOutcome> => ({ reason }),
    close: async () => {},
  };
  return { channel, connect: async () => { connects++; return channel; }, connects: () => connects };
}

describe('runListenLoop hot-spin regression', () => {
  // The defect: streamReplies resolved normally on error, the listener read
  // health from "did it reject", so consecutiveFailures reset every cycle,
  // backoff never applied, and the loop became connect -> return -> close ->
  // connect with ZERO sleep against the live service. This is the same class
  // as the shipped bug where a 1 year timeout overflowed Node's 32 bit timer
  // field, became 1ms, and caused 4 rebuilds in 45 seconds.
  //
  // The assertion that matters is elapsed virtual time, not a call count: a
  // call-count assertion passes against the hot-spinning code.
  it('sleeps on every cycle and escalates when the stream ends immediately', async () => {
    let virtualNow = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      virtualNow += ms;
    };
    const { connect, connects } = instantEndChannel('ended');
    const CYCLES = 20;

    await runListenLoop({
      connect,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep,
      now: () => virtualNow,
      exit: () => {},
      log: () => {},
      maxCycles: CYCLES,
      maxConsecutiveFailures: 1000, // not the subject of this test
    });

    expect(connects()).toBe(CYCLES);
    expect(slept).toHaveLength(CYCLES); // every cycle slept, no exceptions
    expect(Math.min(...slept)).toBeGreaterThanOrEqual(1000);
    // Escalating backoff is actually applied instead of being reset each cycle.
    expect(slept[slept.length - 1]).toBe(300_000);
    // 20 immediate-end cycles cost over an hour of wall clock, not 0ms.
    expect(virtualNow).toBeGreaterThan(60 * 60 * 1000);
  });

  it('applies the same pacing when the stream reports an error outcome', async () => {
    let virtualNow = 0;
    const slept: number[] = [];
    const { connect } = instantEndChannel('error');

    await runListenLoop({
      connect,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        slept.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit: () => {},
      log: () => {},
      maxCycles: 5,
      maxConsecutiveFailures: 1000,
    });

    expect(slept).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
  });

  // The ceiling at listen.ts:150 was unreachable against the real channel.
  // This is the test that says it is reachable now.
  it('exits for a supervisor restart after a ceiling of stream failures', async () => {
    const { connect } = instantEndChannel('error');
    const exit = vi.fn();
    let virtualNow = 0;

    await runListenLoop({
      connect,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit,
      log: () => {},
      maxConsecutiveFailures: 3,
      // No maxCycles: exit() must be the thing that stops the loop. The fake
      // exit does not terminate the process, so a loop that failed to stop
      // would hang this test rather than pass it.
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  // A quiet night is the normal case for a listener. Silence must never be the
  // failure signal, or the retry budget burns down for no reason.
  it('treats a long-lived session that ends cleanly as healthy', async () => {
    let virtualNow = 0;
    const slept: number[] = [];
    const channel: ApprovalChannel = {
      sendDraftMessage: async () => {},
      notify: async () => {},
      captureReplies: async () => [],
      streamReplies: async (): Promise<StreamOutcome> => {
        virtualNow += 10 * 60 * 1000; // ten quiet hours' worth of a session
        return { reason: 'ended' };
      },
      close: async () => {},
    };
    const exit = vi.fn();

    await runListenLoop({
      connect: async () => channel,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        slept.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit,
      log: () => {},
      maxCycles: 4,
    });

    // Only the floor pace, never a backoff: failures never accumulated.
    expect(slept).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(exit).not.toHaveBeenCalled();
  });

  // A session that did its job is healthy however short it was, so a burst of
  // approvals cannot be mistaken for a broken stream.
  it('treats a short session that delivered a reply as healthy', async () => {
    const slept: number[] = [];
    let virtualNow = 0;
    const channel: ApprovalChannel = {
      sendDraftMessage: async () => {},
      notify: async () => {},
      captureReplies: async () => [],
      streamReplies: async (onReply): Promise<StreamOutcome> => {
        await onReply({ text: 'd999 y', messageId: 'm1' });
        return { reason: 'ended' };
      },
      close: async () => {},
    };

    await runListenLoop({
      connect: async () => channel,
      db: openDb(':memory:'),
      sender: { send: vi.fn() },
      sleep: async (ms) => {
        slept.push(ms);
        virtualNow += ms;
      },
      now: () => virtualNow,
      exit: () => {},
      log: () => {},
      maxCycles: 3,
    });

    expect(slept).toEqual([1_000, 1_000, 1_000]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd outreach && npx vitest run test/listen.test.ts`
Expected: FAIL. The hot-spin test reports `slept` as `[]` (zero sleeps across 20 cycles), which is the defect reproduced.

- [ ] **Step 3: Implement the health accounting and the pacing**

In `outreach/src/pipeline/listen.ts`, extend `ListenDeps`:

```typescript
  sleep?: (ms: number) => Promise<void>;
  // Injected so tests can drive virtual time and assert on elapsed wall clock
  // rather than on call counts. A call-count assertion cannot catch a hot spin.
  now?: () => number;
  // A stream that ends cleanly within this window without delivering anything
  // did not have a healthy session, it failed to establish one. See below.
  minHealthySessionMs?: number;
  // Hard floor on how fast the loop may reconnect, whatever else happens.
  minCycleIntervalMs?: number;
```

Add the constants beside the existing ones:

```typescript
// A stream that connects and returns immediately is a broken connection with a
// clean exit code, not a quiet night. Sixty seconds is far below any real
// session and far above any plausible instant return.
const MIN_HEALTHY_SESSION_MS = 60_000;
// The structural anti-spin guard. Even if a channel someday returns an outcome
// nobody anticipated, the loop cannot reach connect() more than once per
// second. Logic-shaped guards have been defeated here before by number-shaped
// bugs (a 1 year timeout overflowed Node's 32 bit timer field and became 1ms,
// causing 4 client rebuilds in 45 seconds against the live service), so the
// floor does not depend on classifying the session correctly.
const MIN_CYCLE_INTERVAL_MS = 1_000;
```

Resolve them next to the other deps at the top of `runListenLoop`:

```typescript
  const now = deps.now ?? (() => Date.now());
  const minHealthySessionMs = deps.minHealthySessionMs ?? MIN_HEALTHY_SESSION_MS;
  const minCycleIntervalMs = deps.minCycleIntervalMs ?? MIN_CYCLE_INTERVAL_MS;
```

Capture the cycle start immediately after `cycles++;`:

```typescript
    cycles++;
    const cycleStart = now();
```

Replace the session block written in Task 2 Step 5 with the full version:

```typescript
    const liveChannel = channel;
    let repliesDelivered = 0;
    let outcome: StreamOutcome;
    const sessionStart = now();
    try {
      outcome = await channel.streamReplies(async (reply) => {
        repliesDelivered++;
        try {
          await handleReply(replyDepsFor(liveChannel), { dryRun: false }, totalsAsSummary, reply);
        } catch (e) {
          // One malformed or unlucky reply must never take the listener down.
          log(`listen: reply handling failed: ${String(e)}`);
        }
      });
    } catch (e) {
      // A channel that rejects rather than reporting is still a failed session.
      outcome = { reason: 'error', detail: String(e) };
    }
    const sessionMs = now() - sessionStart;

    // Three ways to be healthy, and only three. A clean end after a real
    // session, or a clean end that actually delivered work, is a working
    // stream. A clean end that happened instantly and delivered nothing is
    // what a revoked credential, a degraded Spectrum, or a dead network looks
    // like from in here, and calling it healthy is what made the failure
    // ceiling below dead code and let the loop spin with zero sleep.
    // Silence itself is never the failure signal: a quiet night with a live
    // stream lasts hours and passes the duration test.
    const sessionOk = outcome.reason === 'ended' && (sessionMs >= minHealthySessionMs || repliesDelivered > 0);
    if (!sessionOk) {
      log(
        `listen: unhealthy session (reason ${outcome.reason}, ${sessionMs}ms, ${repliesDelivered} reply(ies))` +
          (outcome.detail ? `: ${outcome.detail}` : ''),
      );
    }
```

The failure accounting below it stays as written, and its `await sleep(backoffMs(consecutiveFailures))` is unchanged (the smallest backoff, 5000ms, already exceeds the floor).

Finally, add the pace at the very end of the loop body, after the channel close block:

```typescript
    // The floor. Every path that reaches the end of a cycle passes through
    // here, and the only path that does not (the connect failure `continue`
    // above) has already slept a backoff of at least 5000ms. So no sequence of
    // events can make this loop call connect() twice within a second.
    const elapsed = now() - cycleStart;
    if (elapsed < minCycleIntervalMs) await sleep(minCycleIntervalMs - elapsed);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/listen.test.ts && npm run typecheck`
Expected: all passed, typecheck clean. If the hot-spin test reports `slept` of length 40 rather than 20, the failure path is sleeping twice: the backoff already advanced virtual time past the floor, so check that `cycleStart` is captured before the backoff and not after.

- [ ] **Step 5: Prove the test catches the defect it exists for**

Temporarily change `sessionOk` in `outreach/src/pipeline/listen.ts` back to the old inference (`const sessionOk = true;`) and delete the floor pace block.

Run: `cd outreach && npx vitest run test/listen.test.ts`
Expected: FAIL, specifically "sleeps on every cycle and escalates when the stream ends immediately" with `slept` of length 0, and "exits for a supervisor restart after a ceiling of stream failures" hanging or failing on `exit` never being called. A guard whose test does not fail when the guard is removed is not a guard. Then revert both temporary edits and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add outreach/src/pipeline/listen.ts outreach/test/listen.test.ts
git commit -m "Make the listener failure ceiling reachable and floor every reconnect cycle"
```

---

### Task 4: The allowlist gets a construction invariant and a loud misconfiguration signal (D3, D4)

**Files:**
- Modify: `outreach/src/approval/photonChannel.ts`
- Test: `outreach/test/photonChannel.test.ts`

**Interfaces:**
- Produces: `assertApproverPhone(phone: string): void`, exported for direct test.
- `createPhotonChannel` throws before calling `connect` when `approverPhone` is not exact E.164.

- [ ] **Step 1: Write the failing tests**

Append to `outreach/test/photonChannel.test.ts`:

```typescript
describe('createPhotonChannel approver invariant', () => {
  // The allowlist is the single control that stops a possibly shared iMessage
  // line from being an open reflector, and the comparison is a bare !==. An
  // empty approverPhone would accept any message whose sender.id is also
  // empty. photonOptionsFromEnv rejects empty env values, but the factory
  // accepts any PhotonOptions, so the invariant belongs at construction.
  it('refuses to construct with an empty approver phone, and never connects', async () => {
    const connect = vi.fn();
    await expect(
      createPhotonChannel({ projectId: 'p', projectSecret: 's', approverPhone: '' }, connect),
    ).rejects.toThrow(/E\.164/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses formats the provider never emits, so a misconfiguration fails at boot', async () => {
    const connect = vi.fn();
    for (const bad of ['15555550123', '(555) 555-0123', '+1 555 555 0123', '  +15555550123  ', '+0555555012']) {
      await expect(
        createPhotonChannel({ projectId: 'p', projectSecret: 's', approverPhone: bad }, connect),
      ).rejects.toThrow(/E\.164/);
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('accepts the exact format the provider was observed to emit', () => {
    expect(() => assertApproverPhone('+15555550123')).not.toThrow();
  });

  it('does not put the configured number in the error text', async () => {
    await expect(
      createPhotonChannel({ projectId: 'p', projectSecret: 's', approverPhone: '5555550123' }, vi.fn()),
    ).rejects.toThrow(expect.not.stringContaining('5555550123'));
  });
});

describe('createPhotonChannel allowlist diagnostics', () => {
  // The all-quiet failure this exists for: if APPROVER_PHONE ever diverges in
  // format from what the provider emits, every approval is silently ignored
  // and the symptom is indistinguishable from Aditya not replying. That class
  // of failure has already cost this project a lost approval and required
  // attaching a separate diagnostic listener to diagnose.
  it('warns specifically when a rejected sender differs only by formatting', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });
    try {
      const { channel, dmSend } = await channelFor([
        { id: 'm1', sender: { id: '15555550123' }, content: { type: 'text', text: 'd7 y' } },
      ]);
      const replies = await channel.captureReplies(50);
      expect(replies).toEqual([]); // still rejected: the diagnostic never authorizes
      expect(dmSend).not.toHaveBeenCalled(); // and never answers a rejected sender
    } finally {
      spy.mockRestore();
    }
    expect(warns.some((w) => w.includes('APPROVER_PHONE is misconfigured'))).toBe(true);
    for (const w of warns) expect(w).not.toContain('15555550123');
  });

  it('does not warn about misconfiguration for an unrelated stranger', async () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });
    try {
      const { channel, dmSend } = await channelFor([
        { id: 'm1', sender: { id: '+15555550199' }, content: { type: 'text', text: 'd7 y' } },
      ]);
      expect(await channel.captureReplies(50)).toEqual([]);
      expect(dmSend).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(warns.some((w) => w.includes('APPROVER_PHONE is misconfigured'))).toBe(false);
  });
});
```

Add `assertApproverPhone` to the import at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd outreach && npx vitest run test/photonChannel.test.ts`
Expected: FAIL, `createPhotonChannel` resolves instead of rejecting, and no misconfiguration warning is emitted.

- [ ] **Step 3: Implement the invariant and the diagnostic**

In `outreach/src/approval/photonChannel.ts`, above `decodeReply`:

```typescript
// Exact E.164. This is the format the provider was verified to emit
// (sender: {"id":"+15555550123","address":"+15555550123","country":"US",
// "service":"iMessage"}, observed live) and the allowlist compares exactly, so
// a value in any other format could never match anything: every approval would
// be ignored in silence, which is indistinguishable from nobody replying.
const E164 = /^\+[1-9]\d{7,14}$/;

// The single control preventing a possibly shared iMessage line from becoming
// an open reflector deserves a hard invariant rather than a bare !== against
// whatever a caller passed. Under launchd KeepAlive a throw here produces a
// crash looping job with a named error in listen.err.log, which is loud. The
// alternative is a healthy looking daemon that ignores every approval, which
// is silent, and silence is the failure mode this whole plan exists to remove.
// The configured number is deliberately not interpolated into the message:
// launchd logs are shared and the number adds nothing a reader needs.
export function assertApproverPhone(phone: string): void {
  if (!E164.test(phone)) {
    throw new Error(
      'createPhotonChannel: approverPhone must be an exact E.164 string (for example +15555550123). ' +
        'The iMessage provider emits sender.id in that format and the allowlist compares it exactly, ' +
        'so any other format would silently ignore every approval reply.',
    );
  }
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}
```

Replace the allowlist branch of `decodeReply` (lines 75 to 78) with:

```typescript
  const senderId = message.sender?.id;
  if (senderId !== approverPhone) {
    // Normalize for DIAGNOSIS, never for authorization. Nothing reachable from
    // this comparison can accept a message: both branches return null. Digit
    // equality with a formatting difference means APPROVER_PHONE no longer
    // matches what the provider emits, which is the exact all-quiet failure
    // that once cost a lost approval, so it is named rather than logged as
    // just another stranger. No number and no message text is ever logged:
    // on a possibly shared line both are attacker controlled content.
    if (typeof senderId === 'string' && senderId !== '' && digitsOnly(senderId) === digitsOnly(approverPhone)) {
      console.warn(
        'photonChannel: inbound sender matches the approver only after stripping formatting. ' +
          'APPROVER_PHONE is misconfigured: it must be the exact E.164 string the provider sends. ' +
          'Ignoring this message.',
      );
    } else {
      console.log('photonChannel: inbound message from a non-approver, ignoring');
    }
    return null;
  }
```

And assert at construction, as the first statement of `createPhotonChannel`, before `connect` is called:

```typescript
export async function createPhotonChannel(
  opts: PhotonOptions,
  connect: PhotonConnectFn = defaultConnect,
): Promise<ApprovalChannel> {
  assertApproverPhone(opts.approverPhone);
  const { app, dm } = await connect(opts);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/photonChannel.test.ts && npm run typecheck`
Expected: all passed, typecheck clean.

- [ ] **Step 5: Prove the allowlist tests are real safety tests**

Temporarily invert the comparison in `decodeReply` (`if (senderId === approverPhone)`).

Run: `cd outreach && npx vitest run test/photonChannel.test.ts`
Expected: FAIL on "ignores a message from a non-approver and never reflects a reply to them" and on both diagnostics tests. Revert and re-run to green.

- [ ] **Step 6: Verify the live configuration would pass the new invariant**

Run: `cd outreach && node -e "const v=process.env.APPROVER_PHONE??'';console.log(JSON.stringify(v), /^\+[1-9]\d{7,14}$/.test(v))" --env-file=.env`
Expected: the configured value and `true`. **If this prints `false`, stop.** Deploying Task 8 would crash loop the live daemon. Fix `.env` first and report it, since a `false` here means the current daemon has been ignoring approvals.

- [ ] **Step 7: Commit**

```bash
git add outreach/src/approval/photonChannel.ts outreach/test/photonChannel.test.ts
git commit -m "Assert an exact E.164 approver at channel construction and name a format mismatch loudly"
```

---

### Task 5: `captureReplies` can no longer consume and drop a reply (D2)

**Files:**
- Modify: `outreach/src/approval/photonChannel.ts`
- Test: `outreach/test/photonChannel.test.ts`

**Interfaces:** no signature change. `captureReplies(windowMs)` still returns `Promise<InboundReply[]>`. The iterator and its in-flight `next()` move from call scope to channel scope.

**Context:** today each call builds a fresh iterator, and when the deadline plus the 500ms grace both expire with a `next()` still in flight, that promise is abandoned. A message settling afterwards has been pulled off the iterator and is then discarded, and `iterator.return()` is never called, so the iterator is abandoned rather than closed. The fix is not a longer grace, it is to stop throwing away the in-flight promise: hold it on the channel so the next call simply sees it first.

Note for the reader: the listener never calls `captureReplies` (pinned by the existing "consumes replies via streamReplies and never calls the batch window API" test), so the shared iterator is used by one path at a time.

- [ ] **Step 1: Write the failing tests**

Append to `outreach/test/photonChannel.test.ts`:

```typescript
// A fake app whose stream is driven by the test rather than by an array, so a
// message can be made to arrive at a chosen moment relative to the window.
function controllableApp() {
  const queued: Array<[unknown, RawMessage]> = [];
  let waiting: ((r: IteratorResult<[unknown, RawMessage]>) => void) | undefined;
  let returnCalls = 0;
  let stopped = false;
  const iterator: AsyncIterator<[unknown, RawMessage]> = {
    next() {
      const head = queued.shift();
      if (head !== undefined) return Promise.resolve({ value: head, done: false });
      return new Promise<IteratorResult<[unknown, RawMessage]>>((resolve) => {
        waiting = resolve;
      });
    },
    async return() {
      returnCalls++;
      return { value: undefined, done: true };
    },
  };
  const app: PhotonApp = {
    messages: { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<[unknown, RawMessage]>,
    async stop() {
      stopped = true;
    },
  };
  return {
    app,
    deliver(m: RawMessage) {
      const value: [unknown, RawMessage] = [{ id: 'space-1' }, m];
      if (waiting) {
        const w = waiting;
        waiting = undefined;
        w({ value, done: false });
      } else {
        queued.push(value);
      }
    },
    returnCalls: () => returnCalls,
    stopped: () => stopped,
  };
}

describe('createPhotonChannel captureReplies does not drop a reply', () => {
  // The defect: when the deadline won with a next() in flight, the 500ms grace
  // covered the common case, but a message settling after the grace had been
  // pulled off the iterator and was then discarded. The reply was consumed and
  // lost, and an approval that is consumed and lost looks exactly like an
  // approval that was never sent.
  it('carries an in-flight message to the next call instead of discarding it', async () => {
    const fake = controllableApp();
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: fake.app, dm: { send: vi.fn().mockResolvedValue(undefined) } }),
    );

    // Window and grace both expire with nothing delivered.
    expect(await channel.captureReplies(30)).toEqual([]);

    // The message settles well after the grace period is over.
    fake.deliver({ id: 'm-late', sender: { id: APPROVER }, content: { type: 'text', text: 'd7 y' } });

    // The next call sees it. Before the fix, this returned [].
    expect(await channel.captureReplies(30)).toEqual([{ text: 'd7 y', messageId: 'm-late' }]);
  });

  it('applies the identical allowlist to a carried-over message', async () => {
    const fake = controllableApp();
    const dmSend = vi.fn().mockResolvedValue(undefined);
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: fake.app, dm: { send: dmSend } }),
    );

    expect(await channel.captureReplies(30)).toEqual([]);
    fake.deliver({ id: 'm-late', sender: { id: '+15555550199' }, content: { type: 'text', text: 'd7 y' } });
    expect(await channel.captureReplies(30)).toEqual([]);
    expect(dmSend).not.toHaveBeenCalled(); // a stranger gets nothing back, ever
  });

  it('closes the iterator rather than abandoning it, and still stops the app', async () => {
    const fake = controllableApp();
    const channel = await createPhotonChannel(
      { projectId: 'p', projectSecret: 's', approverPhone: APPROVER },
      async () => ({ app: fake.app, dm: { send: vi.fn().mockResolvedValue(undefined) } }),
    );
    await channel.captureReplies(30);
    await channel.close?.();
    expect(fake.returnCalls()).toBe(1);
    expect(fake.stopped()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd outreach && npx vitest run test/photonChannel.test.ts`
Expected: FAIL. The carryover test returns `[]` on the second call (the message was consumed and dropped), and `returnCalls()` is 0.

- [ ] **Step 3: Move the iterator and the pending promise to channel scope**

In `outreach/src/approval/photonChannel.ts`, inside `createPhotonChannel` and above the returned object literal:

```typescript
  // The iterator and any in-flight next() live for the channel's lifetime, not
  // for one captureReplies call. A per-call iterator abandons its in-flight
  // next() when the window closes, and the message that promise later delivers
  // has already been pulled off the stream, so it is consumed and lost. An
  // approval consumed and lost is indistinguishable from one never sent, which
  // is the failure this codebase keeps paying for. Holding both here means an
  // unconsumed message is simply the first thing the next call sees.
  let iterator: AsyncIterator<[unknown, RawMessage]> | undefined;
  let pending: Promise<IteratorResult<[unknown, RawMessage]>> | undefined;

  const nextMessage = (): Promise<IteratorResult<[unknown, RawMessage]>> => {
    if (!iterator) iterator = app.messages[Symbol.asyncIterator]();
    if (!pending) {
      const p = iterator.next();
      // A promise that loses the race and is never awaited again would surface
      // as an unhandled rejection and take the process down. One handler is
      // attached here at creation; the value is still delivered to whoever
      // awaits `pending` later.
      p.catch(() => {});
      pending = p;
    }
    return pending;
  };
```

Rewrite `captureReplies` to use it:

```typescript
    async captureReplies(windowMs: number): Promise<InboundReply[]> {
      const out: InboundReply[] = [];
      const deadline = Date.now() + windowMs;
      const acceptIfAllowed = (value: [unknown, RawMessage]) => {
        const reply = decodeReply(value, opts.approverPhone);
        if (reply) out.push(reply);
      };

      try {
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          const inFlight = nextMessage();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const next = await Promise.race([
            inFlight,
            new Promise<null>((r) => {
              timer = setTimeout(() => r(null), remaining);
            }),
          ]);
          clearTimeout(timer);
          if (next === null) break; // timeout won; `pending` stays for the grace check
          pending = undefined;
          if (next.done) break;
          acceptIfAllowed(next.value);
        }

        // The timeout won with a next() still in flight. Give it a short grace
        // period: a reply that arrived just as the window closed should still
        // be drained now rather than waiting for the next run. If grace also
        // expires, `pending` is deliberately LEFT SET, so the message is not
        // consumed and dropped, it is the first thing the next call sees.
        if (pending) {
          const graceMs = 500;
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            pending,
            new Promise<null>((r) => {
              graceTimer = setTimeout(() => r(null), graceMs);
            }),
          ]);
          clearTimeout(graceTimer);
          if (settled !== null) {
            pending = undefined;
            if (!settled.done) acceptIfAllowed(settled.value);
          }
        }
      } catch (err) {
        // The stream itself failed. The iterator is dead, so drop it and let
        // the next call build a fresh one, and return what was collected
        // rather than throwing out of an unattended scheduled run.
        pending = undefined;
        iterator = undefined;
        console.warn(`captureReplies: message stream error, returning ${out.length} reply(ies) collected so far: ${String(err)}`);
      }
      return out;
    },
```

And close the iterator on shutdown:

```typescript
    async close() {
      // Tell the transport we are done reading rather than abandoning the
      // iterator. Best effort: a return() that throws must not stop app.stop().
      try {
        await iterator?.return?.();
      } catch (err) {
        console.warn(`photonChannel: iterator close failed, stopping the app anyway: ${String(err)}`);
      }
      iterator = undefined;
      pending = undefined;
      await app.stop();
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/photonChannel.test.ts && npm run typecheck`
Expected: all passed, typecheck clean. Note `noUncheckedIndexedAccess`: `next.value` is typed by the iterator generic, so no index read is introduced. If typecheck complains that `app.messages[Symbol.asyncIterator]()` yields the wrong type, widen the local annotation to match `PhotonApp['messages']` rather than adding a cast.

- [ ] **Step 5: Commit**

```bash
git add outreach/src/approval/photonChannel.ts outreach/test/photonChannel.test.ts
git commit -m "Hold the inbound iterator for the channel lifetime so a boundary reply is never dropped"
```

---

### Task 6: The listener stops fabricating a run report (D6)

**Files:**
- Modify: `outreach/src/pipeline/listen.ts`
- Test: `outreach/test/listen.test.ts`

**Context:** verified by reading `src/pipeline/loop.ts` lines 94 to 170: `handleReply` touches exactly one field of the `LoopSummary` it is handed, `summary.sent++` at line 163. It reads none of the other ten. `freshSummary()` in `listen.ts` zeroes `dryRun`, `seen`, `filtered`, `unsendable`, `messaged`, `queued`, `resumed`, `retryable`, `stranded`, and `errors`, none of which describe anything a listener does.

**Why not change `handleReply`'s signature to take the narrow type:** that is `loop.ts`, which another plan owns. **Why not a cast:** a cast is how the `close?.()` versus `stop()` bug survived review in this codebase, and banning casts at boundaries is an established rule here. So the fabrication is replaced with a named, documented, single-purpose object plus a test that proves it is inert and that will fail the moment it stops being inert.

- [ ] **Step 1: Write the failing test**

Append to `outreach/test/listen.test.ts`:

```typescript
describe('listener summary honesty', () => {
  // The listener has to hand handleReply a LoopSummary because that is the
  // signature, but ten of its eleven fields describe a batch run that the
  // listener never performs. This probe pins the claim that only `sent` is
  // live. If handleReply ever starts reading or writing another field, this
  // fails here rather than the listener silently feeding it a fabricated zero.
  it('handleReply touches only the sent field of the summary it is given', async () => {
    const db = openDb(':memory:');
    const p = seedDraft(db);
    const touched = new Set<string>();
    const target: LoopSummary = {
      dryRun: false,
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
    };
    const probe = new Proxy(target, {
      get(t, k, r) {
        if (typeof k === 'string') touched.add(k);
        return Reflect.get(t, k, r);
      },
      set(t, k, v, r) {
        if (typeof k === 'string') touched.add(k);
        return Reflect.set(t, k, v, r);
      },
    });
    const { channel } = scriptedChannel([[]]);

    await handleReply(
      { db, channel, sender: { send: vi.fn().mockResolvedValue({ sentId: 'msg-1' }) }, senderEmail: 'a@b.c' },
      { dryRun: false },
      probe,
      { text: `${p.shortId} y`, messageId: 'm1' },
    );

    expect([...touched]).toEqual(['sent']);
    expect(target.sent).toBe(1);
  });

  it('logs a cumulative send count so the one live field is observable', async () => {
    const db = openDb(':memory:');
    const p = seedDraft(db);
    const { channel } = scriptedChannel([[{ text: `${p.shortId} y`, messageId: 'm1' }]]);
    const logs: string[] = [];

    await runListenLoop({
      connect: async () => channel,
      db,
      sender: { send: vi.fn().mockResolvedValue({ sentId: 'msg-1' }) },
      sleep: noopSleep,
      exit: () => {},
      log: (m) => logs.push(m),
      maxCycles: 1,
    });

    expect(logs.some((l) => l.includes('sends this process: 1'))).toBe(true);
  });
});
```

Add `handleReply` and the `LoopSummary` type to the imports of `test/listen.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd outreach && npx vitest run test/listen.test.ts`
Expected: FAIL on the cumulative-count log. The probe test may pass immediately, which is fine and is the point: it is a pin, and its value is that it fails when the claim stops being true.

- [ ] **Step 3: Replace `freshSummary` with a named counter**

In `outreach/src/pipeline/listen.ts`, replace `freshSummary()` (lines 47 to 61) with:

```typescript
// handleReply mutates exactly one field of the LoopSummary it is handed
// (summary.sent++, loop.ts:163) and reads none of the others. The listener
// runs no batch, so `seen`, `filtered`, `unsendable`, `messaged`, `queued`,
// `resumed`, `retryable`, and `stranded` describe nothing that happens here,
// and zeroing them produced an object that reads like a run report and is not
// one. The same reasoning produced the ReplyDeps split: the listener does not
// fabricate dependencies it does not use.
//
// The remaining fields exist only because handleReply's signature demands the
// whole type, and that signature belongs to loop.ts, which this change does
// not own. They are inert, and the "handleReply touches only the sent field"
// test in test/listen.test.ts is what keeps them inert.
function sendCounter(): LoopSummary {
  return {
    dryRun: false,
    sent: 0, // the only live field
    seen: 0,
    filtered: 0,
    unsendable: 0,
    messaged: 0,
    queued: 0,
    resumed: 0,
    retryable: 0,
    stranded: 0,
    errors: [],
  };
}
```

Replace `const summary = freshSummary();` with:

```typescript
  // Cumulative for the life of the process, not per cycle: a reconnect is not
  // a new day's work, and the count is what the log line below reports.
  const totalsAsSummary = sendCounter();
```

and inside the `streamReplies` handler, after the `handleReply` call returns, add the log:

```typescript
          log(`listen: reply handled, sends this process: ${totalsAsSummary.sent}`);
```

Place it inside the handler's `try` block, immediately after `await handleReply(...)`, so a failed reply logs the failure line instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/listen.test.ts && npm run typecheck`
Expected: all passed, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add outreach/src/pipeline/listen.ts outreach/test/listen.test.ts
git commit -m "Name the listener's summary for what it is and pin that only sent is live"
```

---

### Task 7: Whole-suite verification and a safety walk-through

**Files:** none modified. This task is evidence, not code.

- [ ] **Step 1: Full suite and typecheck**

Run: `cd outreach && npm test && npm run typecheck`
Expected: every test passes (331 pre-existing plus roughly 20 added by this plan), typecheck clean. Record the actual final count in the commit message of Task 8 rather than assuming it.

- [ ] **Step 2: Confirm no em dash entered any touched file**

Run: `cd outreach && grep -n $'\xe2\x80\x94' src/pipeline/listen.ts src/approval/photonChannel.ts src/approval/channel.ts test/listen.test.ts test/photonChannel.test.ts test/channel.test.ts; echo "exit $?"`

(The pattern is the UTF-8 byte escape for U+2014, written that way so this document does not itself contain the forbidden character.)
Expected: no matching lines, `exit 1` from grep (no matches). Any hit must be fixed before committing.

- [ ] **Step 3: Confirm no test can dial the network**

Run: `cd outreach && grep -n "spectrum-ts" test/*.ts; echo "exit $?"`
Expected: no matches. Every photon test supplies its own `PhotonConnectFn`, so `defaultConnect` is never reached.

- [ ] **Step 4: Walk the three safety invariants against the diff**

Run: `git diff main --stat && git diff main -- outreach/src`
Then confirm, in writing, each of the following against the diff before proceeding:

1. **The allowlist holds and a non-approver never receives any outbound reply.** `decodeReply` is still the single decode for both the batch and push paths. Both new branches of the sender check return `null`. No new call to `dm.send` was added anywhere. Pinned by: "ignores a message from a non-approver and never reflects a reply to them", "applies the identical allowlist to a carried-over message", both diagnostics tests.
2. **Ambiguity never resolves toward sending.** `parseReply` now returns `unparseable` for every id without a keyword, prefixed or not. No new path returns `approve`. Pinned by: "rejects a bare prefixed id as unparseable, not approval".
3. **Nothing sends without an explicit human approval.** No task in this plan adds a call to `deps.sender.send`, and the only route to a send remains `handleReply`, unchanged. Pinned by: the existing "does not send on an approver n reply" and "does not crash on an unknown draft id, and sends nothing" tests, still green and unweakened.

- [ ] **Step 5: Commit any stragglers**

```bash
git status --short
```
Expected: clean tree. If not, the previous tasks left something uncommitted; commit it with a message naming which task it belongs to.

---

### Task 8: Coordinated deployment to the live daemon

**Files:** none. This task is an operational procedure and it requires Aditya.

> **The implementer may not restart the daemon unilaterally.** `com.aditya.outreach-listen` is running now under launchd `KeepAlive`. A restart drops the iMessage stream, and Spectrum does not deliver messages to a client that was disconnected when they were sent, so any reply Aditya texts during the restart window is lost permanently and he would have no way to know. Ask, get an explicit go-ahead, and do the restart while he is at his phone.

- [ ] **Step 1: Establish the current state and show it**

```bash
launchctl list | grep outreach-listen
tail -20 /Users/apgupta/Documents/Coding/new/networks/outreach/data/listen.log
sqlite3 /Users/apgupta/Documents/Coding/new/networks/outreach/data/outreach.db \
  "select short_id, person_id from drafts where status = 'awaiting_approval' order by id"
```
Expected: a PID and exit code 0 for the job, recent log lines, and the list of draft ids that a reply could currently act on. Show all three to Aditya. The last one matters because after the restart those are the ids that a stray reply would name, and because Task 1 changed what a bare `d<id>` does.

- [ ] **Step 2: Confirm no reply is in flight**

Read the last minute of `listen.log`. If any inbound line appears within the last 60 seconds, wait until the log is quiet for a full minute before continuing. Restarting mid-reply loses that reply.

- [ ] **Step 3: Get explicit approval to restart**

Tell Aditya, in these terms: the new code is committed but the running daemon is still on the old code (it runs from source via `tsx` and only picks up changes on restart, which is why nothing has changed for him yet); the restart takes a few seconds; any text he sends during it is lost for good, so he should not text until the confirmation arrives; and after the restart a bare `d7` no longer approves, it needs `d7 y`. Wait for his go-ahead. Do not proceed on inference.

- [ ] **Step 4: Restart**

```bash
launchctl kickstart -k gui/$(id -u)/com.aditya.outreach-listen
```
`kickstart -k` is the verified-permitted form here; `launchctl unload` has previously been blocked by the permission classifier. If `kickstart` is refused, stop and report it rather than reaching for a broader command.

- [ ] **Step 5: Verify the daemon came back**

```bash
sleep 15; launchctl list | grep outreach-listen
tail -20 /Users/apgupta/Documents/Coding/new/networks/outreach/data/listen.log
tail -20 /Users/apgupta/Documents/Coding/new/networks/outreach/data/listen.err.log
```
Expected: a **new** PID with exit code 0, a `listen: channel connected` line with a fresh timestamp, and no `approverPhone must be an exact E.164` error. A crash loop here means Task 4 Step 6 was skipped or `.env` diverges from the repo: fix `APPROVER_PHONE` and kickstart again. Show the actual log lines to Aditya rather than reporting success in prose.

- [ ] **Step 6: Prove the inbound path end to end without sending anything**

Ask Aditya to confirm he received the startup notice, then to text exactly `d999 y`.

Expected: he receives `No draft found for d999. Ignoring that reply.` That single exchange exercises the whole repaired path (stream delivery, the allowlist, `decodeReply`, `parseReply`, `handleReply`, the outbound reply) and **sends no email**, because `d999` names no draft.

Then ask him to text exactly `d999`, with no keyword.

Expected: he receives `Could not read "d999". Reply like "d7 y" or "d7 n".` That is the D5 change visible on his phone. Before this plan, a bare id against a real draft would have sent an email.

Paste both received messages into the report. This is the verification-by-demonstration the project rules require: not "the daemon is fixed", but the actual text he got back.

- [ ] **Step 7: Watch for a cycle, then commit the record**

Leave the daemon alone for ten minutes and re-read `listen.log`. Expected: no reconnect churn. A healthy session produces no per-second reconnect lines; if `listen: unhealthy session` appears repeatedly with escalating waits, the stream is genuinely failing and the new backoff is doing its job, which is a real finding to report rather than a regression to hide.

```bash
git add -A
git commit -m "Record listener reliability deployment verification"
```

**Rollback:** `git revert` the range of commits from this plan, then `launchctl kickstart -k gui/$(id -u)/com.aditya.outreach-listen` again, with the same coordination as Step 3. The daemon runs from source, so a revert plus a kickstart is a complete rollback with no build step.

---

## Residual Risk

Named honestly, because none of these are fixed by this plan.

- **R1. The minimum healthy session is a heuristic.** A real stream that legitimately ends cleanly within 60 seconds having delivered nothing is counted as a failure, costing one backoff. The cost of the opposite error (calling an instant end healthy) is the hot spin this plan exists to remove, so the asymmetry is chosen deliberately. If `listen.log` shows `unhealthy session` for sessions that were genuinely fine, the threshold is the thing to revisit, not the classification.
- **R2. The floor sleep bounds the spin rate; it does not stop a broken stream.** A permanently broken stream now escalates to a 5 minute wait and then exits at the 30 failure ceiling for launchd to restart clean. It does not diagnose why. The `unhealthy session` line with its reason and duration is the diagnostic, and it is new.
- **R3. Carryover crosses window boundaries, not process boundaries.** Task 5 keeps an in-flight message inside the channel object. If the process dies with a message in flight, that message is still gone. Whether Spectrum redelivers to a fresh client is unverified for this case and is exactly the `spec-photon-channel-testing.md` R4 question, unchanged by this plan.
- **R4. Provider honesty.** Command authenticity rests entirely on Photon truthfully reporting `sender.id`. A compromised or buggy provider could report the approver's number for a message that did not come from it. No test and no invariant here can detect that. It is the AL12 residual trust assumption and it is unchanged.
- **R5. `sender.address` remains unread.** The decision to read only `sender.id` is argued above. If the provider ever stops populating `id` with E.164, every approval is rejected, and the new near-miss warning fires only when the digits still match. A wholly different identifier (an Apple ID email) would land in the ordinary non-approver log line. That is fail-closed, which is the correct direction, but it is still an outage that needs a human to read a log.
- **R6. `connect` is still defaulted in `createPhotonChannel`.** A future test that forgets to inject a fake would dial Photon for real. Making it required forces an edit to `src/cli.ts`, which this plan does not own. Follow-up, not done here.
