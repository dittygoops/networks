# Gap-Framed Asks: every email ends on one of Aditya's two open research questions, or is not sent

**Date:** 2026-08-05
**Status:** Draft, not yet reviewed
**Problem owner:** what the emails actually ask for

> The owner's constraint, in his words: "The hook itself can be framed with
> anything sort of shared. The question and CTA of the email itself though
> should be in reference to one of our two research gaps." And, when no good
> question can be made: "we just discard".

This is **not** a matching or filtering change. Hooking is untouched: any
genuine shared term may still justify reaching out, and every existing gate
(identity, collision, hook strength, grounding, prior thread, human approval)
keeps its current semantics. What changes is the **ask**. The email's closing
question must be one of two specific open research questions drawn from the
vault, or the draft is discarded.

## Problem

### The ask has never referenced a gap, because nothing gap-shaped exists to reference

The drafter is handed a free-text `intent` string and nothing else about what
Aditya actually wants to know.

- `src/cli.ts:154` hardcodes `intent: 'seeking direction'` on the loop path.
  Verified against the live DB: **all 56 rows at `status='sent'` carry
  `intent = 'seeking direction'`**, and 97 of the 102 drafts ever created do.
- `src/cli.ts:305` (the manual `outreach add` path) reads a single self-fact:
  `interest / writing = "just looking to connect and get more direction for
  future olfaction / smell research"`. Confirmed present in
  `ontology_facts WHERE person_id IS NULL`. Four drafts carry it.

`DRAFT_SYSTEM` (`src/llm/prompts.ts:184`) then instructs: "ONE clear,
low-friction ask for direction/guidance **in the recipient's area**." With
"seeking direction" as the only content, the model does the only thing it can:
it invents a plausible-sounding question out of the recipient's own abstract.

### What that produced, measured on the 56 sent drafts (`data/outreach.db`, 2026-08-05)

| slice | count |
| --- | --- |
| sent drafts | 56 |
| paper title matches `physics-informed` or `pinn` | **15** |
| paper title matches `gaussian`/`splat`/`3dgs` | **18** |
| paper title matches `olfact`/`odor`/`smell`/`nose`/`scent` | 13 |

The 15 PINN recipients include nitrous oxide flux prediction, periodic orbits
in the gravitational three-body problem, power-grid critical clearing time, and
the nuclear dipole amplitude in the colour glass condensate. The 18 Gaussian
Splatting recipients include head avatars, hair simulation, SLAM, video
deblurring and texture atlases.

Concrete instance, draft `d76` (status `skipped`, DynActiveGS), body verbatim:

> Your work on DynActiveGS got me thinking about failure modes in dynamic scene
> reconstruction, I've trained 3D Gaussian Splatting models end-to-end and hit
> some edge cases with occlusion handling.
>
> I'm an undergrad exploring real-time reconstruction for autonomous systems.
> I'd love to hear your take on where active sampling could help most with
> transient objects.

The ask is a generic 3DGS question. It never mentions olfaction, a smell field,
a POM coordinate, or anything Aditya is actually stuck on. (It also calls him an
undergrad, which is false, but that is a separate defect.)

### Why the model reached for PINNs, specifically

`Research Gap - Volumetric Olfactory Capture.md:105` names PINNs in other
domains as **existing background**, not as the gap:

> "Gaussian Process regression exists for gas field estimation (Lilienthal's
> group). PINNs exist for advection-diffusion in other domains. Fixed sensor
> arrays exist for environmental monitoring. But nobody has assembled them into
> a **volumetric olfactory capture** system."

The self-ontology flattens that distinction away. `interest / method =
Physics-Informed Neural Networks` sits in `ontology_facts` with
`stance='exploring'` and detail "Considering using PINNs, specifically CRVPINN,
to regularize smell field reconstruction with advection-diffusion physics", at
the same structural level as `interest/hobby = Chess` and `academic/tool =
FFmpeg`. 54 flat facts, no gap structure, no notion of "this is the background
I read" versus "this is the question I cannot answer". A hook on PINNs is then
indistinguishable from a hook on the gap, and the ask follows the hook.

### The self-ontology cannot hold a question

`ontology_facts` columns are `facet, key, value, detail, stance, confidence,
usability_tier, source_url`. `value` is constrained by `ENTITY_RULES`
(`prompts.ts:5-19`) to "a short canonical ENTITY... a name or term of 1 to 4
words". There is no field that can hold "how to couple the concentration field
to scene geometry so the physics constraints are spatially aware". The two
gap documents each collapse to a handful of 1-to-4-word entities on the way in,
and the question itself is lost.

### The hook is often genuine while the ask is impossible: measured

Draft `d18` went to Ejike R. Ugba (Helmut Schmidt University), paper "A
Modification of McFadden's $R^2$ for Binary and Ordinal Response Models". His
persisted facts are `academic/method = McFadden's R^2`, `likelihood ratio
index`, `maximum likelihood`, `academic/research_area = Statistics, Ordinal
regression, Categorical variable`, and one more: `academic/dataset = olfactory
perception of boar taint`, used as a real data example in the paper.

