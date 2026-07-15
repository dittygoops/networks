# PRD: Draft Generation

> Part of the Academic Networking Email Assistant suite. Consumes the ranked hooks
> and profile from [profile-mining](./prd-profile-mining.md) and Aditya's intent from
> [persona](./prd-persona.md). Produces the outreach email; sending/approval are
> separate subsystems.

## Overview

Turns a resolved recipient (their profile, the paper, and the ranked intersection hooks)
plus Aditya's self-facts and intent into a short, casual-but-polite outreach email that
leads with a genuine shared hook and makes one clear, low-friction ask. It never sends;
it produces a draft for human review.

## Problem Statement

The pipeline now knows who to contact, how to reach them, and the genuine overlap to open
with. The remaining step is writing the email, and this is where most cold outreach fails:
it is stiff, long, full of flattery and filler, or leads with "I am reaching out" instead of
the thing that actually connects the two people. The draft has to read like a real person
wrote it: casual but respectful, concise, specific, and grounded only in facts we actually
have.

## Goals & Non-Goals

### Goals
- **Lead with the hook.** The first line is the genuine shared thing (the top-ranked
  intersection), stated specifically using its detail, not a greeting-filler.
- **Casual but polite.** Reads like a sharp peer, not a form letter or a stiff cover letter.
  Contractions fine; etiquette intact (proper address, a real ask, a clean sign-off).
- **Ruthlessly concise.** Short body, no fluff. Cut adjectives, flattery, and filler phrases.
- **One clear ask.** A single, low-friction request for direction/guidance, tailored to the
  recipient's area, informed by Aditya's intent (direction on future olfaction work).
- **Grounded only in real facts.** Every specific claim traces to a provided self-fact or
  recipient-fact. No fabrication, no invented shared history.
- Produce a subject and body for review; regeneration and edits are supported by the approval
  subsystem, not here.

### Non-Goals
- **No sending.** Output is a draft only.
- **No approval loop / iMessage.** Separate subsystem.
- **No multi-email sequences or follow-ups.** Separate subsystem.
- **No invented rapport.** It will not claim Aditya has followed their work for years, met them,
  or read things he has not.

## Requirements

### Functional

**F1. Inputs**
- Recipient: name, current affiliation, short profile summary, the paper title.
- Ranked hooks (top few), each with the shared entity and both sides' `detail`.
- Aditya's intent (from his persona), his name, and a small set of his relevant self-facts for
  the credibility marker.

**F2. Structure (roadmap, not a rigid template)**
- Hook (lead): the specific shared thing, 1 short sentence.
- Who I am + one credibility marker: one line, a concrete thing Aditya has done that is relevant.
- The ask: one clear, low-friction request for direction/guidance in the recipient's area.
- Light close: a clean, brief sign-off.

**F3. Style rules (hard constraints)**
- Casual but polite; contractions allowed; no corporate stiffness.
- Concise: body target under ~120 words, ideally 80-110.
- Ban filler: "I hope this email finds you well", "I am reaching out", "I would love to pick
  your brain", excessive superlatives, and empty flattery.
- Address by first name ("Hi <First>,"); sign off simply ("Best, Aditya").

**F4. Grounding**
- The body must include at least one specific reference to the recipient's work and at least one
  to Aditya's own work, both drawn from provided facts. If the facts are too thin to do this
  honestly, the draft says less rather than inventing.

**F5. Output**
- A subject (short, specific, lowercase-casual, no "Re:") and a body. Returned for review.

### Non-Functional
- Uses the frontier LLM tier (the draft is the product; quality over cost here).
- Deterministic-enough: temperature low; the same inputs give a stable draft.

## Edge Cases & Open Questions
- Thin hooks (only a weak/no strong hook): draft a more general but still specific and honest
  note, and flag that the hook is weak.
- Recipient is a senior PI vs a grad student: tone stays casual-but-polite either way; address by
  first name unless a title is clearly expected (open question, default first name).
- Open question: subject-line conventions for academics (short and specific tends to get opened);
  revisit after seeing real replies.
