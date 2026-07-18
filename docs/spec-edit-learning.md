# Technical Spec: Edit Learning

> PRD: [`docs/prd-edit-learning.md`](./prd-edit-learning.md). Consumes the revision
> capture defined by the approval loop (A7 in
> [`docs/prd-imessage-approval-loop.md`](./prd-imessage-approval-loop.md)); feeds the
> drafter ([`docs/spec-draft.md`](./spec-draft.md)). Read-only over revisions: this
> subsystem adds NO second write path for edits.

## Overview

Three small, decoupled pieces under `outreach/src/learning/`:

1. **Derivation** (`derive.ts`): whenever the approval loop stores a human revision or an
   instruction-driven redraft, a deriver (running off the draft critical path) turns it into a
   row in `learning_examples`, classified by scope (stylistic vs recipient-specific) and gated
   by a minimum-change threshold.
2. **Selection + injection** (`select.ts` plus a small extension to the draft prompt): at
   draft time, a deterministic local SQL query picks up to N exemplars by recency and
   contextual similarity, and the current style-notes version; both are appended to the
   drafting user message inside a hard token budget. Every generated draft logs exactly which
   exemplar IDs and style-notes version were in its prompt (`prompt_inputs`).
3. **Distillation** (`distill.ts`): every K new gold-standard examples, a cheap-tier LLM pass
   regenerates the style-notes block (versioned, append-only) and promotes recurring `edit:`
   instructions into standing rules.

Latency story: selection is one local SQLite query plus string assembly (microseconds at this
volume); derivation and distillation run after the approval-loop write, never inside
`generateDraft`. Covers PRD L1 (corpus semantics), L2 (prompt-time consumption, logged),
L3 (distillation), L4 (SQLite only), L5 (metrics CLI).

## Read contract on the approval loop (owned by the approval-loop spec)

This subsystem reads two tables the approval-loop spec owns and defines. The columns below are
the contract this spec requires of them; names are the requirement, and the exact DDL
lives in `spec-imessage-approval-loop.md` (AL4), which states the contract "is matched
exactly" (confirmed: the column lists match). If a future revision there renames anything,
`learning/` is the only consumer to update.

```
revisions                                   -- one row per draft revision (A7)
  id            INTEGER PRIMARY KEY
  draft_id      INTEGER NOT NULL            -- FK drafts(id)
  rev_no        INTEGER NOT NULL            -- monotonic per draft
  subject       TEXT
  body          TEXT NOT NULL
  provenance    TEXT CHECK IN ('model','human')
  prior_revision_id INTEGER                 -- NULL only for rev_no = 1
  instruction   TEXT                        -- edit-instruction text; NULL for inline edits
                                            -- and first drafts
  context_json  TEXT NOT NULL               -- draft context at generation, incl. the
                                            -- groundingTerms key (AL8: paper title lives
                                            -- in groundingTerms.recipientTerms; EL6's
                                            -- redactor sources title stems from it):
                                            -- { intent,
                                            --   hook: { intersectionId, entity, facet, tier },
                                            --   recipientProfileSummary }
  created_at    TEXT

drafts                                      -- one row per draft (short IDs, state)
  id, short_id, person_id, created_at
  decided_at    TEXT                        -- when send/skip landed; NULL while pending
  status        TEXT                        -- includes 'approved'/'sent' and 'skipped'
```

Semantics this subsystem relies on:
- `provenance = 'human'` means Aditya typed the revision text himself (inline page edit).
- `provenance = 'model' AND instruction IS NOT NULL` means an instruction-driven redraft: the
  body is model text, but the instruction is human signal.
- `provenance = 'model' AND instruction IS NULL` is a first draft (or regeneration): context
  only, never an exemplar (PRD L1).
- The approval loop emits an event (or the deriver polls, see EL2) after each revision write.

## Module layout

```
outreach/src/
├── learning/
│   ├── constants.ts      # N, weights, K, thresholds, token budgets (all tunables here)
│   ├── derive.ts         # revision row -> learning_example (threshold + scope classify)
│   ├── select.ts         # deterministic exemplar selection + learned-block assembly
│   ├── distill.ts        # style-notes distillation + recurring-instruction promotion
│   └── metrics.ts        # L5 report queries
├── llm/prompts.ts        # + STYLE_DISTILL_SYSTEM, SCOPE_CLASSIFY_SYSTEM, builders,
│                         #   and the learned-block section in buildDraftUser
├── db/schema.sql         # + learning_examples, style_notes, prompt_inputs
└── cli.ts                # + `learn-report`, `style-notes [--history]`
```

