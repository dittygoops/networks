# Address Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When contact extraction finds an address and `nameMatches` rejects it as belonging to a different person, stop silently dropping the researcher. Draft the email, text Aditya a distinct NEEDS ADDRESS message that cannot be approved by tapback, let him reply `dN to their@address.edu`, and make that draft sendable through the unchanged send path. A one-digit typo in the draft id must never be able to overwrite a verified address or produce a sendable draft.

**Architecture:** `extractContact` gains a detailed sibling that reports name-mismatch rejections instead of discarding them. `OrchestrateResult` carries them (optionally) to `processCandidate`, which drafts, texts a NEEDS ADDRESS message under its own per-run budget, and parks the `seen_papers` row at `drafted_unsendable` with a stranded-visible reason and the draft id attached. `parseReply` gains an `address` kind. A new module `src/pipeline/addressCorrection.ts` owns the one transaction that writes `people.email` and `drafts.to_email` together, plus three refusals that block the typo path. Nothing new sends: a further explicit `dN y` runs the identical, unmodified send path.

**Tech Stack:** TypeScript ESM (Node 24), better-sqlite3 (synchronous), vitest, tsx, tldts. Spec: `docs/superpowers/specs/2026-08-04-address-correction-design.md`.

## Global Constraints

- **ESM with explicit `.js` import extensions.** `import { x } from './foo.js'` even though the file is `foo.ts`. No exceptions.
- **Baseline: 48 test files, 559 tests passing** on `main` at commit 733c3c9. Confirm with `npx vitest run --reporter=dot 2>&1 | tail -5` before starting.
- **Commit 733c3c9 already shipped the `dN:` notify reword.** All three offending strings in `loop.ts` (`already_attempted` at :140-143, `recipient_changed` at :158-161, the dry-run notice at :250-252) now read `dN NOT SENT:` / `dN DRY RUN:`, and `test/notify-tapback-safety.test.ts` guards the invariant at source level. **Do NOT re-do that work and do NOT write a second copy of that test.** Task 5 EXTENDS its `SOURCES` array by one entry.
- **Every new `OrchestrateResult` and `LoopSummary` field must be OPTIONAL.** `test/loop.test.ts:53`, `test/stranding.test.ts:66`, `test/listen.test.ts:451`, and `src/pipeline/listen.ts:79-93` all build those literals behind explicit type annotations. A required field breaks `npm run typecheck` in four places this plan does not own. Read every new field as `(x ?? default)`.
- **Every new `GateConfig` field must be OPTIONAL** for the same reason: `test/loop.test.ts:11`, `test/stranding.test.ts:23`, and `test/relevanceGate.test.ts:7` each build a `GateConfig`-shaped literal.
- **No message this plan adds may begin with `dN:`.** `draftIdFromReactedText` (`photonChannel.ts:134-137`) turns any message whose text starts `/^\s*(d\d+):/` into a tapback-approvable draft, so such a message is silently an approval button. `dN ` followed by anything other than a colon is safe.
- **Do not touch `scripts/flush-queued-drafts.ts`.** Its only outbound call is `sendDraftMessage`, which renders the forbidden `dN: Name (to)` header and would print `(undefined)` for a null address; its guard at line 54 skips exactly these rows; and it is top-level module code with zero exports and no test file. Task 7 puts the backlog drain in `runLoop` instead.
- **`better-sqlite3` is synchronous.** No `await` on db calls.
- **A regression test that cannot fail is worthless.** Every task's mutate step is mandatory. If the test passes before the implementation, the test is wrong.
- **Run the full suite and `npm run typecheck` before each commit**, not just the new test.
- **Commit after every task.** No batching.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/pipeline/contacts.ts` | source-union split, `extractContactDetailed` | 1 |
| `src/pipeline/orchestrate.ts` | thread `rejectedEmails` out of `processPaper` | 2 |
| `src/approval/channel.ts` | `address` reply kind, NEEDS ADDRESS message format | 3 |
| `src/approval/photonChannel.ts` | tapback hint on a NEEDS ADDRESS message | 4 |
| `src/pipeline/addressCorrection.ts` (new) | the correction transaction, three refusals, request/defer/drain helpers | 5 |
| `src/pipeline/loop.ts` | `handleReply` wiring, help strings, decline event | 6 |
| `src/pipeline/loop.ts`, `src/discovery/config.ts` | needs-address branch, budget, summary, backlog drain | 7 |
| `src/discovery/seenLedger.ts` | two `strandedReport` reason patterns | 8 |
| `scripts/eval-trust-safety.ts` | score a needs-address draft `review`, not `fail` | 9 |
| `src/cli.ts` | `outreach add` reports the rejected candidate | 10 |
| (none) | live demonstration | 11 |

**Dependency order.** Task 1 → 2. Task 3 → 4, 5. Tasks 1 and 3 → 5. Task 5 → 6, 7. Task 2 → 7, 10.

**Parallel waves:**
- **Wave A (no dependencies):** Tasks 1, 3, 8, 9.
- **Wave B (needs A):** Task 2 (needs 1), Task 4 (needs 3), Task 5 (needs 1 and 3).
- **Wave C (needs B):** Task 6 (needs 5), Task 7 (needs 2 and 5), Task 10 (needs 2).
- **Wave D:** Task 11, after everything is merged.

If you work in a git worktree, `git merge main` FIRST and re-measure the baseline. Task 7 in particular requires Tasks 2 and 5 to be present in your tree.

---

### Task 1: Surface the name-mismatch rejection out of `contacts.ts`

**Why:** A rejected candidate scores 0 in `scoreCandidate` (`contacts.ts:40`), falls below `CONFIDENCE_THRESHOLD` in `selectEmail`, and disappears. `extractContact` returns `null` and `processCandidate` writes `no email resolved`. Nothing outside `scoreCandidate` can tell "we looked and found a wrong-person address" from "we found nothing". Everything downstream in this plan needs that distinction.

**Files:**
- Modify: `src/pipeline/contacts.ts`
- Test: `test/extract-contact.test.ts`

**Interfaces produced:**

```ts
export type DiscoveredEmailSource = 'pdf' | 'homepage' | 'directory' | 'github_profile' | 'github_commit';
export type EmailSource = DiscoveredEmailSource | 'user_provided';
export interface RejectedCandidate { email: string; source: DiscoveredEmailSource; reason: 'identity_mismatch'; }
export interface ContactResult { selected: SelectedEmail | null; rejected: RejectedCandidate[]; }
export async function extractContactDetailed(
  deps: ContactDeps, person: TargetPerson, paperText: string | null, options?: ExtractOptions,
): Promise<ContactResult>;
export async function extractContact(...same args...): Promise<SelectedEmail | null>; // unchanged signature
```

`EmailCandidate.source` and `RejectedCandidate.source` narrow to `DiscoveredEmailSource`; `SelectedEmail.source` widens to `EmailSource`; `SOURCE_CONFIDENCE` becomes `Record<DiscoveredEmailSource, number>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/extract-contact.test.ts` (reuse the file's existing `makeDeps` / `PERSON` fixtures; add `extractContactDetailed` to its import from `../src/pipeline/contacts.js`):

```ts
describe('extractContactDetailed', () => {
  it('reports a name-mismatched candidate instead of discarding it', async () => {
    // The measured production case: zhangyanghui@tongji.edu.cn was found on
    // Xiyu Zhang's homepage and emailed. nameMatches now rejects it, and
    // before this change the rejection was unobservable outside scoreCandidate.
    const r = await extractContactDetailed(
      makeDeps([{ url: 'https://tongji.edu.cn/~xzhang', title: 'Xiyu Zhang', content: 'zhangyanghui@tongji.edu.cn' }]),
      { name: 'Xiyu Zhang' },
      null,
    );
    expect(r.selected).toBeNull();
    expect(r.rejected).toEqual([
      { email: 'zhangyanghui@tongji.edu.cn', source: 'homepage', reason: 'identity_mismatch' },
    ]);
  });

  it('does not report a low-confidence candidate that DOES name the person', async () => {
    // github_commit scores 0.55, below CONFIDENCE_THRESHOLD, so it is not
    // selected. That is a confidence failure, not a wrong-person failure, and
    // must never produce a needs-address text.
    const r = await extractContactDetailed(
      makeDeps([{ url: 'https://github.com/bkerbl', title: 'Bernhard Kerbl', content: 'bernhard.kerbl@inria.fr' }]),
      { name: 'Bernhard Kerbl' },
      null,
    );
    expect(r.rejected).toEqual([]);
  });

  it('caps the reported rejections at 3 and dedupes by address', async () => {
    const page = (n: number) => ({
      url: `https://uni${n}.edu/staff`, title: 'Staff directory',
      content: `someoneelse${n}@uni${n}.edu someoneelse${n}@uni${n}.edu`,
    });
    const r = await extractContactDetailed(
      makeDeps([page(1), page(2), page(3), page(4)]),
      { name: 'Xiyu Zhang' },
      null,
    );
    expect(r.rejected.length).toBeLessThanOrEqual(3);
    expect(new Set(r.rejected.map((x) => x.email)).size).toBe(r.rejected.length);
  });

  it('extractContact still returns only the selection, so no existing caller changes', async () => {
    const deps = makeDeps([{ url: 'https://inria.fr/kerbl', title: 'Bernhard Kerbl', content: 'bernhard.kerbl@inria.fr' }]);
    const selected = await extractContact(deps, { name: 'Bernhard Kerbl' }, null);
    expect(selected?.email).toBe('bernhard.kerbl@inria.fr');
  });
});
```

If `makeDeps` in that file takes a different shape, adapt the calls to it rather than inventing a new helper. The assertions above are what matters.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/extract-contact.test.ts`
Expected: FAIL, `extractContactDetailed is not a function`.

- [ ] **Step 3: Split the source union in `src/pipeline/contacts.ts`**

Replace lines 5-28 (the type declarations through `SOURCE_CONFIDENCE`) with:

```ts
// Split into two tiers. Candidates only ever come from discovery, so
// scoreCandidate keeps an exhaustive lookup and a future sixth discovery
// source still fails typecheck if its confidence is not declared. A
// human-supplied address never enters the scoring path at all, so it is
// deliberately outside the Record: it is stored at confidence 1.0 and is never
// compared against CONFIDENCE_THRESHOLD.
export type DiscoveredEmailSource = 'pdf' | 'homepage' | 'directory' | 'github_profile' | 'github_commit';
export type EmailSource = DiscoveredEmailSource | 'user_provided';

export interface EmailCandidate {
  email: string;
  source: DiscoveredEmailSource;
  correspondingMarker?: boolean;
}

export interface SelectedEmail {
  email: string;
  confidence: number;
  // Widened, because runContactExtraction's on-record shortcut
  // (orchestrate.ts:150-155) reads a stored email_source back off the person
  // row and casts it. Today that cast is a lie for the one 'user_provided'
  // row; now it is honest.
  source: EmailSource;
}

// Why a candidate was refused, kept rather than discarded. Only an identity
// mismatch belongs here: a github_commit candidate that names the person and
// scores 0.55 is a confidence failure, not a wrong-person failure, and must
// never produce a needs-address text.
export interface RejectedCandidate {
  email: string;
  source: DiscoveredEmailSource;
  reason: 'identity_mismatch';
}

export interface ContactResult {
  selected: SelectedEmail | null;
  rejected: RejectedCandidate[];
}

export const CONFIDENCE_THRESHOLD = 0.7;

// D1 confidence table (name match required everywhere; noreply always discarded).
const SOURCE_CONFIDENCE: Record<DiscoveredEmailSource, number> = {
  pdf: 0.85, // 0.95 with corresponding-author marker
  homepage: 0.85,
  directory: 0.75,
  github_profile: 0.7,
  github_commit: 0.55,
};
```

Change `extractWebEmailCandidates`'s `const source: EmailSource = cls;` (line 159) to `const source: DiscoveredEmailSource = cls;`. `cls` is already narrowed to homepage / directory / github_profile by the `aggregator` `continue` above it, so no cast is needed.

- [ ] **Step 4: Add the rejection collector and the detailed entry point**

Add beside `selectEmail`:

```ts
// The mirror image of selectEmail: the candidates it threw away for naming a
// different person. Deduped by address and ordered by the confidence the
// candidate WOULD have had if the name had matched, so the message shows the
// machine's own ranking. Capped at 3 because the message is read on a phone.
export function collectRejected(candidates: EmailCandidate[], personName: string): RejectedCandidate[] {
  const byEmail = new Map<string, { r: RejectedCandidate; rank: number }>();
  for (const c of candidates) {
    const [localPart = '', domain = ''] = c.email.split('@');
    if (domain.endsWith('noreply.github.com')) continue; // a discard, not a wrong person
    if (nameMatches(localPart, personName)) continue;
    if (byEmail.has(c.email)) continue;
    byEmail.set(c.email, {
      r: { email: c.email, source: c.source, reason: 'identity_mismatch' },
      rank: SOURCE_CONFIDENCE[c.source],
    });
  }
  return [...byEmail.values()].sort((a, b) => b.rank - a.rank).slice(0, 3).map((x) => x.r);
}
```