The top hook is `olfactory embedding space / olfactory perception of boar
taint`, strength 0.8, tier B, rationale "Both are involved in olfactory
perception research". That hook is **real and correctly found**. The overlap
exists. But this recipient is a statistician who used an olfaction dataset once,
and there is no honest question about learning a 16d sensor vector to 256d POM
coordinate map that he is well placed to answer. Under the owner's rule, d18 is
a discard, and the hook stays exactly as it is.

This is the shape of the whole change: **hooking is a term-overlap question and
stays free; asking is an eligibility question and is new.**

### The judge already measures this and already complains about it

`src/eval/draftQuality.ts` and `scripts/eval-draft-quality.ts` shipped
2026-08-04. Its `ask_quality` criterion is scored 0/1/2 with anchors:

- 0 = no question, several questions, or a heavy ask.
- 1 = one question but generic: "it could be sent to anyone in the field".
- 2 = one question that only this recipient is well placed to answer, tied to
  the specific thing named in the hook.

Recorded baseline over the 56 sent drafts (claude-haiku-4.5, temperature 0,
2026-08-04, from the script header): mean **7.68/10** overall, the judge would
send **20 of the 56** the owner sent, and "its complaint on the other 36 is
almost always a generic ask or a hook that names the paper without saying what
is in it". Its ablation showed a deliberate generic-ask damage moves
`ask_quality` by 1.5 and every other criterion by at most 0.1, so the criterion
is specific rather than a latent goodness score. The stated `ask_quality`
baseline of 1.30/2 is carried from the task brief and is **not** recorded in the
script header; it must be re-derived by the before-run described in Verification
before it is used as the comparison point.

## Design

Introduce a first-class representation of the two gaps, route each recipient to
one of them, make the routed gap question the mandatory CTA, and discard the
draft when no gap question can honestly be asked.

### Change 1: the gaps live in `config/gaps.yaml`, sourced from the vault

**Decision: a checked-in config file, not a new table and not a reserved
ontology facet.**

Against a reserved facet in `ontology_facts`: `outreach persona` uses
`replaceSelfFacts`, which destroys the whole self ontology, and `intersections`
cascades on `ontology_facts` (both documented in `CLAUDE.md`). Putting the two
questions that every email now depends on into the one table a routine rebuild
empties is not defensible. It would also fight `ENTITY_RULES`, which exists
precisely to stop sentences from entering `value`.

Against a new table: durable, but it drifts from the vault silently, and the
vault is the source of truth and will change. A table also cannot be reviewed in
a diff, and the ask is now the highest-stakes text in the system: it is what a
real researcher reads and answers.

`config/gaps.yaml` sits beside `config/watchlist.yaml`, which is already the
established home for hand-curated, vault-derived outreach configuration.

```yaml
# The two open research questions every outreach email must end on.
# Transcribed from the Obsidian vault, which is the source of truth:
#   ~/Documents/Coding/new/learning/
# `source_sha256` is the sha256 of the note as transcribed. `outreach gaps`
# re-hashes the note and reports drift. Drift warns, it does not block.
gaps:
  - id: gap1
    title: Sensor to POM Bridge
    source: "Research Gap - Sensor to POM Bridge.md"
    source_sha256: "<sha256 of the note at transcription time>"
    # Verbatim from the note. Quoted, not paraphrased.
    statement: >-
      E-noses produce a vector of sensor readings. The Principal Odor Map takes
      a molecular graph as input. Same smell, completely different
      representations, and nothing connects them. The function to learn is
      sensor_vector (16d) to POM_coordinate (256d), a learned embedding
      alignment problem.
    obstacles:
      - "Each MOX sensor responds to many different molecules at once."
      - "Coffee contains 800+ volatile compounds, so the mapping is many-to-many."
      - "You need thousands of these pairs. Nobody has built this dataset."
      - "MOX sensor baselines shift over days as the sensing material ages."
    questions:
      - id: gap1.data
        text: >-
          To learn sensor_vector to POM_coordinate you need thousands of paired
          (controlled exposure, POM coordinate) examples, and I cannot find
          paired data like that anywhere. Is there a source of paired
          sensor-to-perception data you would trust, or is collecting it the
          whole project?
      - id: gap1.framing
        text: >-
          I am trying to learn a map from a 16-dimensional MOX sensor vector to
          a 256-dimensional POM coordinate, and cross-reactivity plus real
          mixtures make it many-to-many. Does that look tractable to you as a
          learned embedding alignment, or is there a reason the field has not
          framed it that way?
    anchors:
      - "POM coordinate"
      - "principal odor map"
      - "paired sensor"
      - "sensor vector"
      - "embedding alignment"
    honesty: >-
      Aditya has not built this. Neither has anyone else as far as his notes go.
      Frame it as something he cannot find and is stuck on, never as something
      he has done, and never as a claim that nobody has done it.
    route_terms:
      - electronic nose
      - e-nose
      - gas sensor array
      - metal oxide
      - sensor drift
      - olfactory perception
      - odor prediction
      - principal odor map
      - olfactory receptor
      - structure-odor
      - molecular graph
      - chemical senses
      - psychophysics
      - odor mixture

  - id: gap2
    title: Volumetric Olfactory Capture
    source: "Research Gap - Volumetric Olfactory Capture.md"
    source_sha256: "<sha256 of the note at transcription time>"
    statement: >-
      Given a fixed array of e-noses at known positions in a room, reconstruct a
      continuous 3D map of how smell is distributed through that space, one you
      can query at any point including positions where no sensor exists.
      Gaussian Process regression exists for gas field estimation and PINNs
      exist for advection-diffusion in other domains, but nobody has assembled
      them into a volumetric olfactory capture system.
    obstacles:
      - "32 points is nowhere near enough data to train a 4D function."
      - >-
        The open question is how to couple the concentration field to scene
        geometry so the physics constraints are spatially aware.
      - >-
        Augmenting a 3D Gaussian Splatting scene with a chemical concentration
        attribute is a direct extension of 3DGS that nobody has built.
    questions:
      - id: gap2.geometry
        text: >-
          I am trying to reconstruct a continuous concentration field from a
          fixed array of about 32 e-nose sensors, and the part I cannot see is
          how to couple the concentration field to scene geometry so the physics
          constraints are spatially aware, walls blocking diffusion and vents
          forcing flow. Would you push the geometry in as a boundary condition,
          or bake it into the representation itself?
      - id: gap2.splat
        text: >-
          I want to give each Gaussian in a 3DGS scene a chemical concentration
          attribute, so the same splatting operation integrates concentration
          instead of radiance. Does anything in your setup break when a Gaussian
          carries a physical quantity that has to obey advection-diffusion, or
          is that just another attribute to you?
    anchors:
      - "concentration field"
      - "scene geometry"
      - "spatially aware"
      - "chemical concentration attribute"
      - "advection"
      - "smell field"
      - "fixed sensor array"
    honesty: >-
      Aditya has not built this. PINNs and Gaussian Process gas-field regression
      already exist in other domains: that is background he has read, not work he
      has done, and not the gap. The gap is assembling them and coupling the
      field to geometry. Never imply he has a working system, a dataset, or
      results.
    route_terms:
      - advection
      - diffusion
      - gas dispersion
      - plume
      - physics-informed neural network
      - neural field
      - gaussian splatting
      - neural radiance field
      - volumetric reconstruction
      - gas source localization
      - sensor placement
      - gaussian process regression
      - boundary condition
      - flow field
      - occupancy geometry
```

