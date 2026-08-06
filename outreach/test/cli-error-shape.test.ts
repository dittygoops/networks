// The privacy leak this file exists to make impossible. cli.ts's top-level
// handler used to be `main().catch((e) => { console.error(e); process.exit(1); })`.
// Verified on Node 24: console.error(e) appends the error's own enumerable
// properties, so a GaxiosError's response.headers (From addresses under
// format=metadata) and config.url land in data/replies.err.log, bypassing the
// "err.message only" rule the entire read-path privacy argument rests on.
// console.error(e.stack) prints the stack and nothing else.
//
// Static scan, the same approach test/notify-tapback-safety.test.ts uses and
// for the same reason: cli.ts's top-level catch is module-level code with no
// export, so there is nothing to call and assert against. The failure is a
// FORMAT, and new console.error(e) call sites get added over time, so this
// guards the source rather than one call site.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('the CLI never prints a bare error object', () => {
  it('never prints a bare error object, which would dump a GaxiosError response', () => {
    const src = readFileSync(join(here, '..', 'src/cli.ts'), 'utf8');
    // console.error(e) / console.error(err) / console.error(error) append own
    // enumerable properties. console.error(e.stack), console.error(e.message)
    // and a ternary over either do not, and must not trip this.
    expect(/console\.error\(\s*(e|err|error)\s*\)/.test(src)).toBe(false);
  });
});