Then rename the existing `extractContact` body to `extractContactDetailed`, have it return `{ selected, rejected }`, and reintroduce `extractContact` as a wrapper. Concretely, at the current `extractContact` declaration (`contacts.ts:241`), change the signature and the return statements so every `return null` becomes `return { selected: null, rejected: collectRejected(allCandidates, person.name) }` and every `return best` becomes `return { selected: best, rejected: collectRejected(allCandidates, person.name) }`, where `allCandidates` is the accumulated candidate array that function already builds. Then add:

```ts
// Kept at its original signature deliberately. Verified by grep: the only
// callers are orchestrate.ts:157, intake.ts:53, five test files
// (extract-contact, paper-context, two-pass, reconcile, snippet-scan) and
// scripts/smoke-contact.ts. Keeping the wrapper means only orchestrate.ts
// changes and no existing test moves.
export async function extractContact(
  deps: ContactDeps,
  person: TargetPerson,
  paperText: string | null,
  options: ExtractOptions = {},
): Promise<SelectedEmail | null> {
  return (await extractContactDetailed(deps, person, paperText, options)).selected;
}
```

Match `ExtractOptions` to whatever the existing options parameter type is actually named in the file; do not rename it.

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/extract-contact.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5` → 563 tests passing (559 + 4).
Run: `npm run typecheck`

`test/paper-context.test.ts`, `test/two-pass.test.ts`, `test/reconcile.test.ts`, and `test/snippet-scan.test.ts` must pass **unchanged**. If any of them needs editing, the wrapper's signature drifted; fix the wrapper, not the tests.

- [ ] **Step 6: Mutate to prove the tests can fail**

Change `collectRejected`'s `if (nameMatches(localPart, personName)) continue;` to `if (!nameMatches(localPart, personName)) continue;`. Confirm the first test goes RED and the second stays green. Restore, confirm GREEN.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/contacts.ts test/extract-contact.test.ts
git commit -m "Report a name-mismatched email candidate instead of discarding it"
```

---

### Task 2: Carry `rejectedEmails` out of `processPaper`

**Requires:** Task 1.

**Why:** `processCandidate` is where the needs-address decision is made, and it only sees an `OrchestrateResult`. Without this field the rejection dies in `orchestrate.ts`.

**Files:**
- Modify: `src/pipeline/orchestrate.ts`
- Test: `test/orchestrate.test.ts`

**Interfaces produced:**

```ts
export interface OrchestrateResult {
  // ...existing fields...
  rejectedEmails?: RejectedCandidate[];   // OPTIONAL. See Global Constraints.
}
```

- [ ] **Step 1: Write the failing test**

Append to `describe('processPaper (orchestrator)', ...)` in `test/orchestrate.test.ts`:

```ts
  test('a name-mismatched address is reported on the result, not silently dropped', async () => {
    // The whole point: "we found an address for the wrong person" must be
    // distinguishable downstream from "we found nothing".
    const d = deps({
      search: { search: async () => [{ url: 'https://tuwien.ac.at/staff', title: 'Staff', content: 'someoneelse@tuwien.ac.at' }] },
      fetcher: { fetch: async () => [] },
      getPaperText: async () => null,
    });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    const r = await processPaper(d, '2308.04079');
    expect(r.email).toBeNull();
    expect((r.rejectedEmails ?? []).map((x) => x.email)).toContain('someoneelse@tuwien.ac.at');
  });

  test('the on-record shortcut reports no rejections, because nothing was looked up', async () => {
    const search = vi.fn(async () => []);
    const d = deps({ search: { search } });
    saveSelfFacts(d.db, [{ facet: 'academic', key: 'method', value: '3D Gaussian Splatting', sourceUrl: 'self', confidence: 0.9, tier: 'A' } as OntologyFact]);
    await processPaper(d, '2308.04079');   // first pass stores the address
    search.mockClear();
    const r = await processPaper(d, '2308.04079');
    expect(search).not.toHaveBeenCalled();
    expect(r.rejectedEmails ?? []).toEqual([]);
  });
```

Adapt `deps(...)` to the file's existing helper shape; do not invent a new one.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/orchestrate.test.ts -t 'name-mismatched address is reported'`
Expected: FAIL, `rejectedEmails` is undefined.

- [ ] **Step 3: Thread the pair through `src/pipeline/orchestrate.ts`**

Change the import at line 12 to pull in the detailed entry point and the new types:

```ts
import {
  extractContactDetailed,
  type PageFetcher, type SearchClient, type SelectedEmail, type EmailSource,
  type RejectedCandidate, type ContactResult,
} from './contacts.js';
```

Add the field to `OrchestrateResult` (after `email`):

```ts
  // Candidates rejected for naming a different person. OPTIONAL: two test
  // files build an OrchestrateResult literal behind an explicit type
  // annotation, so a required field breaks typecheck outside this file. Read
  // it as `(result.rejectedEmails ?? [])` everywhere.
  rejectedEmails?: RejectedCandidate[];
```

Add a mutable holder beside `let email` (line 133):

```ts
  let rejectedEmails: RejectedCandidate[] = [];
```

Change `runContactExtraction` (lines 140-162) to return a `ContactResult`:

```ts
  const runContactExtraction = async (aff: string | undefined): Promise<ContactResult> => {
    // A repeat author already has an address on record; re-paying Tavily to
    // rediscover it is pure waste. `rejected: []` is not a shrug, it is the
    // truth: nothing was looked up, so nothing was rejected.
    if (personId != null) {
      const known = getPerson(deps.db, personId);
      if (known?.email) {
        return {
          selected: { email: known.email, confidence: known.email_confidence ?? 1, source: (known.email_source as EmailSource | null) ?? 'directory' },
          rejected: [],
        };
      }
    }
    const paperText = deps.getPaperText ? await deps.getPaperText(arxivId) : await defaultPaperText(arxivId, fetchFn);
    return extractContactDetailed({ search: deps.search, fetcher: deps.fetcher }, { name: target.name }, paperText, {
      paperContext: ctx,
      currentAffiliation: aff,
      paperAgeMonths: arxivAgeMonths(arxivId),
    });
  };
```

Add `rejectedEmails` to the `result()` closure (line 176-189), and update all four call sites. Each currently reads `email = await runContactExtraction(currentAff);`; each becomes:

```ts
    ({ selected: email, rejected: rejectedEmails } = await runContactExtraction(currentAff));
```

There are four: line 193 (unresolved exit), line 215 (collision exit), line 229 (no-hook exit), and line 249 (the survivor path). Do not miss one; the no-hook exit at :229 is the one the loop actually hits under hook-first gating when `alwaysExtractContact` is set.

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/orchestrate.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck` → must be clean, which is the real assertion that the field stayed optional.

- [ ] **Step 5: Mutate to prove the test can fail**

Change `rejectedEmails?: RejectedCandidate[]` to be assigned `[]` unconditionally in `result()` (`rejectedEmails: []`). Confirm the first new test goes RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/orchestrate.ts test/orchestrate.test.ts
git commit -m "Carry rejected email candidates out of processPaper"
```

---

### Task 3: The `address` reply kind and the NEEDS ADDRESS message format

**Why:** `parseReply('d70 to someone@uni.edu')` returns `unsupported` today (measured). The message format lives here rather than in `photonChannel.ts` because both the loop (which sends it) and the channel (which must recognise a tapback on it) need it, and `channel.ts` is the transport-agnostic seam both already depend on.

**Files:**
- Modify: `src/approval/channel.ts`
- Test: `test/channel.test.ts`

**Interfaces produced:**

```ts
export type ParsedReply =
  | { kind: 'approve'; shortId: string }
  | { kind: 'skip'; shortId: string }
  | { kind: 'address'; shortId: string; email: string }
  | { kind: 'unsupported'; shortId: string }
  | { kind: 'unparseable' };

export interface NeedsAddressMessage {
  shortId: string; personName: string; affiliation?: string | null; paperTitle: string;
  rejected: Array<{ email: string; source: string; reason: string }>;
}
export function formatNeedsAddressMessage(m: NeedsAddressMessage): string;
export function needsAddressDraftId(text: string | undefined): string | null;
export function needsAddressTapbackHint(shortId: string): string;
```

- [ ] **Step 1: Write the failing tests**

Append to `test/channel.test.ts`:

```ts
describe('parseReply address corrections', () => {
  it('parses the advertised form', () => {
    expect(parseReply('d70 to someone@uni.edu')).toEqual({ kind: 'address', shortId: 'd70', email: 'someone@uni.edu' });
  });

  // The id-stripping loop removes the id token wherever it appears, so `rest`
  // is NOT positionally aligned with the input. Measured: parseReply('to d70
  // a@b.edu') yields rest = ['to','a@b.edu'], identical to the normal form.
  // Recovering the original-case address by indexing the raw split at rest's
  // own index would read 'd70' as the address here.
  it('maps the address back to the ORIGINAL token position, not to its index in rest', () => {
    expect(parseReply('to d70 a@b.edu')).toEqual({ kind: 'address', shortId: 'd70', email: 'a@b.edu' });
  });

  // iOS turns a double space into a period. Without this, the single most
  // likely real reply fails.
  it('strips trailing sentence punctuation', () => {
    expect(parseReply('d70 to a@b.edu.')).toEqual({ kind: 'address', shortId: 'd70', email: 'a@b.edu' });
    expect(parseReply('d70 to a@b.edu!')).toEqual({ kind: 'address', shortId: 'd70', email: 'a@b.edu' });
  });

  // A local part is not formally case-insensitive; a domain is.
  it('preserves local-part case and lowercases the domain', () => {
    expect(parseReply('d70 to A.B@Uni.EDU')).toEqual({ kind: 'address', shortId: 'd70', email: 'A.B@Uni.EDU'.replace('Uni.EDU', 'uni.edu') });
  });

  it('leaves the edit path alone', () => {
    expect(parseReply('d70 to the point')).toEqual({ kind: 'unsupported', shortId: 'd70' });
    // Measured today: this is 'unsupported', NOT 'unparseable'. One advertised
    // form only, matching the existing "an approval must contain a verb" rule.
    expect(parseReply('d70 a@b.edu')).toEqual({ kind: 'unsupported', shortId: 'd70' });
  });
});

describe('the needs-address message', () => {
  const msg = {
    shortId: 'd70', personName: 'Xiyu Zhang', affiliation: 'Tongji University',
    paperTitle: 'A Paper',
    rejected: [{ email: 'zhangyanghui@tongji.edu.cn', source: 'homepage', reason: 'the local part names a different person' }],
  };

  // THE safety property of this whole feature. draftIdFromReactedText converts
  // any message starting `dN:` into a tapback-approvable draft, so a
  // needs-address message with that header would let one thumbs up send the
  // very email that was flagged as going to the wrong person.
  it('begins with NEEDS ADDRESS and has no line beginning with a draft id and a colon', () => {
    const text = formatNeedsAddressMessage(msg);
    expect(text.startsWith('NEEDS ADDRESS for d70')).toBe(true);
    for (const line of text.split('\n')) expect(/^\s*d\d+:/.test(line)).toBe(false);
  });

  it('advertises the correction syntax and the skip', () => {
    const text = formatNeedsAddressMessage(msg);
    expect(text).toContain('"d70 to their@address.edu"');
    expect(text).toContain('"d70 n"');
  });

  it('recognises its own header and nothing else', () => {
    expect(needsAddressDraftId(formatNeedsAddressMessage(msg))).toBe('d70');
    expect(needsAddressDraftId('d70: Xiyu Zhang (a@b.edu)')).toBeNull();
    expect(needsAddressDraftId('d25 sent to jiaruizhao@cuhk.edu.hk.')).toBeNull();
    expect(needsAddressDraftId(undefined)).toBeNull();
  });

  it('hints without becoming an approval button itself', () => {
    const hint = needsAddressTapbackHint('d70');
    expect(/^\s*d\d+:/.test(hint)).toBe(false);
    expect(hint).toContain('"d70 to their@address.edu"');
  });
});
```

Add `formatNeedsAddressMessage`, `needsAddressDraftId`, and `needsAddressTapbackHint` to the file's import from `../src/approval/channel.js`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/channel.test.ts`
Expected: FAIL, `formatNeedsAddressMessage is not a function`, and the parser cases return `unsupported`.

- [ ] **Step 3: Add the `address` kind to `src/approval/channel.ts`**

Extend `ParsedReply` (line 19-23) with `| { kind: 'address'; shortId: string; email: string }` placed before `unsupported`, then replace `parseReply` (lines 56-82) with:

