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

export type RawMessage = { id: string; sender?: { id?: string }; content?: { type?: string; text?: string } };

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
      const iterator = app.messages[Symbol.asyncIterator]();
      // R3: every inbound message must produce a log line, including ignored
      // ones, since the incident that motivated this listener was
      // undiagnosable without one. A non-approver's number or message text
      // is attacker-controlled content that may end up in a shared log, so
      // neither is ever logged, only the fact that it happened.
      const acceptIfAllowed = (value: [unknown, RawMessage]) => {
        const reply = decodeReply(value, opts.approverPhone);
        if (reply) out.push(reply);
      };

      // Holds the in-flight iterator.next() promise across loop iterations so
      // a message that arrives right as the timeout wins is not discarded:
      // only call iterator.next() when nothing is already pending.
      let pending: ReturnType<typeof iterator.next> | undefined;
      try {
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          if (!pending) pending = iterator.next();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const next = await Promise.race([
            pending,
            new Promise<null>((r) => { timer = setTimeout(() => r(null), remaining); }),
          ]);
          clearTimeout(timer);
          if (next === null) break; // timeout won; pending stays for the grace check below
          pending = undefined;
          if (next.done) break;
          acceptIfAllowed(next.value as [unknown, RawMessage]);
        }

        // The timeout won with a next() still in flight. Give it a short
        // grace period rather than discarding it: a reply that arrived just
        // as the window closed should still be drained, not lost silently.
        if (pending) {
          const graceMs = 500;
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            pending,
            new Promise<null>((r) => { graceTimer = setTimeout(() => r(null), graceMs); }),
          ]);
          clearTimeout(graceTimer);
          if (settled && !settled.done) {
            acceptIfAllowed(settled.value as [unknown, RawMessage]);
          }
        }
      } catch (err) {
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
      await app.stop();
    },
  };
}