**Loader.** New module `src/gaps/gaps.ts` exporting `loadGaps(path =
'config/gaps.yaml'): GapSet` and the types below. It follows
`discovery/config.ts:readFile` conventions except in one respect: a missing or
unparseable `config/gaps.yaml` is a **hard error**, not a quiet fallback. There
is no sensible default ask, and the previous default is exactly the defect this
spec removes.

**Vault sync.** New read-only command `outreach gaps`. It prints each gap, its
questions, its anchors, and re-hashes the vault note at
`OUTREACH_VAULT` (default `~/Documents/Coding/new/learning`) joined with
`source`, reporting `in sync` or `DRIFTED (note changed since transcription)`.
`cmdLoop` calls the same check once at startup and prints a one-line warning on
drift.

Drift **warns and does not block**. Blocking would let one unrelated edit to a
vault note strand an entire day of candidates, and the vault is edited by hand.
The config carries the gap text verbatim, so an unreadable or absent vault is a
warning too, never an error: the system must keep working on a machine where
the vault is not mounted.

`outreach gaps` and the loop warning write to stdout via `console.log`, never
via `channel.notify`, so `test/notify-tapback-safety.test.ts` is unaffected. No
new message may begin with a draft id and a colon; nothing here emits a draft
id at all.

```ts
export type GapId = 'gap1' | 'gap2';
export interface GapQuestion { id: string; text: string }
export interface Gap {
  id: GapId;
  title: string;
  source: string;
  sourceSha256: string;
  statement: string;
  obstacles: string[];
  questions: GapQuestion[];
  anchors: string[];
  honesty: string;
  routeTerms: string[];
}
export interface GapSet { gaps: Gap[]; byId(id: GapId): Gap }
```

### Change 2: route each recipient to a gap, or to nothing

**Decision: a deterministic term prior plus one cheap LLM eligibility call, run
inside `processPaper` step 4, immediately after the hook gate and before any
paid call.**

A term-only router was simulated over the 56 sent drafts, scoring paper title
and hook `personValue` at weight 2 and all persisted person facts at weight 1
against the `route_terms` lists, with a floor of 4. Result: `gap1=16, gap2=33,
discard=7`. It is **not usable alone**, for two measured reasons:

- It routes **d18 to gap1 (s1=6)**. That is the statistician above, who cannot
  answer either question. The score came entirely from the hook's own
  `personValue`, "olfactory perception of boar taint", which is exactly why the
  hook was correct and the ask is still impossible.
- It routes **d43 (RealVDeblur, one-step diffusion for video deblurring) to
  gap2 with s2=10** and **d38 (Head Avatars with Dynamic Explicit Hair) to gap2
  with s2=8**. The terms "scene", "reconstruction", "depth", "diffusion" and
  "geometry" appear in nearly every vision paper. This is the same failure
  `INTERSECT_SYSTEM` already warns about at `prompts.ts:236`: a shared broad
  field is not common ground.