The existing conventions hold: prompts live in the single `src/llm/prompts.ts` file, DDL in
`src/db/schema.sql` applied idempotently by `openDb`, LLM calls go through the injectable
`LLMClient` from `src/llm/client.ts` (cheap tier: default `MODEL_CHEAP`).

## Resolved Decisions

### EL1. DDL (in `src/db/schema.sql`)

```sql
-- Edit-learning corpus (PRD L1/L4). Derived from revisions (approval-loop owned);
-- this subsystem never writes revisions, only reads them.
CREATE TABLE IF NOT EXISTS learning_examples (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL UNIQUE,     -- source revision (read contract above)
  draft_id INTEGER NOT NULL,
  person_id INTEGER REFERENCES people(id),
  kind TEXT NOT NULL CHECK(kind IN ('human_revision','instruction')),
  -- gold-standard pair: before = the prior revision body (context), after = the
  -- human-authored or instruction-driven result. Model first drafts appear ONLY
  -- as `before_*`, never as `after_*`.
  before_subject TEXT, before_body TEXT NOT NULL,
  after_subject TEXT,  after_body TEXT NOT NULL,
  instruction TEXT,                        -- kind='instruction' only, verbatim
  instruction_norm TEXT,                   -- normalized in code: lowercase, punctuation
                                           -- stripped, whitespace collapsed (EL5 grouping key)
  -- denormalized draft context for similarity matching (from revisions.context_json)
  intent TEXT,
  hook_entity TEXT, hook_facet TEXT, hook_tier TEXT,
  change_ratio REAL NOT NULL,              -- normalized token edit distance, 0..1
  scope TEXT NOT NULL CHECK(scope IN ('stylistic','recipient_specific','mixed')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_examples_ctx ON learning_examples(intent, hook_facet);

-- Style-notes versions (PRD L3): append-only, never deleted, hard token budget
-- enforced in code before insert.
CREATE TABLE IF NOT EXISTS style_notes (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,         -- 1, 2, 3, ...
  body TEXT NOT NULL,                      -- the distilled block, <= STYLE_NOTES_MAX_TOKENS
  standing_rules_json TEXT NOT NULL,       -- promoted instructions in this version, as
                                           -- [{ "norm": string, "rule": string }] pairs:
                                           -- norm is the deterministic grouping key (EL5),
                                           -- rule is the distiller's imperative phrasing
  source_example_count INTEGER NOT NULL,   -- corpus size when distilled
  created_at TEXT DEFAULT (datetime('now'))
);

-- Prompt-input log (PRD L2): every generated draft records exactly which learning
-- inputs were in its prompt, so a bad draft traces to its inputs.
CREATE TABLE IF NOT EXISTS prompt_inputs (
  id INTEGER PRIMARY KEY,
  revision_id INTEGER NOT NULL UNIQUE,     -- the model revision this prompt produced;
                                           -- references the approval-loop revisions table
                                           -- once it exists (see Sequencing note below)
  exemplar_ids_json TEXT NOT NULL,         -- ordered JSON array of learning_examples.id ([] ok)
  style_notes_version INTEGER,             -- NULL before the first distillation
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Sequencing note**: the `drafts` and `revisions` tables this subsystem reads are created by
the approval-loop implementation, which does not exist yet (today's CLI `add` path prints the
draft without persisting anything). Consequently `prompt_inputs.revision_id` has nothing to
reference until F5 lands, and the deriver has no caller. Build order (mirrored in the
Implementation Plan): steps 1 and 3 proceed now against seeded test data; steps 2, 4, 5, and 6
are blocked on the approval-loop implementation shipping its persistence layer. We keep
`revision_id` as the key (rather than a separate draft-generation event ID) because F5 is the
next build and a second keying scheme would outlive its usefulness within weeks.

### EL2. Derivation (`derive.ts`)

Trigger: the approval loop calls `deriveFromRevision(deps, revisionId)` right after it commits
a revision with `provenance = 'human'` or a non-null `instruction` (fire-and-forget, after the
re-ping, so nothing human-visible waits on it). Safety net: `deriveBacklog(deps)` runs on
daemon start and scans for qualifying revisions with no `learning_examples` row
(`revision_id UNIQUE` makes both paths idempotent).

```ts
// src/learning/derive.ts
export interface DeriveDeps { db: DB; llm: LLMClient; }           // llm = cheap tier
export async function deriveFromRevision(deps: DeriveDeps, revisionId: number): Promise<
  { derived: true; exampleId: number } | { derived: false; reason: string }
