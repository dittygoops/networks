# Technical Spec: Hook Quality

> Refines D6 in [`docs/spec-profile-mining.md`](./spec-profile-mining.md) and DR2/DR3 in
> [`docs/spec-draft.md`](./spec-draft.md). One problem: a hook can be factually true, pass
> every existing check, and still be worthless as the reason a cold email exists.

## 1. Problem

`intersect.ts` today answers one question: **are these two facts the same thing?** That is
match confidence, and `strength` measures it well. Nothing in the system answers the second
question: **is that thing worth putting in the first sentence of an irreversible email?**

The live run against Zhiying Du (paper `2512.05693`, HiMoE-VLA) is the proof. All three
hooks were true. Two were worthless:

| Hook | strength | tier | rationale |
|---|---|---|---|
| Aditya `method/exploring` "hierarchical mixture of experts" x Author `method` "Hierarchical Mixture-of-Experts" | 0.95 | B | "both: Hierarchical Mixture-of-Experts" |
| Aditya `institution/done` "Arizona State University" x Author `institution` "Momenta Pharmaceuticals (United States)" | 0.50 | A | "Both have connections to institutions in the United States." |
| Aditya `tool/done` "Anthropic Claude" x Author `research_area` "Computer science" | 0.30 | A | "Both are involved in computer science." |

The draft opened with "I used Claude in my Content Farm project". Verdict from Aditya:
"the hook is so horrible. Using Claude is barely a hook, everyone does it."

Two reactive fixes already shipped and are **out of scope here**: `isGenericEntity` /
`GENERIC_ENTITIES` drops commodity entities, and `rankHook` is now strength first with tier
as tiebreaker. Both are correct. Both are also a blocklist plus a sort order: they catch
generic entities that somebody thought to enumerate, and they say nothing about what makes a
hook *good*. This spec defines the positive model.

## 2. What the real data shows

Every number below is measured from `outreach/data/outreach.db` (23 people with facts, 3,515
person facts, 11 stored intersections, 6 drafts).

**F1. Genericness is empirically observable, not a matter of opinion.** "computer science"
and "artificial intelligence" each appear for 18 of 23 people. "arXiv (Cornell University)"
appears for 14. "machine learning" for 9. "Hierarchical Mixture-of-Experts", "Olfaction",
and "Chemical Senses" each appear for exactly 1. The corpus already knows which entities
discriminate. A blocklist is a hand-maintained approximation of a statistic the database can
compute.

**F2. Rarity alone is not specificity.** 2,367 of 3,515 person facts (67 percent) are
`collaborator` rows, and 2,330 of those values are unique. A raw inverse-frequency score
would rank "Caro Verbeek" as maximally specific. Intersection id 11 did exactly that: it
paired Aditya against a stranger's co-author name at strength 0.5. Specificity must be
gated by whether the fact class is *shareable at all*, not just by how rare the string is.

**F3. The hookable surface is tiny.** Across 23 people the corpus holds 15 `method` facts, 7
`dataset` facts, 3 `project` facts, and 1 `key_paper` fact, against 773 `institution` rows
and 138 `research_area` rows. The engine reaches for institutions and taxonomy nodes because
that is nearly all there is. Any quality model must therefore be prepared to return "nothing
here is good enough" often, and the system must be comfortable refusing.

**F4. There is a live matching bug that no blocklist would catch.** Intersections 12 and 13
both read "both: Nature" at strength 0.85, tier A, and are the *only* hook for Yitong Zhu and
Zhuo Li. They come from `entityMatches` containment: normalized, "heterogeneous molecular
signatures of human odor perception zanineli 2026" contains the substring "nature", inside
the word "sig**nature**s". The match is a character accident. Containment is applied without
word boundaries.

**F5. The Claude line was a structural failure, not a model failure.** The persisted
`draft_input_json` for draft 6 has no `senderFacts` key at all. `cli.ts:139`
(`buildDraftInput` for the autonomous loop) passes only `recipient`, `hooks`, `intent`, and
`senderName`, while the interactive `outreach add` path (`cli.ts:207`) passes eight
`senderFacts`. The drafter on the loop path had exactly one place to find a credential: the
hook list. It picked the Claude hook, correctly following its instructions. Draft 3, produced
by the CLI path with real `senderFacts`, opens "I'm a student who's trained end to end 3D
Gaussian Splatting models and benchmarked lidar clustering detectors on nuScenes". Same
prompt, same model, different inputs.