- It **discards d34** (Physics-Informed Neural Networks for Predicting Nitrous
  Oxide Flux, s2=3), which is a genuine advection-diffusion transport problem
  and one of the better gap2 fits in the set.

So the term lists become a **prior handed to a judgment**, not the judgment.

New function in `src/gaps/route.ts`:

```ts
export interface GapRouteInput {
  paperTitle: string;
  hooks: { personValue: string; personDetail?: string; selfValue: string }[];
  personFacts: { facet: string; key: string; value: string; detail?: string }[];
}
export interface GapRoute {
  gapId: GapId | null;
  questionId: string | null;
  reason: string;          // one short sentence, recorded on the ledger row
  termScores: Record<GapId, number>;
}
export async function chooseGapAsk(
  llm: LLMClient, gaps: GapSet, input: GapRouteInput,
): Promise<GapRoute>;
```

Behaviour:

1. Compute `termScores` deterministically (title and top-hook values weight 2,
   other person facts weight 1).
2. **Hard floor, code-enforced, not model-enforced.** If both scores are 0,
   return `{ gapId: null, reason: 'no gap terms in this recipient's material' }`
   with no LLM call. This is the cheap guard against a model that will find a
   connection anywhere if asked to.
3. Otherwise one cheap-tier LLM call. The system prompt is given both gap
   `statement`s and `obstacles` **verbatim**, and asks a single question: which
   of these two open problems, if either, is this recipient genuinely well
   placed to say something useful about, given their own work. It is told
   explicitly that "neither" is the expected answer for most people, that a
   shared word is not eligibility, and that d18's shape (used an olfaction
   dataset once, works on ordinal regression) is a `neither`. It returns
   `{ "gap": "gap1"|"gap2"|"none", "question": "<question id>", "reason": "..." }`.
4. Code validates the returned ids against the loaded `GapSet` and downgrades an
   unknown id to `none`.

**Both fit.** Not a failure case. `CLAUDE.md` records that the two gaps are one
program, not parallel interests. The model picks the one the recipient is better
placed to answer. The email asks exactly one question either way, because
`ask_quality` scores 0 for several questions.

**Neither fits.** Discard, per Change 3.

**Placement, and why it is after the hook gate.** `chooseGapAsk` goes in
`orchestrate.ts` at the end of step 4, immediately after

```ts
if (noStrongHook || hooks.length === 0) { ... return result(); }
```

and before step 5's `minePersonWeb`. That ordering is load-bearing:

- The hook gate is strictly cheaper (its `computeIntersections` result is
  already computed) and its bucket semantics are the measurement baseline the
  2026-08-02 hook-first spec depends on. Running the gap gate first would move
  rows out of `no grounded hook` and break run-over-run comparison.
- The 2026-08-02 reorder put every Tavily call behind the free hook gate. A gap
  discard at this position costs **zero Tavily credits**, exactly like a hookless
  candidate. It costs one extra cheap-tier LLM call, on the roughly 57
  candidates per batch that clear the hook gate.
- Hooking is unchanged, which is the owner's constraint. The gap gate never
  suppresses a hook, never edits `intersections`, and never changes which
  candidates are researched.

`OrchestrateResult` gains `gapRoute: GapRoute | null` (null only on the paths
that return before step 4).

**Failure handling, mirroring the hook-first spec's `SelfOntologyMissingError`
rule.** A thrown error from `chooseGapAsk` (transport, rate limit, parse) must
**propagate** to `processCandidate`'s catch (`loop.ts:610`) and be recorded as a
retryable `discovered` row. It must never be caught and degraded into
`gapId: null`, because that verdict is terminal and an outage would permanently
discard a day of candidates. Only a well-formed `"none"` from the model, or the
zero-term floor, produces the terminal verdict.

### Change 3: the discard rule and its visibility

Three terminal verdicts, all sharing one prefix so they form a single greppable
family:

| reason string | where it fires | Tavily cost |
| --- | --- | --- |
| `gap ask: no gap matched (<one-sentence reason>)` | `orchestrate` step 4, via `loop.ts` after the hook gate | **zero** |
| `gap ask: declined by drafter (<gapId>): <reason>` | draft time, model returned `decline` | full step 5 + 6 |
| `gap ask: CTA missing gap anchor (<gapId>)` | draft time, after one retry | full step 5 + 6 |

All three set `seen_papers.status = 'drafted_unsendable'` via the existing
`setStatus`, and increment `summary.unsendable`. No new status value, no schema
migration on `seen_papers`.

**The late two cost real money and that is acknowledged.** A candidate that
reaches drafting has already paid `minePersonWeb` (Tavily searches plus page
extracts), a possible arXiv PDF fetch, and `extractContactDetailed` (more Tavily),
which the hook-first spec measured at roughly 5.4 credits per paper across the
pipeline with steps 5 and 6 carrying nearly all of it. A late gap discard wastes
about what a `no email resolved` row wastes today. Change 2's placement is the
mitigation: the cheap discard happens first, and the late ones are meant to be a
backstop, not the main path. If the run reports more late discards than
`no gap matched` ones, the router is mis-specified and the term lists need work.