```ts
// Deliberately narrow, and the same shape assertSafeOutbound enforces: exactly
// one bare address, no display name, no comma, no angle brackets. This is a
// convenience refusal so a malformed reply gets a useful message at correction
// time; assertSafeOutbound remains the real gate at send time.
const ADDRESS_SHAPE = /^[^\s<>,;:\\"]+@[^\s<>,;:\\"]+\.[^\s<>,;:\\"]+$/;

// The local part of an address is not formally case-insensitive, so it is read
// from the RAW token and preserved; only the domain is lowercased. One run of
// trailing sentence punctuation is stripped because iOS inserts a period on a
// double space, and no real address ends in one.
function normalizeAddress(rawToken: string): string | null {
  const trimmed = rawToken.replace(/[.,;:!?]+$/, '');
  if (!ADDRESS_SHAPE.test(trimmed)) return null;
  const at = trimmed.lastIndexOf('@');
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

export function parseReply(text: string): ParsedReply {
  // Two parallel arrays, deliberately. The id-stripping loop below removes the
  // id token WHEREVER it appears, not only at position 0, so `rest` is not
  // positionally aligned with the input: parseReply('to d70 a@b.edu') yields
  // rest = ['to','a@b.edu'] exactly like the normal form. Recovering the
  // original-case address by indexing `raw` at rest's own index would read
  // 'd70' as the address. `restIdx` records the ORIGINAL index instead.
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const tokens = raw.map((t) => t.toLowerCase());
  if (!tokens.length) return { kind: 'unparseable' };

  let shortId: string | undefined;
  const rest: string[] = [];
  const restIdx: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const id = shortId === undefined ? parseShortId(t) : null;
    if (id !== null) {
      shortId = formatShortId(id);
    } else {
      rest.push(t);
      restIdx.push(i);
    }
  }
  if (shortId === undefined) return { kind: 'unparseable' };

  // Ambiguity never resolves toward sending, with no exceptions. An id alone
  // is a noun: "d7" or "7" could be an accidental text, a year, a house
  // number, or a reply meant for another conversation, and ids are permanent
  // so a stale one still names a real draft. An approval must contain a verb.
  if (rest.length === 0) return { kind: 'unparseable' };
  if (rest.length === 1 && APPROVE.has(rest[0] ?? '')) return { kind: 'approve', shortId };
  if (rest.length === 1 && SKIP.has(rest[0] ?? '')) return { kind: 'skip', shortId };
  // One advertised form only. A bare "d70 someone@uni.edu" stays unsupported,
  // matching the existing "d70 y" shape and keeping the grammar small.
  if (rest.length === 2 && rest[0] === 'to') {
    const email = normalizeAddress(raw[restIdx[1]!] ?? '');
    if (email) return { kind: 'address', shortId, email };
  }
  return { kind: 'unsupported', shortId }; // an edit instruction: F5 owns this
}
```

- [ ] **Step 4: Add the message format to the same file**

Append after `parseReply`:

```ts
// --- The needs-address message -------------------------------------------
// Lives here, not in photonChannel.ts, because two places need it and must not
// drift: the loop sends it, and the channel must recognise a tapback on it.
//
// It MUST begin with the literal 'NEEDS ADDRESS' and no line of it may begin
// with `dN:`. draftIdFromReactedText (photonChannel.ts) turns any message whose
// text starts /^\s*(d\d+):/ into a tapback-approvable draft, so a needs-address
// message with that header would let one thumbs up send the very email that was
// flagged as going to the wrong person. The header therefore puts the id AFTER
// the word 'for' and never follows it with a colon, so even a tolerant future
// parser finds nothing to bind.
export interface NeedsAddressMessage {
  shortId: string;
  personName: string;
  affiliation?: string | null;
  paperTitle: string;
  rejected: Array<{ email: string; source: string; reason: string }>;
}

const NEEDS_ADDRESS_HEADER = /^NEEDS ADDRESS for (d\d+)\b/;

export function formatNeedsAddressMessage(m: NeedsAddressMessage): string {
  const who = m.affiliation ? `${m.personName} (${m.affiliation})` : m.personName;
  return [
    `NEEDS ADDRESS for ${m.shortId}`,
    who,
    `Paper: ${m.paperTitle}`,
    ...m.rejected.map((r) => `Rejected: ${r.email} (${r.source}) because ${r.reason}`),
    `Reply "${m.shortId} to their@address.edu" with the right address, or "${m.shortId} n" to skip.`,
  ].join('\n');
}

export function needsAddressDraftId(text: string | undefined): string | null {
  const m = NEEDS_ADDRESS_HEADER.exec((text ?? '').trim());
  return m ? m[1]! : null;
}

// A tapback is the owner's trained reflex, and on this message it used to
// produce total silence, which is indistinguishable from a dead listener.
// Begins with "d70 " and no colon, so the hint is not itself an approval button.
export function needsAddressTapbackHint(shortId: string): string {
  return `${shortId} needs a typed address, not a tapback. Reply "${shortId} to their@address.edu", or "${shortId} n" to skip.`;
}
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/channel.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

Every existing `parseReply` test in that file must still pass unchanged, in particular `parseReply('d7')` → `unparseable` and `parseReply('7 y')` → `approve`.

- [ ] **Step 6: Mutate to prove the tests can fail**

Two mutations, both mandatory:
1. Change `raw[restIdx[1]!]` to `raw[1]`. Confirm the index-mapping test goes RED and the others stay green. Restore.
2. Change the header to `` `${m.shortId}: NEEDS ADDRESS` ``. Confirm the tapback-header test goes RED. Restore. Confirm GREEN.

- [ ] **Step 7: Commit**

```bash
git add src/approval/channel.ts test/channel.test.ts
git commit -m "Parse dN to addr, and add a needs-address message that no tapback can approve"
```

---

### Task 4: Answer a tapback on a NEEDS ADDRESS message instead of ignoring it

**Requires:** Task 3.

**Why:** `reactionToCommand` (`photonChannel.ts:140-147`) returns `null` and only `console.log`s when the reacted-to text has no `dN:` header. Correct for a status line, wrong here: a tapback is the interaction this codebase deliberately built ("Approving 48 drafts by typing `d25 y` each time is slow enough that it stops happening"), and on a NEEDS ADDRESS message it now produces total silence, which is indistinguishable from a broken listener.

**Files:**
- Modify: `src/approval/photonChannel.ts`
- Test: `test/photonChannel.test.ts`

**Interfaces produced:** none exported. Internal to `createPhotonChannel`.

- [ ] **Step 1: Write the failing tests**

Append to `test/photonChannel.test.ts`, reusing the file's existing `reaction()` and `channelFor()` helpers:

```ts
describe('a tapback on the needs-address message', () => {
  const NEEDS = formatNeedsAddressMessage({
    shortId: 'd70', personName: 'Xiyu Zhang', affiliation: 'Tongji University', paperTitle: 'A Paper',
    rejected: [{ email: 'zhangyanghui@tongji.edu.cn', source: 'homepage', reason: 'the local part names a different person' }],
  });

  // The safety half: a thumbs up here must NOT decode to "d70 y". If it did,
  // one tap would send the exact email the message exists to stop.
  it('never becomes an approval', async () => {
    const { channel } = await channelFor([reaction('\u{1F44D}', NEEDS)]);
    expect(await channel.captureReplies(200)).toEqual([]);
  });

  // The usability half: silence is indistinguishable from a dead listener.
  it('answers on-channel with the correction syntax', async () => {
    const { channel, dmSend } = await channelFor([reaction('\u{1F44D}', NEEDS)]);
    await channel.captureReplies(200);
    expect(dmSend).toHaveBeenCalledTimes(1);
    const sent = String(dmSend.mock.calls[0]![0]);
    expect(sent).toContain('"d70 to their@address.edu"');
    expect(/^\s*d\d+:/.test(sent)).toBe(false);
  });

  it('hints on the push path too, so batch and listener cannot drift', async () => {
    const { channel, dmSend } = await channelFor([reaction('\u{1F44E}', NEEDS)]);
    const seen: string[] = [];
    await channel.streamReplies(async (r) => { seen.push(r.text); });
    expect(seen).toEqual([]);
    expect(dmSend).toHaveBeenCalledTimes(1);
  });

  // Unchanged behaviour, and it matters: the line may be shared, so a reaction
  // on anything else must never be reflected back.
  it('still reflects nothing for a reaction on an ordinary status line', async () => {
    const { channel, dmSend } = await channelFor([reaction('\u{1F44D}', 'd25 sent to jiaruizhao@cuhk.edu.hk.')]);
    expect(await channel.captureReplies(200)).toEqual([]);
    expect(dmSend).not.toHaveBeenCalled();
  });
});
```

Import `formatNeedsAddressMessage` from `../src/approval/channel.js` in that file.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/photonChannel.test.ts -t 'answers on-channel'`
Expected: FAIL, `dmSend` was never called.

- [ ] **Step 3: Turn the decode into a three-way result in `src/pipeline/../approval/photonChannel.ts`**

Add to the imports at line 7:

```ts
import { needsAddressDraftId, needsAddressTapbackHint } from './channel.js';
```

Replace `reactionToCommand` (lines 139-156) with:

```ts
// Three outcomes, not two. `hint` exists because a tapback on a NEEDS ADDRESS
// message used to produce total silence: the reacted-to text has no `dN:`
// header (deliberately, that header is what makes a message approvable), so it
// fell into the "reaction on a non-draft message" branch and only logged.
type Decoded =
  | { kind: 'command'; command: string }
  | { kind: 'hint'; text: string }
  | { kind: 'ignore' };

function reactionToDecoded(content: NonNullable<RawMessage['content']>): Decoded {
  const targetText = content.target?.content?.text;
  const shortId = draftIdFromReactedText(targetText);
  if (!shortId) {
    const needs = needsAddressDraftId(targetText);
    if (needs) {
      // Answer, do not act. Whatever emoji it was, the only useful response is
      // the syntax, because this draft cannot be approved until an address
      // exists for it.
      console.log(`photonChannel: reaction on the needs-address message for ${needs}, replying with the syntax`);
      return { kind: 'hint', text: needsAddressTapbackHint(needs) };
    }
    // Reacting to a status line ("d25 sent to ...") or to anything else is a
    // normal human thing to do and must never be read as an instruction, and
    // must never be reflected: the line may be shared.
    console.log('photonChannel: reaction on a non-draft message, ignoring');
    return { kind: 'ignore' };
  }
  const emoji = baseEmoji(content.emoji ?? '');
  if (emoji === THUMBS_UP) return { kind: 'command', command: `${shortId} y` };
  if (emoji === THUMBS_DOWN) return { kind: 'command', command: `${shortId} n` };
  // iMessage also offers heart, laugh, emphasis and question. None of them mean
  // "send this to a stranger", and guessing at intent on the irreversible path
  // is exactly the wrong trade.
  console.log(`photonChannel: reaction on ${shortId} is not a thumbs up or down, ignoring`);
  return { kind: 'ignore' };
}
```

Change `decodeReply`'s return type from `InboundReply | null` to `Decoded2`, defined beside it:

```ts
type Decoded2 = { kind: 'reply'; reply: InboundReply } | { kind: 'hint'; text: string } | { kind: 'ignore' };
```

and rewrite its three `return null` sites as `return { kind: 'ignore' }`, its reaction branch as:

```ts
  if (message.content?.type === 'reaction') {
    const d = reactionToDecoded(message.content);
    if (d.kind === 'ignore') return { kind: 'ignore' };
    if (d.kind === 'hint') return { kind: 'hint', text: d.text };
    console.log(`photonChannel: reaction from approver accepted as "${d.command}" (id ${message.id})`);
    return { kind: 'reply', reply: { text: d.command, messageId: message.id } };
  }
```

and its final `return { text: ..., messageId: ... }` as `return { kind: 'reply', reply: { text: message.content.text, messageId: message.id } }`.

- [ ] **Step 4: Send the hint from both paths**

In `captureReplies`, replace `acceptIfAllowed` (lines 248-251) with:

```ts
      // Async now, because a hint is an outbound message. A send failure here
      // must not abort the drain: an unanswered tapback is bad, a lost approval
      // is worse.
      const acceptIfAllowed = async (value: [unknown, RawMessage]) => {
        const d = decodeReply(value, opts.approverPhone);
        if (d.kind === 'reply') out.push(d.reply);
        else if (d.kind === 'hint') {
          try {
            await dm.send(d.text);
          } catch (err) {
            console.warn(`captureReplies: could not send the needs-address hint: ${String(err)}`);
          }
        }
      };
```

Both call sites (`acceptIfAllowed(next.value)` and `acceptIfAllowed(settled.value)`) become `await acceptIfAllowed(...)`.

In `streamReplies`, replace the decode block (lines 311-312) with:

```ts
          const d = decodeReply(value as [unknown, RawMessage], opts.approverPhone);
          if (d.kind === 'ignore') continue;
          if (d.kind === 'hint') {
            try {
              await dm.send(d.text);
            } catch (err) {
              console.warn(`streamReplies: could not send the needs-address hint: ${String(err)}`);
            }
            continue;
          }
          const reply = d.reply;
```

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/photonChannel.test.ts` → PASS, all pre-existing reaction tests unchanged.
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 6: Mutate to prove the tests can fail**

Change `reactionToDecoded`'s needs-address branch to `return { kind: 'ignore' }`. Confirm the two hint tests go RED and `never becomes an approval` stays GREEN (it must: silence is still safe, just useless). Restore, confirm GREEN.

- [ ] **Step 7: Commit**

```bash
git add src/approval/photonChannel.ts test/photonChannel.test.ts
git commit -m "Answer a tapback on a needs-address message with the correction syntax"
```

---

### Task 5: The correction transaction and its three refusals

**Requires:** Tasks 1 and 3.

**Why:** This is the safety core. Both spec reviewers confirmed that the two-write transaction is what keeps `loadApprovedSend`'s recipient-changed check honest: writing only `drafts.to_email` leaves `people.email` NULL and `'x@y.edu' !== null` returns `recipient_changed` forever; writing only `people.email` returns `no_snapshot`. And a one-digit typo (`d17` for `d70`) would otherwise overwrite a verified address at `confidence 1.0`, make it permanent via the on-record shortcut and `coalesce`, and re-present that draft as tapback-approvable.

**Files:**
- Create: `src/pipeline/addressCorrection.ts`
- Test: `test/address-correction.test.ts` (new)

**Interfaces produced:**

```ts
export type CorrectionResult =
  | { kind: 'applied'; shortId: string; personId: number; personName: string; email: string; nameMatched: boolean }
  | { kind: 'refused'; message: string };