**F6. Depth is scarce.** Only 107 of 3,515 person facts carry a `detail`. The facts that do
are mostly paper derived. Depth must be a soft modifier, never a hard gate, or it would
reject nearly everything.

**F7. The refusal bar is inconsistent between paths.** `loop.ts:229` refuses on
`result.noStrongHook || hooks.length === 0`. `cli.ts:203` drafts on `r.hooks.length > 0`
alone. The same person can be refused by the scheduled loop and drafted by the CLI.

## 3. The model

### HQ1. Two orthogonal axes, never collapsed

| Axis | Question | Owned by | Range |
|---|---|---|---|
| `strength` | Are these two facts the same thing? | existing D6 scoring (entity match + LLM pass) | 0 to 1 |
| `value` | Is that thing worth opening an email with? | this spec | 0 to 1 |

`strength` is match confidence. `value` is editorial worth. They are independent: the Claude
hook was correctly scored 0.30 on strength (the two facts really are loosely related) and is
worth 0.00. The ASU hook was correctly scored 0.50 (both really are institutions in the US)
and is worth 0.00.

This is why the existing thresholds must not move. `MIN_STRENGTH` 0.3 and `STRONG_HOOK` 0.5
gate the *first* axis and a prior investigation validated them. The fix for a worthless hook
is never to raise the strength floor, because the hook was not weakly matched, it was well
matched to something not worth saying. `value` adds a second gate on a second axis. See HQ8.

### HQ2. The shared entity is the unit of evaluation, not the fact pair

A hook's value is a property of **the thing the two people share**, not of either fact.
"Arizona State University" is a specific entity (df 1). "Momenta Pharmaceuticals (United
States)" is a specific entity (df 1). What they *share* is "the United States", which is
worthless. Scoring either side alone gets this backwards.

Therefore every hook must carry an explicit `sharedEntity`: a canonical 1 to 4 word entity
naming what is actually in common.

- **Deterministic entity matches**: `sharedEntity` is the matched normalized value. Free.
- **LLM conceptual pass**: the model must return `sharedEntity` as a required field
  alongside `rationale`. A prose rationale ("Both are involved in computer science") is not
  a substitute, because prose can name a class without ever naming an entity, which is
  precisely how the two bad hooks passed.
- A hook whose `sharedEntity` is absent, empty, or longer than 6 words is **rejected**. If
  the overlap cannot be named as an entity, it is not an overlap, it is a category.

This single requirement rejects both motivating bad hooks without consulting any list:
"Both have connections to institutions in the United States" must resolve to
`sharedEntity: "United States"`, and "Both are involved in computer science" to
`sharedEntity: "computer science"`, at which point HQ3 scores them near zero.

### HQ3. Support rule (the anti-fabrication gate)

`sharedEntity` must be **supported by the person side**: it must stem match (the 5 character
stemming already used by `draft.ts`, so "olfaction" matches "olfactory") the person fact's
`value` or `detail`.

- Supported by person side **and** self side: `both-sided` hook. The email may say "we both".
- Supported by person side **only**: `one-sided` hook. Still usable, but the draft must
  phrase it as "you work on X, I am working on Y", never as shared ground.
- **Not supported by the person side: reject.** The opening line names something about the
  recipient. If the claimed common thing is not traceable to one of their facts, writing it
  is fabrication about a real person, which the project forbids outright.

Real case this catches: intersection 10 pairs Aditya's "olfactory embedding space" with the
author's `research_area` "Pharmacy" at strength 0.5, rationale "both interested in
olfaction/smell research". The claimed shared thing, olfaction, is supported by Aditya's side
and by nothing on Akshay Sajan's side. Under HQ3 that hook is rejected. Intersection 9 for
the same person ("Chemical Senses", supported by his venue fact) survives as `one-sided`.

### HQ4. Word boundary matching (fixes F4)

`entityMatches` containment must match on **token boundaries** over the normalized value, not
raw substrings. "gaussian splatting" inside "3d gaussian splatting" is a token subsequence
and must still fire at 0.85. "nature" inside "signatures" is not, and must not fire at all.
Equality matching at 0.95 is unaffected.

### HQ5. Value = S x A x Y x E

```
value = S(specificity) * A(alignment) * Y(shape) * E(evidence)
```