**Visibility, which is a real hazard here.** `strandedReport`
(`src/discovery/seenLedger.ts:185-202`) matches four reason prefixes today:
`abandoned after%`, `ambiguous orphan drafts%`, `awaiting address correction%`,
`address correction not yet requested%`. Measured now: `drafted_unsendable` has
**309 rows**, of which exactly **9 print** (all address-correction rows added
2026-08-04). The remaining 300 are invisible. (The task brief's "zero of ~276
are printed" was true before the address-correction feature landed; it is 9 of
309 today.)

A new bucket must not silently join those 300. But it must also not drown the 9
actionable rows a human can fix with one text message: the estimate below is
roughly 20 discards per 56 drafts, so this bucket grows fast.

So `StrandedReport` gains an **aggregate**, not per-row output:

```ts
export interface GapDiscardSummary {
  totalRows: number;
  byReason: { reason: string; count: number }[];   // the three prefixes above
  recent: { arxivId: string; reason: string; updatedAt: string }[]; // 10 most recent
}
export interface StrandedReport {
  discovered: StrandedDiscoveredRow[];
  terminalStranded: StrandedTerminalRow[];
  orphanDrafts: OrphanDraftRow[];
  gapDiscards: GapDiscardSummary;   // NEW
}
```

The query is `WHERE status = 'drafted_unsendable' AND reason LIKE 'gap ask:%'`.
`terminalStranded` is left exactly as it is: gap discards are deliberately not
added to its `LIKE` list, because every row it prints today has a human remedy
and a gap discard does not.

`cmdStranded` (`cli.ts:186`) prints a fourth section:

```
gap-ask discards (N total):
  no gap matched                        N1
  declined by drafter                   N2
  CTA missing gap anchor                N3
  most recent 10:
    <arxivId>  <reason>
```

There is no `dN:` prefix anywhere in that output.

`outreach add` applies the same rule and prints `gap ask: no gap matched
(<reason>); nothing drafted` instead of producing a draft. The manual path keeps
its `alwaysExtractContact: true` exemption unchanged: the owner's constraint is
about what he sends, not about batch cost, and printing a contact result for a
lookup that did run is still truthful.

### Change 4: `intent` is replaced by a `GapAsk` on `DraftInput`

`DraftPromptInput.intent: string` (`prompts.ts:170`) becomes:

```ts
export interface GapAsk {
  gapId: GapId;
  title: string;
  statement: string;
  question: string;    // the sanctioned text, verbatim from config
  anchors: string[];
  honesty: string;
}
export interface DraftPromptInput {
  recipient: { ... };            // unchanged
  hooks: [...];                  // unchanged
  ask: GapAsk;                   // replaces `intent: string`
  senderName: string;
  senderFacts?: [...];           // unchanged
}
```

Both call sites:

- **`cli.ts:151-161` (loop `buildDraftInput`).** Delete `intent: 'seeking
  direction'`. Add `ask: askFrom(gaps, r.gapRoute)`, where `gaps` is loaded once
  in `cmdLoop` alongside `loadConfig`. `buildDraftInput` stays synchronous and
  pure, because the routing decision was already made in `processPaper` and
  arrives on `OrchestrateResult`. `askFrom` throws if `gapRoute` is null; the
  loop must never reach drafting with a null route, and a throw here is a
  programming error, not a candidate verdict.
- **`cli.ts:303-325` (manual path).** Delete the `self.find(f => f.facet ===
  'interest' && f.key === 'writing')` lookup and its fallback string entirely.
  Route with `chooseGapAsk` and build the same `GapAsk`.

**The `drafts.intent` column and `PersistDraftInput.intent` stay.** They are
written `` `${ask.gapId}: ${ask.question}` ``. No migration, the 102 existing
rows keep their meaning, and the ledger becomes self-describing: `SELECT intent,
count(*) FROM drafts GROUP BY intent` becomes the routing report. `contextJson`
gains `gapId` and `questionId`.

The `interest / writing` self-fact is left in the ontology. Removing it is
ontology cleanup and is out of scope; it simply stops being read.

### Change 5: the CTA must be the gap question

**`DRAFT_SYSTEM` (`prompts.ts:177-207`).** Structure item 3 changes from

> '3. ONE clear, low-friction ask for direction/guidance in the recipient's area.'

to:

```
3. THE ASK. The email must end on the ONE question given under "THE ASK".
   You MAY and SHOULD re-word it to land on this recipient's specific work:
   name their method, result or design choice and put the question against it.
   You may NOT substitute a different question, and you may NOT ask about
   their work in a way Aditya is not himself stuck on. Exactly one question
   mark in the body.
   Your final sentence must contain at least one ANCHOR phrase, near verbatim.
   End with that sentence. Do NOT add a closing or signature.
```

Two additions to STYLE / TRUTH:

```
- BANNED, additionally: "nobody has", "no one has", "this has never been done",
  "I would be the first". Aditya is a masters student writing to a researcher
  who may know the counterexample. Say what he cannot find, not what does not
  exist: "I cannot find", "as far as I can tell", "am I missing prior work".
```

