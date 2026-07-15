# PRD: Academic Networking Email Assistant

## Overview

A human-in-the-loop email outreach system that helps Aditya build genuine research relationships with authors of interesting AV/3DGS/neural-rendering papers. The system discovers authors from papers (starting with ones already read), researches each person from public sources, drafts a deeply personalized outreach email grounded in both the paper and Aditya's own work, and sends it only after one-tap approval over iMessage. It then manages the follow-up cadence, detects replies, and drafts same-day responses — every outbound message gated by human approval. Runs locally on Aditya's Mac; sends from `apgupta3@asu.edu`.

## Problem Statement

Aditya is transitioning into AV/simulation research from a SWE background and needs guidance from people already in the field — specifically the authors of papers he finds compelling. Doing this well by hand is slow and inconsistent: finding a researcher's actual email, reading enough of their background to write a credible personalized note, remembering to follow up without nagging, and responding promptly when someone replies. The result is that outreach mostly doesn't happen. Generic automation is worse than nothing — a templated email to a professor burns the exact relationship it was meant to start. The system's job is to remove the logistical friction while keeping quality and judgment human.

## Goals & Non-Goals

### Goals
- Turn "I read an interesting paper" into a sent, personalized outreach email with < 5 minutes of human effort.
- Never send anything without explicit human approval (reply `send` over iMessage).
- Maintain a disciplined follow-up cadence: first follow-up after 2 business days of silence, max 2 follow-ups, sequence cancelled the moment a reply is detected.
- Respond to replies same-day: system detects the reply, drafts a response with full thread + paper context, pings for approval.
- Ground every draft in real specifics: the person's actual work (Scholar, homepage, GitHub, X) compared against Aditya's profile (resume, research-gap docs, project work) to find a genuine similarity to lead with.
- Keep a contact ledger so no one is ever double-contacted and thread state is always known.

### Non-Goals (v1)
- **No autonomous sending.** Every email — outreach, follow-up, reply — requires approval.
- **No LinkedIn automation.** Public sources only (Scholar, homepages, GitHub, X). LinkedIn scraping risks account restriction and academics' public pages are richer anyway.
- **No bulk/volume outreach.** This is a precision tool; expected volume is a few emails per week. No deliverability infra, no sending domains, no sequences-at-scale.
- **No fully-automated paper discovery in v1.** A standing arXiv watch is a v2 candidate; v1 discovery is manual (paste an arXiv ID/URL) seeded by the already-read papers in the learning vault.
- **No VPS deployment in v1** — but the messaging layer is abstracted so a later move to always-on hosting (e.g. iMessage relay via Photon Spectrum) is cheap.

## User Stories

- As a researcher-in-training, I want to paste an arXiv ID and have the system identify who to contact and why, so that outreach starts from papers I actually care about.
- As the sender, I want each draft to reference something specific I've done (nuScenes eval pipeline, 3DGS banana project, research-gap proposals) that connects to the recipient's work, so the email reads as a peer reaching out, not a template.
- As the sender, I want a text on my phone with a one-line gist and a link to the full context (draft, paper summary, person profile, similarity angle), so I can approve with a single reply — `send`, `skip`, or `edit: <instructions>`.
- As the sender, I want follow-ups scheduled automatically (2 business days, max 2) and cancelled instantly on reply, so I stay persistent without ever nagging.
- As the sender, I want to be pinged the same day someone replies, with a drafted response ready for approval, so promising conversations don't stall on my inbox habits.
- As the sender, I want a ledger of everyone contacted — status, thread history, follow-up state — so I never double-email a person or a lab awkwardly.

## Requirements

### Functional

**F1. Paper intake & author selection**
- Input: arXiv ID or URL (manual, v1). Seed list: papers already read (learning vault).
- System pulls metadata + full text (arxiv MCP already configured), identifies authors, and recommends a target: **default first author** (usually the grad student — more likely to reply, closer career stage); **fall back to PI/last author** when the first author is unfindable or the ask is strategic direction rather than technical.
- User confirms/overrides the target before any research begins.

**F2. Contact extraction (tiered, confidence-gated)**
- Tier 1: emails in the paper PDF (corresponding author).
- Tier 2: Google Scholar profile → university/lab homepage (most reliable `.edu` source).
- Tier 3: GitHub profile/commit metadata.
- No confident email found → paper enters a **manual-lookup queue**; the system never guesses. A bounced or wrong-person email is worse than a delayed one.

