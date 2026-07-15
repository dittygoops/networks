# Task A: Wire current affiliation into contact extraction

> Ref: `docs/spec-profile-mining.md` (D3a, D5b, D1a-D1c). Builds on the committed
> OpenAlex resolver in `src/pipeline/research.ts` and `src/openalex/client.ts`.

## Goal
Contact extraction currently searches with the paper's (possibly stale) affiliation.
Use the OpenAlex resolver to get the author's **current** affiliation first, and let
that take precedence in the web-search query and the D5a guard. This sharpens
mover-email discovery (e.g. Kerbl's paper says INRIA, OpenAlex says TU Wien).

## Deliverables
1. **New file `src/pipeline/intake.ts`** exporting:
   ```ts
   resolveAndExtractContact(deps, person, paperContext, options?) => Promise<SelectedEmail | null>
   ```
   - `deps` = existing `ContactDeps` (search + fetcher) plus `{ fetchFn?: FetchFn }` for OpenAlex.
   - Flow: `fetchAuthorCandidates(person.name, { fetchFn })` -> `resolveAuthor(...)`.
     If resolved, compute `currentAffiliation(raw)` and pass it into `extractContact`
     as the affiliation to use for web queries. If UNRESOLVED, fall back to the
     paper affiliation (existing behavior), unchanged.
2. **Edit `src/pipeline/contacts.ts`**: add an optional `currentAffiliation?: string`
   to `ExtractOptions`. When present, it takes precedence over
   `paperContext.affiliationHint` / `person.affiliation` for BOTH the web-search
   query and the D5a "has affiliation" guard. Everything else (age decay, two-pass
   domain discovery, reconciliation) stays exactly as is.
3. **Smoke script `scripts/smoke-intake.ts`** (the repo owner runs it with keys).

## Boundaries (avoid merge conflicts)
- You OWN: `src/pipeline/intake.ts` (new), `src/pipeline/contacts.ts` (edit),
  `scripts/smoke-intake.ts` (new), your test files.
- Do NOT edit `src/pipeline/research.ts` or `src/openalex/client.ts` (import only).
- Add no new dependencies. Do NOT stage or commit `package-lock.json`.

## Testing (offline, TDD)
- Follow the superpowers test-driven-development skill: failing test first, then code.
- No network in tests. Inject a fake `fetchFn` returning canned OpenAlex JSON, and the
  existing fake `SearchClient`/`PageFetcher` pattern (see `test/reconcile.test.ts`).
- Required cases:
  - Mover: paper affiliation "INRIA", fake OpenAlex resolves current affiliation
    "TU Wien"; assert the web-search query used "TU Wien", not "INRIA".
  - UNRESOLVED (no corroboration): falls back to paper affiliation; behavior identical
    to today.
  - No regression: run the full existing suite (`npx vitest run`) and `npm run typecheck`.
- After `npm install`, both `npx vitest run` and `npm run typecheck` must pass before you finish.

## Style
No em dashes in comments, commit messages, or docs (repo owner's rule). Match existing
code style in `contacts.ts`.