That framing is not only more honest, it is the highest-scoring form of the ask
under the judge's own anchor: "one question that only this recipient is well
placed to answer" is precisely "here is what I cannot find, do you know of it".

And the decline path:

```
If the gap question cannot honestly be asked of THIS recipient, that is, you
would have to invent a connection between their work and the question, do not
force it. Return {"subject":"","body":"","decline":"<one short reason>"}.
A discarded draft is the correct outcome. A forced one is not.
```

**`buildDraftUser` (`prompts.ts:209-228`).** The line
`` `Aditya's intent: ${input.intent}` `` is replaced by a block:

```
THE ASK (the email must end on this question):
  gap: <title> (<gapId>)
  where Aditya is stuck: <statement>
  the question: <question>
  anchor phrases, use at least one near verbatim: <anchors joined by " | ">
  honesty: <honesty>
```

Everything else in `buildDraftUser` is unchanged, including the hook block and
the `[done]` / `[exploring]` tagging.

**`generateDraft` (`src/pipeline/draft.ts:62`).** Three changes, all extending
machinery that already exists.

1. `parseDraft` also reads an optional `decline: string`. On a decline, return
   `{ subject: '', body: '', grounded: false, wordCount: 0, notes: [...],
   declineReason }`. `Draft` gains `declineReason?: string` and
   `askGrounded: boolean`.

2. **Anchor check, extending the existing `stems` / `shares` helpers.** `shares`
   (`draft.ts:57`) returns true if *any* stem matches, which is too loose for a
   multi-word anchor: "concentration field" would pass on the word "field"
   alone. Add its strict sibling:

   ```ts
   const containsAll = (bodyStems: Set<string>, phrase: string): boolean => {
     const need = stems(phrase);
     if (need.size === 0) return false;
     for (const t of need) if (!bodyStems.has(t)) return false;
     return true;
   };
   const askGrounded = input.ask.anchors.some((a) => containsAll(bs, a));
   ```

   The 5-character stem is what makes this tolerate inflection: "geometry" and
   "geometric" both reduce to `geome`, "concentration" and "concentrations" both
   to `conce`. Anchors shorter than 5 characters contribute no stems and are
   rejected by `loadGaps` at load time, so a config typo cannot silently create
   an anchor that can never match.

3. **One retry before discarding.** If `askGrounded` is false and this is the
   first attempt, re-call the model once with an appended instruction: "Your
   draft did not end on the required question. Rewrite it so the final sentence
   asks: `<question>`, and contains one of: `<anchors>`." Then re-check. This
   keeps the discard bucket meaning "cannot honestly ask" rather than "model
   forgot the phrase", which is the whole point of making the bucket visible.
   The retry is recorded in `notes` so a run can report how many discards
   survived one.

`grounded` keeps its current meaning and is **not** overloaded with the anchor
result. `loop.ts` must check the new fields **before** the existing
`if (!draft.grounded)` branch, otherwise a decline would be filed as
`grounding failed: ...` and land in the wrong bucket:

```ts
if (draft.declineReason) { setStatus(..., `gap ask: declined by drafter (${input.ask.gapId}): ${draft.declineReason}`); ... return; }
if (!draft.askGrounded)  { setStatus(..., `gap ask: CTA missing gap anchor (${input.ask.gapId})`); ... return; }
if (!draft.grounded)     { ...unchanged... }
```

Both drafting sites in `loop.ts` need this: `processCandidate` (`:585-591`) and
`draftAndRequestAddress` (`:443-449`).

**What is deliberately not enforced.** `questionCount !== 1` is recorded as a
note, not a discard. Two question marks is an `ask_quality` problem the judge
already measures, and hard-failing on punctuation would discard drafts whose ask
is correct. `formChecks.questionCount` already reports it.

### Change 6: honesty, and what must not be undermined

- The `stance` machinery is untouched. `buildSenderFacts`
  (`credibility.ts:23-29`) still filters `stance !== 'exploring'`, so the loop's
  credibility line is still drawn only from completed work, and DRAFT_SYSTEM's
  `[done]` / `[exploring]` rules are unchanged. The gap ask is a separate block
  carrying its own `honesty` line, which reinforces rather than replaces them.
- Both gaps are `exploring` by construction: Gap 1's note closes "Nobody has
  done this yet (as of mid-2026)" and Gap 2's closes "Nobody has done this as a
  unified system". The `honesty` field states that plainly to the drafter, and
  the new banned-phrase rule stops it from being stated to the recipient as a
  claim about the field.
- Gap 2's `honesty` field carries the specific correction this project needs:
  PINNs and Gaussian Process gas-field regression are **background he has read,
  not work he has done, and not the gap**. That sentence is the direct fix for
  the 15 PINN emails.
- No safety gate is touched: human approval, `assertSafeOutbound`, the send
  claim, the identity and collision gates, `occursInSource`, the page-identity
  checks and the prior-thread check all keep their current position and
  semantics. The gap gate only ever removes drafts, never adds a send path.

## Behavioral changes to acknowledge

- **Draft volume falls, by design.** Estimated 15 to 26 of 56 discarded (see
  Verification). Fewer emails per run. The owner asked for this explicitly.