export function applyAddressCorrection(db: DB, draftId: number, rawEmail: string): CorrectionResult;
export function addressRequestDeclined(db: DB, personId: number): boolean;
export function addressWasRequested(db: DB, draftId: number): boolean;
export function pendingAddressCount(db: DB): number;

export interface AddressRequestInput {
  db: DB; notify: (text: string) => Promise<void>;
  arxivId: string; draftId: number; shortId: string;
  personId: number; personName: string; affiliation?: string | null; paperTitle: string;
  rejected: RejectedCandidate[];
}
export async function requestAddress(r: AddressRequestInput): Promise<boolean>;
export function deferAddressRequest(r: Omit<AddressRequestInput, 'notify'>): void;
export interface DeferredAddressRow { arxivId: string; draftId: number; shortId: string; paperTitle: string; }
export function deferredAddressRequests(db: DB, limit: number): DeferredAddressRow[];
export function deferredPayload(db: DB, draftId: number): { personId: number; personName: string; affiliation: string | null; rejected: RejectedCandidate[] } | null;
```

- [ ] **Step 1: Write the failing tests**

Create `test/address-correction.test.ts`:

```ts
// The typo blocker. d17 and d70 are one keystroke apart on a phone, and before
// the three refusals below, `d17 to alice@x.edu` would have overwritten person
// 17's verified address at confidence 1.0, made it permanent (the on-record
// shortcut in orchestrate.ts returns early forever and upsertPerson's
// `email = coalesce(?, email)` cannot displace a non-NULL value), rewritten
// drafts.to_email so loadApprovedSend returns 'ok', and re-presented d17 as a
// normal tapback-approvable draft. One thumbs up then sends a real,
// irreversible cold email to the wrong human.
import { describe, expect, it } from 'vitest';
import { openDb, upsertPerson, getPerson } from '../src/db/db.js';
import { persistDraft, logEvent, loadApprovedSend, decide } from '../src/approval/ledger.js';
import { applyAddressCorrection, addressRequestDeclined, addressWasRequested } from '../src/pipeline/addressCorrection.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Xiyu Zhang', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 'a subject', body: 'a body', grounded: true, wordCount: 2, notes: [] };

function seed(email: string | null, emailSource: string | null = null, name = 'Xiyu Zhang') {
  const db = openDb(':memory:');
  const personId = upsertPerson(db, { name, openalexId: `A-${name}`, email, emailSource: emailSource ?? undefined });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  return { db, personId, ...p };
}

describe('applyAddressCorrection', () => {
  it('writes people.email and drafts.to_email in one transaction, which is what keeps loadApprovedSend honest', () => {
    const { db, draftId, personId } = seed(null);
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'xiyu.zhang@tongji.edu.cn');
    expect(r.kind).toBe('applied');
    const person = getPerson(db, personId)!;
    expect(person.email).toBe('xiyu.zhang@tongji.edu.cn');
    expect(person.email_source).toBe('user_provided');
    expect(person.email_confidence).toBe(1);
    const to = (db.prepare('SELECT to_email AS t FROM drafts WHERE id = ?').get(draftId) as { t: string }).t;
    expect(to).toBe('xiyu.zhang@tongji.edu.cn');
    // The pair assertion. Either half alone passes for the wrong reason.
    decide(db, draftId, 'send', 'imessage');
    expect(loadApprovedSend(db, draftId).kind).toBe('ok');
    upsertPerson(db, { name: 'Xiyu Zhang', openalexId: 'A-Xiyu Zhang', email: 'someone.else@tongji.edu.cn' });
    expect(loadApprovedSend(db, draftId).kind).toBe('recipient_changed');
  });

  it('REFUSES a correction that would overwrite a machine-verified address', () => {
    const { db, draftId, personId } = seed('verified@tongji.edu.cn', 'homepage');
    const r = applyAddressCorrection(db, draftId, 'alice@x.edu');
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.message).toContain('verified@tongji.edu.cn');
    expect(getPerson(db, personId)!.email).toBe('verified@tongji.edu.cn');
    expect((db.prepare('SELECT to_email AS t FROM drafts WHERE id = ?').get(draftId) as { t: string | null }).t)
      .toBe('verified@tongji.edu.cn');
  });

  it('ALLOWS re-correcting your own typo, because that value is user_provided', () => {
    const { db, draftId, personId } = seed('typo@x.edu', 'user_provided');
    logEvent(db, draftId, 'address_requested', { personId });
    expect(applyAddressCorrection(db, draftId, 'correct@x.edu').kind).toBe('applied');
    expect(getPerson(db, personId)!.email).toBe('correct@x.edu');
  });

  it('REFUSES when no address was requested for this draft and the person already has one', () => {
    const { db, draftId, personId } = seed('earlier@x.edu', 'user_provided');
    const r = applyAddressCorrection(db, draftId, 'alice@x.edu');
    expect(r.kind).toBe('refused');
    expect(getPerson(db, personId)!.email).toBe('earlier@x.edu');
  });

  it('ALLOWS a draft with no request whose person has no address, which is outreach add\'s manual queue', () => {
    const { db, draftId } = seed(null);
    expect(applyAddressCorrection(db, draftId, 'alice@x.edu').kind).toBe('applied');
  });

  it('reports whether the address names the person, advisorily, without gating on it', () => {
    const { db, draftId, personId } = seed(null);
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'ishen@stu.hit.edu.cn');
    // Applied ANYWAY. Gating on nameMatches would be circular (it is the check
    // that just failed) and would block the unusual-but-correct addresses this
    // feature exists to rescue.
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.nameMatched).toBe(false);
  });

  // Reached only by calling this function directly: parseReply splits on
  // /\s+/, so no whitespace-bearing address can ever arrive through it, and a
  // test written through parseReply could not fail.
  it('refuses a header-injection shaped address without writing anything', () => {
    const { db, draftId, personId } = seed(null);
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'a@b.edu\r\nBcc: evil@x.com');
    expect(r.kind).toBe('refused');
    expect(getPerson(db, personId)!.email).toBeNull();
  });

  it('refuses a draft that has already been decided or attempted', () => {
    for (const setup of ['skipped', 'attempted'] as const) {
      const { db, draftId, personId } = seed(null);
      logEvent(db, draftId, 'address_requested', { personId });
      if (setup === 'skipped') decide(db, draftId, 'skip', 'imessage');
      else {
        decide(db, draftId, 'send', 'imessage');
        db.prepare("UPDATE drafts SET send_attempted_at = datetime('now') WHERE id = ?").run(draftId);
      }
      expect(applyAddressCorrection(db, draftId, 'alice@x.edu').kind).toBe('refused');
      expect(getPerson(db, personId)!.email).toBeNull();
    }
  });

  it('clears the stale seen_papers reason so outreach stranded stops printing a resolved item', () => {
    const { db, draftId, personId, shortId } = seed(null);
    db.prepare(
      `INSERT INTO seen_papers (arxiv_id, title, discovered_via, status, reason, draft_id)
       VALUES ('2601.00001','A Paper','saved_query','drafted_unsendable',?,?)`,
    ).run(`awaiting address correction (${shortId}): rejected wrong@x.edu`, draftId);
    logEvent(db, draftId, 'address_requested', { personId });
    applyAddressCorrection(db, draftId, 'alice@x.edu');
    const reason = (db.prepare('SELECT reason AS r FROM seen_papers WHERE arxiv_id = ?').get('2601.00001') as { r: string }).r;
    expect(reason).toBe(`address corrected (${shortId})`);
  });
});

