# Task B: Person ontology facts (OpenAlex structured + LLM personal facets)

> Ref: `docs/spec-profile-mining.md` (D3a, D4, D5b, D6a, D3 tier caps, D-vocabulary).
> Builds on the committed resolver in `src/pipeline/research.ts` +
> `src/openalex/client.ts`.

## Goal
Turn a resolved OpenAlex author into structured `OntologyFact`s: deterministic
academic/trajectory facts from OpenAlex (no LLM), plus personal-facet facts mined
from Tavily pages via a cheap LLM, domain-gated to the resolved person (D5b).
Return the facts as data (do NOT persist to SQLite yet; that is a later step).

## Deliverables
1. **In `src/pipeline/research.ts`**, add:
   ```ts
   interface OntologyFact { facet:'academic'|'trajectory'|'interest'; key:string;
     value:string; sourceUrl:string; confidence:number; tier:'A'|'B'|'C'; }

   factsFromOpenAlex(candidate: OpenAlexCandidate, raw: OpenAlexAuthorRaw): OntologyFact[]
   minePerson(deps, resolution, raw, paperContext) => Promise<{ facts: OntologyFact[]; profileSummary: string }>
   ```
   - `factsFromOpenAlex` (deterministic, D6a): current affiliation -> trajectory/`institution`
     conf 0.9 tier A; prior affiliations 0.8; concepts -> academic/`research_area` 0.85;
     venues -> academic/`venue` 0.8; co-authors -> academic/`collaborator` 0.7. Source class
     `openalex` => tier A. Keys from the D-vocabulary.
   - `minePerson`: run the D4 Tavily personal pass (`"name" <currentAffiliation> homepage`,
     `"name" blog OR talk`, `"name" github`), fetch top non-aggregator pages, **domain-gate
     per D5b** (keep a page only if its registrable domain matches the current/known
     affiliation domain or a homepage, or it is linked from an OpenAlex URL), then LLM-extract
     personal facts. Clamp each fact's tier to the D3 source-class cap. One extra LLM call
     produces `profileSummary`. Respect D4 budgets.
2. **New file `src/llm/client.ts`**: an injectable `LLMClient` interface
   `{ complete(system: string, user: string): Promise<string> }` and an OpenRouter
   implementation using `fetch` (NO new npm dependency). Reads `OPENROUTER_API_KEY`
   and `MODEL_CHEAP` from env. Temperature 0. JSON responses.
3. **New file `src/llm/prompts.ts`**: the fact-extraction prompt (returns a JSON array of
   `{facet,key,value,confidence,proposedTier}` with the D6a confidence rubric) and the
   profile-summary prompt.
4. **Smoke script `scripts/smoke-mine.ts`** (repo owner runs it with keys).

## Boundaries (avoid merge conflicts)
- You OWN: `src/pipeline/research.ts` (edit), `src/llm/client.ts` (new),
  `src/llm/prompts.ts` (new), `scripts/smoke-mine.ts` (new), your test files.
- Do NOT edit `src/pipeline/contacts.ts` (import `PaperContext`, `WebPage`,
  `SearchClient`, `PageFetcher` types only) or `src/openalex/client.ts` (import only).
- Prefer no new dependencies (use `fetch` for OpenRouter). If unavoidable, edit
  `package.json` only and do NOT stage or commit `package-lock.json`.

## Testing (offline, TDD)
- Follow the superpowers test-driven-development skill: failing test first, then code.
- No network in tests. Inject a fake `LLMClient` returning canned JSON, and fake
  `SearchClient`/`PageFetcher` (see `test/reconcile.test.ts`).
- Required cases:
  - `factsFromOpenAlex`: correct facet/key/confidence/tier for affiliation, concepts,
    venues, co-authors.
  - Tier clamping: a personal fact the LLM proposes as tier A from a blog/social page is
    clamped to B/C per D3.
  - Domain gating: a page whose domain does not match the resolved person is dropped
    (homonym-page rejection).
  - LLM JSON parse failure: retry once, then skip that page without crashing.
  - `npx vitest run` and `npm run typecheck` both pass after `npm install`.

## Style
No em dashes in comments, commit messages, or docs (repo owner's rule). Match existing
code style in `research.ts`.
