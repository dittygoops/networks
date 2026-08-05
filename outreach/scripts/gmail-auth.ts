// One-time Gmail OAuth consent: exchanges a browser sign-in for a refresh token
// you paste into .env. Run once per scope, then the sender (src/sender/gmail-api.ts)
// uses the send refresh token forever.
//
// Two scopes are supported:
//   --scope=gmail.send      (default) mints GMAIL_OAUTH_REFRESH_TOKEN, the send credential.
//   --scope=gmail.metadata  mints GMAIL_OAUTH_READ_REFRESH_TOKEN, a read-only credential
//                            used by the reply poller. It can never send.
// The printed variable name always matches the scope actually requested, so pasting
// the script's own output can never overwrite the send credential with a read-only one.
//
// Prereq: a Google Cloud OAuth 2.0 Client ID of type "Desktop app" (Gmail API
// enabled on the project, the relevant scope(s) enabled, your ASU account added as
// a test user on the consent screen). Put its id/secret in .env as
// GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET, then:
//   npx tsx --env-file=.env scripts/gmail-auth.ts
//   npx tsx --env-file=.env scripts/gmail-auth.ts --scope=gmail.metadata
import { createServer } from 'node:http';
import { google } from 'googleapis';

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET missing (run with --env-file=.env)');
}

// Default unchanged, so the documented invocation keeps working verbatim.
const SCOPES: Record<string, string> = {
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'gmail.metadata': 'https://www.googleapis.com/auth/gmail.metadata',
};
const requested = (process.argv.find((a) => a.startsWith('--scope='))?.split('=')[1]) ?? 'gmail.send';
const scope = SCOPES[requested];
if (!scope) throw new Error(`unknown scope ${requested}; expected one of ${Object.keys(SCOPES).join(', ')}`);
// A read scope must never be pasted over the send credential.
const envVar = requested === 'gmail.send' ? 'GMAIL_OAUTH_REFRESH_TOKEN' : 'GMAIL_OAUTH_READ_REFRESH_TOKEN';

const PORT = 4771;
const redirectUri = `http://localhost:${PORT}/oauth2callback`;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',        // ask for a refresh token
  prompt: 'consent',             // force it even if previously granted
  scope: [scope],
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err || !code) {
    res.writeHead(400).end(`auth failed: ${err ?? 'no code'}`);
    console.error(`auth failed: ${err ?? 'no code'}`);
    server.close();
    process.exit(1);
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Done. You can close this tab and return to the terminal.');
    if (!tokens.refresh_token) {
      console.error(
        'No refresh token returned. Re-run this script: prompt=consent is already set, which is what forces one. ' +
          'Do NOT revoke the app at myaccount.google.com/permissions: that revokes the OAuth client for the whole ' +
          'account and kills GMAIL_OAUTH_REFRESH_TOKEN with it, which is the only working send path (ASU Workspace ' +
          'blocks SMTP app passwords). If you revoke anyway, re-mint the send token first.',
      );
      server.close();
      process.exit(1);
    }
    console.log(`\nSuccess. Scope granted: ${scope}`);
    console.log(`Add this line to outreach/.env:\n`);
    console.log(`${envVar}=${tokens.refresh_token}\n`);
    if (envVar !== 'GMAIL_OAUTH_REFRESH_TOKEN') {
      console.log('Do NOT paste this over GMAIL_OAUTH_REFRESH_TOKEN. This token cannot send.\n');
    }
  } catch (e) {
    console.error('token exchange failed:', e instanceof Error ? e.message : e);
    res.writeHead(500).end('token exchange failed');
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log('Open this URL in the browser signed in as apgupta3@asu.edu:\n');
  console.log(authUrl + '\n');
  console.log(`Waiting for the redirect to ${redirectUri} ...`);
});
