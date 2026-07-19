// One-time Gmail OAuth consent: exchanges a browser sign-in for a refresh token
// you paste into .env as GMAIL_OAUTH_REFRESH_TOKEN. Run once, then the sender
// (src/sender/gmail-api.ts) uses the refresh token forever.
//
// Prereq: a Google Cloud OAuth 2.0 Client ID of type "Desktop app" (Gmail API
// enabled on the project, gmail.send scope, your ASU account added as a test
// user on the consent screen). Put its id/secret in .env as
// GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET, then:
//   npx tsx --env-file=.env scripts/gmail-auth.ts
import { createServer } from 'node:http';
import { google } from 'googleapis';

const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  throw new Error('GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET missing (run with --env-file=.env)');
}

const PORT = 4771;
const redirectUri = `http://localhost:${PORT}/oauth2callback`;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',        // ask for a refresh token
  prompt: 'consent',             // force it even if previously granted
  scope: ['https://www.googleapis.com/auth/gmail.send'],
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
      console.error('No refresh token returned. Revoke the app at myaccount.google.com/permissions and re-run.');
      server.close();
      process.exit(1);
    }
    console.log('\nSuccess. Add this line to outreach/.env:\n');
    console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
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
