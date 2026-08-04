import { describe, expect, test } from 'vitest';
import { extractContact, extractContactDetailed, type ContactDeps, type WebPage } from '../src/pipeline/contacts.js';

// Orchestration basics (see reconcile.test.ts for age/reconciliation rules):
// tier 1 short-circuits a fresh paper; otherwise web is consulted; below 0.7 → null.

function makeDeps(pages: WebPage[], fetched: Record<string, string>, searchLog: string[] = []): ContactDeps {
  return {
    search: {
      async search(q: string) {
        searchLog.push(q);
        return pages;
      },
    },
    fetcher: {
      async fetch(urls: string[]) {
        return urls.map((url) => ({ url, title: '', content: fetched[url] ?? '' }));
      },
    },
  };
}

const PERSON = { name: 'Aditya Gupta', affiliation: 'Arizona State University' };

describe('extractContact', () => {
  test('returns a fresh tier-1 corresponding email without searching the web', async () => {
    const log: string[] = [];
    const result = await extractContact(
      makeDeps([], {}, log),
      PERSON,
      'Corresponding author: agupta@asu.edu',
      { paperAgeMonths: 2 },
    );
    expect(result).toEqual({ email: 'agupta@asu.edu', confidence: 0.95, source: 'pdf' });
    expect(log).toHaveLength(0);
  });

  test('falls back to web when the paper has no send-eligible email', async () => {
    const homepage = 'https://www.asu.edu/~agupta/';
    const deps = makeDeps(
      [{ url: homepage, title: 'Aditya Gupta', content: '' }],
      { [homepage]: 'contact: gupta3@asu.edu' },
    );
    const result = await extractContact(deps, PERSON, 'no emails here');
    expect(result).toEqual({ email: 'gupta3@asu.edu', confidence: 0.85, source: 'homepage' });
  });

  test('returns null when nothing reaches the 0.7 threshold', async () => {
    const page = 'https://somewhere.org/list';
    const deps = makeDeps([{ url: page, title: 'Attendees', content: '' }], { [page]: 'unrelated@other.org' });
    const result = await extractContact(deps, PERSON, null);
    expect(result).toBeNull();
  });

  test('includes name and affiliation in the search query', async () => {
    const log: string[] = [];
    await extractContact(makeDeps([], {}, log), PERSON, null);
    expect(log.some((q) => q.includes('Aditya Gupta') && q.includes('Arizona State University'))).toBe(true);
  });
});

describe('extractContactDetailed', () => {
  // Adapted from the plan: this file's makeDeps takes (pages, fetched, searchLog?)
  // with `fetched` required, not the plan's single-arg makeDeps(pages). Also, the
  // D5a guard in extractContact (contacts.ts:257) skips the web tier entirely when
  // no affiliation is available anywhere (options.currentAffiliation /
  // paperContext.affiliationHint / person.affiliation all empty), so every person
  // below carries an affiliation the plan's bare `{ name: ... }` omitted; without
  // one, deps.search.search is never called and every rejected/selected assertion
  // here would trivially pass on an empty array for the wrong reason.
  test('reports a name-mismatched candidate instead of discarding it', async () => {
    // The measured production case: zhangyanghui@tongji.edu.cn was found on
    // Xiyu Zhang's homepage and emailed. nameMatches now rejects it, and
    // before this change the rejection was unobservable outside scoreCandidate.
    const r = await extractContactDetailed(
      makeDeps([{ url: 'https://tongji.edu.cn/~xzhang', title: 'Xiyu Zhang', content: 'zhangyanghui@tongji.edu.cn' }], {}),
      { name: 'Xiyu Zhang', affiliation: 'Tongji University' },
      null,
    );
    expect(r.selected).toBeNull();
    expect(r.rejected).toEqual([
      { email: 'zhangyanghui@tongji.edu.cn', source: 'homepage', reason: 'identity_mismatch' },
    ]);
  });

  test('does not report a candidate that DOES name the person', async () => {
    // A confidence failure (scored below CONFIDENCE_THRESHOLD) is not a
    // wrong-person failure, and must never produce a needs-address text.
    // collectRejected only checks nameMatches, never the score, so this holds
    // regardless of which source tier the candidate came from.
    const r = await extractContactDetailed(
      makeDeps([{ url: 'https://github.com/bkerbl', title: 'Bernhard Kerbl', content: 'bernhard.kerbl@inria.fr' }], {}),
      { name: 'Bernhard Kerbl', affiliation: 'Inria' },
      null,
    );
    expect(r.rejected).toEqual([]);
  });

  test('caps the reported rejections at 3 and dedupes by address', async () => {
    const page = (n: number) => ({
      url: `https://uni${n}.edu/staff`, title: 'Staff directory',
      content: `someoneelse${n}@uni${n}.edu someoneelse${n}@uni${n}.edu`,
    });
    const r = await extractContactDetailed(
      makeDeps([page(1), page(2), page(3), page(4)], {}),
      { name: 'Xiyu Zhang', affiliation: 'Some University' },
      null,
    );
    expect(r.rejected.length).toBeLessThanOrEqual(3);
    expect(new Set(r.rejected.map((x) => x.email)).size).toBe(r.rejected.length);
  });

  test('extractContact still returns only the selection, so no existing caller changes', async () => {
    const deps = makeDeps([{ url: 'https://inria.fr/kerbl', title: 'Bernhard Kerbl', content: 'bernhard.kerbl@inria.fr' }], {});
    const selected = await extractContact(deps, { name: 'Bernhard Kerbl', affiliation: 'Inria' }, null);
    expect(selected?.email).toBe('bernhard.kerbl@inria.fr');
  });
});