>;
export async function deriveBacklog(deps: DeriveDeps): Promise<number>; // rows derived
```

Rules:
1. **Eligibility**: `provenance='human'` becomes `kind='human_revision'`;
   `provenance='model' AND instruction IS NOT NULL` becomes `kind='instruction'`. Anything
   else: not derived (model first drafts are context only, PRD L1).
2. **Minimum-change threshold**: compute `change_ratio` as token-level Levenshtein distance
   between `before_body` and `after_body`, divided by `max(tokenCount(before), tokenCount(after))`
   (whitespace tokenization, lowercase, deterministic, no LLM). If
   `change_ratio < MIN_CHANGE_RATIO` (default **0.05**, roughly "fewer than 1 in 20 words
   changed"), the revision stays captured in `revisions` but is NOT promoted: return
   `{ derived: false, reason: 'below-min-change' }`. Typo fixes never dilute the corpus.
   Instruction examples skip this gate (the instruction text is the signal even when the diff
   is small).
3. **Scope classification** (recipient-specific vs stylistic): one cheap-tier call,
   temperature 0, `SCOPE_CLASSIFY_SYSTEM`: given the before/after pair and the recipient
   name, answer `{"scope":"stylistic"|"recipient_specific"|"mixed"}`.
   `recipient_specific` means the change is about this recipient's facts (a title, a paper
   name, a corrected claim about their work); `stylistic` means tone, structure, length,
   phrasing; `mixed` means both. On parse failure, default `mixed` (safe: still selectable,
   still shown to the distiller with its caveat). Scope steers selection (EL3) and the
   distiller prompt (EL4); nothing is discarded.
4. Context columns (`intent`, `hook_*`) come from `revisions.context_json`; `person_id` from
   the draft row.
5. **Instruction normalization**: for `kind='instruction'`, compute `instruction_norm` in
   code (lowercase, strip punctuation, collapse whitespace) and store it alongside the
   verbatim instruction. This single code-side definition is the grouping and comparison key
   for promotion (EL5); no SQL-side normalization anywhere.

### EL3. Selection (`select.ts`): deterministic, local SQL, scored in code

```ts
// src/learning/select.ts
export interface DraftContext { personId: number | null; intent: string; hookEntity: string; hookFacet: string; }
export interface SelectedExemplar { id: number; beforeBody: string; afterBody: string; instruction: string | null; score: number; }
export interface LearnedBlock {
  exemplars: SelectedExemplar[];          // <= MAX_EXEMPLARS, ordered by score desc
  styleNotes: { version: number; body: string } | null;
  promptText: string;                      // the assembled block, within token budget
}
export function selectLearnedBlock(db: DB, ctx: DraftContext): LearnedBlock;
```

Candidate pool (one SQL query, no LLM): all `learning_examples` where
`scope = 'stylistic' OR person_id = ctx.personId`. Both `recipient_specific` and `mixed`
examples surface only for the same recipient: a `mixed` body still contains the original
recipient's facts, so it gets the same containment as a fully recipient-specific one (PRD
privacy plus the edge case in the PRD). Only `stylistic` examples cross recipients.

Scoring formula, computed in code over the candidate rows (all weights in
`learning/constants.ts`, marked tune-with-real-data):

```
recency   = 0.5 ^ (age_days / RECENCY_HALF_LIFE_DAYS)          # half-life 45 days
intentSim = 1.0 if example.intent == ctx.intent else 0.0
hookSim   = 1.0 if same facet AND stem(entity) == stem(ctx.hookEntity)
            else 0.6 if same facet
            else 0.0
score     = W_RECENCY * recency + W_INTENT * intentSim + W_HOOK * hookSim
          = 0.5 * recency + 0.3 * intentSim + 0.2 * hookSim
