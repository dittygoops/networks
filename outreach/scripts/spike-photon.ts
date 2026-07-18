// F5 Step 1 spike (spec AL1/Open Question 2): prove send, receive, sender identity,
// and (separately, by killing/restarting this script) replay-after-disconnect.
// Usage: npx tsx --env-file=.env scripts/spike-photon.ts [--listen-only]
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';

const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
const approverPhone = process.env.APPROVER_PHONE;
if (!projectId || !projectSecret || !approverPhone) {
  throw new Error('SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET / APPROVER_PHONE missing (run with --env-file=.env)');
}

const ts = () => new Date().toISOString();
const skipSend = process.argv.includes('--listen-only');

const app = await Spectrum({
  projectId,
  projectSecret,
  platforms: [imessage.config()],
});
console.log(`[${ts()}] connected`);

if (!skipSend) {
  const im = imessage(app);
  const aditya = await im.user(approverPhone);
  const dm = await im.space.create(aditya);
  const sent = await dm.send(`outreach spike ${ts()}: reply anything to test inbound`);
  console.log(`[${ts()}] outbound sent`, JSON.stringify(sent, null, 2));
}

console.log(`[${ts()}] listening for inbound (ctrl-c to stop; use --listen-only after a kill to test replay)`);
for await (const [space, message] of app.messages) {
  // Same allowlist the real adapter will enforce (spec AL3): never react to any
  // sender but Aditya. Shared/service lines can receive strangers' texts, and an
  // unconditional ack is an open reflector plus a potential bot-to-bot loop.
  if (message.sender?.id !== approverPhone) {
    console.log(`[${ts()}] ignored message from ${JSON.stringify(message.sender?.id ?? null)}`);
    continue;
  }
  console.log(`[${ts()}] inbound:`);
  console.log('  message id:', message.id);            // dedup key (spec AL4 channel_inbound)
  console.log('  timestamp:', message.timestamp);      // distinguishes replay from redelivery
  console.log('  sender:', JSON.stringify(message.sender));
  console.log('  content:', JSON.stringify(message.content));
  console.log('  space id:', (space as { id?: string }).id);
  if (message.content?.type === 'text') {
    await space.send(`ack: got "${message.content.text}" at ${ts()}`);
    console.log(`[${ts()}] ack sent`);
  }
}