Multiplicative, not additive, because each factor is a veto. A perfectly specific overlap
that has nothing to do with what Aditya wants is still not worth writing. An overlap that is
perfectly aligned but shared with half the field is still not worth writing. A sum would let
a strong factor launder a fatal one, which is exactly how a 0.30 hook became an opening line.

#### S: specificity (how many researchers would this match)

```
idf(e) = ln((N + 1) / (df(e) + 1)) / ln((N + 1) / 2)      clamped to [0, 1]
S      = K(personKey) * S_base
```

- `N` = distinct people with facts in `ontology_facts`. `df(e)` = distinct people carrying a
  fact whose normalized `value` stem matches `e`. Measured, not asserted (F1).
- `S_base = 0` if `e` is in the cold start prior list (below). Otherwise
  `S_base = max(idf(e), prior(e))` where `prior` handles the cold start problem: an entity
  the corpus has never seen gets a lexical prior (multi word technical term 0.8, single
  proper noun 0.6, single common word 0.3) rather than a spuriously perfect idf.
- The **cold start prior list is the existing `GENERIC_ENTITIES` blocklist**, demoted from
  mechanism to seed. It exists so a fresh database is not fooled before it has 20 people.
  Extend it with the megajournal and preprint venues the corpus already flags empirically:
  `Nature`, `Science`, `arXiv (Cornell University)`, `PubMed`, `PLOS ONE`, `Scientific
  Reports`, `IEEE Access`. Once `N >= 20` the measured `idf` dominates and the list stops
  mattering, which is the whole point: the corpus enumerates genericness so a human does not
  have to.

`K(personKey)` is the hookability of the person side fact class, and it is what stops F2
(rare names scoring as specific):

| person-side `key` | K | Why |
|---|---|---|
| `method`, `dataset`, `project`, `key_paper`, `lab` | 1.00 | An artifact or an act. The strongest possible common ground. |
| `tool` | 0.90 | Real if the tool is not commodity; commodity tools are already zeroed by `S_base`. |
| `research_area` | 0.80 | A taxonomy node, coarse by construction (OpenAlex concepts). Usable when rare and aligned. |
| `venue` | 0.70 | Publishing in the same niche venue is real common ground; a megajournal is not. |
| `institution`, `advisor` | 0.60 | Only meaningful when it is the *same* institution, which HQ3 already enforces. |
| `role`, `location`, `hobby`, `community` | 0.50 | Human, occasionally charming, rarely the reason to write. |
| `collaborator` | 0.15 | A person's name. Rare by construction, not common ground unless Aditya knows them. Raise to 1.00 only when the same name appears on both sides. |

#### A: alignment to the ask (is this connected to what he wants?)

Aditya's asks are already first class data: `deriveGapQueries` in `discovery/gapSeeds.ts`
defines the research gaps as exactly the self facts with `stance = 'exploring'`, and
`seen_papers.source_detail` records which gap query surfaced the paper.

| Condition on the self side fact | A |
|---|---|
| `stance = 'exploring'` and it is the gap that produced the triggering discovery query | 1.00 |
| `stance = 'exploring'`, a different active gap thread | 0.80 |
| `stance = 'done'` and topically linked to the active gap or to the recipient's area | 0.50 |
| `stance = 'done'`, unrelated credential (`institution`, `company`, `tool`, `location`, `hobby`) with no topical link | 0.20 |

The ASU hook and the Claude hook both land at 0.20 on this axis alone, before specificity is
even considered. They were credentials pretending to be common ground. HQ10 gives credentials
their own channel instead of banning them.

#### Y: shape and symmetry (does it link an act to an act?)

```
Y = shape * sidedness
```

| shape | Y factor |
|---|---|
| Aditya `exploring` x person `done`: **the ask shape** | 1.00 |
| Aditya `done` x person `done`: the peer shape | 0.85 |

**The model deliberately rewards `exploring` to `done` highest.** "You have published on the
thing I am trying to learn" is the single best reason a masters student has to email a
researcher, and it is the true shape of the good MoE hook. This is not a tolerated exception
to the honesty rule, it is the honesty rule paying off: the `stance` field exists so the
draft can say "I have been digging into hierarchical MoE" instead of "I built one", and that
honest phrasing is also the more compelling one. The existing `DRAFT_SYSTEM` stance rules
(never claim an `exploring` fact as done work) remain unchanged and unconditional.