**F3. Person ontology & intersection engine**
- Public sources only: Google Scholar, personal/lab homepage, GitHub, X/Twitter, personal blogs, conference bios, podcast/talk appearances.
- Builds a structured **person ontology** per target — facets, each fact stored with source URL and confidence:
  - *Academic*: research areas, methods, key papers, venues, advisors/lab lineage.
  - *Trajectory*: institutions attended, companies/roles, geographic path (where they've studied/worked/lived, when publicly stated).
  - *Interests*: hobbies, side projects, open-source work, writing, communities — anything they publicly broadcast.
- A matching **self-ontology for Aditya** is built once from his resume, research-gap docs, project write-ups, and a short self-interview to fill facets documents don't cover (places lived, hobbies, communities) — then reused and occasionally updated.
- The **intersection engine** computes overlaps between the two ontologies and ranks them by strength and specificity. Every intersection carries a **usability tier** derived from where the target's side of the fact was found:
  - **Tier A — lead-with-it**: professional/academic overlaps (shared research problems, methods, institutions, alma maters, conferences, open-source ecosystems). Eligible to be the explicit hook.
  - **Tier B — mention-if-natural**: personal facts the target broadcasts in professional-adjacent contexts (homepage bio, own blog, conference bio). Usable as a light aside, never the opening.
  - **Tier C — context-only**: anything requiring digging (old profiles, personal social media). Shapes tone and topic selection invisibly; **never referenced in the email**. The recipient must never be able to reconstruct the research done on them.
- Output to the drafter: ranked intersection list with tiers + the short person profile (current position, research focus, recent work, notable activities).

**F4. Draft generation (intent-flavored roadmap, not fill-in-the-blank template)**
- One flexible email roadmap (hook → who I am + credibility marker → specific engagement with their work → the ask → light close), flavored by intent. v1 intents:
  - **Seeking direction**: "I'm moving into this field, here's what I've built, what would you recommend I go deep on?"
  - **Research-gap probe**: "Have you looked at ⟨gap⟩? I've been exploring it and would value your take."
- The hook is chosen from the intersection engine's ranked list, respecting usability tiers (F3): Tier A intersections may open the email; Tier B may appear as an aside; Tier C never appears.
- Every draft must include ≥1 specific reference to the recipient's work and ≥1 specific reference to Aditya's own work. Drafts that can't meet this bar are flagged rather than padded with generalities.
- Concise by default (~120–180 words); professors skim.

**F5. Approval loop over iMessage**
- Delivery: local Messages app (AppleScript / imessage-kit) to 480-692-8263.
- Text contains: recipient, paper, one-line gist of the draft, and a link to a local review page showing the full draft, paper summary, person profile, and similarity rationale.
- Reply grammar: `send` → send now; `skip` → mark rejected, log reason optional; `edit: <instructions>` → redraft and re-ping. Unrecognized replies get a short help response.
- Nothing sends without an explicit `send`.

**F6. Sending**
- From `apgupta3@asu.edu` (ASU Google Workspace). Preferred path: Gmail API via OAuth; fallback: IMAP/SMTP app password if org policy allows (see Open Questions).
- Sent mail lands in the real Sent folder; replies thread normally in Gmail.

**F7. Follow-up scheduler**
- On send: schedule follow-up #1 at +2 business days, #2 at +2 more business days. Hard cap: 2 follow-ups.
- Follow-up drafts are short, add one new piece of value (not "just bumping this"), and go through the same approval loop.
- Any detected reply cancels the remaining sequence immediately.

**F8. Reply handling (detect + draft)**
- Inbox polling detects replies to tracked threads.
- On reply: cancel follow-ups, classify (engaged / polite decline / question / auto-reply / bounce), draft a same-day response using full thread + paper + person context, and ping for approval via the standard loop.
- Auto-replies (OOO, noreply, mailer-daemon) never trigger drafts; bounces flag the contact's email as bad and re-enter contact extraction.

**F9. Contact ledger (mini-CRM)**
- Local store (SQLite) tracking: person, email, paper(s), status (queued / researched / drafted / awaiting-approval / sent / following-up / replied / closed / bounced / skipped), full thread history, timestamps, follow-up schedule.
- Stores each person's ontology (facts with source, confidence, usability tier) so research is done once and enriched over time, and the review page can show *why* a hook was chosen.
- Hard rule: never email a person who already has an active or closed thread without explicit user override.
- Soft rule: warn before contacting two people from the same lab within a short window.

### Non-Functional

- **Quality over throughput.** The bottleneck is intentionally the human review step. No batching pressure, no daily quotas.
- **Security**: OAuth tokens / app passwords stored locally with restrictive permissions; the review page binds to localhost (see Open Questions for off-network access). Only Aditya's phone number is accepted as a command source on the iMessage channel.
- **Resilience to sleep**: the Mac may be asleep during a poll window; on wake, the system catches up (missed follow-ups fire late rather than never; late by hours is acceptable at this volume).
- **Auditability**: every draft version, approval decision, and send is logged.

## Edge Cases & Open Questions

### Edge cases (handled by design)
- Author email unfindable → manual-lookup queue, never guessed.
- Reply arrives mid-follow-up-sequence → sequence cancelled before next fire (check at fire time, not just at schedule time).
- Same author appears on multiple interesting papers → single contact record; new papers attach as additional context, not additional emails.
- OOO/auto-reply → does not count as a reply for cancelling follow-ups (classification distinguishes it), does not trigger a drafted response.
- Bounce → contact marked bad-email, returned to extraction tiers.
- Recipient replies with a deep technical question → drafted response is grounded only in work Aditya has actually done; the draft flags any point where the honest answer is "I haven't gotten there yet."
- Two facts conflict across sources (e.g. Scholar says MIT, homepage says CMU) → most recent primary source wins; conflicting fact stored with lowered confidence and excluded from hooks.
- Ontology facts go stale (people move institutions) → facts carry a retrieved-at date; anything older than ~6 months is re-verified before being used in a hook.

### Open questions
1. **ASU Google Workspace restrictions**: does ASU allow app passwords / third-party IMAP-SMTP, or is Gmail API OAuth (possibly with admin-consent limitations) the only path? Must be verified first — it gates F6.
2. **Review-page access away from home**: localhost links won't resolve from the phone off-network. Options: Tailscale (recommended, free), or falling back to full-draft-in-text when off-network. Decide at build time.
3. **iMessage automation reliability on modern macOS**: AppleScript send is solid; programmatic *read* of replies may require Full Disk Access to `chat.db`. Needs a spike before committing to the reply-grammar UX.
4. **v2 candidates** (explicitly deferred): standing arXiv keyword watch with weekly candidate digest; conference-deadline-aware timing; VPS + iMessage relay (Photon Spectrum) for always-on operation; additional intents once physical work ships (e.g. "I extended your work, here's what I found").
