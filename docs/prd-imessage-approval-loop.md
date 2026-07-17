# PRD: iMessage Approval Loop (F5)

## Overview

The approval loop is the human gate between draft generation and sending. When the pipeline produces a draft, the system texts Aditya a short ping (recipient, paper, one-line gist, review link) via a hosted iMessage API. Aditya can act from either surface: reply over text with a small grammar (`send <id>` / `skip <id>` / `edit <id>: <instructions>`), or open the review page, which shows full context (draft, paper summary, person profile, intersection rationale) and supports the same actions plus direct inline editing of the draft text. Nothing is ever sent without an explicit approval. In this milestone, approval hands the draft to a stub sender that logs and archives the email, so the loop is rehearsable end to end before real Gmail sending (F6) exists.

## Problem Statement

The pipeline can now go from arXiv ID to a grounded draft, but there is no way to review, revise, or approve drafts without sitting at the Mac and inspecting the database. Every outbound email must be human-approved (a hard rule of the parent system), and the review moment usually arrives while Aditya is away from the machine. Without a phone-native approval surface, drafts pile up unreviewed and the system's throughput collapses to whenever Aditya happens to be at his desk.

## Goals & Non-Goals

### Goals
- Ping Aditya's phone within seconds of a draft entering `awaiting_approval`, with enough context in the text to decide or to tap through for more.
- Support decide-from-text (grammar) and decide-from-page (buttons plus inline editing) with identical effect on state.
- Make wrong-draft actions impossible: every draft carries a stable short ID (e.g. `d7`) used in pings, lists, and commands; IDs never shift as new drafts arrive.
- Re-run the grounding check on every instruction-driven redraft; a redraft that cannot meet the grounding bar is flagged, never padded with generalities.
- Keep the loop rehearsable now: `send` routes to a stub sender (log + archive), cleanly replaceable by F6.

### Non-Goals (v1)
- Real email sending, OAuth, Gmail integration (F6).
- Follow-up scheduling and reply handling (F7, F8).
- Reminder re-pings for stale pending drafts: drafts hold forever until acted on. If this stings later, re-pings piggyback on F7's scheduler.
- Native on-Mac iMessage automation (AppleScript send, chat.db reads). The hosted API replaces it; the native path remains a documented fallback, not a build target.
- Intake-via-text (texting an arXiv link to trigger the pipeline). Useful, but a separate concern; noted as a v2 candidate.
- Consuming captured edits to improve future drafts (gold-standard corpus, exemplar injection, style distillation): own problem/solution pair, see `prd-edit-learning.md`. F5 only captures.

## User Stories

- As Aditya, I want a text the moment a draft is ready, so that review happens in the natural flow of my day instead of at my desk.
- As Aditya, I want to reply `send d7` from my phone and trust that exactly that draft (and no other) is approved, so that a stale reply can never approve the wrong email.
- As Aditya, I want to reply `edit d7: mention the RSS gap instead` and get a re-grounded redraft pinged back to me, so that revision doesn't require the laptop.
- As Aditya, I want to open a review page showing the draft, the paper, the person profile, and why each hook was chosen, so that I can judge borderline drafts with full context.
- As Aditya, I want to edit the draft text directly on the page when my change is faster to type than to describe, so that small wording fixes take one step, not an edit-instruction round trip.
- As Aditya, I want unrecognized replies to get a short help message, so that I never wonder whether my command was understood.
- As Aditya, I want every failure (grounding, redraft, delivery) reported in the message thread itself, so that I can see what went wrong without opening server logs.
- As Aditya, I want every edit I make captured with full context, so that the edit-learning subsystem (see `prd-edit-learning.md`) has a faithful record to learn from.

## Requirements

### Functional

