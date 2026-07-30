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
import type { ApprovalChannel, InboundReply } from '../approval/channel.js';
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
  exit?: (code: number) => void;
  log?: (msg: string) => void;
  // Test-only escape hatch: stop after this many cycles instead of running
  // forever, so tests can assert on behavior without mocking an infinite loop.
  maxCycles?: number;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 30;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;

function defaultBackoffMs(failures: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
}

function freshSummary(): LoopSummary {
  return {
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
}

export async function runListenLoop(deps: ListenDeps): Promise<void> {
  const log = deps.log ?? ((msg: string) => console.error(msg));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const backoffMs = deps.backoffMs ?? defaultBackoffMs;
  const maxFailures = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;

  // The reply-handling deps are rebuilt each cycle with whatever channel is
  // currently live; db/sender/senderEmail never change across reconnects.
  const replyDepsFor = (channel: ApprovalChannel): ReplyDeps => ({
    db: deps.db,
    channel,
    sender: deps.sender,
    senderEmail: deps.senderEmail,
  });

  const summary = freshSummary();
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
    let sessionOk = true;
    try {
      await channel.streamReplies(async (reply) => {
        try {
          await handleReply(replyDepsFor(liveChannel), { dryRun: false }, summary, reply);
        } catch (e) {
          // One malformed or unlucky reply must never take the listener down.
          log(`listen: reply handling failed: ${String(e)}`);
        }
      });
    } catch (e) {
      sessionOk = false;
      log(`listen: streamReplies failed: ${String(e)}`);
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
  }
}
