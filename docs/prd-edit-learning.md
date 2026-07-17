# PRD: Edit Learning (human corrections improve future drafts)

## Overview

Every time Aditya edits a draft (inline on the review page) or issues an edit instruction (`edit <id>: ...` over iMessage), the approval loop (see `prd-imessage-approval-loop.md`, A7) captures the before/after revisions with provenance and context. This subsystem turns that capture into a gold-standard corpus and feeds it back into draft generation, so first drafts steadily converge toward Aditya's voice and stop repeating corrections he has already made. Human-written revisions are the gold standard: they outrank every model output as evidence of what a draft should look like.

## Problem Statement

The drafter starts every email from the same prompt, so it makes the same mistakes forever: the same too-formal phrasing, the same over-claiming Aditya has to soften, the same structural tics he rewrites every time. Each correction is currently spent once and thrown away. For a system whose entire value is producing drafts that need little or no editing, discarding the highest-quality signal available (what the human actually changed) means review effort never decreases.

## Goals & Non-Goals

### Goals
- Persist every captured edit as a structured learning example: prior revision, human revision (gold-standard) or instruction-driven revision, draft context (recipient profile, chosen hook, intent), and the edit instruction when one exists.
- Feed the drafter at generation time: recent and representative gold-standard before/after exemplars plus recurring edit instructions are injected into the drafting prompt.
- Maintain a distilled **style-notes block**: a short, periodically regenerated summary of recurring corrections ("cut greetings longer than one sentence", "never open with 'I hope this finds you well'"), included in every drafting prompt.
- Measurable outcome: edit rate per draft (revisions before approval) trends down over time; the corpus makes this measurable for free since every revision is stored.

### Non-Goals (v1)
- Fine-tuning a model on the corpus, or automated prompt evolution/optimization loops. Explicitly v2.
- Learning from `skip` decisions (why a draft was rejected wholesale). The skip reason is stored by the approval loop, but interpreting it is deferred.
- Learning tone from Aditya's regular sent mail or other writing outside this system.
- Any UI beyond what the review page already shows; this subsystem is invisible except through better drafts.

## User Stories

- As Aditya, I want a correction I make once to be reflected in future first drafts, so that I never have to make the same edit twice.
- As Aditya, I want my own written revisions treated as the gold standard over anything the model produced, so that the system learns my voice rather than reinforcing its own.
- As Aditya, I want recurring edit instructions to become standing guidance, so that "make it shorter" stops being something I have to type.
- As Aditya, I want to see the edit rate per draft over time, so that I can tell whether the system is actually learning.

## Requirements

### Functional

**L1. Corpus semantics**
- Source of truth is the revision capture defined in the approval-loop PRD (A7); this subsystem adds no second write path.
- A learning example is derived per human-authored revision (gold-standard) and per instruction-driven redraft (instruction examples). Model-authored first drafts are context, never exemplars.
- Examples carry the draft context so retrieval can prefer relevant ones (same intent, similar hook type, similar recipient facet).

**L2. Prompt-time consumption**
- The drafting prompt includes: (a) up to N gold-standard before/after exemplars, selected by recency and contextual similarity to the current draft; (b) the distilled style-notes block; (c) recurring edit instructions phrased as standing rules.
- Selection is deterministic and logged: every generated draft records exactly which exemplars and style-notes version were in its prompt, so a bad draft can be traced to its inputs.

**L3. Style-notes distillation**
- A cheap-tier LLM pass regenerates the style-notes block from the corpus periodically (e.g. after every K new gold-standard examples), not on every draft.
- The block is short (hard token budget), versioned, and stored in the ledger. Regeneration never deletes prior versions.

**L4. Storage**
- Corpus and style-notes versions live in the existing SQLite ledger, queryable and auditable like everything else. No new storage system.

**L5. Metrics**
- Per-draft edit count and time-to-approval are derivable from existing revision data; expose a simple query/report (CLI is fine) showing the trend.

### Non-Functional

- **No added draft latency worth noticing**: exemplar selection is a local DB query; distillation happens off the critical path.
- **Honesty invariant preserved**: learned style never overrides grounding or stance rules. A gold-standard exemplar teaches voice and structure, not facts; recipient-specific content is never copied across drafts.
- **Privacy**: exemplars contain past recipients' names and facts; they are used only in local prompt assembly and LLM calls the system already makes, never shown to future recipients or included in any outbound email.

## Edge Cases & Open Questions

### Edge cases (handled by design)
- An edit fixes a factual error the grounding verifier can't see → the gold-standard pair still captures the correction, so the corpus teaches it even though no check fired.
- Contradictory corrections over time (Aditya's taste changes) → recency-weighted selection and periodic re-distillation let new preferences displace old ones; style-notes versioning makes the shift visible.
- An edit is recipient-specific, not stylistic (e.g. fixing one professor's title) → contextual similarity selection makes it unlikely to surface as an exemplar elsewhere; the style distiller is instructed to ignore one-off factual fixes.
- Tiny edits (typo fixes) → below a minimum-change threshold, revisions are captured but not promoted to exemplars, keeping the corpus high-signal.

### Open questions
1. **Exemplar count and selection weights** (N, recency vs similarity balance): tune during spec/implementation against real edit data.
2. **Distillation cadence** (K): pick once a few dozen examples exist.
3. **Instruction generalization**: when does a one-time `edit:` instruction become a standing rule vs stay a one-off? Likely threshold: seen 2+ times across different drafts. Decide in spec.
4. **v2 candidates**: fine-tuning on the corpus, learning from skip reasons, importing voice from Aditya's real sent mail.