- **A new large invisible-by-default bucket exists** unless Change 3's aggregate
  ships with it. `drafted_unsendable` goes from 309 rows to 309 plus roughly one
  third of every future batch.
- **Some discards happen after paid spend.** The two draft-time verdicts consume
  `minePersonWeb` and `extractContactDetailed` first. This is a real regression
  in credits-per-sent-email, partially offset by the fact that a discarded
  candidate never triggers a notify, an approval round trip, or a send.
- **`drafts.intent` changes shape** from `'seeking direction'` to
  `'gap1: <question>'`. Nothing keys off its value: `grep` finds it read only
  for persistence and display. The 102 existing rows are untouched.
- **The loop makes one extra cheap LLM call per hooked candidate**
  (`chooseGapAsk`), on the order of 57 per batch, plus at most one extra
  frontier-model draft call per anchor-check retry.
- **Two recipients who compare notes will see the same closing question.** With
  two gaps and two sanctioned variants each, at most four distinct question
  cores across all outreach. The rewording requirement and the anchor-only check
  are what keep them from reading as a form letter. This is a real cost of the
  owner's constraint, not a defect in the implementation.
- **`outreach add` can now print "nothing drafted"** where it previously always
  drafted for a hooked, resolved person.
- **A pre-existing inconsistency becomes more visible and is left alone:** the
  manual path builds `senderFacts` at `cli.ts:307-310` without the
  `stance !== 'exploring'` filter the loop path applies. Out of scope here.

## Verification

Per the project rule: demonstrate against reality, not artifacts.

### 1. Primary evidence: a paired before/after judge run

`scripts/eval-draft-quality.ts` reads bodies from the database, so it cannot
score an email that has not been written. The before/after therefore needs a
re-draft harness: **new script `scripts/eval-gap-ask-ab.ts`**, read-only against
the DB and writing nothing back.

1. Load the 56 `status='sent'` drafts and their frozen `draft_input_json` (the
   same source `eval-draft-quality.ts` uses, and for the same recorded reason: a
   persona rebuild emptied `intersections` for 15 of them, so the live table
   disagrees with what the drafter saw).
2. For each, run `chooseGapAsk` over the frozen hooks, the paper title and the
   person's current facts. Record the route. **Report the discards; they are a
   result, not an error.**
3. For each survivor, regenerate the body with the new `DRAFT_SYSTEM`,
   `buildDraftUser` and `GapAsk`, using the same drafting model the originals
   used (`MODEL_FRONTIER`, falling back to `deepseek/deepseek-chat`).
4. Judge both the original and the regenerated body with the unchanged judge
   (`anthropic/claude-haiku-4.5`, temperature 0) and report paired per-draft and
   per-criterion deltas.

**The comparison must be restricted to the surviving subset, with the baseline
recomputed on that same subset.** Comparing `X/36` after against `20/56` before
is not like-for-like and would flatter the change by exactly the drafts it threw
away. Report both: the paired subset comparison as the claim, and the full-56
before numbers for context.

### 2. What counts as success

Primary, on the paired surviving subset:

- `ask_quality` mean rises by at least **+0.35** (from its re-derived baseline,
  expected near 1.30/2, to at least ~1.65/2).
- At least **60%** of drafts whose `ask_quality` changes move **up**, and no
  more than **10%** drop by 2.

Justification for that magnitude: the recorded ablation moved `ask_quality` by
**1.5** for a deliberate generic-ask damage and every other criterion by at most
**0.1**, so the criterion has roughly 1.5 points of usable range on this
population. +0.35 is about a quarter of that range. The judge's measured
stability on this rubric was 0 of 6 drafts moving between identical calls, so
+0.35 is comfortably outside its noise. A smaller movement should not be claimed
as success.

Guards, all of which must hold:

- No other criterion falls by more than **0.10** (the ablation's measured
  cross-talk ceiling). A gap ask that costs hook specificity is not a win.
- The count of `stance_honesty == 0` does not rise above baseline. This is the
  honesty regression that matters most: a gap question is easy to overstate.
- No new banned phrase appears in `formChecks`, and `formChecks.emDash` stays
  at zero.

Reported alongside, not gated on: the judge's `send` count on the subset (before
and after), the routing split, the discard reasons, and a hand-read sample of
10 `ask_quality` `why` strings. That last one matters because `ask_quality`
could improve for the wrong reason: a gap question is inherently more specific
than "any pointers", so the judge may reward specificity on a recipient who
still cannot answer. Reading the reasons is the check against that.

### 3. Regression tests

