# PRD: Profile Mining

> Part of the Academic Networking Email Assistant suite. Related docs: persona/self-ontology (separate PRD), draft generation, approval channel, email send/monitoring.

## Overview

A research subsystem that, given a target person (typically a paper author), mines their public footprint into a structured, sourced **person ontology**, finds a confident contact email, and (given Aditya's self-ontology as an input) computes a ranked, tiered list of **genuine intersections** between the two people. Its output is everything a downstream drafter needs to write a credible, personalized email: who this person is, how to reach them, and what Aditya honestly has in common with them.

## Problem Statement

Writing a credible personalized email to a researcher requires knowing them well: their actual research focus, trajectory, and publicly shared interests, plus a working email address. Doing this by hand means 30 to 60 minutes per person across Scholar, homepages, GitHub, and X, and the quality is inconsistent: hooks end up generic, emails bounce, and it is easy to reference something that reads as creepy rather than resonant. The mining needs to be automated; the judgment about what is usable in an email needs to be encoded, not improvised.

## Goals & Non-Goals

### Goals
- Turn a person's name plus paper context into a structured ontology of sourced, confidence-scored facts in under 5 minutes of wall-clock time, not an hour of manual digging.
- Find a contact email with confidence ≥ 0.7 (scale defined in F1), or explicitly report "couldn't." Never guess: a bounce or wrong-person email is worse than a delayed one.
- Encode the creepiness boundary: every fact carries a usability tier (lead-with-it / mention-if-natural / context-only) assigned deterministically from its source class, so downstream drafting can never surface research the recipient should not be able to reconstruct.
- Produce ranked intersections against the self-ontology, so the drafter's hook selection is a lookup, not a judgment call.
- Mine once, reuse forever: ontologies persist and are enriched over time, with staleness handling.

### Non-Goals
- **No LinkedIn.** Public sources only (Scholar, homepages, GitHub, X, blogs, conference bios, talks). LinkedIn scraping risks account restriction and academics' public pages are richer anyway.
- **No email drafting.** This subsystem ends at profile plus intersections; drafting is a separate PRD.
- **No building of the self-ontology.** Aditya's own ontology is produced by the persona subsystem (separate PRD); this system consumes it read-only.
- **No private-source digging.** Nothing behind logins, no data brokers, no people-search sites.
- **No X/Twitter API integration in v1.** X content is used only when it surfaces through ordinary web search. Accepted trade-off; revisit only if hooks feel thin in practice.

## User Stories

- As the sender, I want the system to research an author for me and show a short profile (current position, research focus, recent work, notable activities), so I know who I am writing to without an hour of tabs.
- As the sender, I want every fact to carry its source URL and confidence, so I can audit why the system believes something before it shapes an email.
- As the sender, I want the system to tell me honestly when it cannot find an email, so I can look it up manually rather than have a message bounce.
- As the sender, I want intersections ranked by strength with clear usability tiers, so the best genuine hook is at the top and nothing creepy can leak into a draft.

## Requirements

### Functional

**F1. Contact extraction (tiered, confidence-gated)**
- Confidence is a 0 to 1 score assigned deterministically by source and name-match quality (exact table in the spec). **Threshold: ≥ 0.7 is send-eligible.**
- Tier 1: emails in the paper PDF (corresponding-author markers score highest).
- Tier 2: university/lab homepage or directory page found via web search (most reliable `.edu` source).
- Tier 3: GitHub profile or commit metadata (GitHub `noreply` addresses are always discarded).
- An email is only attributed to the target if its local part matches the person's name (matching rule in the spec). Each found email is stored with source and confidence.
- Below threshold, the person enters the **manual-lookup queue**: extraction returns "not found," the owning record is flagged, and the queue is visible via CLI (`outreach list --needs-email`) and the review page. Resolution is manual (`outreach set-email`).

**F2. Person ontology**
- Sources: OpenAlex (structured academic data: papers, co-authors, time-stamped affiliations, research concepts), personal/lab homepage, GitHub, X/Twitter (only as surfaced by web search), personal blogs, conference bios, podcast/talk appearances. (Google Scholar is not scraped: it blocks automated access and OpenAlex covers the same academic facts reliably.)
- Research effort is bounded: at most 6 web-search queries per person (query plan in the spec).
- Structured facets, each fact stored with source URL, confidence, and retrieved-at date:
  - *Academic*: research areas, methods, key papers, venues, advisors/lab lineage.
  - *Trajectory*: institutions attended, companies/roles, geographic path (when publicly stated).
  - *Interests*: hobbies, side projects, open-source work, writing, communities, anything they publicly broadcast.
- **Identity corroboration**: a page only contributes facts if it matches the target on at least one corroborating signal (affiliation, a co-author's name, the paper itself, or research-area overlap; exact list in the spec). Ambiguous pages are skipped, never merged.
- Every fact is assigned a **usability tier**. The tier is capped by a deterministic source-class table (below); the extractor may assign a *lower* tier than the cap but never higher.
  - **Tier A cap sources** (lead-with-it eligible): arXiv/DBLP/Scholar pages, university or lab pages, GitHub repos and profile, conference program pages. Content: professional/academic facts (research problems, methods, institutions, alma maters, conferences, open-source ecosystems).
  - **Tier B cap sources** (mention-if-natural): the person's own blog, personal-homepage bio sections, conference bios, podcast/talk appearances. Personal facts the target broadcasts in professional-adjacent contexts.
  - **Tier C cap sources** (context-only): social-media posts, old or archived profiles, forum posts, anything reachable only by digging. Shapes tone and topic selection invisibly; **never referenced in an email**. The recipient must never be able to reconstruct the research done on them.

**F3. Intersection engine**
- Input: person ontology (this system) × self-ontology (persona subsystem, read-only). If the self-ontology is empty, the engine fails loudly with instructions to run persona setup; it never silently produces zero intersections.
- Computes overlaps, scores strength 0 to 1 (rubric in the spec), keeps intersections with strength ≥ 0.3 up to a cap of 20 per person, ranked by strength descending.
- Each intersection inherits the **minimum** usability tier of its two facts and stores a one-sentence human-readable rationale.
- Output contract for the drafter: ranked intersection list with tiers, plus a short person profile (current position, research focus, recent work, notable activities). If no intersection scores ≥ 0.5, the output explicitly says "no strong hook" rather than dressing up weak overlaps.

**F4. Persistence & reuse**
- Ontologies, facts, and intersections persist in the shared local store; research runs once per person. When the person appears on a new paper, existing facts are kept and only a light refresh runs (new paper context added; stale facts re-verified per the staleness rule).
- **Staleness rule**: facts older than 180 days are re-verified (one targeted search) before being used in a hook; re-verification happens lazily, only for facts that back a candidate hook.
- A profile view (consumed by the review page) shows the ontology and intersections with sources, so the "why this hook" question is always answerable.

### Non-Functional

- **Honesty over coverage**: an empty facet is better than a low-confidence guess. Facts below confidence 0.5 are stored but excluded from intersections.
- **Cost-bounded**: ≤ 6 search queries and ≤ 4 cheap-tier LLM calls per person mined; free-tier search API (about 1,000 credits/month, roughly 100+ people at this budget).
- **Auditable**: every fact traceable to a source URL and retrieval date.
- **Deterministic where possible**: tier caps, confidence scores for emails, and thresholds are table-driven code, not LLM judgment.

## Edge Cases

- No confident email → manual-lookup queue, never guessed.
- Two facts conflict across sources (e.g. Scholar says MIT, homepage says CMU) → the more recent primary source wins; the losing fact is kept with confidence lowered below 0.5, which excludes it from hooks.
- Facts go stale (people move institutions) → 180-day re-verification rule (F4).
- Common name / ambiguous identity → corroboration rule (F2); ambiguous pages dropped rather than merged.
- Person has almost no public footprint → thin ontology is reported as thin; "no strong hook" is an explicit, first-class output (F3).
- Person's GitHub email is a `noreply` address → discarded at extraction, never stored.

## Open Questions

1. **Tier-cap and confidence tables**: first drafts are in the spec; the Step B human gate exists specifically to calibrate them against Aditya's taste before they are trusted. Not a blocker to building.
2. **Search-budget headroom**: 1,000 credits/month is about 10× the expected volume. Monitor via the events log; no action unless volume changes by an order of magnitude.
