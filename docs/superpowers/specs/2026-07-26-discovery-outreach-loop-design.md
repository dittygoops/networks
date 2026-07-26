# Design: Autonomous Discovery and Scheduled Outreach Loop

Date: 2026-07-26
Status: Approved design, pending implementation plan
Author: Aditya Gupta (with Claude)

## 1. Problem

Today a human picks papers by hand and runs `outreach add <arxiv-id>` per paper. Nothing
discovers new work, nothing schedules the pipeline, and nothing reaches the phone. The
result is that outreach happens only when Aditya remembers to sit down and drive it.

This design adds an autonomous front end: it discovers relevant new papers on a schedule,
drives them through the existing pipeline, and sends an iMessage only when there is a
genuinely sendable draft.

## 2. Scope

This spec covers **discovery, scheduling, and the orchestration glue** only. Per the
project rule of one problem per spec, it composes two already specced subsystems rather
than redefining them:

| Subsystem | Spec | Relationship |
| --- | --- | --- |
| iMessage approval loop (F5) | `docs/spec-imessage-approval-loop.md` | Owns Photon Spectrum send, reply capture, decision ledger. This loop calls into it. |
| Edit learning | `docs/spec-edit-learning.md` | Owns turning approvals and edits into a learning signal. This loop feeds it, and does not reimplement it. |

New surface added by this spec:

1. A **discovery** module with three sources behind one interface.
2. A **seen papers ledger** so no paper is ever processed or messaged twice.
3. A **relevance gate** scoring candidates against the research gap ontology.
4. A single **`outreach loop`** orchestrator command.
5. A **launchd** schedule that fires it.

### Non goals

- No arXiv category firehose. Discovery is precision first (see Section 3).
- No long running daemon.
- No real time reply listener. Approvals drain at the next scheduled run.
- No changes to how drafts are written or grounded.

## 3. Discovery sources

Three sources, all precision oriented, each behind a common `DiscoverySource` interface so
they are independently testable and independently failable:

| Source | Mechanism | Seeded from |
| --- | --- | --- |
| `saved_query` | Runs a set of search queries against arXiv and Semantic Scholar | Research gap ontology terms, plus config additions |
| `author_watch` | Checks a watchlist of researchers for new postings | Already engaged authors and coauthors of drafted papers, plus config additions |
| `recommend` | Expands from seed papers via recommendation APIs | Papers already in the DB, plus config seeds |

Each source returns `Candidate[]`. The orchestrator merges them and dedupes within the
batch by `arxivId`.

## 4. Run flow

A single `outreach loop` command performs the whole cycle and exits.

```
launchd (daily) -> outreach loop
   |
   1. DRAIN APPROVALS: F5.captureReplies() over a bounded Spectrum window
   |      for each reply: F5.decide()
   |        approved + grounded -> Gmail API send -> markSent
   |        edited             -> new revision -> re-ground -> re-send iMessage
   |        rejected           -> log, feed edit-learning
   |
   2. DISCOVER: DiscoverySource[].fetch() (saved_query, author_watch, recommend)
   |      merge candidates, dedup within batch by arxivId
   |
   3. SEEN LEDGER FILTER: drop any arxivId already in seen_papers
   |      insert survivors as seen_papers(status='discovered')
   |
   4. RELEVANCE GATE: score(candidate, research gap ontology) >= threshold?
   |      below -> status='filtered_low_relevance' (silent, inspectable)
   |
   5. PIPELINE (existing orchestrate.ts): persona mine -> intersect -> draft
   |      no grounded hook OR no resolved email -> status='drafted_unsendable' (silent)
   |
   6. EMIT: sendable draft -> F5.sendDraftMessage() -> status='messaged'
   |      over max_messages_per_run -> status='queued_for_message' (emitted next run)
   |
   7. EXIT (next run picks up replies to what we just sent)
```

The human touchpoint is relevance gated auto draft: only candidates above threshold get the
expensive treatment, and only those with at least one grounded hook **and** a resolved email
produce an iMessage. Everything else is logged silently and stays inspectable.

## 5. Components

| Component | Input | Output | Depends on |
| --- | --- | --- | --- |
| `DiscoverySource` (interface) | seeds and config | `Candidate[]` | arXiv and S2 APIs |
| `discovery/index.ts` | config | merged `Candidate[]` | the sources |
| `seenLedger.ts` | `Candidate[]` | new only `Candidate[]` | DB `seen_papers` |
| `relevanceGate.ts` | candidate plus ontology | score plus keep or drop | LLM or embeddings |
| `loop.ts` (orchestrator) | none | side effects plus run summary | all of the above, F5, `orchestrate.ts` |
| `config/watchlist.ts` | auto derived plus override file | resolved seeds | DB, optional yaml |

**Key data flow rule.** Every candidate ends each run holding exactly one
`seen_papers.status`. Most are terminal, while `discovered` and `queued_for_message` are
resting states that the next run picks up. That single status column plus its `reason` is
the whole audit trail:
"what did the loop see, and why did it not message me" is answerable without joins.

## 6. Data model

New table `seen_papers`, acting as both dedup ledger and audit trail:

