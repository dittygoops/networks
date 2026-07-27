// Real iMessage transport over Photon Spectrum. Mirrors the proven spike in
// scripts/spike-photon.ts, including the sender allowlist (AL3): a shared
// service line can receive strangers' texts, and reacting to them would make
// this an open reflector.
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';
import type { ApprovalChannel, InboundReply, OutboundDraftMessage } from './channel.js';

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

export async function createPhotonChannel(opts: PhotonOptions): Promise<ApprovalChannel> {
  const app = await Spectrum({
    projectId: opts.projectId,
    projectSecret: opts.projectSecret,
    platforms: [imessage.config()],
  });
  const im = imessage(app);
  const approver = await im.user(opts.approverPhone);
  const dm = await im.space.create(approver);

  return {
    async sendDraftMessage(msg) {
      await dm.send(formatDraftMessage(msg));
    },
    async notify(text) {
      await dm.send(text);
    },
    // Drains inbound for a bounded window, then returns. The loop is a batch
    // job: replies that arrive later are picked up by the next run.
    async captureReplies(windowMs: number): Promise<InboundReply[]> {
      const out: InboundReply[] = [];
      const deadline = Date.now() + windowMs;
      const iterator = app.messages[Symbol.asyncIterator]();
      type RawMessage = { id: string; sender?: { id?: string }; content?: { type?: string; text?: string } };
      const acceptIfAllowed = (value: [unknown, RawMessage]) => {
        const [, message] = value;
        if (message.sender?.id !== opts.approverPhone) return; // allowlist
        if (message.content?.type !== 'text' || !message.content.text) return;
        out.push({ text: message.content.text, messageId: message.id });
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
    async close() {
      await app.stop();
    },
  };
}
