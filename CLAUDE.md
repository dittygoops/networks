# Project rules
<!-- claude-learns:begin (generated from rules.json; edit the registry, not this block) -->
- When a feature produces observable output or data, run it and show the user the actual result before calling it done. Verification by demonstration, not assertion.
- When working on prd-writing:
  - Each PRD and its spec must address exactly one problem/solution pair. If a document mixes multiple features or domains, split it into separate focused PRD/spec pairs.
<!-- claude-learns:end -->

## Aditya's research lives in an Obsidian vault, not in this repo

`~/Documents/Coding/new/learning/` (42 notes, 12 of them under `Papers/`). This is the
source of truth for what he works on. The database's self-ontology is a lossy derivative
of it. Read the vault before reasoning about his interests.

Every failure of this project's judgment so far traces to reasoning from the derivative
instead of the source. Concretely, the system once ran on 2 of 42 notes and 1 of 12
papers, and the consequences were not subtle: it spent a day "discovering" Kordel France
(UT Dallas) as a novel find while four of his papers sat in `Papers/`, and it presented
the Mershin machine-olfaction roadmap as a lead when that note was already in the vault.

### Vault conventions that break naive parsing

- **Wikilinks.** Notes cite each other and their sources as `[[Papers/Title (Author Year)]]`.
  Following those links is how you find what a gap is built on.
- **Paper notes carry the arXiv id in their header as `**arXiv:** 2506.02373`.** The
  markdown bold sits between the label and the id, so a regex expecting `arXiv:\s*` misses
  every one. That exact miss caused a fallback to title search, which resolved a paper to
  `2506.04539` and seeded a paper Aditya had never read. Extract ids from the notes; do not
  resolve titles when an id is present.
- **Note titles are abbreviated versions of real paper titles.** "Molecular Odor Taxonomies
  for Structure-Odor Prediction" is on arXiv as "Exploring Molecular Odor Taxonomies for
  Structure-based Odor...". Exact title matching will not find them. Prefer the recorded id;
  when there is none, ask rather than fuzzy-match, because a wrong id sends discovery down
  an unrelated citation tree.

### The research gaps are numbered and COUPLED

- **Gap 1**: `Research Gap - Sensor to POM Bridge.md`
- **Gap 2**: `Research Gap - Volumetric Olfactory Capture.md`
- **Gap 3**: not a separate document. It is the "geometry coupling" section inside Gap 2.

They are one program, not parallel interests. Gap 2 names augmenting a 3D Gaussian
Splatting scene with a chemical concentration attribute as "a direct extension of 3DGS
that nobody has built", so **3DGS is the architecture for his most novel direction**, not
a finished side project. Asking "is 3DGS or olfaction the active thread?" is a badly
framed question; it produced a mute rule that blinded the system to precisely the
intersection where his contribution sits. Ask about the coupling, not about which thread
to drop.

### His gap vocabulary is not the field's vocabulary

Auto-derived queries use the verbatim `value` of each `stance='exploring'` fact, which is
how he described a gap to himself. Measured arXiv yield:

| his phrasing | results | field phrasing | results |
| --- | --- | --- | --- |
| olfactory embedding space | 0 | electronic nose | 20 |
| paired sensor-POM examples | 0 | olfactory perception | 19 |
| BME688 | 2 | machine olfaction | 9 |

With only his phrasings configured, the single high-yield query was the domain-generic
"hierarchical mixture of experts", so every early draft was an MoE paper in robotics or
emotion recognition, and exactly one olfaction paper was found across 43. Field
terminology belongs in `outreach/config/watchlist.yaml`. When adding a gap, add the terms
the field publishes under, not only his.

### Paper notes are SEEDS, not persona facts

`outreach persona` extracts facts **about Aditya** and correctly returns `[]` for a note
about someone else's paper. Feeding `Papers/` to it cannot work and once produced a
strictly worse ontology (gaps 9 to 3, key_papers 1 to 0). Papers belong in
`watchlist.yaml` under `seeds`, where they drive Semantic Scholar recommendations and
reach the Science, Nature, and Chemical Senses venues arXiv keyword search cannot.

Two related hazards: `persona` uses `replaceSelfFacts`, so it destroys the existing
ontology, and `intersections` cascades on `ontology_facts`, so a rebuild silently deletes
every stored hook. Export first (`data/self-ontology-backup.json`) and prefer
`saveSelfFacts` (additive) over a full rebuild. The extractor also runs on a cheap model
and has returned `[]` non-deterministically on a document that extracts fine on retry, so
a single empty result is not evidence of an empty document.

## Verify against reality, not against artifacts

This project has repeatedly been wrong in ways that passing tests and written specs did
not reveal. Treat these as the default failure mode:

- **Tests can agree with the code and both disagree with the world.** The Semantic Scholar
  source returned zero for its entire life because the fixture wrote the same wrong key the
  implementation read. Check a real response before trusting a passing test about an
  external API.
- **Specs assert things that are false about the code.** Across nine spec reviews, every
  spec came back NEEDS REVISION, several with load-bearing claims that evaporated when
  checked. Verify a spec's factual claims against the source before implementing it.
- **Some bugs are only reachable by running the real thing.** A one-year timeout that
  silently became 1ms, batch-versus-push delivery semantics, and a launchd PATH failure
  were all invisible to a green suite and obvious within seconds of a live run.
- **A regression test that cannot fail is worthless.** Mutate the fix, confirm the test
  goes red, restore. Several fixes here were validated only because that step was taken.