```

`stem` is the existing 5-char stem trick from `pipeline/draft.ts`, lifted into a shared
helper. Take the top `MAX_EXEMPLARS` (default **N = 3**) by score, tie-break by
`learning_examples.id DESC` (newest wins), so the same DB state at the same time always
yields the same selection (PRD L2 determinism; the recency term means selections can shift
as examples age, which is intended). Recency in the formula is what lets new taste displace old
when corrections contradict each other (PRD edge case): a 6-month-old exemplar scores at most
0.5 * 0.06 + 0.5 = well below a fresh one in the same context.

Style notes: `SELECT version, body FROM style_notes ORDER BY version DESC LIMIT 1` (NULL
before the first distillation).

**Token budgets** (enforced by `promptText` assembly, estimate = chars / 4):
- style-notes body: `STYLE_NOTES_MAX_TOKENS = 300` (enforced at write time, EL4).
- exemplar block: `EXEMPLARS_MAX_TOKENS = 1200` total. Exemplars are added in score order;
  one that would overflow the budget is dropped (not truncated: a cut-off email teaches bad
  structure). `before_body` is included only for `human_revision` examples (the contrast is
  the lesson); `instruction` examples show the instruction plus `after_body`.

### EL4. Style-notes distillation (`distill.ts`): cheap tier, every K gold examples

Trigger: after each successful `deriveFromRevision`, check
`(SELECT count(*) FROM learning_examples) - (SELECT coalesce(max(source_example_count),0) FROM style_notes) >= DISTILL_EVERY_K`
(default **K = 10**). If true, run `distill(deps)` in the same background task, never on the
draft path (PRD L3, latency invariant).

```ts
export async function distill(deps: { db: DB; llm: LLMClient }): Promise<{ version: number } | { skipped: string }>;
```

Input assembly (deterministic): the most recent `DISTILL_INPUT_CAP = 40` examples, newest
first, each rendered as facts (kind, scope, instruction if any, before/after bodies truncated
to 400 chars each), plus the previous style-notes body, plus the promotion candidates from
EL5.

`STYLE_DISTILL_SYSTEM` sketch (added to `src/llm/prompts.ts`, same style as the existing
system prompts):

```
You distill a short style guide for outreach emails from before/after edit pairs made by
one writer (Aditya) and from his edit instructions. Return ONLY JSON:
{ "notes": string, "standingRules": string[] }.

- "notes" is a compact bulleted block, MAX 200 words, of recurring corrections stated as
  rules ("cut greetings longer than one sentence", "prefer 'digging into' over 'exploring'").
- Only include patterns that recur across MULTIPLE examples or continue a rule from the
  previous notes. IGNORE one-off factual fixes (a corrected name, title, paper, or fact
  about one specific recipient); examples marked scope=recipient_specific are shown for
  completeness only and must not produce rules.
- When corrections conflict, newer examples win: state only the current preference, do not
  hedge with both.
- "standingRules" must include every promotion candidate given in the input, phrased as an
  imperative rule.
- Rules are about voice, structure, and length. Never about facts, claims, or specific
  recipients. No em dashes.
```

Post-processing: parse JSON; if `notes` exceeds `STYLE_NOTES_MAX_TOKENS` (300 tokens,
chars / 4 estimate), retry once with "too long, halve it" appended; if still over, keep the
prior version and log (`{ skipped: 'over-budget' }`). On success insert a new `style_notes`
row with `version = max + 1`. Old versions are never deleted or updated (PRD L3):
`outreach style-notes --history` prints all versions with timestamps, so a taste shift shows
up as a visible diff between version bodies.

### EL5. Recurring-instruction promotion (PRD open question 3, concrete mechanism)

Deterministic candidate pass, then the distiller phrases the rule:

1. Normalization happens once, in code, at derivation time (EL2 rule 5) and is stored as
   `learning_examples.instruction_norm`; SQL never re-normalizes.
2. SQL groups on the stored norm and counts **distinct drafts**:

```sql
SELECT instruction_norm AS norm, count(DISTINCT draft_id) AS drafts_seen,
       max(created_at) AS last_seen