`sidedness` is 1.00 for a both-sided hook and 0.70 for a one-sided hook (HQ3).

#### E: evidence, recency, depth

```
E = 0.6 + 0.4 * (0.4*ev + 0.3*rec + 0.3*depth)        range [0.6, 1.0]
```

A soft modifier by construction. It reorders comparable hooks and never kills one, because
of F6: with 107 of 3,515 facts carrying detail, a hard depth gate would refuse everyone.

- `ev` = tier weight (A 1.0, B 0.8, C 0.3) times `min(selfConfidence, personConfidence)`.
- `rec` = 1.0 if the person fact came from the triggering paper (`isPaperSourceUrl`), 0.8 if
  `retrieved_at` is under the D7 180 day window, 0.4 if older. Recency is why a hook from
  this month's paper beats a hook from a five year old profile scrape: it is evidence they
  still care about the thing.
- `depth` = 1.0 if both sides carry a `detail`, 0.6 if one side, 0.3 if neither. Depth is
  what lets the draft say something concrete instead of name dropping. Both "Nature" hooks
  have detail on neither side; the MoE hook has detail on both.

### HQ6. Entity validity gate (pre-scoring)

A fact whose `value` is a sentence rather than an entity can never back a hook, on either
side. Reject before scoring when `value` exceeds 6 tokens or ends in sentence punctuation.

Real case: self fact 448, `interest/writing`, value "just looking to connect and get more
direction for future olfaction / smell research", `stance = 'done'`. It is the *intent*
field, not a fact, and it backs two stored hooks (ids 7 and 11) including the Caro Verbeek
one. `ENTITY_RULES` in `prompts.ts` already forbids this shape; nothing enforced it.

### HQ7. Ranking

```
score = strength * value
```

Rank by `score` descending, `tier` as the tiebreaker.

This **preserves** the validated strength first ordering as a special case: when two hooks
have equal `value`, the ordering is exactly today's ordering, strength first with tier
breaking ties. It never lets a low strength hook outrank a high strength one of equal worth.
On the motivating case: MoE `0.95 * 0.93 = 0.88`, ASU `0.50 * 0.00 = 0.00`, Claude
`0.30 * 0.00 = 0.00`.

### HQ8. Composition with existing thresholds

`MIN_CONFIDENCE` 0.5, `MIN_STRENGTH` 0.3, and `STRONG_HOOK` 0.5 are **unchanged and must not
be lowered**. Two new constants gate the second axis:

| Constant | Value | Meaning |
|---|---|---|
| `MIN_VALUE` | 0.25 | Below this a hook is discarded, exactly as `MIN_STRENGTH` discards. |
| `LEAD_VALUE` | 0.40 | A hook may open an email only at or above this. |

A hook is **kept** when `strength >= MIN_STRENGTH AND value >= MIN_VALUE`.
A hook is a **lead hook** when `strength >= STRONG_HOOK AND value >= LEAD_VALUE`.

`noStrongHook` is redefined as "no lead hook exists". It is a strict tightening: every hook
that qualified before must still clear the same strength bar, plus a value bar. The initial
values above are calibrated against the labeled set in Section 5 and are **re-tuned there,
not guessed** (see HQ13).

### HQ9. Refusal bar

**If no lead hook exists, the system refuses to draft.** Not draft and flag, refuse.

This generalizes the existing `noStrongHook` refusal, and it must be enforced **identically
on both paths**, fixing F7: the loop path (`loop.ts`) already refuses, the CLI `add` path
(`cli.ts`) currently drafts on `hooks.length > 0` and must adopt the same condition. The
refusal records `seen_papers.status = 'drafted_unsendable'` with a reason naming the best
value achieved and why it failed, so a refusal is diagnosable rather than silent.

The justification is asymmetric cost, not purism. A skipped paper costs one missed
opportunity, recoverable. A sent email that opens on "I used Claude" costs a real
researcher's goodwill, irreversibly, and Aditya has consistently preferred the first.
Given F3, this will fire often, and that is the correct behavior for the current corpus.

### HQ10. Credibility selection is a separate concern

**Yes, and the evidence is F5, not theory.** The drafter's job has two slots with two
different jobs:

| Slot | Question it answers | Criterion |
|---|---|---|
| Hook (sentence 1) | Why *you*? | Shared, specific, aligned to the ask, true of the recipient. |
| Credibility (sentence 2) | Why should you reply to *me*? | Demonstrated capability. Not shared, not rare, not about them. |

These criteria are almost opposites. Rarity is the whole point of a hook and irrelevant to a
credential. Sharedness is mandatory for a hook and meaningless for a credential. Feeding one
list into both slots is what produced the Claude line: the loop path supplied no
`credibilityFacts` and no `senderFacts`, so the only credential shaped material in the prompt
was hook 2.

`DraftInput` gains a required `credibilityFacts` field, selected independently:

- **C1.** `stance` must be `'done'`. Hard. An `exploring` fact can never be a credential, on
  pain of claiming unfinished work as done.
- **C2.** The `detail` must describe an act of construction or measurement (built, trained,
  benchmarked, implemented, shipped, measured, orchestrated, designed), not an act of use
  (used, tried, installed, set up). "Anthropic Claude: Used in Content Farm project" fails
  C2. "nuScenes: Benchmarked a lidar clustering detector against its ground truth" passes.
  This is Aditya's own verdict made mechanical: using a tool everyone uses is not an
  accomplishment.
- **C3.** Not commodity: the same `S_base` measure from HQ5, so anything a blocklist or the
  corpus flags as generic is disqualified as a credential too, even though it is true.
- **C4.** Ranked by transferability to the recipient: prefer a fact in the same topical
  thread as the recipient's area or the lead hook, then by rigor (a measured result over an
  unmeasured build).
- **C5.** At most 2 facts, rendered as one sentence.
- **C6.** Prefer a fact distinct from the lead hook's self fact, so the email carries two
  independent pieces of information rather than one restated.
- **C7.** **If no fact passes C1 to C3, the credibility line is omitted.** A three sentence
  email is better than a four sentence one with a filler credential. This is HQ9's principle
  applied at the sentence level, and it is the specific rule that would have prevented the
  Claude line even with the input bug present.

`DRAFT_SYSTEM` must state that hooks and credibility facts are different inputs with
different jobs, and must forbid using a hook entity as the credibility marker unless it also
appears in `credibilityFacts`.

### HQ11. Callers must supply the full input

Both `buildDraftInput` implementations (`cli.ts:139` for the loop, `cli.ts:207` for
interactive `add`) must supply `credibilityFacts`, `senderFacts`, `profileSummary`, and
`affiliation`. The loop path currently supplies none of these, and it is the path that runs
unattended, which is the worst place for the thinnest prompt. A single shared
`buildDraftInput(db, result)` used by both paths is the mechanical fix.

### HQ12. Persist the breakdown

`intersections` gains `shared_entity TEXT`, `value REAL`, and `value_json TEXT` (the S, A, Y,
E components and the reject reason). Without this, a bad hook can only be diagnosed by
rerunning the pipeline against a live LLM, and the eval in Section 5 cannot be computed
offline from the ledger.

### HQ13. Thresholds are calibrated, not asserted

`MIN_VALUE` and `LEAD_VALUE` are outputs of the Section 5 evaluation, swept over the labeled
set and chosen for **zero false drafts**, breaking ties toward refusal. They are re-run
whenever the labeled set grows. They are never adjusted to make a particular email send.

## 4. Worked scoring of the real hooks

Every row is a real stored intersection. `df` values are measured against the current corpus
(N = 23).

