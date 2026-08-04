// Real iMessage transport over Photon Spectrum. Mirrors the proven spike in
// scripts/spike-photon.ts, including the sender allowlist (AL3): a shared
// service line can receive strangers' texts, and reacting to them would make
// this an open reflector.
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';
import type { ApprovalChannel, InboundReply, OutboundDraftMessage, StreamOutcome } from './channel.js';

export interface PhotonOptions {
  projectId: string;
  projectSecret: string;
  approverPhone: string;
}

export function photonOptionsFromEnv(): PhotonOptions {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  const approverPhone = process.env.APPROVER_PHONE;
  if (!projectId || !projectSecret || !approverPhone) {
    throw new Error('SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET / APPROVER_PHONE missing (use --env-file=.env)');
  }
  return { projectId, projectSecret, approverPhone };
}

export function formatDraftMessage(msg: OutboundDraftMessage): string {
  return [
    `${msg.shortId}: ${msg.personName} (${msg.to})`,
    `Subject: ${msg.subject}`,
    '',
    msg.body,
    '',
    `Reply "${msg.shortId} y" to send, "${msg.shortId} n" to skip.`,
  ].join('\n');
}

export type RawMessage = {
  id: string;
  sender?: { id?: string };
  content?: {
    type?: string;
    text?: string;
    // Present when type === 'reaction'. Verified live 2026-08-03: Spectrum
    // delivers an iMessage tapback as an ordinary inbound message whose
    // content carries exactly { type, emoji, target }, where target is the
    // full message that was reacted to.
    emoji?: string;
    target?: { id?: string; content?: { type?: string; text?: string } };
  };
};

export interface PhotonApp {
  messages: AsyncIterable<[unknown, RawMessage]>;
  stop(): Promise<void>;
}

export interface PhotonDm {
  send(content: string): Promise<unknown>;
}

export type PhotonConnectFn = (opts: PhotonOptions) => Promise<{ app: PhotonApp; dm: PhotonDm }>;

// Real Spectrum connect. A separate function (rather than inline in
// createPhotonChannel) so tests can inject a fake and never open a real gRPC
// connection (R7), and so `outreach listen` can rebuild a fresh client after
// a stream failure by calling createPhotonChannel again instead of
// re-iterating a dead stream on the same client.
async function defaultConnect(opts: PhotonOptions): Promise<{ app: PhotonApp; dm: PhotonDm }> {
  const app = await Spectrum({
    projectId: opts.projectId,
    projectSecret: opts.projectSecret,
    platforms: [imessage.config()],
  });
  const im = imessage(app);
  const approver = await im.user(opts.approverPhone);
  const dm = await im.space.create(approver);
  return { app: app as unknown as PhotonApp, dm };
}


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

// --- Tapback approval -------------------------------------------------------
// Approving 48 drafts by typing "d25 y" each time is slow enough that it stops
// happening, and an unread queue is its own failure mode. A tapback is one tap.
//
// The translation is deliberately shallow: a reaction becomes the exact text
// command a human would have typed, and is then handed to the same decode and
// the same handleReply path. Nothing downstream learns that reactions exist, so
// every safety gate (the decision claim, the prior-thread check, the send
// refusal) is reached unchanged. This is the irreversible path: a thumbs up
// sends a real cold email to a named stranger.
const THUMBS_UP = '\u{1F44D}';
const THUMBS_DOWN = '\u{1F44E}';

// Phones send 👍 with a skin-tone modifier and often a variation selector or
// ZWJ. Comparing raw strings would silently ignore the default reaction on most
// handsets, which looks identical to "reactions don't work".
function baseEmoji(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, '');
}

// formatDraftMessage puts "d25: Name (email)" on the first line, so the draft a
// reaction refers to is recoverable from the reacted-to text itself. That beats
// storing an outbound-message-id map: the listener is a long-lived daemon that
// restarts on failure, and an in-memory map would silently lose every pending
// draft on restart while appearing to work.
function draftIdFromReactedText(text: string | undefined): string | null {
  const m = /^\s*(d\d+):/.exec(text ?? '');
  return m ? m[1]! : null;
}

// Returns the equivalent text command, or null if this reaction must be ignored.
function reactionToCommand(content: NonNullable<RawMessage['content']>): string | null {
  const shortId = draftIdFromReactedText(content.target?.content?.text);
  if (!shortId) {
    // Reacting to a status line ("d25 sent to ...") or to anything else is a
    // normal human thing to do and must never be read as an instruction.
    console.log('photonChannel: reaction on a non-draft message, ignoring');
    return null;
  }
  const emoji = baseEmoji(content.emoji ?? '');
  if (emoji === THUMBS_UP) return `${shortId} y`;
  if (emoji === THUMBS_DOWN) return `${shortId} n`;
  // iMessage also offers heart, laugh, emphasis and question. None of them mean
  // "send this to a stranger", and guessing at intent on the irreversible path
  // is exactly the wrong trade.
  console.log(`photonChannel: reaction on ${shortId} is not a thumbs up or down, ignoring`);
  return null;
}

// Single decode for both captureReplies (batch) and streamReplies (push), so
// the allowlist and the content check cannot drift between the two paths.
// Returns null for anything not actionable, always logging why: the incident
// that motivated the listener was undiagnosable because these were silent.
// A non-approver's number and message text are attacker-controlled content on
// a possibly shared line, so neither is ever logged.
function decodeReply(value: [unknown, RawMessage], approverPhone: string): InboundReply | null {
  const [, message] = value;
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
  // Reactions are translated into the text command a human would have typed,
  // then fall through to the identical downstream path. Placed after the sender
  // allowlist above, so a stranger cannot approve a draft by tapping one.
  if (message.content?.type === 'reaction') {
    const command = reactionToCommand(message.content);
    if (!command) return null;
    console.log(`photonChannel: reaction from approver accepted as "${command}" (id ${message.id})`);
    return { text: command, messageId: message.id };
  }
  if (message.content?.type !== 'text' || !message.content.text) {
    console.log(`photonChannel: inbound message from approver has unreadable content (type ${message.content?.type ?? 'unknown'}), ignoring`);
    return null;
  }
  console.log(`photonChannel: inbound message from approver accepted (id ${message.id})`);
  return { text: message.content.text, messageId: message.id };
}

export async function createPhotonChannel(
  opts: PhotonOptions,
  connect: PhotonConnectFn = defaultConnect,
): Promise<ApprovalChannel> {
  assertApproverPhone(opts.approverPhone);
  const { app, dm } = await connect(opts);

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

  return {
    async sendDraftMessage(msg) {
      await dm.send(formatDraftMessage(msg));
    },
    async notify(text) {
      await dm.send(text);
    },
    // Drains inbound for a bounded window, then returns. The batch loop uses
    // a short window (a run is a batch job: replies that arrive later are
    // picked up by the next run); `outreach listen` uses an effectively
    // unbounded window so a return means the stream itself ended or errored.
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

    // Push counterpart to captureReplies, for `outreach listen`. Same decode
    // and same allowlist (decodeReply below is the single implementation, so
    // the two paths cannot drift), but each accepted reply is handed to the
    // caller immediately instead of being held until a window expires.
    // Resolves when the stream ends or errors, which the caller treats as a
    // signal to rebuild the client.
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
  };
}