FROM learning_examples
WHERE kind = 'instruction'
GROUP BY instruction_norm
HAVING drafts_seen >= 2;      -- PROMOTION_THRESHOLD = 2 distinct drafts
```

   Exact-match grouping will under-count paraphrases ("shorter" vs "make it shorter"); that
   is acceptable for v1, and the distiller partially compensates because it also sees the raw
   instructions and may fold recurring paraphrases into `notes` on its own.
3. Every group passing the threshold is passed to the distiller as a promotion candidate,
   keyed by its norm; the distiller must emit one imperative rule per candidate. `distill.ts`
   pairs each returned rule back with its candidate's norm and stores
   `[{ "norm": string, "rule": string }]` in `style_notes.standing_rules_json`; the rules are
   rendered at the top of the notes body under a `Standing rules:` heading, so "make it
   shorter" stops being something Aditya types.
4. A promotion also counts as a distillation trigger: run `distill` (even if the K counter
   has not filled) whenever the promotion query returns a norm that does not appear among the
   `norm` keys in the latest version's `standing_rules_json`. Norm-to-norm comparison is
   exact string equality; the LLM's phrasing is never part of the containment test.

### EL6. Drafter integration (prompt injection point, privacy)

`DraftPromptInput` (in `src/llm/prompts.ts`) gains an optional field; `generateDraft` and its
callers are otherwise untouched:

```ts
export interface DraftPromptInput {
  // ...existing fields unchanged...
  learned?: { promptText: string };   // LearnedBlock.promptText from select.ts
}
```

`buildDraftUser` appends `input.learned.promptText` as the final section of the user message,
after "Aditya's relevant facts". The learned block renders as:

```
VOICE CALIBRATION (style and structure ONLY):
Style notes (v<version>):
<style-notes body>

Examples of Aditya's approved voice. Learn tone, structure, and length from them.
NEVER reuse any name, paper, institution, or fact that appears in an example: every
specific claim in your draft must come from the recipient/hook facts above.
--- example 1 (his rewrite) ---
BEFORE: <before_body>
AFTER: <after_body>
--- example 2 (his instruction: "<instruction>") ---
<after_body>
```

**Deterministic redaction (mechanical privacy enforcement, v1)**: before assembly, the block
assembler redacts each exemplar's recipient identity from everything it renders, the
`before/after` bodies AND the instruction text (an instruction like "say her Nature paper
came first" carries recipient facts too). The redaction vocabulary for an example is: the
example recipient's name tokens (from the example's `people` row), paper-title stems (from
`context_json.groundingTerms.recipientTerms`, which the read contract includes), the
example's `hook_entity` stems, and the stems of ALL of that recipient's `ontology_facts`
values (institutions, collaborators, locations; this was Open Question 3's v2 scope,
pulled into v1 because misclassification makes narrow redaction leaky). Name tokens
become `<Name>`; everything else becomes `<their work>`. Matching reuses the same 5-char
stem helper as DR4, so "olfaction" catches "olfactory". Redaction applies only to the
prompt block; the stored rows keep full text for auditability. A prompt rule alone would
not be enforcement, and DR4 cannot catch echoes of a PAST recipient's name (it only checks
for the presence of CURRENT hook and sender stems), so redaction is the actual guarantee.
Because redaction is unconditional, an exemplar the cheap-tier classifier mislabels
`stylistic` (EL2: an LLM decision, unaudited) still crosses recipients only in redacted
form; the scope label narrows selection, it is not the privacy boundary.

The same vocabulary guards the distiller output: EL4's post-processing runs the stem
screen over the produced `style_notes.body` against every `recipient_specific`/`mixed`
source example's redaction vocabulary; any hit drops that rule line and logs
`style_notes_screened`. Style notes are injected into every future draft, so they get the
same mechanical treatment as exemplars, not just the prompt instruction.

Why the user message and not `DRAFT_SYSTEM`: the system prompt is the stable contract
(structure, style, TRUTH and stance rules) and stays constant; learned content is per-draft
data. Because the TRUTH and HONESTY-BY-STANCE sections remain in the system prompt and the
learned block explicitly subordinates itself to the facts section, learned style can never
override grounding or stance (PRD honesty invariant). The existing deterministic grounding
check in `pipeline/draft.ts` (DR4) still runs on the output against the CURRENT hooks and
sender facts, so a draft that leaned on exemplar facts instead of real hooks gets flagged
`grounded=false` exactly as before: a second, mechanical line of defense.

Privacy (PRD non-functional): exemplar text is used only in this local prompt assembly and
the OpenRouter call the system already makes for drafting. Three layers keep past recipients
out of outbound emails: (1) the selection filter (EL3) surfaces `recipient_specific` and
`mixed` examples only for the same `person_id`; (2) unconditional deterministic redaction
(above) over bodies, instructions, and distilled style notes, with the full ontology-fact
vocabulary; (3) the NEVER-reuse prompt rule steers the model away from imitating example
content. Only (1) and (2) are enforcement; (3) is best-effort steering, and the DR4
grounding check is NOT a leakage detector (it checks only that current-hook and sender
stems are present).

Call-site wiring (lives in the approval-loop draft path when it exists; the CLI `add` path
gets the same three lines): before `generateDraft`, call `selectLearnedBlock(db, ctx)`; after
the model revision row is written, insert the `prompt_inputs` row with the exemplar IDs and
style-notes version used (empty array and NULL are valid and logged too, PRD L2).

### EL7. Metrics (`metrics.ts` + CLI `learn-report`, PRD L5)

Derived entirely from approval-loop data (read contract), no new writes:

```sql
-- Per-draft edit count (human revisions + instruction redrafts before decision)
SELECT d.short_id,
       date(d.created_at) AS drafted_on,
       sum(CASE WHEN r.provenance = 'human' OR r.instruction IS NOT NULL THEN 1 ELSE 0 END) AS edit_count,
       CAST((julianday(d.decided_at) - julianday(d.created_at)) * 24.0 AS REAL) AS hours_to_decision,
       d.status