describe('the durable decline record', () => {
  it('is keyed on the person, because the re-ask arrives on a different draft', () => {
    const { db, draftId, personId } = seed(null);
    expect(addressRequestDeclined(db, personId)).toBe(false);
    logEvent(db, draftId, 'address_requested', { personId });
    expect(addressWasRequested(db, draftId)).toBe(true);
    logEvent(db, draftId, 'address_request_declined', { personId });
    expect(addressRequestDeclined(db, personId)).toBe(true);
    expect(addressRequestDeclined(db, personId + 999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/address-correction.test.ts`
Expected: FAIL, cannot resolve `../src/pipeline/addressCorrection.js`.

- [ ] **Step 3: Create `src/pipeline/addressCorrection.ts`**

```ts
// The one place a human-supplied address becomes state. Split out of loop.ts
// so both the batch loop and `outreach listen` reach the identical logic
// through handleReply and cannot drift, and so it is testable without a
// channel or a sender.
//
// This module writes state. It never sends. A corrected draft still requires a
// separate explicit `dN y`, which runs the unchanged send path: decide
// first-write-wins, loadApprovedSend, assertSafeOutbound, beginSendAttempt's
// conditional UPDATE, markSent. Nothing here bypasses any of it.
import { parse as parseHost } from 'tldts';
import type { DB } from '../db/db.js';
import { formatShortId } from '../approval/ids.js';
import { logEvent } from '../approval/ledger.js';
import { setStatus } from '../discovery/seenLedger.js';
import { formatNeedsAddressMessage } from '../approval/channel.js';
import { nameMatches, type RejectedCandidate } from './contacts.js';

// Belt and braces beside assertSafeOutbound, which stays the real gate. This
// exists only so a malformed reply is refused with a useful message at
// correction time instead of at send time. Same shape as SINGLE_ADDRESS in
// sender/types.ts: exactly one bare address, no display name, no comma, no
// angle brackets.
const CORRECTION_SHAPE = /^[^\s<>,;:\\"]+@[^\s<>,;:\\"]+\.[^\s<>,;:\\"]+$/;

// The two reasons this feature writes into seen_papers.reason. Spelled out in
// full in both places they are used (here and in strandedReport) so the
// predicate that makes a row stranded and the predicate that un-strands it
// cannot drift. A collapsed pattern like 'a%address correction%' looks tempting
// and is wrong: it does not match 'address correction not yet requested'.
export const AWAITING_REASON_LIKE = 'awaiting address correction%';
export const DEFERRED_REASON_LIKE = 'address correction not yet requested%';

export type CorrectionResult =
  | { kind: 'applied'; shortId: string; personId: number; personName: string; email: string; nameMatched: boolean }
  | { kind: 'refused'; message: string };

export function addressWasRequested(db: DB, draftId: number): boolean {
  return (
    db.prepare("SELECT 1 FROM draft_events WHERE draft_id = ? AND type = 'address_requested'").get(draftId) !== undefined
  );
}

// Keyed on the PERSON, not the draft. `dN n` sets drafts.status = 'skipped',
// and priorThreads (ledger.ts) matches only sent%/approved/awaiting_approval,
// so a skip UNBLOCKS the person while leaving people.email NULL. The next paper
// by the same author would then re-draft and re-ask, forever. The re-ask
// arrives on a different draft id, so a per-draft record could never suppress
// it. json_extract on draft_events is the same shape stallAlreadyReported
// already uses, so no migration is needed.
export function addressRequestDeclined(db: DB, personId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM draft_events
          WHERE type = 'address_request_declined'
            AND json_extract(detail_json, '$.personId') = ?`,
      )
      .get(personId) !== undefined
  );
}

export function pendingAddressCount(db: DB): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM seen_papers
          WHERE status = 'drafted_unsendable'
            AND (reason LIKE ? OR reason LIKE ?)`,
      )
      .get(AWAITING_REASON_LIKE, DEFERRED_REASON_LIKE) as { n: number }
  ).n;
}

interface DraftRow {
  shortId: string;
  status: string;
  attemptedAt: string | null;
  personId: number;
  personName: string;
  personEmail: string | null;
  personEmailSource: string | null;
}

export function applyAddressCorrection(db: DB, draftId: number, rawEmail: string): CorrectionResult {
  const email = rawEmail.trim();
  const row = db
    .prepare(
      `SELECT d.short_id AS shortId, d.status AS status, d.send_attempted_at AS attemptedAt,
              d.person_id AS personId, p.name AS personName, p.email AS personEmail,
              p.email_source AS personEmailSource
         FROM drafts d JOIN people p ON p.id = d.person_id
        WHERE d.id = ?`,
    )
    .get(draftId) as DraftRow | undefined;
  if (!row) return { kind: 'refused', message: `No draft found for ${formatShortId(draftId)}. Nothing recorded.` };

  if (!CORRECTION_SHAPE.test(email)) {
    return {
      kind: 'refused',
      message: `${row.shortId} not changed: that is not a single plain address. Nothing recorded.`,
    };
  }

  // Which drafts may be corrected, decided by what the send path can still
  // refuse. awaiting_approval covers the needs-address flow and `outreach
  // add`'s manual-lookup queue. approved-with-no-attempt is the remedy for the
  // no_snapshot and recipient_changed refusals, both of which return before the
  // claim; a further explicit `dN y` is still required.
  if (row.status !== 'awaiting_approval' && row.status !== 'approved') {
    return {
      kind: 'refused',
      message: `${row.shortId} is ${row.status}. The recipient of a decided draft is never rewritten. Nothing recorded.`,
    };
  }
  if (row.attemptedAt !== null) {
    // The one send attempt is spent and Gmail's outcome is unknown. Nothing
    // here may resolve that.
    return {
      kind: 'refused',
      message: `${row.shortId} already has a send attempt recorded at ${row.attemptedAt}. Nothing recorded; check the Gmail Sent folder.`,
    };
  }

  // Refusal 2, the typo blocker. d17 and d70 are one keystroke apart. Aiming at
  // a person the machine already resolved would overwrite a verified address
  // permanently, because runContactExtraction's on-record shortcut
  // (orchestrate.ts:150-155) returns early forever once people.email is set and
  // upsertPerson's `email = coalesce(?, email)` cannot displace a non-NULL
  // value. Both intended uses survive by construction: the needs-address flow
  // has people.email NULL, and re-correcting your own typo overwrites a
  // 'user_provided' value.
  if (row.personEmail && row.personEmailSource !== 'user_provided') {
    return {
      kind: 'refused',
      message:
        `${row.shortId} not changed: ${row.personName} already has ${row.personEmail} on record ` +
        `(${row.personEmailSource ?? 'unknown source'}). Did you mean a different draft? Nothing recorded.`,
    };
  }

  // Refusal 3, the residue Refusal 2 lets through: aiming at a person whose
  // stored address is already 'user_provided' from an earlier correction.
  if (row.personEmail && !addressWasRequested(db, draftId)) {
    return {
      kind: 'refused',
      message:
        `${row.shortId} not changed: no address was requested for it, and ${row.personName} already has ` +
        `${row.personEmail}. Nothing recorded.`,
    };
  }

  // Advisory only, never a gate. Running the check that just failed as a gate
  // would be circular, and it would block the unusual-but-correct addresses
  // this feature exists to rescue (ishen@stu.hit.edu.cn for Xiongri Shen is the
  // measured example). As an echo it costs nothing and surfaces the typo class
  // from a second direction.
  const localPart = email.slice(0, email.lastIndexOf('@'));
  const host = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const nameMatched = nameMatches(localPart, row.personName);
  const registrable = parseHost(`http://${host}`).domain ?? host;

  db.transaction(() => {
    // Both writes are mandatory and neither alone works. Writing only
    // drafts.to_email leaves people.email NULL, and loadApprovedSend compares
    // row.toEmail !== row.currentEmail (ledger.ts:192), so 'x@y.edu' !== null
    // returns recipient_changed and the send is refused forever. Writing only
    // people.email leaves the frozen snapshot NULL and returns no_snapshot.
    db.prepare(
      `UPDATE people SET email = ?, email_confidence = 1.0, email_source = 'user_provided',
              updated_at = datetime('now') WHERE id = ?`,
    ).run(email, row.personId);
    db.prepare('UPDATE drafts SET to_email = ? WHERE id = ?').run(email, draftId);
    // Third write. Without it the seen_papers row still reads 'awaiting address
    // correction' after a successful send, and `outreach stranded` prints a
    // resolved item forever. The row stays at drafted_unsendable on purpose:
    // the paper was never messaged as a draft candidate, so promoting it would
    // claim something that has not happened.
    db.prepare(
      `UPDATE seen_papers SET reason = ?, updated_at = datetime('now')
        WHERE draft_id = ? AND status = 'drafted_unsendable'
          AND (reason LIKE ? OR reason LIKE ?)`,
    ).run(`address corrected (${row.shortId})`, draftId, AWAITING_REASON_LIKE, DEFERRED_REASON_LIKE);
    logEvent(db, draftId, 'address_corrected', {
      personId: row.personId,
      personName: row.personName,
      priorEmail: row.personEmail,
      priorEmailSource: row.personEmailSource,
      correctedEmail: email,
      correctedHost: host,
      correctedDomain: registrable,
      priorDraftStatus: row.status,
      nameMatched,
      via: 'imessage',
    });
  })();

  return {
    kind: 'applied',
    shortId: row.shortId,
    personId: row.personId,
    personName: row.personName,
    email,
    nameMatched,
  };
}

// --- Requesting an address ------------------------------------------------

export interface AddressRequestInput {
  db: DB;
  notify: (text: string) => Promise<void>;
  arxivId: string;
  draftId: number;
  shortId: string;
  personId: number;
  personName: string;
  affiliation?: string | null;
  paperTitle: string;
  rejected: RejectedCandidate[];
}

const REASON_MSG: Record<RejectedCandidate['reason'], string> = {
  identity_mismatch: 'the local part names a different person',
};

function messageFor(r: Omit<AddressRequestInput, 'notify' | 'db'>): string {
  return formatNeedsAddressMessage({
    shortId: r.shortId,
    personName: r.personName,
    affiliation: r.affiliation,
    paperTitle: r.paperTitle,
    rejected: r.rejected.map((x) => ({ email: x.email, source: x.source, reason: REASON_MSG[x.reason] })),
  });
}

function payload(r: Omit<AddressRequestInput, 'notify' | 'db'>): Record<string, unknown> {
  return {
    personId: r.personId,
    personName: r.personName,
    affiliation: r.affiliation ?? null,
    paperTitle: r.paperTitle,
    rejected: r.rejected,
    via: 'loop',
  };
}

// Returns false when the text could not be delivered, having parked the row so
// the next run's drain retries it. Mirrors `emit`'s failure handling in loop.ts.
export async function requestAddress(r: AddressRequestInput): Promise<boolean> {
  const first = r.rejected[0]?.email ?? 'unknown';
  try {
    await r.notify(messageFor(r));
  } catch {
    deferAddressRequest(r);
    return false;
  }
  // The draft id is load-bearing, not tidiness: strandedReport's orphanDrafts
  // query excludes drafts a seen_papers row points at. Without it, the moment a
  // correction sets people.email the draft appears as an orphan and `outreach
  // stranded` raises that alarm forever.
  setStatus(r.db, r.arxivId, 'drafted_unsendable', `awaiting address correction (${r.shortId}): rejected ${first}`, r.draftId);
  logEvent(r.db, r.draftId, 'address_requested', payload(r));
  return true;
}

// The per-run address budget is spent, or the text failed. The event carries
// the full structured payload so the drain can rebuild the exact message later
// instead of parsing the address back out of a reason string.
export function deferAddressRequest(r: Omit<AddressRequestInput, 'notify'>): void {
  const first = r.rejected[0]?.email ?? 'unknown';
  setStatus(
    r.db, r.arxivId, 'drafted_unsendable',
    `address correction not yet requested (${r.shortId}): rejected ${first}`, r.draftId,
  );
  logEvent(r.db, r.draftId, 'address_request_deferred', payload(r));
}

export interface DeferredAddressRow {
  arxivId: string;
  draftId: number;
  shortId: string;
  paperTitle: string;
}

// Oldest first. Restricted to drafts still awaiting a decision whose person
// still has no address, so a correction that landed via another draft, or a
// `dN n`, silently drops the row out of the queue instead of re-asking.
export function deferredAddressRequests(db: DB, limit: number): DeferredAddressRow[] {
  return db
    .prepare(
      `SELECT s.arxiv_id AS arxivId, s.draft_id AS draftId, d.short_id AS shortId, d.paper_title AS paperTitle
         FROM seen_papers s
         JOIN drafts d ON d.id = s.draft_id
         JOIN people p ON p.id = d.person_id
        WHERE s.status = 'drafted_unsendable'
          AND s.reason LIKE ?
          AND d.status = 'awaiting_approval'
          AND p.email IS NULL
        ORDER BY s.first_seen_at ASC, s.arxiv_id ASC
        LIMIT ?`,
    )
    .all(DEFERRED_REASON_LIKE, limit) as DeferredAddressRow[];
}

export function deferredPayload(
  db: DB,
  draftId: number,
): { personId: number; personName: string; affiliation: string | null; rejected: RejectedCandidate[] } | null {
  const row = db
    .prepare(
      `SELECT detail_json AS detail FROM draft_events
        WHERE draft_id = ? AND type = 'address_request_deferred' ORDER BY id DESC LIMIT 1`,
    )
    .get(draftId) as { detail: string | null } | undefined;
  if (!row?.detail) return null;
  try {
    const d = JSON.parse(row.detail) as { personId: number; personName: string; affiliation: string | null; rejected: RejectedCandidate[] };
    return { personId: d.personId, personName: d.personName, affiliation: d.affiliation ?? null, rejected: d.rejected ?? [] };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Extend the source-level tapback guard**

Add the new module to `SOURCES` in `test/notify-tapback-safety.test.ts` (line 21):

```ts
const SOURCES = ['src/pipeline/loop.ts', 'src/pipeline/listen.ts', 'src/cli.ts', 'src/pipeline/addressCorrection.ts'];
```

Do NOT write a second copy of this test. Commit 733c3c9 created it precisely so new modules get covered by adding one string.

- [ ] **Step 5: Run the tests and the full suite**

Run: `npx vitest run test/address-correction.test.ts test/notify-tapback-safety.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 6: Mutate to prove the tests can fail**

Three mutations, all mandatory, because these are the three independent halves of the typo blocker:
1. Delete the Refusal 2 block. Confirm `REFUSES a correction that would overwrite a machine-verified address` goes RED. Restore.
2. Delete the `UPDATE drafts SET to_email` line from the transaction. Confirm the first test goes RED at `loadApprovedSend(db, draftId).kind === 'ok'` (it will report `recipient_changed`). Restore.
3. Delete the `UPDATE seen_papers` statement. Confirm `clears the stale seen_papers reason` goes RED. Restore, confirm GREEN.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/addressCorrection.ts test/address-correction.test.ts test/notify-tapback-safety.test.ts
git commit -m "Add the address-correction transaction and its three refusals"
```

---

### Task 6: Wire the correction into `handleReply`, and fix two help strings

**Requires:** Tasks 3 and 5.

**Why:** `handleReply` is the single place both the batch loop and `outreach listen` act on a reply, which is the argument the tapback path already rests on. Separately, the two most likely replies to a NEEDS ADDRESS message from someone who has not memorised the syntax currently get actively wrong advice, and one of them tells him to approve a draft the system just flagged as going to the wrong person.

**Files:**
- Modify: `src/pipeline/loop.ts` (`handleReply` only)
- Test: `test/send-path.test.ts`

**Interfaces produced:** none. `handleReply`'s signature is unchanged, and it must still touch only `summary.sent`, which `test/listen.test.ts:447` pins.

- [ ] **Step 1: Write the failing tests**

Append to `test/send-path.test.ts`, reusing its `seed()` helper and `createStubChannel`:

```ts
describe('address correction through handleReply', () => {
  const summary = (): LoopSummary => ({
    dryRun: false, sent: 0, seen: 0, filtered: 0, unsendable: 0, messaged: 0,
    queued: 0, wouldMessage: 0, resumed: 0, retryable: 0, stranded: 0, errors: [],
  });

  it('records the address, names the PERSON in the acknowledgement, and re-presents the draft', async () => {
    const db = openDb(':memory:');
    const p = seed(db, null);
    logEvent(db, p.draftId, 'address_requested', { personId: p.personId });
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: false }, summary(), {
      text: `${p.shortId} to jane.doe@uni.edu`,
    });
    // The name is the only token in the acknowledgement he can check against
    // what he intended. Without it, a one-digit typo in the draft id is silent.
    expect(channel.notices[0]).toBe('Recorded jane.doe@uni.edu for Jane Doe (d1). Nothing sent yet.');
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]!.to).toBe('jane.doe@uni.edu');
  });

  it('adds the advisory sentence when the address does not name the person', async () => {
    const db = openDb(':memory:');
    const p = seed(db, null);
    logEvent(db, p.draftId, 'address_requested', { personId: p.personId });
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: false }, summary(), {
      text: `${p.shortId} to zz9@uni.edu`,
    });
    expect(channel.notices[0]).toContain('The local part does not name that person.');
  });

  it('sends nothing and passes the refusal through', async () => {
    const db = openDb(':memory:');
    const p = seed(db, 'verified@uni.edu'); // email_source is NULL, not user_provided
    const send = vi.fn();
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send } }, { dryRun: false }, summary(), {
      text: `${p.shortId} to alice@x.edu`,
    });
    expect(send).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
    expect(channel.notices[0]).toContain('not changed');
    expect((db.prepare('SELECT email AS e FROM people WHERE id = ?').get(p.personId) as { e: string }).e)
      .toBe('verified@uni.edu');
  });

  it('records nothing in a dry run', async () => {
    const db = openDb(':memory:');
    const p = seed(db, null);
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: true }, summary(), {
      text: `${p.shortId} to jane.doe@uni.edu`,
    });
    expect(channel.notices[0]).toContain('DRY RUN');
    expect((db.prepare('SELECT email AS e FROM people WHERE id = ?').get(p.personId) as { e: string | null }).e).toBeNull();
  });

  // Skipping unblocks the person (priorThreads does not match 'skipped') while
  // leaving people.email NULL, so without this the next paper by the same
  // author re-drafts and re-asks, forever.
  it('records a durable per-person decline when a needs-address draft is skipped', async () => {
    const db = openDb(':memory:');
    const p = seed(db, null);
    logEvent(db, p.draftId, 'address_requested', { personId: p.personId });
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: false }, summary(), {
      text: `${p.shortId} n`,
    });
    expect(addressRequestDeclined(db, p.personId)).toBe(true);
  });

  it('does not record a decline when an ordinary draft is skipped', async () => {
    const db = openDb(':memory:');
    const p = seed(db, 'jane@uni.edu');
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: false }, summary(), {
      text: `${p.shortId} n`,
    });
    expect(addressRequestDeclined(db, p.personId)).toBe(false);
  });
});

describe('help strings advertise the correction syntax', () => {
  const summary = (): LoopSummary => ({
    dryRun: false, sent: 0, seen: 0, filtered: 0, unsendable: 0, messaged: 0,
    queued: 0, wouldMessage: 0, resumed: 0, retryable: 0, stranded: 0, errors: [],
  });

  // Measured: parseReply('alice@x.edu') is 'unparseable', and
  // parseReply('d1 alice@x.edu') is 'unsupported'. Both are likely replies to a
  // NEEDS ADDRESS message, and the second currently tells him to APPROVE a
  // draft flagged as going to the wrong person.
  it('tells a bare address how to be typed', async () => {
    const db = openDb(':memory:');
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: false }, summary(), { text: 'alice@x.edu' });
    expect(channel.notices[0]).toContain('to their@address.edu');
  });

  it('tells "dN addr" how to be typed, and does not tell him to approve it', async () => {
    const db = openDb(':memory:');
    const p = seed(db, null);
    const channel = createStubChannel();
    await handleReply({ db, channel, sender: { send: vi.fn() } }, { dryRun: false }, summary(), {
      text: `${p.shortId} alice@x.edu`,
    });
    expect(channel.notices[0]).toContain(`"${p.shortId} to their@address.edu"`);
  });
});
```

Add to that file's imports: `logEvent` from `../src/approval/ledger.js`, and `addressRequestDeclined` from `../src/pipeline/addressCorrection.js`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/send-path.test.ts -t 'address correction through handleReply'`
Expected: FAIL, the acknowledgement is `Edits are not yet supported for d1. ...`.

- [ ] **Step 3: Rewrite the two help strings in `src/pipeline/loop.ts`**

Line 225:

```ts
    await deps.channel.notify(
      `Could not read "${reply.text}". Reply like "d7 y", "d7 n", or "d7 to their@address.edu".`,
    );
```

Line 239:

```ts
    await deps.channel.notify(
      `Edits are not yet supported for ${parsed.shortId}. Reply "${parsed.shortId} to their@address.edu" to set ` +
        `the address, "${parsed.shortId} y" to send, or "${parsed.shortId} n" to skip.`,
    );
```

Neither begins with `dN:`, which `test/notify-tapback-safety.test.ts` enforces.

- [ ] **Step 4: Extend the dry-run notice and add the address branch**

Replace the dry-run block (lines 249-254) with:

```ts
  if (opts.dryRun) {
    await deps.channel.notify(
      parsed.kind === 'address'
        ? `${parsed.shortId} DRY RUN: would record ${parsed.email}. Nothing recorded and nothing sent.`
        : `${parsed.shortId} DRY RUN: nothing recorded and nothing sent (would ${parsed.kind}).`,
    );
    return;
  }

  // A correction writes state and never sends. A further explicit
  // "dN y" is still required, and it runs the identical, unmodified send path.
  if (parsed.kind === 'address') {
    const outcome = applyAddressCorrection(deps.db, draftId, parsed.email);
    if (outcome.kind === 'refused') {
      await deps.channel.notify(outcome.message);
      return;
    }
    // Names the PERSON, not just the id and the address. d17 and d70 are one
    // keystroke apart, and the name is the only token here he can check against
    // what he meant. Same argument as the SENT confirmation below.
    await deps.channel.notify(
      `Recorded ${outcome.email} for ${outcome.personName} (${outcome.shortId}).` +
        (outcome.nameMatched ? '' : ' The local part does not name that person.') +
        ` Nothing sent yet.`,
    );
    // Present it in the standard format so tapback works on it as on any other
    // draft. Not counted against max_messages_per_run: it is one message per
    // reply he typed, so it is self-limiting, and a run's cap has no meaning
    // inside `outreach listen`, which has no run.
    const rev = deps.db
      .prepare(
        `SELECT r.subject AS subject, r.body AS body, p.email AS toEmail, p.name AS personName
           FROM drafts d
           JOIN people p ON p.id = d.person_id
           LEFT JOIN revisions r ON r.id = d.sendable_revision_id
          WHERE d.id = ?`,
      )
      .get(draftId) as { subject: string | null; body: string | null; toEmail: string | null; personName: string } | undefined;
    if (rev?.body && rev.toEmail) {
      await deps.channel.sendDraftMessage({
        shortId: outcome.shortId,
        subject: rev.subject ?? '',
        body: rev.body,
        to: rev.toEmail,
        personName: rev.personName,
      });
    }
    return;
  }
```

Note the acknowledgement is built with a leading space before `Nothing sent yet.` and no space before the advisory clause, so the matched case reads exactly `Recorded x@y.edu for Jane Doe (d1). Nothing sent yet.`

- [ ] **Step 5: Record the decline in the skip branch**

Replace the skip branch (lines 256-262) with:

```ts
  if (parsed.kind === 'skip') {
    const res = decide(deps.db, draftId, 'skip', 'imessage');
    // A skip clears the DRAFT but not the PERSON: priorThreads matches only
    // sent%/approved/awaiting_approval, so 'skipped' unblocks them, and
    // people.email is still NULL, so the next paper by the same author would
    // re-draft and re-ask forever. Record the decline against the person.
    if (res.applied && addressWasRequested(deps.db, draftId)) {
      const owner = deps.db.prepare('SELECT person_id AS personId FROM drafts WHERE id = ?').get(draftId) as
        | { personId: number }
        | undefined;
      if (owner) logEvent(deps.db, draftId, 'address_request_declined', { personId: owner.personId });
    }
    await deps.channel.notify(
      res.applied ? `${parsed.shortId} skipped.` : `${parsed.shortId} was already ${res.existing.action}.`,
    );
    return;
  }
```

Add to loop.ts's imports:

```ts
import { addressWasRequested, applyAddressCorrection } from './addressCorrection.js';
```

- [ ] **Step 6: Run the tests and the full suite**

Run: `npx vitest run test/send-path.test.ts` → PASS
Run: `npx vitest run test/listen.test.ts -t 'touches only the sent field'` → **must still pass**. The correction path writes no summary field; if this fails, something in Step 4 touched `summary`.
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 7: Mutate to prove the tests can fail**

1. Change the acknowledgement to `Recorded ${outcome.email} (${outcome.shortId}). Nothing sent yet.` Confirm the first test goes RED. Restore.
2. Remove the `logEvent(..., 'address_request_declined', ...)` call. Confirm the decline test goes RED. Restore, confirm GREEN.

- [ ] **Step 8: Commit**

```bash
git add src/pipeline/loop.ts test/send-path.test.ts
git commit -m "Handle dN to addr in handleReply, and stop the help strings giving wrong advice"
```

---

### Task 7: The needs-address branch, its own budget, and the backlog drain

**Requires:** Tasks 2 and 5.

**Why:** This is where the failure this spec exists for actually gets caught. It must not silently consume `max_messages_per_run` slots that would otherwise deliver approvable drafts, and it must not be conflated with `summary.messaged` in the run summary line (`loop.ts:894-906`). The deferred backlog needs a drain, because a `drafted_unsendable` row is terminal and nothing revisits it.

**Files:**
- Modify: `src/discovery/config.ts`, `src/pipeline/loop.ts`
- Test: `test/loop.test.ts`

**Interfaces produced:**

```ts
// src/discovery/config.ts
export interface GateConfig { /* ... */ maxAddressRequestsPerRun?: number; }   // OPTIONAL
// src/pipeline/loop.ts
export interface LoopSummary { /* ... */ addressRequested?: number; addressesPending?: number; }  // BOTH OPTIONAL
```

- [ ] **Step 1: Write the failing tests**

Append to `test/loop.test.ts`, inside `describe('runLoop discovery', ...)`:

```ts
  const rejectedResult = (arxivId: string, personId: number): OrchestrateResult => ({
    ...resolvedResult(arxivId, personId),
    email: null,
    rejectedEmails: [{ email: 'someoneelse@uni.edu', source: 'homepage', reason: 'identity_mismatch' }],
  });

  it('drafts, asks for the address, and parks the row with its draft id attached', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00020', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(rejectedResult('2601.00020', pid)),
    });
    await runLoop(deps, { dryRun: false });
    // The message, not a draft message: a draft message begins "dN:" and is
    // tapback-approvable, which would let one thumbs up send the very email
    // that was flagged as going to the wrong person.
    expect(channel.sent).toHaveLength(0);
    const needs = channel.notices.find((n) => n.startsWith('NEEDS ADDRESS'));
    expect(needs).toBeDefined();
    expect(needs).toContain('someoneelse@uni.edu');
    const row = db.prepare('SELECT status, reason, draft_id AS draftId FROM seen_papers WHERE arxiv_id = ?')
      .get('2601.00020') as { status: string; reason: string; draftId: number | null };
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toMatch(/^awaiting address correction \(d\d+\): rejected someoneelse@uni\.edu$/);
    // Load-bearing: without it, a successful correction makes strandedReport's
    // orphanDrafts query raise a permanent false alarm.
    expect(row.draftId).not.toBeNull();
  });

  it('still reports no email resolved when nothing was rejected', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00021', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue({ ...resolvedResult('2601.00021', pid), email: null }),
    });
    await runLoop(deps, { dryRun: false });
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00021') as { reason: string };
    expect(row.reason).toBe('no email resolved');
  });

  // The budget-separation regression. GATE.maxMessagesPerRun is 3 in this
  // file, and maxAddressRequestsPerRun defaults to 3, so three approvable
  // drafts AND an address request must all go out in one run.
  it('does not let an address request consume a message slot', async () => {
    const db = openDb(':memory:');
    const ids = ['2601.00030', '2601.00031', '2601.00032'];
    const people = ids.map((_, i) => upsertPerson(db, { name: `Person ${i}`, openalexId: `A${i}` }));
    const needy = upsertPerson(db, { name: 'Needy', openalexId: 'A-needy' });
    const byId: Record<string, OrchestrateResult> = {};
    ids.forEach((a, i) => { byId[a] = resolvedResult(a, people[i]!); });
    byId['2601.00033'] = rejectedResult('2601.00033', needy);
    const { deps, channel } = baseDeps(db, {
      sources: [source([...ids, '2601.00033'].map((a) => cand(a, 'Olfactory Embedding Space Sensors')))],
      processPaper: vi.fn(async (_d: unknown, a: string) => byId[a]!),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(3);              // the cap is fully spent on drafts
    expect(summary.addressRequested).toBe(1);      // and the request still went out
    expect(channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(1);
  });

  it('defers past its own budget without touching queued_for_message', async () => {
    const db = openDb(':memory:');
    const ids = ['2601.00040', '2601.00041', '2601.00042', '2601.00043'];
    const byId: Record<string, OrchestrateResult> = {};
    ids.forEach((a, i) => { byId[a] = rejectedResult(a, upsertPerson(db, { name: `P${i}`, openalexId: `B${i}` })); });
    const { deps, channel } = baseDeps(db, {
      sources: [source(ids.map((a) => cand(a, 'Olfactory Embedding Space Sensors')))],
      processPaper: vi.fn(async (_d: unknown, a: string) => byId[a]!),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.addressRequested).toBe(3);
    expect(channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(3);
    const deferred = db.prepare(
      `SELECT status, reason FROM seen_papers WHERE reason LIKE 'address correction not yet requested%'`,
    ).all() as { status: string; reason: string }[];
    expect(deferred).toHaveLength(1);
    // queued_for_message is the wrong resting place: runLoop's flush would call
    // resolveSendableDraft, hit the no_email branch, and RETIRE the draft with
    // decide(skip), destroying the very draft the correction waits for.
    expect(deferred[0]!.status).toBe('drafted_unsendable');
  });

  it('drains the deferred backlog on the next run', async () => {
    const db = openDb(':memory:');
    const ids = ['2601.00040', '2601.00041', '2601.00042', '2601.00043'];
    const byId: Record<string, OrchestrateResult> = {};
    ids.forEach((a, i) => { byId[a] = rejectedResult(a, upsertPerson(db, { name: `P${i}`, openalexId: `C${i}` })); });
    const first = baseDeps(db, {
      sources: [source(ids.map((a) => cand(a, 'Olfactory Embedding Space Sensors')))],
      processPaper: vi.fn(async (_d: unknown, a: string) => byId[a]!),
    });
    await runLoop(first.deps, { dryRun: false });
    const second = baseDeps(db, { sources: [source([])] });
    const summary = await runLoop(second.deps, { dryRun: false });
    expect(summary.addressRequested).toBe(1);
    expect(second.channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM seen_papers WHERE reason LIKE 'address correction not yet requested%'`)
      .get()).toEqual({ n: 0 });
  });

  it('never asks again about a person who declined', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00050', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(rejectedResult('2601.00050', pid)),
    });
    // Stand in for an earlier "dN n" on a different draft for the same person.
    logEvent(db, null, 'address_request_declined', { personId: pid });
    await runLoop(deps, { dryRun: false });
    expect(channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(0);
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00050') as { reason: string };
    expect(row.reason).toBe('address correction declined for this person');
  });

  it('puts the pending backlog in the run summary, because a CLI command is somewhere he has to go', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00060', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(rejectedResult('2601.00060', pid)),
    });
    await runLoop(deps, { dryRun: false });
    const line = channel.notices[channel.notices.length - 1]!;
    expect(line).toContain('address requests 1');
    expect(line).toContain('addresses pending 1');
  });
