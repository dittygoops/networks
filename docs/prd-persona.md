# PRD: Persona (self-ontology)

> Part of the Academic Networking Email Assistant suite. Produces the self side of
> the ontology that [profile-mining](./prd-profile-mining.md)'s intersection engine
> reads (`ontology_facts` where `person_id IS NULL`). Consumed by draft generation.

## Overview

A subsystem that builds **Aditya's own ontology**: a structured, tiered set of facts about
who he is, what he has built, what he studies, and what he cares about, in the same shape as
a researched person's ontology. It is built once from his documents plus a short
self-interview, stored locally, and reused by the intersection engine to find genuine
overlaps with the people he reaches out to. Without it, every hook is computed against a
fixture, so the emails cannot reference Aditya's real work.

## Problem Statement

The intersection engine needs *both* sides. It already mines the recipient. The self side is
currently a hand-written fixture. To produce hooks grounded in Aditya's actual projects
(the Gaussian-splat banana, the nuScenes obstacle-detection pipeline, his olfactory research
direction) and his personal facets (background, places lived, hobbies) the system needs a
real self-ontology, extracted from his materials and a brief interview, not maintained by
hand.

## Goals & Non-Goals

### Goals
- Produce a self-ontology in the same `ontology_facts` shape (facet, key, value, confidence,
  tier) so the existing intersection engine consumes it with no changes.
- Extract facts **about Aditya** from curated documents (his project write-ups and research
  docs), not encyclopedia facts from topic study notes.
- Capture the facets documents miss (background, places lived, hobbies, communities, what he
  is looking for) via a short self-interview.
- Be rebuildable: running persona setup again replaces the self-ontology cleanly.
- Assign honest usability tiers to self-facts (professional work A, personal-broadcast B,
  private C) so intersections inherit the correct min-tier.

### Non-Goals
- **No automatic document discovery.** Aditya curates which documents count as "about me";
  the folder is full of topic notes that are not.
- **No resume parsing pipeline** (there is no resume in the repo). Structured career history,
  if wanted later, comes from the interview or a supplied resume file.
- **No ongoing sync.** Built once, updated occasionally by re-running; not a live feed.
- Does not touch the recipient-research or contact subsystems; it only writes self-facts.

## User Stories

- As the sender, I want the system to read my project and research docs and turn them into
  facts about me (what I built, what I am moving toward), so hooks can cite my real work.
- As the sender, I want a short interview to capture the personal things my docs do not say
  (where I have lived, my hobbies, what I am looking for), so warm non-research hooks are
  possible.
- As the sender, I want to rebuild my self-ontology after I add a project, without hand-editing
  the database.

## Requirements

### Functional

**F1. Document-sourced self-facts**
- Input: a curated list of document paths (project write-ups, research-gap/proposal docs).
- Each document is read and passed to a cheap LLM that extracts facts **about Aditya**: what he
  built or did (academic/method, dataset, project), what he studies or is moving toward
  (academic/research_area), and stated interests. Encyclopedia facts about the topic itself are
  not extracted.
- Facts use the shared facet/key vocabulary; confidence is high (first-person authoritative
  materials); tier reflects hook-usability.

**F2. Self-interview**
- A fixed set of questions covering facets documents miss: background/current role, places
  lived, hobbies, communities, side projects, and what he is looking for from outreach.
- Answers become facts (trajectory/location, interest/hobby, interest/community, etc.).
- Answers may be provided interactively or from an answers file, so the step is automatable and
  testable.

**F3. Rebuildable storage**
- Self-facts are stored with `person_id IS NULL`. Running persona setup **replaces** the entire
  self-ontology atomically (the build is authoritative), so re-running never duplicates.

**F4. Tiers for self-facts**
- Professional/academic facts (research, methods, projects) → Tier A (lead-with-it).
- Personal facts he is happy to share (hobbies, communities, places lived) → Tier B.
- Anything sensitive → Tier C (shapes tone only). The intersection engine already takes the
  min of the two sides, so honest self-tiers keep hooks appropriate.

### Non-Functional
- Reuses the profile-mining LLM tier, vocabulary, and DB. No new external services.
- Bounded cost: one cheap LLM call per document plus the interview; a handful of calls total.

## Edge Cases & Open Questions
- A topic note that is not about Aditya yields few or no self-facts (the prompt is About-Aditya
  only); that is correct, not a failure.
- The interview is optional; a docs-only build still produces a usable (if less personal)
  self-ontology.
- Open question: should career history come from a supplied resume file later? Deferred until a
  resume exists; the interview covers the essentials for now.
