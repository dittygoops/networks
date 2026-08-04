// A tapback resolves which draft it means by parsing /^\s*(d\d+):/ off the text
// of the message that was reacted to (draftIdFromReactedText, photonChannel.ts).
// So ANY message the system sends that begins "dN:" is silently an approval
// button. Reacting to a refusal with a thumbs up, which is a natural human
// response to bad news, then decodes to "dN y".
//
// Two of the three offenders were inert only by accident. `recipient_changed`
// becomes a live send the moment the address mismatch closes, and it can close
// on its own: upsertPerson uses `email = coalesce(?, email)`, so a later run
// that rediscovers the original address restores it. That is a real send path
// reachable today, not a hypothetical.
//
// This guards the invariant at the source level rather than per message,
// because the failure is a FORMAT, and new notify calls get added over time.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = ['src/pipeline/loop.ts', 'src/pipeline/listen.ts', 'src/cli.ts', 'src/pipeline/addressCorrection.ts'];

// Mirrors draftIdFromReactedText. A draft id followed by a colon is the token
// that makes a message tapback-actionable.
const TAPBACK_HEADER = /notify\(\s*\n?\s*`\$\{[A-Za-z.]*[sS]hortId\}:/;

describe('no outbound notification can be mistaken for a draft message', () => {
  test.each(SOURCES)('%s contains no notify() beginning with a draft id and a colon', (rel) => {
    const src = readFileSync(join(here, '..', rel), 'utf8');
    expect(TAPBACK_HEADER.test(src)).toBe(false);
  });
});