| # | Hook (self x person) | strength | sharedEntity | df | S | A | Y | E | value | score | Outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| H1 | hierarchical mixture of experts (exploring) x Hierarchical Mixture-of-Experts (`method`) | 0.95 | Hierarchical Mixture-of-Experts | 1 | 1.00 | 1.00 | 1.00 | 0.93 | **0.93** | 0.88 | **lead** |
| H2 | olfactory embedding space (exploring) x Olfaction (`research_area`) | 0.90 | Olfaction | 1 | 0.80 | 1.00 | 1.00 | 0.90 | **0.72** | 0.65 | **lead** |
| H3 | olfactory embedding space (exploring) x Chemical Senses (`venue`) | 0.70 | Chemical Senses | 1 | 0.70 | 1.00 | 0.70 | 0.90 | **0.44** | 0.31 | **lead (borderline)** |
| H4 | Arizona State University (done) x Momenta Pharmaceuticals (US) (`institution`) | 0.50 | United States | n/a | 0.00 | 0.20 | 0.85 | 0.88 | **0.00** | 0.00 | reject (HQ5 prior) |
| H5 | Anthropic Claude (done) x Computer science (`research_area`) | 0.30 | computer science | 18 | 0.00 | 0.20 | 0.85 | 0.86 | **0.00** | 0.00 | reject (HQ5) |
| H6 | nuScenes (done) x Artificial intelligence (`research_area`) | 0.30 | artificial intelligence | 18 | 0.00 | 0.50 | 0.85 | 0.88 | **0.00** | 0.00 | reject (HQ5) |
| H7 | key_paper "...Signatures..." (exploring) x Nature (`venue`) | 0.85 | Nature | 2 | 0.00 | 1.00 | 0.70 | 0.87 | **0.00** | 0.00 | reject (HQ4 first, HQ5 prior as backstop) |
| H8 | "just looking to connect..." (done) x Olfaction (`research_area`) | 0.85 | Olfaction | 1 | 0.80 | 0.20 | 0.85 | 0.87 | n/a | n/a | reject (HQ6, self value is a sentence) |
| H9 | "just looking to connect..." (done) x Caro Verbeek (`collaborator`) | 0.50 | Caro Verbeek | 1 | 0.15 | 0.20 | 0.85 | 0.86 | **0.02** | 0.01 | reject (HQ6, and HQ5 K as backstop) |
| H10 | olfactory embedding space (exploring) x Pharmacy (`research_area`) | 0.50 | olfaction (claimed) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | reject (HQ3, unsupported by person side) |

Observations that validate the model:

- H2 is a `research_area` taxonomy node on the person side, the same *class* as the worthless
  H5 and H6, and it is a good hook. The model gets this right without a special case: it
  survives on measured rarity (df 1) and perfect alignment, while H5 and H6 die on rarity
  (df 18). This is why specificity must be measured rather than inferred from the fact class.
- H4 has a df 1 entity on each side and is still worthless, which is HQ2's entire argument.
- Every rejection has at least two independent reasons except H3's borderline pass, so the
  model degrades safely if one factor is mis-estimated.
- Under these thresholds, Zhiying Du still gets an email, led by H1, with the credibility line
  either drawn from `credibilityFacts` (3D Gaussian Splatting, nuScenes) or omitted per C7.
  The two people whose only hook was "both: Nature" get **no** email, correctly.

## 5. Evaluation

Hook quality has the same silent failure problem as the relevance gate (Section 11 of
`docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`): a loose bar sends
embarrassing email, a tight bar silently sends nothing, and neither is visible from unit
tests. It gets the same treatment.

### E1. The labeled set

`test/fixtures/hook-quality-labeled.json`, generated from the real ledger by a checked in
script (`npm run eval:export-hooks`) that joins `intersections` to `ontology_facts` and
`people`. Seeded with the 10 rows in Section 4, each carrying the fields the scorer needs
(both fact values, details, keys, stances, tiers, confidences, source urls) plus:

| field | meaning |
|---|---|
| `label` | `good` (should lead), `weak` (may be kept, must never lead), `bad` (must be rejected) |
| `reason` | one line, in Aditya's words where they exist |
| `source` | `real:intersection:<id>` or `adversarial:<name>` |

Initial labels: H1 `good`, H2 `good`, H3 `good` (borderline, flagged), H4 to H10 `bad`.
H4, H5 and the Claude opening line carry Aditya's verbatim verdict as the reason.

### E2. Adversarial set

Hand built perturbations of the real rows, held in the same file with `source: adversarial:*`:

- `nature-substring`: the H7 pair, to pin HQ4 forever.
- `renamed-commodity`: H5 with `sharedEntity` "Claude Code" instead of "computer science", so
  the blocklist misses it by name and only the corpus `df` and `A` can catch it. This is the
  test that the model is not just a blocklist.
- `unsupported-shared-entity`: H10, a plausible `sharedEntity` supported only by the self side.
- `sentence-as-entity`: H8.
- `rare-collaborator`: H9, a df 1 person name.
- `exploring-claimed-as-done`: a hook whose draft output asserts an `exploring` fact as built
  work, for the drafting side of the gate.

### E3. Metrics

Computed offline from the fixture, no network, no LLM:

