# Technical Spec: Persona (self-ontology)

> PRD: [`docs/prd-persona.md`](./prd-persona.md). Writes `ontology_facts` with
> `person_id IS NULL`, consumed by profile-mining's `computeIntersections`.

## Overview

A small module (`src/pipeline/persona.ts`) plus a CLI command that builds Aditya's
self-ontology from curated documents and a short self-interview, and replaces the stored
self-facts. Pure over its inputs (document texts and interview answers are passed in; file IO
lives in the CLI), so it is testable offline with a fake LLM.

## Resolved Decisions

### P1. Storage: self-facts are `person_id IS NULL`, rebuilt by replace
Keeps the existing "NULL = self" convention that `computeIntersections` (`factRows(db, null)`)
already reads. Because SQLite treats NULLs as distinct in the `UNIQUE(person_id, facet, key,
value)` index, self-facts cannot use the accumulate upsert; instead a persona build is
**authoritative and atomic**: `replaceSelfFacts(db, facts)` deletes all `person_id IS NULL`
rows and inserts the fresh set inside a transaction. Re-running never duplicates.

### P2. Document extraction is About-Aditya only
`factsFromDocument(llm, docText, sourceLabel)` sends one cheap-tier call per document. The
prompt (`SELF_EXTRACT_SYSTEM`) extracts facts **about the author (Aditya)**: what he built or
did, what he studies or is moving toward, and stated interests, explicitly NOT encyclopedia
facts about the document's topic. Returns the same JSON fact array as recipient extraction
(`{facet, key, value, confidence, proposedTier}`). Keys pass through `normalizeKey`
(shared vocabulary). Confidence defaults to 0.85 (first-person authoritative source) when the
model omits it. A topic note that is not about Aditya correctly yields `[]`.

### P3. Self-interview
`INTERVIEW_QUESTIONS` is a fixed array of `{ id, facet, key, prompt }` covering the facets docs
miss: current role/background (trajectory/role), places lived (trajectory/location), hobbies
(interest/hobby), communities (interest/community), side projects (interest/side_project), what
he is looking for (interest/writing as a free note). `interviewFacts(answers)` maps a
`{ [id]: string }` answer map to facts (confidence 0.95, self-reported; tier per P4). Answers
are injected (from a JSON file or interactive readline in the CLI), so the step is testable and
non-blocking.

### P4. Tiers for self-facts
The LLM proposes a tier for document facts; code clamps it to a sane cap by facet: `academic`
and `trajectory` facts cap at A, `interest` facts cap at B (a hobby should not be a
lead-with-it Tier A). Interview facts get A for role, B for hobbies/communities/locations, and
the model/user may not raise them. This mirrors D3's clamp-only-lower rule. The intersection
engine already inherits `min(self.tier, person.tier)`, so honest self-tiers keep hooks
appropriate.

### P5. Build orchestration
`buildSelfOntology(deps, { documents, answers })` where `documents: {label, text}[]` and
`answers: Record<string,string>`: runs `factsFromDocument` per document (LLM failures skip that
doc, never crash), plus `interviewFacts(answers)`, dedupes exact `(facet,key,value)` in memory,
and returns `OntologyFact[]`. The caller persists with `replaceSelfFacts`. One LLM call per
document; no network beyond the LLM.

### P6. CLI
`outreach persona <doc-path...> [--answers <file.json>]`: reads the document files and optional
answers JSON, calls `buildSelfOntology`, then `replaceSelfFacts`, and prints the fact count by
facet/tier. Replaces the dev fixture the profile-mining CLI seeds.

## Data Model
No new tables. Writes existing `ontology_facts` with `person_id = NULL`. `db.ts` gains
`replaceSelfFacts(db, facts)` (delete NULL rows + insert, transactional).

## Interfaces
| Interface | Shape | Consumer |
|---|---|---|
| `factsFromDocument(llm, text, label)` | `Promise<OntologyFact[]>` | buildSelfOntology |
| `interviewFacts(answers)` | `OntologyFact[]` | buildSelfOntology |
| `buildSelfOntology(deps, input)` | `Promise<OntologyFact[]>` | CLI |
| `replaceSelfFacts(db, facts)` | writes `person_id IS NULL` facts | CLI |

## Implementation Plan
1. `replaceSelfFacts` in `db.ts` (+ tests). 
2. `SELF_EXTRACT_SYSTEM` / `buildSelfExtractUser` prompts.
3. `persona.ts`: `factsFromDocument`, `INTERVIEW_QUESTIONS`, `interviewFacts`,
   `buildSelfOntology` (+ tests with a fake LLM).
4. CLI `persona` command; live-run on Aditya's real project/research docs, review the facts.
   ✅ *Human gate: read the generated self-ontology; are these accurate facts about you, tiered
   the way you would judge them? This calibrates P2/P4 before drafts rely on it.*

## Open Questions
- Resume ingestion deferred until a resume file exists (interview covers essentials).
- Interactive readline vs answers file: CLI supports the file now; interactive is a thin add.
