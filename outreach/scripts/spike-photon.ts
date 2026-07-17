// F5 Step 1 spike (spec AL1/Open Question 2): prove send, receive, sender identity,
// and (separately, by killing/restarting this script) replay-after-disconnect.
// Run: npx tsx --env-file=.env scripts/spike-photon.ts
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';

const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
const approverPhone = process.env.APPROVER_PHONE;
if (!projectId || !projectSecret || !approverPhone) {
  console.error('missing SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET / APPROVER_PHONE in .env');
  process.exit(1);
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
  console.log(`[${ts()}] inbound:`);
  console.log('  sender:', JSON.stringify(message.sender));
  console.log('  content:', JSON.stringify(message.content));
  console.log('  message keys:', Object.keys(message).join(', '));
  console.log('  space id:', (space as { id?: string }).id);
  if (message.content?.type === 'text') {
    await space.send(`ack: got "${message.content.text}" at ${ts()}`);
    console.log(`[${ts()}] ack sent`);
  }
}
