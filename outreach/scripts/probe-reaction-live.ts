// Probe: does Photon Spectrum deliver iMessage tapbacks, and in what shape?
//
// ANSWERED 2026-08-03, live. Yes. A tapback arrives as a normal inbound
// message with content.type === 'reaction' and exactly three content keys:
//
//   { type: 'reaction',
//     emoji: '\u{1F44D}',
//     target: { id, content: { type: 'text', text: <the message reacted to> }, ... } }
//
// Three consequences, all load-bearing for reaction-based approval:
//   1. `emoji` distinguishes thumbs up from thumbs down, so both approve and
//      skip are expressible.
//   2. `target.id` names the message reacted to, so a 48-deep queue is not
//      ambiguous.
//   3. `target.content.text` carries the ORIGINAL TEXT, and draft messages
//      begin "d25: Name (email)", so the draft id can be parsed off the
//      reaction with no schema change and no in-memory map. That matters
//      because a map would not survive a daemon restart.
//
// decodeReply currently rejects these (it accepts only content.type 'text')
// and logs "unreadable content (type reaction), ignoring".
//
// EXPERIMENT DESIGN NOTE, learned the hard way: iMessage allows ONE tapback
// per person per message, so re-reacting to a message that already carries
// your reaction is a no-op and fires NOTHING. A probe must send a FRESH
// message and have the reaction be a state change, which is why this script
// sends and listens rather than just listening.
//
// a state CHANGE and therefore actually fires. (A message that already carries
// a reaction from this person is a no-op when re-reacted: iMessage allows one
// tapback per person per message.)
import { photonOptionsFromEnv } from '../src/approval/photonChannel.js';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';

const opts = photonOptionsFromEnv();
const app = await Spectrum({ projectId: opts.projectId, projectSecret: opts.projectSecret, platforms: [imessage.config()] });
const im = imessage(app);
const dm = await im.space.create(await im.user(opts.approverPhone));

const stamp = process.argv[2] ?? 'A';
const sent = await dm.send(`TAPBACK PROBE ${stamp}: react to THIS message with a thumbs up (one tap, nothing is sent).`);
console.log('SENT_MESSAGE_RAW:', JSON.stringify(sent));

const digits = opts.approverPhone.replace(/\D/g, '');
const redact = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'string' && x.replace(/\D/g, '') === digits ? '<approver>' : x)));

setTimeout(() => { console.log('TIMEOUT: no reaction observed'); app.stop().then(() => process.exit(0)); }, 150_000);
let n = 0;
for await (const value of (app as unknown as { messages: AsyncIterable<[unknown, unknown]> }).messages) {
  const [, m] = value as [unknown, Record<string, unknown>];
  console.log(`INBOUND #${++n}:`, JSON.stringify(redact(m)));
  if (n >= 2) break;
}
await app.stop();
process.exit(0);