| Test | What it must assert |
| --- | --- |
| `test/gaps-config.test.ts` (new) | `loadGaps` parses `config/gaps.yaml`, rejects an anchor with no >=5-char stem, throws on a missing file, and reports drift when a `source_sha256` does not match a fixture note. |
| `test/gap-route.test.ts` (new) | Zero-term input returns `gapId: null` with **no LLM call** (assert on a counting fake). A thrown LLM error **propagates** and is not degraded to null. An unknown gap id from the model is downgraded to `none`. Fixtures built from the real d18, d34 and d43 material. |
| `test/draft.test.ts` (4 `intent` sites) | Rewrite to `ask`. Add: a body missing every anchor triggers exactly one retry then returns `askGrounded: false`; a body containing `"concentration field"` passes; a body containing only `"field"` fails (this is the case the loose `shares` helper would have passed). A `decline` reply returns `declineReason` and an empty body. |
| `test/loop.test.ts` (8 `intent` sites) | A `declineReason` fixture records `gap ask: declined by drafter (...)`, not `grounding failed`. An `askGrounded: false` fixture records `gap ask: CTA missing gap anchor`. Both in `processCandidate` and in `draftAndRequestAddress`. |
| `test/orchestrate.test.ts` | Ordering, with the existing shared call log: a candidate that fails the gap gate makes **zero paid calls**, and `chooseGapAsk` runs strictly after `computeIntersections` and strictly before `minePersonWeb`. Fresh `:memory:` DB per case, per the hook-first spec's warning about accumulated facts. |
| `test/seenLedger.test.ts` | `strandedReport().gapDiscards` counts and buckets `gap ask:%` rows and does **not** add them to `terminalStranded`. |
| `test/stranding.test.ts` (16 `intent` sites), `test/approval.test.ts`, `test/listen.test.ts`, `test/reply-time.test.ts`, `test/sent-threads.test.ts`, `test/address-correction.test.ts` | Mechanical: these use `intent` as a `persistDraft` field, which is unchanged. Only fixtures that build a `DraftInput` need editing. |
| `test/notify-tapback-safety.test.ts` | **Keep unchanged and passing.** No new notify is added by this spec. |
| `test/draft-quality-judge.test.ts` | **Keep unchanged.** The judge is not modified; modifying it while using it as the measuring instrument would invalidate the before/after. |

**Every fix must be mutated to red and restored.** In particular: break
`containsAll` back to `shares` and confirm the "only the word field" case goes
green (which is the failure), then restore.

Baseline before changes, measured 2026-08-05: **52 files, 657 tests, all
passing.**

### 4. Live demonstration

One real `outreach loop` run after merge. Report: the routing split, the count
and reasons in the new `gap-ask discards` section of `outreach stranded`, the
Tavily usage delta from `GET https://api.tavily.com/usage`, and the full text of
one drafted email so the owner reads an actual gap-framed ask before approving
anything.

## Risks

- **The judge could reward the change for the wrong reason.** A gap question is
  more specific than "any pointers on where to start", so `ask_quality` may rise
  even for a recipient who cannot answer it. Mitigation: hand-read 10
  `ask_quality` reasons, and report the discard count, which is the honest
  measure of the eligibility judgment.
- **`chooseGapAsk` becomes a new silent terminal verdict.** The hook-first spec
  documented exactly this failure with `identity unconfirmed`: 65+ rows sat
  unseen. Mitigation is Change 3's aggregate plus the mandatory re-throw on
  transport failure.
- **The router's term lists will rot.** They are field vocabulary, and `CLAUDE.md`
  records that Aditya's phrasing yields near-zero on arXiv while field phrasing
  yields 20. The lists live next to the same watchlist terms and should be
  revised together, but nothing enforces that.
- **Vault drift warns rather than blocks**, so the system can run for a long time
  on a stale transcription of a question the owner has since rewritten. Accepted
  deliberately: blocking strands a day of candidates on an unrelated note edit.
- **Four question cores across all outreach.** If two recipients in the same lab
  compare emails, the shared closing question is visible. The rewording
  requirement is the only defence and it is a model behaviour, not a check.
- **Volume drops by roughly a third** and the drop is front-loaded on exactly the
  populations that dominate current discovery (generic PINN theory and
  appearance-focused 3DGS). If discovery is not retuned, run yield could fall
  further than the estimate. Retuning discovery is out of scope.
- **The retry adds nondeterminism to drafting.** One extra frontier-model call on
  an unknown fraction of drafts. It is bounded at one and recorded in `notes`.

## Out of scope

Listed so a future reader does not fold them in. Each is a separate
problem/solution pair.

- **Any change to matching, hooking, `computeIntersections`, `INTERSECT_SYSTEM`
  or hook strength.** Hooking is explicitly unchanged. This spec only gates and
  shapes the ask.
- **Ontology cleanup of the `tool/FFmpeg`, `hobby/Chess`, `method/DBSCAN` class**,
  and the flat-54-facts structure generally. The gap questions deliberately live
  outside `ontology_facts` precisely so this cleanup can happen independently.
- **Removing the now-unread `interest / writing` self-fact.**
- **Discovery, sourcing, `watchlist.yaml` queries, seeds and author watch.**
- **Reply tracking, address correction, and the approval or send paths.**
- **Making the other ~300 `drafted_unsendable` rows visible or retryable in
  `outreach stranded`.** Still deferred, as the hook-first spec deferred it.
- **The manual path's missing `stance !== 'exploring'` filter on `senderFacts`.**
- **Treating geometry coupling as a third gap.** `CLAUDE.md` records that Gap 3
  is the geometry-coupling section inside Gap 2, and it is represented here as
  Gap 2's `gap2.geometry` question, which is the gap's own words.
- **Fixing d76's "I'm an undergrad" fabrication.** Real, in a body, and a
  different defect from the ask.
