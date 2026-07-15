import { describe, expect, test } from 'vitest';
import { extractContact, type ContactDeps } from '../src/pipeline/contacts.js';

// Regression: an email present in the search snippet but obfuscated out of the
// fetched page plaintext (common on staff pages) must still be found. We scan
// both the snippet and the fetched content.

describe('snippet + fetched content scanning', () => {
  test('finds an email that only appears in the search snippet', async () => {
    const homepage = 'https://www.cg.tuwien.ac.at/staff/BernhardKerbl';
    const deps: ContactDeps = {
      search: {
        async search() {
          // snippet carries the email; fetched page (below) hides it
          return [{ url: homepage, title: 'Bernhard Kerbl', content: 'email: bernhard.kerbl@tuwien.ac.at' }];
        },
      },
      fetcher: {
        async fetch(urls) {
          return urls.map((url) => ({ url, title: '', content: 'no email in the rendered body' }));
        },
      },
    };
    const result = await extractContact(deps, { name: 'Bernhard Kerbl' }, null);
    expect(result?.email).toBe('bernhard.kerbl@tuwien.ac.at');
  });
});