```sql
CREATE TABLE seen_papers (
  arxiv_id       TEXT PRIMARY KEY,      -- natural dedup key, survives rowid reuse
  title          TEXT NOT NULL,
  discovered_via TEXT NOT NULL,         -- 'saved_query' | 'author_watch' | 'recommend'
  source_detail  TEXT,                  -- which query, which author, which seed
  relevance      REAL,                  -- gate score, null until scored
  status         TEXT NOT NULL,         -- discovered | filtered_low_relevance
                                        -- | drafted_unsendable | queued_for_message
                                        -- | messaged | sent | rejected
  draft_id       INTEGER,               -- FK to drafts when one was created
  reason         TEXT,                  -- human readable "why it stopped here"
  first_seen_at  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

One row per paper, ever. `arxiv_id` as primary key makes rediscovery across runs and across
sources a no op.

## 7. Configuration

Auto derived defaults with an optional override file merged in, so the loop works with zero
upkeep but stays controllable.

`config/watchlist.yaml`:

```yaml
queries:            # merged with gap ontology derived queries
  add:    ["principal odor map", "olfactory embedding"]
  mute:   ["gaussian splatting"]        # kill a noisy auto query
authors:            # merged with already engaged authors
  add:    ["Alexander Wiltschko"]
seeds:              # extra arXiv IDs for recommendation expansion
  add:    ["2306.12345"]
gate:
  threshold: 0.6
  borderline_band: 0.1                  # scores within +/- this of threshold go to the LLM judge
  max_messages_per_run: 3               # hard cap so the phone never floods
```

If the file is absent, pure auto derivation runs. `max_messages_per_run` is the flood guard:
even if twenty relevant papers land, at most N iMessages go out per run. Sendable drafts over
the cap are parked at `queued_for_message` and emitted on the next run, highest relevance
first, ahead of newly discovered candidates.

## 8. Relevance gate

A cheap first cascade, so most decisions cost nothing and only ambiguous ones spend a token:

- **Stage 1, deterministic prefilter.** Compare title and abstract against research gap
  ontology terms, by embedding cosine similarity where embeddings exist, otherwise weighted
  term overlap. Clear keeps and clear drops resolve here. Fully unit testable with fixtures.
- **Stage 2, LLM judge, borderline only.** For candidates inside the borderline band around
  the threshold, one small LLM call returns a score from 0 to 1 plus a one line reason, for
  example "matches Gap 1: sensor to POM mapping". That reason string is written to
  `seen_papers.reason`, so every decision is explainable.

Threshold and borderline band come from config. The score is grounded in actual ontology
terms and the reason is quoted rather than invented, which keeps the gate consistent with the
never fabricate rule.

## 9. Error handling, safety, idempotency

- **Never email twice** is enforced twice over: F5's existing `priorThreads` guard, and the
  `seen_papers` primary key.
- **Nothing sends without an explicit reply.** The loop only ever messages. The Gmail send
  happens in step 1 of a later run, gated on an explicit approve. A crash mid run cannot send
  an unapproved email.
- **Per source isolation.** A discovery source that throws, for example an arXiv 429 or an S2
  outage, is caught, logged, and skipped. Other sources still run. Reuses the existing arXiv
  retry with backoff.
- **Idempotent runs.** Status transitions are monotonic and keyed on `arxiv_id`, so rerunning
  after a crash skips already messaged papers and resumes partially processed ones.
- **Transparent in thread logging.** Each run sends a one line run summary to the thread, for
  example "seen 12, filtered 9, unsendable 2, messaged 1". Failures surface in thread rather
  than being buried in logs.
- **Dry run.** `outreach loop --dry-run` discovers, gates, and drafts, but messages nothing and
  sends nothing. This is the safe demo path before arming launchd.

## 10. Testing

- **Unit.** Each source parser against fixture responses. `seenLedger` dedup, same id twice
  and across sources. Relevance gate cascade, above, below, and borderline. Config merge,
  auto plus override plus mute. All deterministic, no network.
- **Integration.** One full `outreach loop --dry-run` against a seeded temp DB with stubbed
  sources and a stub F5 sender, asserting the terminal `seen_papers.status` for each fixture
  paper is exactly what is expected.
- **Live smoke.** A `--to-self` run that discovers real recent papers, gates them, and
  iMessages the drafts, proving the Photon path end to end before scheduling.

Follows the existing vitest and injected dependency pattern, as in
`fetchArxivPaper({ fetchFn })`.

## 11. Validation and acceptance criteria

Deterministic components are covered by the unit and integration tests in Section 10. Two
components carry LLM judgment whose failures are silent, and those get eval sets rather than
assertions alone. The eval work itself is a separate effort, run with the
`product-agnostic-eval-guide` plugin at the point of implementation, not folded into this
spec.

**Relevance gate.** Good means: on topic papers matching a stated research gap are kept, off
topic papers are dropped, and each decision carries a reason traceable to an ontology term.
Both failure modes are invisible without an eval, since a loose gate floods the phone and a
tight gate silently drops good work. The threshold and borderline band must be tuned against
a labeled test set, not guessed. Real labeled seeds already exist in the DB: the Zanineli and
Sajan papers are positives that produced grounded hooks, while the Sinigaglia paper and the
Zhang paper that produced zero hooks are hard negatives or borderlines.

**Draft groundedness.** Good means: every claim about the researcher and about Aditya traces
to a stored fact. This carries a hard constraint, since the global rule forbids fabricating
user data and a cold email to a real researcher is irreversible. The existing DR4 grounding
check is a deterministic guard, but a guard cannot report how often it holds across many
drafts. This needs a faithfulness eval set plus one adversarial set whose only job is to
catch a draft inventing a fact.

Components explicitly **not** worth an eval suite: the seen papers ledger, config merge, and
status transitions are deterministic and fully covered by unit tests. Contact and email
resolution is factual and small, so pattern assertions suffice.

## 12. Open questions

None. All design decisions are settled:
discovery sources are saved query, author watch, and recommend;
the touchpoint is relevance gated auto draft;
scheduling is pure scheduled batch with approvals drained at the next run;
seeds are auto derived with a config override;
and eval coverage is scoped to the relevance gate and draft groundedness.
