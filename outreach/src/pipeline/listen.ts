// Persistent approval listener: `outreach listen` (R1-R5 of the listener
// spec). The batch loop (src/pipeline/loop.ts) only holds a Spectrum
// connection open for ~20 seconds a day; a proven production failure showed
// Spectrum does not deliver messages to a client that was disconnected when
// they were sent, so approvals sent while the batch is not connected are
// lost. This module stays connected and reacts to replies as they arrive.
//
// Modeled on the resilient reconnect loop in
// /Users/apgupta/Documents/Coding/new/daily-prompts/src/channel/spectrum.ts
// (readLoop): re-iterating a dead stream on the same client reconnects
// nothing, so on stream end or error the channel is closed and a fresh one
// is built via connect(), with escalating capped backoff, and a ceiling of
// consecutive failures exits the process so a supervisor (launchd) restarts
// it clean.
import type { ApprovalChannel, InboundReply, StreamOutcome } from '../approval/channel.js';
import type { DB } from '../db/db.js';
import type { Sender } from '../sender/types.js';
import { handleReply } from './loop.js';
import type { LoopSummary, ReplyDeps } from './loop.js';

export interface ListenDeps {
  connect: () => Promise<ApprovalChannel>;
  db: DB;
  sender: Sender;
  senderEmail?: string;
  // Sent once, right after the first successful connect, e.g. to warn Aditya
  // that email sending is broken (R5) without ever blocking the receive side.
  startupNotice?: string;
  maxConsecutiveFailures?: number;
  backoffMs?: (failures: number) => number;
  sleep?: (ms: number) => Promise<void>;
  // Injected so tests can drive virtual time and assert on elapsed wall clock
  // rather than on call counts. A call-count assertion cannot catch a hot spin.
  now?: () => number;
  // A stream that ends cleanly within this window without delivering anything
  // did not have a healthy session, it failed to establish one. See below.
  minHealthySessionMs?: number;
  // Hard floor on how fast the loop may reconnect, whatever else happens.
  minCycleIntervalMs?: number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  // Test-only escape hatch: stop after this many cycles instead of running
  // forever, so tests can assert on behavior without mocking an infinite loop.
  maxCycles?: number;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 30;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
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

function defaultBackoffMs(failures: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

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
    wouldMessage: 0,
    resumed: 0,
    retryable: 0,
    stranded: 0,
    errors: [],
  };
}

export async function runListenLoop(deps: ListenDeps): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const backoffMs = deps.backoffMs ?? defaultBackoffMs;
  const maxFailures = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const now = deps.now ?? (() => Date.now());
  const minHealthySessionMs = deps.minHealthySessionMs ?? MIN_HEALTHY_SESSION_MS;
  const minCycleIntervalMs = deps.minCycleIntervalMs ?? MIN_CYCLE_INTERVAL_MS;

  // The reply-handling deps are rebuilt each cycle with whatever channel is
  // currently live; db/sender/senderEmail never change across reconnects.
  const replyDepsFor = (channel: ApprovalChannel): ReplyDeps => ({
    db: deps.db,
    channel,
    sender: deps.sender,
    senderEmail: deps.senderEmail,
  });

  // Cumulative for the life of the process, not per cycle: a reconnect is not
  // a new day's work, and the count is what the log line below reports.
  const totalsAsSummary = sendCounter();
  let channel: ApprovalChannel | undefined;
  let consecutiveFailures = 0;
  let cycles = 0;
  let notifiedStartup = false;

  for (;;) {
    if (deps.maxCycles !== undefined && cycles >= deps.maxCycles) {
      try {
        await channel?.close?.();
      } catch {
        // Best effort on the way out; a close failure here must not mask
        // whatever the test/caller is asserting.
      }
      return;
    }
    cycles++;
    const cycleStart = now();

    if (!channel) {
      try {
        channel = await deps.connect();
        log('listen: channel connected');
      } catch (e) {
        consecutiveFailures++;
        log(`listen: connect failed (${consecutiveFailures} consecutive failure(s)): ${String(e)}`);
        if (consecutiveFailures >= maxFailures) {
          log(`listen: ${consecutiveFailures} consecutive failures, exiting for supervisor restart`);
          exit(1);
          return;
        }
        await sleep(backoffMs(consecutiveFailures));
        continue;
      }
      if (deps.startupNotice && !notifiedStartup) {
        notifiedStartup = true;
        try {
          await channel.notify(deps.startupNotice);
        } catch (e) {
          log(`listen: startup notice failed: ${String(e)}`);
        }
      }
    }

    // Push, not batch. captureReplies only returns when its window expires,
    // so a daemon using it would hold a real approval in memory unprocessed
    // (observed: an accepted "d8 y" sat unhandled behind a 24 day window).
    // streamReplies hands each reply over as it arrives and resolves only
    // when the stream ends, which is the signal to rebuild the client.
    const liveChannel = channel;
    let repliesDelivered = 0;
    let outcome: StreamOutcome;
    const sessionStart = now();
    try {
      outcome = await channel.streamReplies(async (reply) => {
        repliesDelivered++;
        try {
          await handleReply(replyDepsFor(liveChannel), { dryRun: false }, totalsAsSummary, reply);
          log(`listen: reply handled, sends this process: ${totalsAsSummary.sent}`);
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

    // A session that ran cleanly counts as healthy even if it delivered no
    // replies: a quiet night is the normal case for a listener, and treating
    // silence as failure would burn the retry budget and exit for no reason.
    if (sessionOk) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= maxFailures) {
        log(`listen: ${consecutiveFailures} consecutive stream failures, exiting for supervisor restart`);
        exit(1);
        return;
      }
      await sleep(backoffMs(consecutiveFailures));
    }

    // The session that just returned (whether it delivered replies, errored,
    // or ended cleanly) is over. Re-iterating a dead stream on the same
    // client reconnects nothing, so close it and rebuild fresh next cycle
    // rather than looping back into channel.streamReplies on this one.
    const finishedChannel = channel;
    channel = undefined;
    try {
      await finishedChannel.close?.();
    } catch (e) {
      log(`listen: channel close during reconnect failed: ${String(e)}`);
    }

    // The floor. Every path that reaches the end of a cycle passes through
    // here, and the only path that does not (the connect failure `continue`
    // above) has already slept a backoff of at least 5000ms. So no sequence of
    // events can make this loop call connect() twice within a second.
    const elapsed = now() - cycleStart;
    if (elapsed < minCycleIntervalMs) await sleep(minCycleIntervalMs - elapsed);
  }
}