```

Add `logEvent` to that file's import from `../src/approval/ledger.js`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/loop.test.ts -t 'asks for the address'`
Expected: FAIL, the reason is `no email resolved` and no NEEDS ADDRESS notice exists.

- [ ] **Step 3: Add the optional config key in `src/discovery/config.ts`**

In `GateConfig`, after `maxResumeAttempts`:

```ts
  // Its own bound, deliberately not shared with maxMessagesPerRun: a draft
  // message can be approved with one tap, an address request costs a human
  // lookup, so sharing the cap would let a request silently displace an
  // approvable draft. OPTIONAL because three test files build a
  // GateConfig-shaped literal and a required field breaks all three.
  maxAddressRequestsPerRun?: number;
```

In `RawFile.gate`, add `max_address_requests_per_run?: number;`. In `DEFAULT_GATE`, add `maxAddressRequestsPerRun: 3,`. In `loadConfig`'s returned `gate`, add:

```ts
      maxAddressRequestsPerRun: raw.gate?.max_address_requests_per_run ?? DEFAULT_GATE.maxAddressRequestsPerRun,
```

- [ ] **Step 4: Add the summary fields and the branch in `src/pipeline/loop.ts`**

Add to the imports:

```ts
import {
  addressRequestDeclined,
  deferAddressRequest,
  deferredAddressRequests,
  deferredPayload,
  pendingAddressCount,
  requestAddress,
} from './addressCorrection.js';
```

