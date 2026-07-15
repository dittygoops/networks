# Technical Spec: Draft Generation

> PRD: [`docs/prd-draft.md`](./prd-draft.md). Consumes profile-mining hooks and
> persona intent; produces a draft for review (no send).

## Overview

`src/pipeline/draft.ts`: `generateDraft(llm, input)` builds a frontier-tier prompt from the
recipient, the top hooks (entity + detail), and Aditya's intent, and returns `{ subject, body }`.
Pure over its inputs (LLM injected), testable offline with a fake. Wired into the CLI so
`outreach add` prints a draft after the hooks.

## Resolved Decisions

### DR1. Model tier
Drafts use the **frontier** model (the draft is the product). `createOpenRouterClient(model?)`
takes an optional model; the CLI passes `MODEL_FRONTIER` (default a strong general model) for
drafts, while research/intersections keep `MODEL_CHEAP`. Temperature 0.4 (a little warmth, still
stable).

### DR2. Inputs
```ts
interface DraftInput {
  recipient: { name: string; affiliation?: string | null; profileSummary?: string; paperTitle?: string };
  hooks: { selfValue: string; personValue: string; selfDetail?: string; personDetail?: string; tier: 'A'|'B'|'C' }[];
  intent: string;      // Aditya's goal, from his persona (interest/writing fact)
  senderName: string;  // "Aditya Gupta"
  senderFacts?: string[]; // a few of Aditya's relevant self-facts for the credibility marker
}
```
The CLI assembles this: recipient from `processPaper` (name, affiliation, profileSummary,
paperTitle), `hooks` = top 3 by strength, `intent` = the `interest/writing` self-fact,
`senderFacts` = a few Tier-A self-facts related to the top hook.

### DR3. Prompt (hard style rules)
`DRAFT_SYSTEM` encodes the roadmap and the non-negotiable style:
- Structure: hook line -> one-line who-I-am + one concrete credibility marker -> one clear ask ->
  brief sign-off. No greeting filler before the hook.
- Casual but polite; contractions fine; no corporate stiffness.
- Body under 120 words (aim 80-110). Cut adjectives, flattery, filler.
- Banned openers/phrases: "I hope this email finds you well", "I am reaching out", "I would love
  to pick your brain", "I have been following your work", empty superlatives.
- Address "Hi <First>,"; sign "Best,\nAditya".
- Ground: use at least one specific recipient fact and one specific sender fact from the input;
  never invent shared history, prior contact, or papers not given.
- No em dashes.
- Return ONLY JSON `{ "subject": string, "body": string }`. Subject short, specific, lowercase-
  casual, no "Re:".

`buildDraftUser(input)` lays out: recipient name/affiliation/paper, the top hooks as
`shared: <entity> | you: <personDetail> | me: <selfDetail>`, Aditya's intent, and his relevant
facts.

### DR4. Grounding check (light, deterministic)
After generation, verify the body is non-empty and contains a token from at least one hook's
`personValue` and one hook's `selfValue` (case-insensitive substring). If not, set
`grounded=false` in the result so the caller can flag it. Parse failure or an over-long body
(> 160 words) also sets a flag rather than throwing.

### DR5. Output
```ts
interface Draft { subject: string; body: string; grounded: boolean; wordCount: number; notes: string[]; }
```
Returned for review. No persistence here (the approval subsystem owns the drafts table).

### DR6. CLI
`outreach add <arxiv-id>` gains a final draft step: if the person resolved and there is at least
one hook, generate and print the draft (subject + body + a note if weak-hook or ungrounded).
Never sends.

## Interfaces
| Interface | Shape | Consumer |
|---|---|---|
| `generateDraft(llm, input)` | `Promise<Draft>` | CLI / (later) approval subsystem |
| `createOpenRouterClient(model?)` | `LLMClient` | draft uses frontier, others cheap |

## Implementation Plan
1. `createOpenRouterClient` optional model param.
2. `DRAFT_SYSTEM` + `buildDraftUser` prompts.
3. `draft.ts`: `generateDraft` (parse JSON, grounding check, word count) + tests (fake LLM).
4. Wire into CLI `add`; live-run on a real olfaction paper and read the draft cold.
   ✅ *Human gate: does it read casual-but-polite, lead with the hook, stay concise, and only say
   true things? Iterate on the prompt before trusting it.*

## Open Questions
- Address form for senior PIs (default first name); revisit with real replies.
- Whether to draft against a weak/no-strong-hook person at all, or route to manual; for now it
  drafts and flags.