| Metric | Definition | Gate |
|---|---|---|
| `falseDraftRate` | fraction of people whose lead hook is labeled `bad` | **0.00, hard** |
| `precision@1` | fraction of people whose top ranked hook is labeled `good` | >= 0.90 |
| `badRejectRate` | fraction of `bad` rows rejected before ranking | >= 0.95 |
| `falseRefusalRate` | fraction of people with a `good` hook who are nonetheless refused | <= 0.10, reported not gated |

`falseDraftRate` is the only hard gate because it is the only irreversible failure.

### E4. Threshold sweep

Sweep `MIN_VALUE` and `LEAD_VALUE` over `[0.10, 0.70]` in 0.05 steps, emit the confusion
matrix per point, and select the point with `falseDraftRate = 0` and the highest
`precision@1`, breaking ties toward the **higher** threshold (refuse rather than send). The
selected point and its matrix are recorded in this document when the sweep first runs.

### E5. Feedback loop

Every draft Aditya rejects on the strength of its opening line is appended to the labeled set
as a `bad` row with his stated reason, via the existing decision ledger (`decisions.reason`).
The set therefore grows from real rejections rather than from imagined ones, which is how the
Claude case would have entered it automatically.

## 6. Test requirements

Numbered so implementation and tests trace to them. `T1` to `T9` are regression cases built
from real hooks in the ledger.

**Regression, from real data**

- **T1** (H1, HQ5/HQ7): the MoE hook scores `value >= 0.85` and ranks first among the three
  Zhiying Du hooks.
- **T2** (H4, HQ2): a hook whose `sharedEntity` is "United States" is rejected, with strength
  left at 0.50, proving rejection is on the value axis and not by lowering `MIN_STRENGTH`.