(merge with the Task 6 import from the same module).

Add to `LoopSummary`, after `stalled?`:

```ts
  // Needs-address texts sent this run. Deliberately NOT `messaged`: nothing was
  // messaged as an approvable draft, and conflating them would hide an address
  // request inside a number the summary line already reports. Optional, like
  // `stalled`, because listen.ts builds a LoopSummary literal.
  addressRequested?: number;
  // The whole outstanding backlog, reported every run. It otherwise appears
  // only in `outreach stranded`, and 18 drafts once sat undelivered because
  // nothing that requires going somewhere gets read.
  addressesPending?: number;
```

Add near the top of the file:

```ts
// Small on purpose. Measured drafts per day on data/outreach.db were 11, 6 and
// 7 over the three days before this shipped, against a max_messages_per_run of
// 10, so the message cap is NOT saturated daily and this is hygiene rather than
// an emergency. Raise it once the real rate of rejections is measured.
const DEFAULT_MAX_ADDRESS_REQUESTS_PER_RUN = 3;
```

Add the needs-address helper above `processCandidate`:

```ts
// Drafts first, then asks. Drafting is forced, not preferred: the correction
// reply is handled by handleReply, whose dependency set is ReplyDeps, and that
// split exists so `outreach listen` never fabricates drafting dependencies.
// Drafting inside the reply handler would put llm, buildDraftInput and an
// OpenRouter key into the listener daemon. Drafting up front also gives the
// correction a dN to name, which is what makes the reply syntax work.
async function draftAndRequestAddress(
  deps: LoopDeps,
  summary: LoopSummary,
  c: Candidate,
  result: OrchestrateResult,
  rejected: RejectedCandidate[],
  relevanceReason: string,
): Promise<void> {
  const input = deps.buildDraftInput(result);
  const draft = await deps.generateDraft(deps.llm as LLMClient, input);
  if (!draft.grounded) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', `grounding failed: ${draft.notes.join('; ')}`);
    summary.unsendable++;
    return;
  }
  const persisted = deps.db.transaction((): PersistedDraft => {
    const p = persistDraft(deps.db, {
      personId: result.personId as number,
      paperArxivId: result.arxivId,
      paperTitle: result.paperTitle,
      intent: input.intent,
      draftInput: input,
      draft,
      contextJson: { discoveredVia: c.discoveredVia, sourceDetail: c.sourceDetail, relevance: relevanceReason },
    });
    // persistDraft reads people.email (NULL here) into drafts.to_email, which
    // is the shape `outreach add` already parks as a manual-lookup queue and
    // which loadApprovedSend already refuses as no_snapshot.
    setStatus(deps.db, c.arxivId, 'discovered', relevanceReason, p.draftId);
    return p;
  })();

  const person = getPerson(deps.db, result.personId as number);
  const req = {
    db: deps.db,
    arxivId: c.arxivId,
    draftId: persisted.draftId,
    shortId: persisted.shortId,
    personId: result.personId as number,
    personName: result.target,
    affiliation: person?.affiliation ?? null,
    paperTitle: result.paperTitle,
    rejected,
  };
  summary.unsendable++;
  const budget = deps.config.gate.maxAddressRequestsPerRun ?? DEFAULT_MAX_ADDRESS_REQUESTS_PER_RUN;
  if ((summary.addressRequested ?? 0) >= budget) {
    deferAddressRequest(req);
    return;
  }
  if (await requestAddress({ ...req, notify: (t) => deps.channel.notify(t) })) {
    summary.addressRequested = (summary.addressRequested ?? 0) + 1;
  }
}
```

Import `RejectedCandidate` as a type from `./contacts.js` and `PersistedDraft` is already imported.

Replace the email gate in `processCandidate` (lines 377-386) with:

```ts
    // Checked AFTER the hook gate. Hook-first gating means contact extraction
    // does not run for a hookless candidate, so `email: null` there means "not
    // attempted", not "looked and failed".
    if (!result.email) {
      const rejected = result.rejectedEmails ?? [];
      if (rejected.length === 0) {
        setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no email resolved');
        summary.unsendable++;
        return;
      }
      // Duplicated rather than hoisted above the email gate. Hoisting would
      // relabel every candidate that fails both checks from 'no email resolved'
      // to 'prior thread exists', and the hook-first spec's Change 2 is the
      // record of what a gate reorder does to the status buckets.
      const priorForAddress = priorThreads(deps.db, result.personId);
      if (priorForAddress.length > 0) {
        setStatus(deps.db, c.arxivId, 'drafted_unsendable', `prior thread exists (${priorForAddress[0]?.shortId ?? ''})`);
        summary.unsendable++;
        return;
      }
      if (addressRequestDeclined(deps.db, result.personId)) {
        setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'address correction declined for this person');
        summary.unsendable++;
        return;
      }
      if (opts.dryRun) {
        setStatus(deps.db, c.arxivId, 'discovered', 'dry run: would request address');
        summary.wouldMessage++;
        return;
      }
      await draftAndRequestAddress(deps, summary, c, result, rejected, verdict.reason);
      return;
    }
```

- [ ] **Step 5: Add the backlog drain and the summary line fields**

Add above `runLoop`:

```ts
// A deferred needs-address row rests at drafted_unsendable, which is terminal:
// getResumable only looks at 'discovered', and queued_for_message is unusable
// here because resolveSendableDraft's no_email branch RETIRES the draft. So the
// backlog needs its own drain, bounded by the same per-run address budget.
async function drainAddressRequests(deps: LoopDeps, summary: LoopSummary): Promise<void> {
  const budget = deps.config.gate.maxAddressRequestsPerRun ?? DEFAULT_MAX_ADDRESS_REQUESTS_PER_RUN;
  const remaining = budget - (summary.addressRequested ?? 0);
  if (remaining <= 0) return;
  for (const row of deferredAddressRequests(deps.db, remaining)) {
    // Rebuilt from the structured event payload, never by parsing the address
    // back out of a reason string: the reason wording changes twice in this
    // feature and the drain must not be coupled to it.
    const p = deferredPayload(deps.db, row.draftId);
    if (!p) continue;
    const ok = await requestAddress({
      db: deps.db,
      notify: (t) => deps.channel.notify(t),
      arxivId: row.arxivId,
      draftId: row.draftId,
      shortId: row.shortId,
      personId: p.personId,
      personName: p.personName,
      affiliation: p.affiliation,
      paperTitle: row.paperTitle,
      rejected: p.rejected,
    });
    if (ok) summary.addressRequested = (summary.addressRequested ?? 0) + 1;
  }
}
```

Call it inside `runLoop`, immediately after the queued-draft flush block (after line 864) and inside the same `if (!opts.dryRun)` discipline:

```ts
    // After the queued draft flush and before discovery, same reason queued
    // work goes out ahead of new work.
    if (!opts.dryRun) {
      try {
        await drainAddressRequests(deps, summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        summary.errors.push(`address request drain failed: ${msg}`);
      }
    }
```

In the `finally` block, before `const line = ...`:

```ts
    try {
      summary.addressesPending = pendingAddressCount(deps.db);
    } catch {
      // Read-only reporting must never mask the real failure above.
    }
```

and add to the line, after the `stalled` clause:

```ts
      (summary.addressRequested ? `, address requests ${summary.addressRequested}` : '') +
      (summary.addressesPending ? `, addresses pending ${summary.addressesPending}` : '') +
```

- [ ] **Step 6: Run the tests and the full suite**

Run: `npx vitest run test/loop.test.ts` → PASS, and every pre-existing test in that file unchanged.
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck` → the real assertion that both new fields stayed optional.

- [ ] **Step 7: Mutate to prove the tests can fail**

Three mutations, all mandatory:
1. Change the budget check to `if (summary.messaged >= deps.config.gate.maxMessagesPerRun)` and increment `summary.messaged` instead. Confirm `does not let an address request consume a message slot` goes RED. Restore.
2. Drop the `p.draftId` argument from `setStatus` inside `requestAddress`. Confirm `parks the row with its draft id attached` goes RED. Restore.
3. Delete the `addressRequestDeclined` guard. Confirm `never asks again about a person who declined` goes RED. Restore, confirm GREEN.

- [ ] **Step 8: Commit**

```bash
git add src/discovery/config.ts src/pipeline/loop.ts test/loop.test.ts
git commit -m "Ask for a rejected candidate's address under its own per-run budget"
```

---

### Task 8: Make the two new reasons visible in `outreach stranded`

**Why:** `strandedReport` (`seenLedger.ts:185-193`) selects `drafted_unsendable` rows only where the reason is `abandoned after%` or `ambiguous orphan drafts%`. Measured on `data/outreach.db`: zero of the 252 `drafted_unsendable` rows match. The bucket is terminal and invisible at the same time, and this feature adds two more reasons to it.

**Files:**
- Modify: `src/discovery/seenLedger.ts`
- Test: `test/stranding.test.ts`

**Interfaces produced:** none. `strandedReport`'s signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/stranding.test.ts`:

```ts
describe('stranded report covers pending address corrections', () => {
  const seedRow = (db: ReturnType<typeof openDb>, arxivId: string, reason: string) =>
    db.prepare(
      `INSERT INTO seen_papers (arxiv_id, title, discovered_via, status, reason)
       VALUES (?, 'A Paper', 'saved_query', 'drafted_unsendable', ?)`,
    ).run(arxivId, reason);

  it('prints both new reasons', () => {
    const db = openDb(':memory:');
    seedRow(db, '2601.00001', 'awaiting address correction (d7): rejected wrong@x.edu');
    seedRow(db, '2601.00002', 'address correction not yet requested (d8): rejected wrong@y.edu');
    // Unchanged: the other 250-odd drafted_unsendable rows stay invisible.
    // Making them visible is a separate spec.
    seedRow(db, '2601.00003', 'no grounded hook');
    const ids = strandedReport(db, 3).terminalStranded.map((r) => r.arxivId).sort();
    expect(ids).toEqual(['2601.00001', '2601.00002']);
  });

  it('drops a corrected row, so a resolved item is not printed forever', () => {
    const db = openDb(':memory:');
    seedRow(db, '2601.00004', 'awaiting address correction (d7): rejected wrong@x.edu');
    db.prepare("UPDATE seen_papers SET reason = 'address corrected (d7)' WHERE arxiv_id = ?").run('2601.00004');
    expect(strandedReport(db, 3).terminalStranded).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run test/stranding.test.ts -t 'prints both new reasons'`
Expected: FAIL, `terminalStranded` is empty.