**A1. Channel: hosted iMessage API**
- Outbound pings and inbound replies go through a hosted iMessage provider behind a `channel` interface. Provider was selected in the spec phase by comparing LoopMessage, Sendblue, and Photon Spectrum on price, sender identity, and inbound-delivery ergonomics: **Photon Spectrum, managed free shared-line tier** (decided Jul 16 with Aditya; the shared sending number is acceptable). LoopMessage is the documented fallback.
- Accepted tradeoffs (decided): texts may arrive from a service number rather than a normal contact thread, and message content transits the provider's servers.
- Inbound replies are delivered over a long-lived stream the daemon opens outbound to the provider (Photon's gRPC transport), so the primary design has no public endpoint at all. Every inbound message is verified against Aditya's phone number; everything else is dropped and logged. If a webhook-only provider is ever swapped in, the fallback ingress is a single Tailscale Funnel route with a verified shared secret (spec AL11 appendix).

**A2. Ping content**
- On a draft entering `awaiting_approval`: one text containing recipient name + institution, paper title (short), the draft's one-line gist, the draft's short ID, and the review-page link.
- Pings contain Tier A/B context only; Tier C facts never appear in a text (they transit a third party). Full rationale, including Tier C, lives only on the tailnet-bound review page.

**A3. Reply grammar**
- `send <id>`: mark approved; hand to the stub sender.
- `skip <id>`: mark skipped; optional trailing text stored as the skip reason.
- `edit <id>: <instructions>`: redraft with the instructions, re-run the grounding check, re-ping with the new version (same ID, new revision number).
- Bare `send` / `skip` / `edit: ...` with exactly one pending draft applies to it; with more than one pending, the bot replies with the ID'd list and asks for an explicit ID.
- `list`: returns all pending drafts with IDs and gists.
- Anything unrecognized: one short help message with the grammar. No action taken.

**A4. Review page**
- Serves per-draft pages at a stable URL included in the ping. Bound to the tailnet interface only (Tailscale); no additional page auth in v1. Never bound to a public interface.
- Shows: full draft (current revision plus revision history), paper summary, person profile, ranked intersections with tiers and the chosen hook's rationale.
- Actions with full grammar parity: Send, Skip (with reason field), Edit-with-instructions.
- Inline editing: Aditya can edit the draft text directly and save it as the new revision. Inline edits pass the same grounding check as redrafts: a revision that fails cannot become the sendable revision. The page shows exactly which requirement failed (missing recipient-work reference, missing own-work reference) so the fix is one more edit away; the last passing revision remains sendable in the meantime.

**A5. Edit loop semantics**
- No cap on edit cycles. Every instruction-driven redraft passes the grounding verifier (≥1 specific recipient-work reference, ≥1 specific own-work reference) before re-pinging.
- A redraft that fails grounding is not sent to the phone as-is: the ping flags the failure and the draft stays pending with the last passing revision marked.
- All revisions, instructions, and decisions are stored (auditability is a parent-system requirement).

**A6. Transparent failure reporting over iMessage**
- Every failure in the loop is reported in the thread in plain language, never swallowed into a log file only: grounding failures (with which requirement failed), redraft/LLM errors, stub-sender errors, provider delivery failures on retry exhaustion, and rejected inbound messages (summarized, e.g. "ignored 2 messages from unknown numbers today").
- Failure texts always state what happened, which draft ID it affected, and what state the draft is in now, so recovery never requires reading server logs.
- The review page mirrors the same event log per draft (timestamped ping/command/revision/failure history).

**A7. Edit capture (feeds the edit-learning subsystem)**
- Every revision is stored with provenance (`model` or `human`), the prior revision, the draft context (recipient profile, chosen hook, intent), and, for instruction-driven redrafts, the instruction text.
- This PRD's obligation ends at faithful capture in the ledger. How captured edits become a gold-standard corpus and feed future draft generation is a separate problem/solution pair: see `prd-edit-learning.md`.

**A8. Stub sender (F6 seam)**
- `send` transitions the draft to approved and invokes a sender interface. v1 implementation: write the fully rendered email (headers + body) to the ledger and an on-disk archive, mark the record `sent (stubbed)`, and confirm back over iMessage.
- F6 replaces only the sender implementation; no approval-loop changes required.

**A9. State & concurrency**
- Draft short IDs are permanent, unique, human-typeable (e.g. `d7`), assigned at draft creation.
- Actions are idempotent: a duplicate `send d7` after the draft is decided gets "already sent/skipped" back, never a double action.
- Race between page and text (both act on the same draft): first write wins; the loser surface reports the existing outcome.
- Pending drafts hold indefinitely. No expiry, no auto-skip, no re-ping.

### Non-Functional

- **Latency**: ping dispatched within 10 seconds of a draft entering `awaiting_approval`; inbound command acted on within 5 seconds of receipt.
- **Security**: no publicly reachable surface in the primary design (inbound arrives on the outbound stream); the sender number is verified on every message. Review page is tailnet-only. Provider credentials stored locally with restrictive permissions. (Webhook fallback, if ever used: that endpoint is the only public surface and verifies a shared secret.)
- **Privacy**: Tier C research facts never leave the machine except to the tailnet page (A2).
- **Resilience**: if the Mac sleeps and the stream drops, replies are processed on reconnect (server-side replay if the provider supports it, verified by the spec's Step 1 spike; otherwise an on-reconnect pending notice); late by hours is acceptable.
- **Auditability**: every ping, inbound command (including rejected/unrecognized), revision, and decision is logged with timestamps.

## Edge Cases & Open Questions

### Edge cases (handled by design)
- Reply references a decided or unknown ID → informative response ("d7 was already sent Tuesday"), no action.
- Two pending drafts, bare `send` → ID'd list returned, no action until an explicit ID arrives.
- Inline page edit and a text `edit d7: ...` land near-simultaneously → revisions serialize by arrival; each new revision re-pings, latest revision is what `send` sends.
- Provider outage → pings queue locally and retry with backoff; review page (tailnet) still works, so approvals are never fully blocked.
- Webhook receives a message from any number other than Aditya's → dropped and logged, never parsed as a command.
- Redraft or inline edit repeatedly fails grounding → draft stays pending with the failure and the specific missing requirement reported in-thread and on the page; the last passing revision stays sendable, and skip is always available.

### Open questions
1. **Provider selection**: resolved in the spec phase. Photon Spectrum (managed free tier, gRPC stream inbound, no public endpoint); LoopMessage fallback ($20/mo, verified webhook scheme). Remaining unknown: replay-after-disconnect behavior, settled empirically by the spec's Step 1 spike.
2. **Tailscale Funnel constraints**: resolved. Funnel can expose a single mounted route while everything else stays tailnet-only (verified against Tailscale KB); only relevant if the webhook fallback is ever exercised.
3. **Gist generation**: is the one-line gist a cheap-tier LLM call at draft time or derived from the chosen hook? Decide in spec; must not add noticeable latency to the ping.
4. **v2 candidates** (deferred): intake-via-text (texting an arXiv link), re-pings via F7's scheduler, native on-Mac channel as a cost-reduction fallback.