FROM drafts d LEFT JOIN revisions r ON r.draft_id = d.id
WHERE d.decided_at IS NOT NULL
GROUP BY d.id ORDER BY d.created_at;

-- Weekly trend (is it learning?)
SELECT strftime('%Y-%W', d.created_at) AS week,
       count(*) AS drafts,
       round(avg(e.edit_count), 2) AS avg_edits,
       round(avg(e.hours_to_decision), 1) AS avg_hours_to_approval
FROM drafts d
JOIN (SELECT d2.id, sum(CASE WHEN r.provenance='human' OR r.instruction IS NOT NULL THEN 1 ELSE 0 END) AS edit_count,
             (julianday(d2.decided_at) - julianday(d2.created_at)) * 24.0 AS hours_to_decision
      FROM drafts d2 LEFT JOIN revisions r ON r.draft_id = d2.id
      WHERE d2.decided_at IS NOT NULL GROUP BY d2.id) e ON e.id = d.id
-- decided-and-not-skipped: tolerant of stub-phase statuses like 'sent (stubbed)' (A8)
WHERE d.decided_at IS NOT NULL AND d.status <> 'skipped'
GROUP BY week ORDER BY week;
```

`outreach learn-report` prints both tables plus corpus stats (example counts by kind/scope,
current style-notes version, last distillation date). `outreach style-notes [--history]`
prints the current (or all) style-notes versions.

### EL8. Contradictory corrections

Three mechanisms, all already specified above, listed here because the PRD calls the edge
case out: (a) selection recency (half-life 45 days) means fresh exemplars dominate the
prompt; (b) the distiller sees examples newest-first with the "newer wins, state only the
current preference" instruction, so re-distillation rewrites stale rules; (c) style-notes
versions are append-only, so `style-notes --history` shows exactly when and how a preference
flipped. No conflict detection heuristics in v1; recency is the arbiter.

## Interfaces

| Interface | Shape | Consumer |
|---|---|---|
| `deriveFromRevision(deps, revisionId)` | `Promise<{derived, ...}>` | approval loop, post-revision hook |
| `deriveBacklog(deps)` | `Promise<number>` | daemon start |
| `selectLearnedBlock(db, ctx)` | `LearnedBlock` (sync, local SQL) | draft call sites |
| `distill(deps)` | `Promise<{version} \| {skipped}>` | derive trigger (background) |
| `learnReport(db)` / `styleNotesHistory(db)` | printable rows | CLI |

## Implementation Plan

1. **Schema + constants**: add the three tables to `src/db/schema.sql`; create
   `src/learning/constants.ts` with all tunables. Unit-test idempotent re-open.
   ✅ *Human gate: read the DDL against PRD L1/L3/L2 (exemplars derived not copied,
   style notes append-only, prompt inputs logged) and confirm the defaults table below.*
2. **Derivation** *(blocked on F5 persistence; testable now only with seeded revisions)*:
   `derive.ts` with the change-ratio gate and scope classifier (fake LLM in
   tests: typo-level edit not promoted, real rewrite promoted, recipient-title fix classified
   `recipient_specific`).
   ✅ *Human: feed 3 real revision pairs (hand-written) through the deriver and confirm the
   promoted/not-promoted and scope calls match your judgment.*
3. **Selection + learned block**: `select.ts` scoring, budgets, block assembly; extend
   `buildDraftUser`. Tests: determinism (same DB, same output), recipient-specific exclusion,
   budget-drop behavior.
   ✅ *Human: with a seeded corpus, print the assembled block for a real draft context and
   check the chosen exemplars are the ones you would pick, and that no other recipient's
   facts could plausibly leak from them into a draft.*
4. **Prompt-input logging** *(blocked on F5 persistence)*: wire `selectLearnedBlock` +
   `prompt_inputs` insert into the draft call site(s).
   ✅ *Human: generate a draft, then query `prompt_inputs` and confirm it names exactly the
   exemplar IDs and style-notes version you saw in step 3's block.*
5. **Distillation + promotion** *(blocked on F5 persistence for live data; unit-testable now)*:
   `distill.ts`, `STYLE_DISTILL_SYSTEM`, the K trigger and the
   promotion SQL. Tests with a fake LLM: budget retry, version increment, promotion candidate
   forced into `standingRules`.
   ✅ *Human: after ~10 real examples exist, read style-notes v1 cold. Bar: every rule is
   something you actually keep correcting, nothing is a one-off factual fix, and a twice-given
   instruction appears as a standing rule.*
6. **Metrics CLI** *(blocked on F5 persistence)*: `learn-report` and `style-notes --history`.
   ✅ *Human: run `learn-report` after a week of use; confirm the per-draft edit counts match
   your memory of the week and the trend query buckets look sane. Then live with it: the real
   acceptance test is whether avg_edits drifts down over the following weeks.*

## Defaults (all tune-with-real-data, in `learning/constants.ts`)

| Constant | Default | Note |
|---|---|---|
| `MAX_EXEMPLARS` (N) | 3 | more crowds the prompt before the corpus earns it |
| `W_RECENCY / W_INTENT / W_HOOK` | 0.5 / 0.3 / 0.2 | recency is the arbiter of taste |
| `RECENCY_HALF_LIFE_DAYS` | 45 | |
| `MIN_CHANGE_RATIO` | 0.05 | below: captured, not promoted |
| `DISTILL_EVERY_K` | 10 | plus forced run on new promotions |
| `PROMOTION_THRESHOLD` | 2 distinct drafts | exact-match normalized instructions |
| `STYLE_NOTES_MAX_TOKENS` | 300 | write-time enforced |
| `EXEMPLARS_MAX_TOKENS` | 1200 | whole-exemplar drop, never truncate |
| `DISTILL_INPUT_CAP` | 40 newest examples | keeps the cheap call cheap |

## Open Questions

1. **Paraphrase grouping for promotion**: exact-match normalization will miss "shorter" vs
   "tighten it". If real data shows misses, add a cheap-tier canonicalization at derivation
   time (store `instruction_norm` from an LLM instead of string normalization). Deferred
   until observed.
2. **Subject-line edits**: `change_ratio` currently measures the body only; if Aditya turns
   out to edit subjects often, extend the ratio to a weighted body+subject measure.
3. **Redaction coverage**: RESOLVED into v1 (code-review finding, Jul 18). EL6 redaction
   now uses the full vocabulary (name, paper title via `groundingTerms`, hook entity, and
   all of the example recipient's `ontology_facts` value stems), applies to instruction
   text, and screens distilled style notes at write time. Remaining residual: facts about
   a recipient that appear in an exemplar body but were never captured as ontology facts;
   accepted, since the corpus is Aditya's own writing about people he researched.
4. **Revisions read contract**: RESOLVED. `spec-imessage-approval-loop.md` AL4 landed in
   the same commit and matches this contract exactly (including
   `context_json.groundingTerms`, which EL6 relies on); `learning/` remains the only
   consumer to adjust if it ever drifts.