- **T3** (H5, HQ5): the Claude x Computer science hook is rejected with `value == 0`.
- **T4** (H7, HQ4): `entityMatches` produces **no** hook for the pair ("Heterogeneous
  Molecular Signatures of Human Odor Perception (Zanineli 2026)", "Nature"), and still
  produces a 0.85 hook for ("3d gaussian splatting", "gaussian splatting").
- **T5** (H10, HQ3): an LLM hook returning `sharedEntity: "olfaction"` against a person fact
  "Pharmacy" is rejected as unsupported.
- **T6** (H8, HQ6): a self fact whose value is the 13 word intent sentence backs no hook.
- **T7** (H9, HQ5): a `collaborator` fact with df 1 yields `value < MIN_VALUE`.
- **T8** (H2, HQ5): the Olfaction hook is kept and leads, proving a `research_area` fact is
  not rejected as a class.
- **T9** (H3, HQ3): the Chemical Senses hook is marked `one-sided` and its `value` reflects
  the 0.70 sidedness factor.

**Model behavior**

- **T10** (HQ5, S): `df` is computed from the live corpus, and an entity absent from
  `GENERIC_ENTITIES` but present for 18 of 23 people scores `S < 0.15`. This is the test that
  the system is no longer a blocklist.
- **T11** (HQ5, S): with `N < 20`, the cold start prior applies and a blocklisted entity still
  scores `S == 0`.
- **T12** (HQ5, Y): given two hooks identical except stance, `exploring x done` outscores
  `done x done`.
- **T13** (HQ5, A): a hook on the gap that produced the triggering discovery query outscores
  the same hook attributed to an unrelated gap.
- **T14** (HQ5, E): a hook whose person fact is paper derived outscores an identical hook from
  a fact retrieved over 180 days ago.
- **T15** (HQ7): with `value` held equal across all hooks, the output ordering is byte
  identical to the current strength first, tier tiebreak ordering.
- **T16** (HQ8): `MIN_CONFIDENCE`, `MIN_STRENGTH`, and `STRONG_HOOK` retain the values 0.5,
  0.3, 0.5. A guard test asserting the literals, so a future tuning pass cannot quietly lower
  the strength floor to compensate for the value gate.

**Refusal and drafting**

- **T17** (HQ9): a person with hooks that are all kept but none leading produces a refusal,
  not a draft, on **both** the loop path and the CLI `add` path, with the same reason string.
- **T18** (HQ9): the refusal writes `seen_papers.status = 'drafted_unsendable'` with a reason
  naming the best `value` achieved.
- **T19** (HQ10/C2): a `credibilityFacts` selector over the real self ontology excludes
  "Anthropic Claude: Used in Content Farm project" and includes "nuScenes: Benchmarked a lidar
  clustering detector against its ground truth".
- **T20** (HQ10/C1): an `exploring` self fact is never selected as a credibility fact.
- **T21** (HQ10/C7): when no self fact passes C1 to C3, `credibilityFacts` is empty and the
  generated draft contains no credential sentence, rather than falling back to a hook entity.
- **T22** (HQ11): both `buildDraftInput` call sites produce a `DraftInput` carrying
  `credibilityFacts`, `senderFacts`, `profileSummary`, and `affiliation`. A test that
  reconstructs draft 6's inputs and asserts they are no longer empty.
- **T23** (HQ12): a computed hook round trips `shared_entity`, `value`, and `value_json`
  through `saveIntersections` and back.

**Evaluation harness**

- **T24** (E3): the harness runs offline against the fixture and reports all four metrics.
- **T25** (E3): `falseDraftRate == 0` on the labeled set at the selected thresholds. This is
  the gate that fails CI.

## 7. Interfaces

| Interface | Shape | Change |
|---|---|---|
| `Intersection` | `+ sharedEntity: string; + value: number; + valueParts: { s: number; a: number; y: number; e: number }; + sidedness: 'both' \| 'one'` | extended |
| `scoreHookValue(ctx, hook)` | `(corpus stats, gap set, hook) => { value, parts, rejectReason? }` | new, pure, no LLM |
| `entityDocumentFrequency(db)` | `=> Map<normalizedEntity, personCount>` | new, one query, cached per run |
| `selectCredibilityFacts(db, ctx)` | `=> { text, stance }[]` (<= 2) | new |
| `DraftInput` | `+ credibilityFacts: { text: string; stance: 'done' }[]` | extended, required |
| `computeIntersections` | `noStrongHook` now means "no lead hook" | semantics tightened |
| `INTERSECT_SYSTEM` | must return `sharedEntity` per hook | prompt change |
| `DRAFT_SYSTEM` | hooks and credibility are distinct inputs with distinct jobs | prompt change |

## 8. Implementation plan

Each step ends with a human gate, per house convention.

1. **Measurement first.** `entityDocumentFrequency`, the labeled fixture export script, and
   the eval harness (E1, E3), scoring the current engine as a baseline. Nothing changes
   behavior yet.
   Human gate: does the baseline reproduce the known failures, specifically does it rank the
   Claude hook where the live run did?
2. **Deterministic gates.** HQ4 (word boundary), HQ6 (entity validity), HQ2 schema field plus
   the `INTERSECT_SYSTEM` change, HQ3 (support rule). T4, T5, T6.
   Human gate: re-run against the stored Zhiying Du and Yitong Zhu facts. The Nature hooks
   must be gone.
3. **The value model.** HQ5, HQ7, HQ8, HQ12. T1 to T3, T7 to T16.
   Human gate: read the re-ranked hooks for all 5 people in the ledger cold. Would Aditya open
   with the top hook in each case?
4. **Threshold calibration.** Run E4, record the selected point in this document.
   Human gate: accept the confusion matrix, including which real people are now refused.
5. **Refusal unification.** HQ9. T17, T18.
   Human gate: confirm a refusal is legible in the loop summary and in `seen_papers.reason`.
6. **Credibility channel.** HQ10, HQ11. T19 to T22.
   Human gate: regenerate draft 6 end to end with the same paper and read the opening two
   sentences. The Claude line must be gone and the email must still be honest about MoE being
   something Aditya is exploring, not something he built.

## 9. Open questions

- **Corpus contamination.** `df` is computed over people the system has already mined, which
  is a biased sample (heavily vision and language, per F1). If Aditya pivots fields, the
  previously rare terms in the new field will look rare for the right reason but the
  previously common ones will decay slowly. Revisit if the gap set changes wholesale.
- **Recency needs a year.** OpenAlex work records carry `publication_year` and `research.ts`
  discards it. `rec` currently leans on `retrieved_at`, which measures when *we looked*, not
  when *they worked*. Storing `evidence_year` on person facts would make `rec` honest. Small
  change, deferred because it does not block the model.
- **`LEAD_VALUE` versus corpus growth.** Given F3, the current bar may refuse most people
  until the paper-fact extractor is the dominant source of person facts. If the refusal rate
  is intolerable in practice, the correct response is to mine deeper facts, not to lower the
  bar.