- [ ] **Step 3: Extend the predicate in `src/discovery/seenLedger.ts`**

Replace the `WHERE` clause at lines 189-190:

```ts
       WHERE status = 'drafted_unsendable'
         AND (reason LIKE 'abandoned after%'
           OR reason LIKE 'ambiguous orphan drafts%'
           -- The two reasons the address-correction feature creates. Both
           -- describe a real person the system wants to email and cannot,
           -- waiting on one text message from a human. Deliberately scoped:
           -- the other ~250 drafted_unsendable rows stay invisible, and
           -- 'address corrected%' is deliberately absent so a resolved row
           -- stops printing.
           OR reason LIKE 'awaiting address correction%'
           OR reason LIKE 'address correction not yet requested%')
```

- [ ] **Step 4: Run the tests and the full suite**

Run: `npx vitest run test/stranding.test.ts` → PASS
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`
Run: `npm run typecheck`

- [ ] **Step 5: Mutate to prove the test can fail**

Remove the two new `OR` clauses. Confirm the first test goes RED. Restore, confirm GREEN.

- [ ] **Step 6: Commit**

```bash
git add src/discovery/seenLedger.ts test/stranding.test.ts
git commit -m "Print pending address corrections in outreach stranded"
```

---

### Task 9: Stop needs-address drafts from turning the trust-and-safety eval red

**Why:** `scripts/eval-trust-safety.ts:83-85` pushes a hard `TS2` **fail** for any draft with no `to_email`, and the script exits non-zero on any fail (`:147`). Needs-address drafts have exactly that shape by construction, so shipping this feature without a rule makes that eval permanently red, and an eval that is always red is an eval nobody reads.

**Files:**
- Modify: `scripts/eval-trust-safety.ts`
- Test: manual verification (this script has no test harness; `tsconfig.json` includes only `src/**` and `test/**`, so `npm run typecheck` will NOT catch a break here). Do not build a harness for it.

**Interfaces produced:** none.

- [ ] **Step 1: Add the draft id to the query**

Change the `drafts` query (line 31-35) to select the row id, which is what the event lookup needs:

```ts
const drafts = db.prepare(`
  SELECT dr.id AS draft_row_id, dr.short_id, dr.person_id, dr.draft_input_json, dr.to_email,
         p.name, p.affiliation, p.email_source, p.homepage_url
  FROM drafts dr JOIN people p ON p.id = dr.person_id
  WHERE dr.status = ? ORDER BY dr.id`).all(status) as any[];
```

- [ ] **Step 2: Add the prepared lookup**

Beside `factById` (line 37):

```ts
// A draft with no to_email is normally a hard fail (it cannot be sent, and the
// glued-label and dlapiper.com incidents both showed up as address problems).
// A draft that is deliberately WAITING for a human to supply the address is a
// different thing, and scoring it 'fail' would make this eval permanently red.
// Keyed on the event rather than on seen_papers.reason so the eval does not
// depend on reason-string wording, which the address-correction feature changes
// twice.
const addressRequested = db.prepare(
  `SELECT created_at FROM draft_events WHERE draft_id = ? AND type = 'address_requested' ORDER BY id LIMIT 1`);
```

- [ ] **Step 3: Split the no-address finding**

Replace lines 83-85:

```ts
  const email: string | null = d.to_email ?? null;
  if (!email) {
    const req = addressRequested.get(d.draft_row_id) as { created_at: string } | undefined;
    if (req) {
      findings.push({
        draft: d.short_id, person: d.name, set: 'TS2', severity: 'review',
        detail: `awaiting a human-supplied address (requested ${req.created_at}); not sendable until it arrives`,
      });
    } else {
      findings.push({ draft: d.short_id, person: d.name, set: 'TS2', severity: 'fail', detail: 'draft has no to_email' });
    }
  } else {
```

leaving the existing `else` body untouched.

- [ ] **Step 4: Verify by demonstration**

```bash
cp data/outreach.db /tmp/eval-check.db
sqlite3 /tmp/eval-check.db "
  INSERT INTO people (name, openalex_id) VALUES ('Eval Probe', 'A-eval-probe');
  INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, intent, draft_input_json, status)
    VALUES ('d99991', (SELECT id FROM people WHERE openalex_id='A-eval-probe'), '2601.99991', 'Probe', 'x', '{}', 'awaiting_approval');
  INSERT INTO draft_events (draft_id, type, detail_json)
    VALUES ((SELECT id FROM drafts WHERE short_id='d99991'), 'address_requested', '{}');"
```

Run the script twice against that copy, once with the change and once with the `addressRequested` lookup forced to return undefined (the mutation). Point it at the copy by temporarily changing `openDb('data/outreach.db')` to `openDb('/tmp/eval-check.db')`, or by copying the file into place. Paste both outputs into the commit body: the first must show the probe as `[REVIEW] TS2` and the hard gate unchanged; the second must show `[FAIL ] TS2 ... draft has no to_email`. **This is the mutation check**; without it the change is unverified, because there is no test file for this script.

Then restore the DB path and delete `/tmp/eval-check.db`.

- [ ] **Step 5: Run the suite (nothing should move) and commit**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
git add scripts/eval-trust-safety.ts
git commit -m "Score a draft awaiting a human-supplied address as review, not fail"
```

---

### Task 10: Let `outreach add` say a candidate was rejected

**Requires:** Task 2.

**Why:** `cli.ts:367` prints `no email found: draft stays awaiting_approval in the manual-lookup queue`. After Task 1 that sentence can mean two different things and one of them is actionable. An operator surface should not report a rejection as an absence.

**Files:**
- Modify: `src/cli.ts`
- Test: manual verification (this path has no test harness; do not build one here).

**Interfaces produced:** none.

- [ ] **Step 1: Add the line**

Replace `src/cli.ts:365-368`:

```ts
    if (!r.email) {
      console.log('no email found: draft stays awaiting_approval in the manual-lookup queue');
      // Not the same as "we looked and found nothing". A rejected candidate is
      // an address the machine found and refused because its local part names a
      // different person, which is exactly the case a human can resolve.
      for (const rej of r.rejectedEmails ?? []) {
        console.log(`  rejected candidate: ${rej.email} (${rej.source}) does not name this person`);
      }
      return;
    }
```

- [ ] **Step 2: Typecheck and run the suite**

Run: `npm run typecheck`
Run: `npx vitest run --reporter=dot 2>&1 | tail -5`

- [ ] **Step 3: Verify by demonstration**

Run `npx tsx --env-file=.env src/cli.ts add <an arxiv id whose author's address the tightened rule rejects>` and paste the output into the commit body. Candidates named by `scripts/audit-name-match-tightening.ts`: person 12 Xiongri Shen (`ishen@stu.hit.edu.cn`), person 222 Zhisheng Han (`l.zhang.16@bham.ac.uk`). Do NOT approve or send anything.

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "Report a rejected email candidate in outreach add"
```

---

### Task 11: Demonstrate the whole path against the live system

**Requires:** Tasks 1 to 10 merged.

**Why:** Project rule: verification by demonstration, not assertion. This repo has shipped a green test suite that agreed with wrong code more than once (the Semantic Scholar source returned zero for its entire life because the fixture wrote the same wrong key the implementation read; a one-year timeout silently became 1ms; batch-versus-push delivery semantics were invisible to the suite).

**Files:** none (measurement only).

- [ ] **Step 1: Back up the database**

```bash
cp data/outreach.db data/outreach.backup-preaddress-$(date +%H%M%S).db
```

- [ ] **Step 2: Confirm the suite and the eval are green**

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
npm run typecheck
npx tsx scripts/eval-trust-safety.ts | tail -20
```

The eval's hard gate must read PASS. If it reads FAIL for a reason other than a pre-existing finding, stop.

- [ ] **Step 3: Run one real cycle and capture the phone**

```bash
npx tsx --env-file=.env src/cli.ts loop
```

Show the actual iMessage text that arrives. A NEEDS ADDRESS message must be present for at least one candidate; if none appears in this run, note the measured rejection rate and re-run tomorrow rather than declaring the feature done. Screenshot or transcript, not a description.

- [ ] **Step 4: Reply with a real address and capture the result**

Tapback the NEEDS ADDRESS message first and confirm the hint arrives (Task 4). Then reply `dN to <a real address>` and show:
- the acknowledgement, which must name the PERSON;
- the re-presented draft in `dN: Name (address)` format;
- and, only if you intend to email that person, a further `dN y`.

- [ ] **Step 5: Dump the state**

```bash
sqlite3 -header -column data/outreach.db "
  SELECT id, name, email, email_confidence, email_source FROM people WHERE email_source='user_provided';
  SELECT short_id, status, to_email FROM drafts WHERE to_email IS NULL OR short_id IN (SELECT short_id FROM drafts ORDER BY id DESC LIMIT 5);
  SELECT draft_id, type, created_at, detail_json FROM draft_events
   WHERE type IN ('address_requested','address_corrected','address_request_declined','address_request_deferred')
   ORDER BY id DESC LIMIT 10;
  SELECT arxiv_id, status, reason, draft_id FROM seen_papers WHERE reason LIKE '%address correction%' OR reason LIKE 'address corrected%';"
```

- [ ] **Step 6: Prove the typo blocker on the live database**

Pick a person with a non-NULL `people.email` whose `email_source` is NOT `user_provided`, find any `awaiting_approval` draft for them (or create nothing if none exists, and use the backup copy instead), and reply `dN to typo@nowhere.edu`. Show the refusal message and confirm with `sqlite3` that `people.email` and `drafts.to_email` are both unchanged. **This is the single most important demonstration in the plan**: it is the one that proves a one-digit typo cannot produce a sendable draft aimed at the wrong human.

- [ ] **Step 7: Confirm `outreach stranded` and the summary agree**

```bash
npx tsx src/cli.ts stranded | head -30
```

The pending count printed in the run summary text must match the number of address-correction rows listed here. If they disagree, `pendingAddressCount` and `strandedReport`'s predicate have drifted, which is exactly the failure both were written from a single pair of patterns to prevent.

---

## Self-Review

**Spec coverage.** Change 1 → Task 1. Change 2 → Task 1 (the union split). Change 3 → Task 7 (branch, budget, drain, `setStatus` with `draftId`) and Task 5 (`addressRequestDeclined`, `requestAddress`, `deferAddressRequest`). Change 3 item 5 → Task 8. Change 3 item 6 → Task 7's `drainAddressRequests`, and the flush script is explicitly untouched. Change 4 → already shipped in 733c3c9; the message format is Task 3, the guard extension is Task 5 Step 4. Change 4a → Task 4. Change 5 → Task 3 (parser) and Task 5 (state table). Change 5a → Task 5 (all three refusals plus the advisory) and Task 6 (the acknowledgement). Change 6 → Task 5 (all four event types). Change 7 → Task 6. Change 8 → Task 9. Change 9 → Task 10. Verifications 1 to 9 → Tasks 3, 4, 5, 6, 7, 8, 9. Verification 10 → Task 11. No spec section is unimplemented.

**Placeholders.** None. Every code step carries real code. Tasks 9 and 10 have no automated test because neither `scripts/` nor the `outreach add` CLI path has a harness and `tsconfig.json` includes only `src/**` and `test/**`; both get an explicit demonstration step instead, and Task 9's demonstration includes a mutation.

**Type consistency.** `RejectedCandidate` and `ContactResult` are defined in Task 1 and consumed by name in Tasks 2, 5, 7, and 10. `OrchestrateResult.rejectedEmails?` is defined in Task 2 and read as `(x ?? [])` in Tasks 7 and 10. `ParsedReply`'s `address` kind is defined in Task 3 and consumed in Task 6. `formatNeedsAddressMessage` / `needsAddressDraftId` / `needsAddressTapbackHint` are defined in Task 3 and consumed in Tasks 4 and 5. `applyAddressCorrection` / `addressWasRequested` are defined in Task 5 and consumed in Task 6. `requestAddress` / `deferAddressRequest` / `deferredAddressRequests` / `deferredPayload` / `pendingAddressCount` / `addressRequestDeclined` are defined in Task 5 and consumed in Task 7. `GateConfig.maxAddressRequestsPerRun?` is defined in Task 7 and read in the same task.

**Known risks to watch during implementation.**
- Task 1's rename touches the function every contact test calls. If `test/paper-context.test.ts`, `two-pass`, `reconcile`, or `snippet-scan` needs editing, the wrapper signature drifted; fix the wrapper.
- Task 4 changes `decodeReply`'s return type, which is the single decode both `captureReplies` and `streamReplies` use. Miss one call site and the two paths drift, which is precisely what that function's comment says must never happen.
- Task 7's `draftAndRequestAddress` duplicates `processCandidate`'s persist-and-set-status transaction. If they drift, a needs-address draft could be persisted without its `seen_papers` pointer, which CS4.3 exists to prevent. Consider extracting the shared transaction if the duplication grows past this one use.
- `email_confidence` is stored as SQLite REAL; `expect(person.email_confidence).toBe(1)` in Task 5's test assumes `1.0` reads back as `1`. If better-sqlite3 returns something else on this platform, assert `toBeCloseTo(1)` rather than weakening the write.
