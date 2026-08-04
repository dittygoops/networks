# Identity Resolution Without an Academic Anchor

**Date:** 2026-08-04
**Status:** Draft, not yet reviewed
**Problem owner:** the pipeline can only understand people who have an OpenAlex author record
**Depends on:** `2026-08-02-hook-first-gating-design.md` (implemented). Absorbs the
Understander seam from `2026-08-04-pipeline-interfaces-design.md` (DEFERRED), which
explicitly hands that seam to this document.

## Problem

Every person this system has ever understood is anchored on an OpenAlex author id.

`persistPerson` (`outreach/src/pipeline/persist.ts:7-25`) takes an `AuthorResolution` and
writes `resolution.author.id` into `people.openalex_id`. There is no other code path that
creates a person with facts. `processPaper` (`orchestrate.ts:191-195`) returns early with
`personId === null` when `resolveAuthor` returns null, and `processCandidate`
(`loop.ts:362-366`) files that as `drafted_unsendable / 'identity unconfirmed'`.

That bucket is terminal and invisible. `getResumable` and `getExhausted`
(`seenLedger.ts:92-117`) both filter `status = 'discovered'`, `filterUnseen`
(`seenLedger.ts:31-44`) drops anything already in `seen_papers`, and `strandedReport`
(`seenLedger.ts:185-193`) matches only `reason LIKE 'abandoned after%'` or
`'ambiguous orphan drafts%'`. Nothing prints these rows and nothing retries them.

### Measured, `outreach/data/outreach.db`, 2026-08-03

| metric | value |
| --- | --- |
| `people` rows | 234 |
| with an `openalex_id` | 189 |
| without an `openalex_id` | 45 |
| of those 45: rows with ≥1 fact | **0** |
| of those 45: rows with ≥1 draft | **0** |
| `seen_papers` by status | discovered 7, drafted_unsendable 252, filtered_low_relevance 176, messaged 63 |
| `drafted_unsendable` reasons | no grounded hook 99, **identity unconfirmed 78**, no email resolved 50, prior thread 5, identity collision 20 |
| `people.email_source` | pdf 111, homepage 45, directory 20, github_profile 3, user_provided 1 |

The 45 rows without an OpenAlex id are the contact-only rows the hook-first spec deleted the
branch for. Confirmed here: none of them ever produced a fact or a draft. So the practical
count of people this system can understand is exactly the count it can find in OpenAlex.

### The worked example: the owner himself

Live against the OpenAlex API on 2026-08-03, using the same polite User-Agent the client
sends (`openalex/client.ts:7`):

```
GET https://api.openalex.org/authors?search=Aditya%20Gupta
  -> meta.count = 194

GET https://api.openalex.org/authors?search=Aditya%20Gupta
      &filter=last_known_institutions.id:I55732556   (Arizona State University)
  -> meta.count = 0
```

Top five by works count: `A5100603158` Aditya K. Gupta (1215 works, National Center for
Disease Control), `A5100603157` Aditya Gupta (911, University of Central Florida),
`A5017136504` Aditya Gupta (63, C-DAC), `A5117097165` Aditya Gupta (26, Google / Harvard),
`A5001742940` Aditya Kumar Gupta (90, NIT Sikkim).

So the owner of this system is 1 of 194 name matches, 0 of which are at his institution. He
has no OpenAlex record, no Google Scholar profile, and no arXiv paper. Under the current
design he is not merely hard to resolve, he is **unresolvable, and 194 wrong answers are one
weak corroboration signal away.**

That is not hyperbole about the signal count. `resolveAuthor` (`research.ts:228-253`) accepts
a candidate on `≥1 strong signal` (coauthor, title, arxiv) `or ≥2 weak signals` (concept,
affiliation). For a candidate that did not come from a paper there is no title, no arXiv id,
and no coauthor list, so **only the two weak signals are reachable, and both of them are
cohort labels rather than identities.** "Works on machine learning" and "is at Arizona State"
are true of thousands of people.

### Why loosening this is dangerous, with the receipts

This system has already sent a cold email to the wrong person. `daniel.lee@dlapiper.com`, a
law firm address, was sent for the olfaction researcher Daniel Kepple, because
`nameMatches('daniel.lee', 'Daniel Kepple')` returned true on the bare first name. The
incident is recorded in the comment at `contacts.ts:309-339` and the rule was tightened:
a bare first name is no longer a sufficient match. Person 58 now correctly holds
`dkepple@uncc.edu`.

**The symmetric gap on the surname side is still open, and it is live.** `strongPatterns`
(`contacts.ts:359-365`) accepts a bare surname by plain substring containment with only a
`p.length > 1` guard. Measured by executing the shipped `nameMatches` against all 180 stored
addresses on 2026-08-03:

- **71 of 180** addresses pass without the person's first name appearing in the local part at
  all, i.e. purely on the surname branch.
- **34 of 180** pass on a surname that is not aligned to any delimiter-separated segment of
  the local part, which is the shape a genuine `f.last` / `flast` / `lastf` address never has.

The worst of the 34, each verified against the live `people` table:

| person | stored address | how it passed |
| --- | --- | --- |
| 184 Ziheng Xu | `xuhuaping@buaa.edu.cn` | `xu` is a prefix, `huaping` is somebody else's given name |
| 208 Xianliang Huang | `huangbo@njust.edu.cn` | `huang` is a prefix, `bo` is not `xianliang` |
| 232 Xiyu Zhang | `zhangyanghui@tongji.edu.cn` | `zhang` is a prefix, `yanghui` is not `xiyu` |
| 222 Zhisheng Han | `l.zhang.16@bham.ac.uk` | surname `han` found **inside** `zhang` |
| 105 Jiahao He | `zhengkai.zhao@nuaa.edu.cn` | surname `he` found **inside** `zhengkai` |
| 96 MD Wahiduzzaman Khan | `jawairia.khan@uts.edu.au` | surname `khan`, different human entirely |
| 27 Hongkun Yang | `yangbaoquan@sjtu.edu.cn` | `yang` prefix, `baoquan` is not `hongkun` |
| 182 Sicheng Yu | `lanyu@cqu.edu.cn` | `yu` suffix, `lan` is not `sicheng` |

**These are not queued, they were sent.** A batch of 41 drafts was approved via iMessage and
sent between `2026-08-04 01:35` and `2026-08-04 01:41` UTC (`drafts.send_attempted_at`,
`decisions.via = 'imessage'`), which is roughly fifteen minutes before this spec was written.
`d52` (Ziheng Xu), `d60` (Xianliang Huang), `d69` (Xiyu Zhang), `d51` (Sicheng Yu), `d27`
(Hongkun Yang), and `d37` (MD Wahiduzzaman Khan) are all in that batch, all `status = 'sent'`.

Two mechanisms produced them, and they are different:

1. **`email_source = 'directory'` (20 rows, includes person 184).** `classifyWebPage`
   (`contacts.ts:135-145`) returns `'directory'` precisely when the person's name patterns do
   **not** appear in the page URL or title. Its confidence is 0.75, above the 0.7 threshold.
   So a page the classifier itself judged not to be about the target still contributes
   addresses, and `nameMatches` is the only remaining filter.
2. **`email_source = 'homepage'` (45 rows, includes persons 208 and 232).** The page really
   is about the target, and it also lists a colleague's or PI's address. Again `nameMatches`
   is the only filter.

This spec does **not** fix `nameMatches`. That fix changes address selection for the existing
academic population and must be measured against all 180 stored addresses, so it is its own
spec (see Out of scope, where the evidence above is handed over). What this spec must do, and
what the rest of the design is organised around, is **make the new non-academic path strictly
safer than the existing one rather than inheriting its weakest link.**

## Design

The thesis in one line: **the identity anchor must become a namespaced identifier that the
subject demonstrably controls, and it must be asserted by a record rather than inferred from
a name.**

### Change 1: the Understander seam, with the hook gate enforced by the type

New file `src/pipeline/ports.ts`. It imports types only (`OntologyFact` from `research.ts`,
`Intersection` from `intersect.ts`). It must not import `arxiv.ts`, `openalex/client.ts`,
`contacts.ts`, or `search/tavily.ts`, and that constraint is the actual test of whether the
split worked.

This spec owns the seam because it is the first change with a real second implementation
(`createAnchoredUnderstander` below). It deliberately does **not** define `Source` or
`Reacher`: the deferred spec's own argument, that `src/pipeline/intake.ts` rotted into dead
code because it was extracted without a second consumer, still applies to those two.

```ts
// ---------------------------------------------------------------------------
// Candidate input. This is the SUBSET of the deferred spec's SourcedCandidate
// that an Understander actually needs. When a Source spec lands it should
// define `SourcedCandidate = CandidateSubject & { sourceName; sourceDetail }`
// rather than introduce a second shape.
// ---------------------------------------------------------------------------

export type AnchorKind = 'openalex' | 'orcid' | 'github' | 'site' | 'linkedin' | 'manual';

// An identifier the ARTIFACT ITSELF states. A Source fills this from structured
// data it already holds. A Source must never mint one by guessing from a name;
// see AR4 below and DN1 in docs/spec-verified-personal-sources.md, where that
// exact heuristic was implemented, measured, and reverted.
export interface StatedAnchor {
  kind: AnchorKind;
  id: string;        // 'dittygoops', 'A5039262617', '0000-0002-1825-0097'
  url: string;       // dereferenceable, e.g. 'https://github.com/dittygoops'
  statedAt: string;  // the artifact URL that states it; becomes evidence_url
}

export interface CandidateEvidence {
  title: string;         // paper title, repo name, talk title, posting title
  summary: string;       // abstract, README, bio, session description
  url: string;           // canonical artifact URL; becomes OntologyFact.sourceUrl
  peers: string[];       // coauthors, co-maintainers, co-panelists
  areaTerms: string[];
  fullTextUrl?: string;  // PDF or equivalent; absent means no tier-1 document
  ageMonths?: number;
  statedAnchors: StatedAnchor[];  // may be empty; empty is a valid, common case
}

export interface CandidateSubject {
  sourceId: string;   // namespaced id of the ARTIFACT ('arxiv:2606.00001')
  person: { name: string; affiliationHint?: string | null };
  evidence: CandidateEvidence;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface ResolvedAnchor {
  anchorId: string;    // '<kind>:<id>', e.g. 'github:dittygoops'
  kind: AnchorKind;
  evidenceUrl: string; // the artifact or record that bound it
  assertedBy: string;  // 'artifact-host' | 'anchor-record' | 'linked-from:<anchorId>' | 'operator'
}

export interface PersonIdentity {
  anchorId: string;             // the PRIMARY anchor; people.anchor_id
  anchors: ResolvedAnchor[];    // every anchor bound to this person
  displayName: string;          // from the ANCHOR RECORD, not from the artifact
  affiliation?: string | null;
  homepageUrls: string[];       // the allow-list buildDomainGate consumes
}

export interface Understanding {
  personId: number;
  identity: PersonIdentity;
  facts: OntologyFact[];
  profileSummary: string;
  hooks: Intersection[];
  noStrongHook: boolean;
}

export type UnderstandVerdict =
  // Could not establish who this is. TERMINAL. An Understander MUST reserve
  // this for a well-formed no-match and MUST re-throw transport failures, so an
  // outage stays retryable (orchestrate.ts:164-170, test/orchestrate.test.ts).
  | { kind: 'unresolved'; note: string }
  // OpenAlex-only: the author record looks like several humans merged.
  // TERMINAL. The person is already persisted and stale hooks already cleared.
  | { kind: 'collision'; personId: number; reason: string }
  // NEW. The candidate presents two or more anchors that already belong to
  // DIFFERENT person rows. TERMINAL, and deliberately never auto-merged.
  | { kind: 'anchor_conflict'; reason: string; personIds: number[] }
  | { kind: 'understood'; understanding: Understanding };
```

The hook gate, enforced structurally:

```ts
// Declared, never emitted. There is no runtime value, so no module outside
// ports.ts can write this key into an object literal.
export declare const HOOK_GATE_PASSED: unique symbol;
export type Hooked = { readonly [HOOK_GATE_PASSED]: true };

// The ONLY function that produces a Hooked value, and it re-applies the gate
// itself. A caller cannot mint one for a hookless Understanding.
export function passHookGate(u: Understanding): (Understanding & Hooked) | null {
  if (u.noStrongHook || u.hooks.length === 0) return null;
  return u as Understanding & Hooked;
}

export interface Understander {
  readonly name: string;
  // FREE half. MUST make zero paid calls (Change 7). Runs on every candidate.
  understand(c: CandidateSubject): Promise<UnderstandVerdict>;
  // PAID half. Unreachable without a Hooked value, which only passHookGate
  // mints. A failure inside MUST be non-fatal: return the input unchanged
  // rather than throwing (research.ts:538-542 already behaves this way).
  enrich(u: Understanding & Hooked): Promise<Understanding & Hooked>;
}
```

**Be precise about what this does and does not enforce**, because the deferred spec
overstated it ("an `Understanding` cannot be constructed without hooks having been computed"
is structurally false in TypeScript, which is nominal only where a brand makes it so).

| mechanism | what it enforces | how it can still be defeated |
| --- | --- | --- |
| `enrich(u: Understanding & Hooked)` | a data dependency: you must hold a gated value | a deliberate `as unknown as` cast |
| `HOOK_GATE_PASSED` never emitted | provenance: only `passHookGate` mints the brand | the same deliberate cast |
| `test/ordering.test.ts` shared call log | timing: no paid seam fires before `llm:intersect` | editing the test, which review catches |

Three mechanisms, each covering what the others cannot. Reordering `enrich` above the gate
becomes a **compile error** rather than a silent cost regression, which is the improvement
over today, where a comment and one test are the whole defense for roughly 700 Tavily credits
a month.

### Change 2: what counts as an identity anchor

**AR1. An anchor is an identifier the subject controls, dereferenceable, and stated by the
artifact.** Cohort membership is not identity.

| accepted kind | id form | why it is an identity |
| --- | --- | --- |
| `openalex` | `A5039262617` | one author record, already the status quo |
| `orcid` | `0000-0002-1825-0097` | issued to one person, profile is self-asserted |
| `github` | login | one account; everything under it is published by its holder |
| `site` | registrable domain | DNS registration is exclusive |
| `linkedin` | vanity slug | one profile (see Change 6 for why it is hard) |
| `manual` | operator-supplied string | a human asserted it, `outreach add` only |

**Rejected as anchors, usable only as corroboration:** employer name, school name,
department, lab, city, job title, research area, email domain, ORCID-less institutional
directory listing. Every one of these is a set with more than one member.

This is the sharp form of the requirement. The task framing offered "a company, a school, a
GitHub handle, a personal domain" as candidate disambiguators. Two of those four are
identifiers and two are cohorts. **A strong disambiguator is a URL, not a string.** Arizona
State has on the order of tens of thousands of students; `github.com/dittygoops` has one
holder.

**AR2. Binding.** A candidate resolves to anchor `A` only if a machine-checkable reference
exists in at least one direction:

- **B1 (artifact is under the anchor).** `anchorAdmitsUrl(A.url, evidence.url)` is true.
  `anchorAdmitsUrl` (`research.ts:476-489`) already implements exactly the right test:
  exact hostname match, or a shared registrable label of at least
  `MIN_DISTINCTIVE_LABEL_LENGTH = 4` characters. It is reused verbatim, not reimplemented.
- **B2 (anchor record cites the artifact).** The anchor's own record names the artifact: an
  OpenAlex work whose external id equals the candidate's, a GitHub repo owned by the login, an
  ORCID `works` entry with the artifact's DOI.
- **B3 (transitive, one hop only).** The artifact page links to `A.url` **and** the artifact
  page is itself on an anchor already bound to this person by B1 or B2. This is what lets a
  verified personal homepage introduce a GitHub anchor. The "already bound" precondition is
  load-bearing: without it, "a page links to a GitHub account" readmits name-guessing through
  any page a search engine returned, which is DN3 in
  `docs/spec-verified-personal-sources.md`.

**AR3. Name corroboration is necessary for proposed anchors and irrelevant for sourced
ones.** Distinguish the two:

- **Sourced anchor** (bound by B1 or B2): the artifact came from under the anchor, so the
  anchor *is* the identity by construction. No name test applies, and `displayName` is taken
  from the anchor record, never from the artifact.
- **Proposed anchor** (bound by B3): `personNameInText(anchorRecord.displayName,
  candidate.person.name)` must return true. `personNameInText` (`src/text/match.ts:99-146`)
  is the strict token matcher, requiring the surname as a complete token plus a nearby given
  name or initial. It is deliberately not `nameMatches`, for the reasons its own comment
  gives.

**AR4. The system must refuse to guess. Specifically it must never:**

- search for an anchor by name. The `"${name}" github` query was already removed from
  `minePersonalFacts` for this reason (`research.ts:589-593`), and DN1 records the
  measurements: `nameMatches('dittygoops', 'Aditya Gupta')` is false (poor recall on the
  owner's own real handle) while `nameMatches('guptaa', 'Anika Gupta')` is true (poor
  precision on a stranger). Weak in both directions, feeding irreversible email.
- accept an anchor because a search engine ranked it for the name (DN3).
- accept a *host class* as an anchor. `domainWithoutSuffix` collapses `github.io`,
  `github.com`, and `sites.google.com` to `github`, `github`, `google`, so admitting a class
  is indistinguishable from disabling the gate for the largest hosting platforms on the web
  (DN2).
- infer an anchor from an email address, in either direction. The local part is not an
  identity claim, which is the entire lesson of the `daniel.lee` incident.
- merge two person rows because their names and affiliations agree.

**AR5. Anchor uniqueness.** One `anchor_id` maps to at most one `people` row, enforced by a
unique index. A candidate presenting two anchors that already belong to different rows yields
`anchor_conflict`, which is terminal and logged. It is never resolved by merging (Change 4).

### Change 3: the worked example, run through the rule

Three ways the owner could arrive as a candidate. All three verdicts are the design's real
output, not the flattering one.

**Scenario A: sourced from a GitHub repository under `dittygoops`.**
B1 holds: `anchorAdmitsUrl('https://github.com/dittygoops', 'https://github.com/dittygoops/<repo>')`
is true on exact hostname. The anchor is `github:dittygoops`, sourced, so no name test is
required. Verified live on 2026-08-03:

```
GET https://api.github.com/users/dittygoops
  login: dittygoops         name: Aditya Gupta
  html_url: https://github.com/dittygoops
  public_repos: 48          created_at: 2023-03-01
  company: null   blog: ""   email: null   twitter_username: null
```

**Verdict: `understood`.** `displayName` "Aditya Gupta" comes from the anchor record and
happens to corroborate the artifact's name, which is a nice property rather than a
requirement.

Then reaching fails. `company`, `blog`, and `email` are all empty, so there is no address and
no affiliation from this anchor. The pipeline records `no email resolved`, correctly, and
does not fall back to searching `"Aditya Gupta" Arizona State email`, because that query is
forbidden on this path (Change 5). **The honest summary is: the design resolves the owner's
identity and then cannot reach him.** That is the right failure. Silence beats mailing one of
the other 193.

**Scenario B: a conference program line reading "Aditya Gupta, Arizona State University".**
`statedAnchors` is empty. No B1, no B2, no B3. **Verdict: `unresolved`.** This is correct and
the design does not apologise for it: 194 OpenAlex authors carry that name, 0 of them are at
ASU, and the two available corroboration signals (`concept`, `affiliation`) are cohort labels.
A name plus a school is not an identity, for him or for anyone.

**Scenario C: sourced from `linkedin.com/in/aditya-gupta-asu`.**
The slug is a controlled identifier, so B1 would hold by the rule. But `linkedin.com` is in
`AGGREGATOR_HOSTS` (`contacts.ts:129-133`) and is never fetched, and the profile is
login-walled, so the binding cannot actually be checked without a logged-in browser session.
**Verdict today: `unresolved`.** This is the single case that genuinely needs Change 6, and
it is deferred there rather than hand-waved.

Both `linkedin.com/in/aditya-gupta-asu` and `github.com/dittygoops` are already in
`SIGNATURE` (`src/pipeline/draft.ts:21-28`), which is the only place in this repo that records
the owner's own anchors. That is the correct source for a manual seed and the reason
scenario A is testable at all.

### Change 4: what identity is stored as

`people.openalex_id` is today's dedup key: `upsertPerson` (`db.ts:101-120`) looks the row up
by it, and it is `TEXT UNIQUE` in `schema.sql:6`. It keeps its meaning and its 189 populated
rows. A general anchor is layered on top.

**New table**, in `schema.sql`, created idempotently like every other table:

```sql
CREATE TABLE IF NOT EXISTS person_anchors (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  anchor_id TEXT NOT NULL UNIQUE,     -- 'openalex:A5039262617', 'github:dittygoops'
  kind TEXT NOT NULL,
  evidence_url TEXT NOT NULL,         -- the artifact or record that bound it
  asserted_by TEXT NOT NULL,          -- 'artifact-host' | 'anchor-record' | 'linked-from:<id>' | 'operator'
  first_seen_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anchors_person ON person_anchors(person_id);
```

**New column** `people.anchor_id TEXT`, the primary anchor, plus a unique index.

**The migration mechanism matters and was verified by execution on 2026-08-03.** SQLite
refuses to add a unique column:

```
sqlite> ALTER TABLE people ADD COLUMN anchor_id TEXT UNIQUE;
Error: in prepare, Cannot add a UNIQUE column
```

The working form, also verified, including that it allows many NULLs and rejects a duplicate
non-NULL:

```
ALTER TABLE people ADD COLUMN anchor_id TEXT;                              -- ok
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_anchor ON people(anchor_id);  -- ok
INSERT ... ('c','github:x');   -- ok
INSERT ... ('d','github:x');   -- Error: UNIQUE constraint failed: people.anchor_id
```

`schema.sql` is applied with `CREATE TABLE IF NOT EXISTS` and therefore cannot reach an
existing database, which is exactly why `migrateSeenPapers` and `migrateDrafts`
(`db.ts:31-75`) exist. Add `migratePeopleAnchors` beside them, following the same guarded,
idempotent pattern, and run it in one transaction:

1. `ALTER TABLE people ADD COLUMN anchor_id TEXT` if the column is absent.
2. `UPDATE people SET anchor_id = 'openalex:' || openalex_id WHERE openalex_id IS NOT NULL AND anchor_id IS NULL`.
3. `INSERT INTO person_anchors (person_id, anchor_id, kind, evidence_url, asserted_by)`
   selecting those same rows, with `evidence_url = 'https://openalex.org/' || openalex_id`
   and `asserted_by = 'backfill'`.
4. `CREATE UNIQUE INDEX` **last**, so a duplicate produced by the backfill aborts the
   transaction instead of half-applying.

Expected on the live file: 189 anchors, 234 people, 45 rows left with `anchor_id IS NULL`.

**Dedup for a non-academic person.** `upsertPerson` gains `anchors?: ResolvedAnchor[]` and
resolves the row id in this order:

1. `SELECT DISTINCT person_id FROM person_anchors WHERE anchor_id IN (...)`.
2. Exactly one result: that is the person. Insert any anchors not already present.
3. Zero results: fall back to the existing `openalex_id` lookup (compatibility during the
   backfill window), else insert a new row. Its `anchor_id` is the first anchor in
   preference order `openalex > orcid > github > site > linkedin > manual`, chosen so an
   academic later found through GitHub still keys on OpenAlex.
4. More than one result: **do not merge.** Return the conflict to the caller, which surfaces
   it as `anchor_conflict`.

`openalexId` keeps being written whenever an `openalex` anchor is present, so
`test/db.test.ts` (12 call sites), `test/persist.test.ts:35`, `test/intersect.test.ts` (24
call sites), and `test/orchestrate.test.ts:82-83` all keep passing byte-for-byte.

**When the same human is later found via two different sources.** Three cases, and only the
first is automatic:

- **Overlapping anchors** (candidate states `github:dittygoops`, row 240 already holds it):
  same person, new anchors added. Automatic and safe, because the shared anchor *is* the
  evidence.
- **Disjoint anchors, no existing rows** (candidate states only `site:example.dev`, the human
  already exists as row 240 under `github:dittygoops` with no link between them): the system
  creates a **second row**. It does not detect the duplicate, and it must not, because the
  only available signal would be name plus affiliation, which is exactly what AR1 forbids.
- **Disjoint anchors, both already known** (`github:dittygoops` on row 240,
  `site:example.dev` on row 251, one candidate states both): `anchor_conflict`. Terminal, no
  merge, no draft, logged to `draft_events` with `draft_id NULL` and `type =
  'anchor_conflict'` (that table already permits a null draft id, `schema.sql:104-110`).

A human merge command is the correct remedy and is out of scope. The ordering of harms is
deliberate: **a duplicate person row risks a duplicate email; an auto-merge risks attributing
one human's facts to another and mailing the wrong person. The second is worse, so the design
accepts the first.**

**One consequence must be paid for here, not deferred.** `priorThreads`
(`src/approval/ledger.ts:310-320`) keys on `person_id` alone, so two rows for one human defeat
the never-email-twice guard. Add a companion:

```ts
export function priorThreadsByAddress(db: DB, toEmail: string, excludeDraftId?: number): PriorThread[]
```

querying the identical status set against `drafts.to_email`, and call it in `loop.ts`
immediately after the existing person-level check at `:387-392` (and in `cli.ts:376`). This is
additive only: it can refuse a send that would otherwise proceed, never permit one that would
otherwise be refused. It does not close the gap where the same human is reachable at two
different addresses.

### Change 5: reaching an anchor-resolved person

The address hunt for a non-`openalex`-anchored person is **strictly narrower** than today's,
which is the concrete answer to "how does loosening identity not make wrong-person sends more
likely".

For a person whose primary anchor kind is not `openalex`:

1. **Structured first.** Read the address off the anchor record itself when it exists:
   GitHub's `email` field, ORCID's public email. This is an assertion by the person, and it is
   the strongest address evidence the system can obtain. (Measured cost of the owner's case:
   `email: null`, so it yields nothing for him.)
2. **Anchor-bound documents only.** A page may contribute an address only if
   `anchorAdmitsUrl(anchor.url, page.url)` is true for one of the person's bound anchors.
   This reuses the shipped function, unchanged.
3. **The name-plus-affiliation search query is forbidden on this path.**
   `extractContact`'s pass-1 query is `"${person.name}" ${affiliation} email`
   (`contacts.ts:271-274`). That query shape is a name-similarity search over the open web and
   is the mechanism behind the `email_source = 'directory'` wrong addresses, because
   `classifyWebPage` assigns `'directory'` precisely when the name is **not** in the page URL
   or title, yet `SOURCE_CONFIDENCE.directory = 0.75` clears the 0.7 threshold anyway.
   Implementation: the anchored Reacher passes only anchor-derived queries and drops any page
   failing step 2, rather than editing `contacts.ts`, which stays untouched and keeps all six
   of its test suites green.
4. **`nameMatches` still applies**, because it lives inside `scoreCandidate`
   (`contacts.ts:37-43`). So the new path is `nameMatches` **and** anchor binding **and**
   structured-first, which is strictly stronger than the existing path at every step.

Honest limit: step 2 would not have blocked `xuhuaping@buaa.edu.cn`, because `buaa.edu.cn`
genuinely is Ziheng Xu's institution. Only a stricter local-part rule catches that one, and
that rule is the deferred `nameMatches` spec. What step 2 does is prevent the **new**
population from ever reaching the weak path at all, so general outreach does not multiply an
open defect across a larger and less structured population.

### Change 6: browser automation, and where it is not needed

The owner has accepted account-ban risk on alt accounts, so that is settled and not
re-litigated here. The question left is where a logged-in session actually buys something.

**Cheaper path suffices, no browser:**

| need | free structured path | evidence |
| --- | --- | --- |
| GitHub identity + profile | `GET api.github.com/users/{login}` | verified live; returned name, html_url, 48 repos |
| ORCID identity + researcher URLs | ORCID public API | `docs/spec-verified-personal-sources.md` E4 measured 18 of 23 people had an ORCID on their OpenAlex record |
| academic identity | OpenAlex | the status quo |
| personal domain | plain `fetch` | already what `PageFetcher` does |
| company staff directory | plain `fetch` | already what `PageFetcher` does |
| conference program page | plain `fetch` | already what `PageFetcher` does |

**Genuinely needs a logged-in browser:** login-walled social profiles, in practice LinkedIn.
It is simultaneously the richest non-academic anchor (current employer, title, education, all
self-asserted, which is exactly AR1's requirement) and the only one with no free structured
access.

**Where it belongs:** the long tail, never the main path, and this is not a hedge. A browser
agent run is tens of seconds to minutes and dollars-scale per person against milliseconds and
effectively zero for `api.github.com`. It is also non-deterministic: the same profile can
yield different extractions on two runs, which is the property that makes it unsuitable as an
input to an irreversible cold email without a human looking at it. Concretely it may run only:

- for a candidate that has **already passed the hook gate** and has **already failed anchor
  resolution on every free path**, and
- behind an explicit per-run cap and an explicit flag, and
- producing a `manual`-kind anchor that a human confirms, never an automatic `linkedin` anchor.

**The implementation is out of scope for this spec.** This section fixes its placement in the
ordering so a later spec cannot quietly attach it to the main loop.

### Change 7: what stays free

`understand` is on the every-candidate path, so its budget is the whole point of the
2026-08-02 reorder. The rule:

**`understand` MAY:** call OpenAlex, ORCID, and the GitHub REST API (all free, no key);
dereference URLs the artifact already states (`evidence.url`, `evidence.fullTextUrl`,
`statedAnchors[].url`); make the LLM calls it already makes (`summarize`,
`extractPaperFacts`, `computeIntersections`).

**`understand` MUST NOT:** call `SearchClient.search` or `PageFetcher.fetch` (the Tavily
seams); fetch any URL the artifact did not state; invoke a browser agent.

Two consequences to state explicitly:

- **`test/ordering.test.ts` needs no assertion change.** Its paid seams are `search`,
  `fetcher`, and `getPaperText`; a free anchor lookup goes through `fetchFn`, which the test
  already routes. Fixtures may be extended, assertions may not.
- **Anchor lookups are rate-limited and must not be miscounted as no-match.** Measured live
  on 2026-08-03: `x-ratelimit-limit: 60` per hour unauthenticated on `api.github.com`. A
  403 or 429 is a **transport failure that re-throws**, so `processCandidate`'s catch
  (`loop.ts:442-458`) makes it retryable. Only a well-formed 404 may become `unresolved`.
  This is the same rule the hook-first spec established for OpenAlex, and it matters more
  here because `unresolved` is terminal and invisible. Cost control: call GitHub only when
  the artifact already states the login, never speculatively.

## Behavioral changes to acknowledge

- **`people` gains rows that have no `openalex_id` and do have facts.** Today all 45 such
  rows have zero facts and zero drafts, so any query that used `openalex_id IS NOT NULL` as a
  proxy for "real person" silently changes meaning. No such query exists in `src/` today
  (verified: every reader of `openalex_id` is `db.ts`, `persist.ts`, `orchestrate.ts:253`, or
  a test), but `scripts/smoke-persist.ts:33` prints it and will print `null` for anchored
  people.
- **`identity unconfirmed` shrinks and `no email resolved` grows.** Candidates that now
  resolve on an anchor proceed to the hook gate and, if they hook, to reaching, where many
  will fail for want of an address (the owner's own case). Run-over-run comparisons of
  `seen_papers.reason` cross this boundary.
- **A new terminal reason appears: `anchor_conflict`.** It joins `identity unconfirmed` in
  the bucket `strandedReport` does not print, which is a known and separately-specced gap.
  Because it is a genuine data-quality signal rather than a routine miss, it is also written
  to `draft_events`, which **is** durable and queryable, so it is not lost.
- **One human may occupy two `people` rows.** Deliberate (Change 4). The
  `priorThreadsByAddress` companion covers the same-address case; the different-address case
  can produce two emails to one human. Accepted, and strictly preferred to auto-merging.
- **`detectIdentityCollision` becomes vacuous, not weakened, for anchored people.** It counts
  `academic/collaborator` and `trajectory/institution` facts (`research.ts:186-204`), all of
  which come from `factsFromOpenAlex`. A GitHub-anchored person has none, so it returns
  `suspected: false` for the trivial reason that there is nothing to count. The replacement
  is anchor uniqueness (AR5), which is a **weaker** guarantee: it catches "two anchors, two
  rows", not "one anchor, two humans". A shared GitHub organisation account, for example, is
  one anchor and not one human, and nothing here detects that. Named so it is not
  rediscovered as a surprise.
- **`outreach add` gains a manual anchor form.** `cli.ts:278` today takes an arXiv id. It
  should also accept `github:<login>`, `orcid:<id>`, or a bare URL, producing a `manual` or
  sourced anchor with `asserted_by = 'operator'`. Its `alwaysExtractContact` exemption and
  its draft predicate (`cli.ts:303`) are unchanged.
- **Nothing on the OpenAlex path changes observably.** `createOpenAlexUnderstander` wraps
  today's `orchestrate.ts:171-246` verbatim, including the three re-throw rules (transport
  failure, `SelfOntologyMissingError`, and the collision path's `clearIntersections`).

### Safety gates that are not touched

None of these is weakened, reordered, or made optional. Restated because the whole spec is a
loosening and the loosening must be bounded.

| invariant | where it lives |
| --- | --- |
| Human approval before any send | `loop.ts` `performApprovedSend` / `loadApprovedSend` |
| At-most-once send claim, committed pre-network | `drafts.send_attempted_at` |
| Frozen recipient vs mutable `people.email` | `drafts.to_email`, `schema.sql:66` |
| `assertSafeOutbound` | `src/sender/types.ts:42-75`, called at `loop.ts:177`, `gmail.ts:24`, `gmail-api.ts:47` |
| Identity collision gate plus `clearIntersections` | `orchestrate.ts:207-217` |
| Page-identity and anti-fabrication gates | `pageIsAboutPerson`, `buildDomainGate`, `urlSlugMatchesPerson`, `safeClassify`, `anchorAdmitsUrl` |
| Paper-fact injection gate (`occursInSource`) | `research.ts:782-818` |
| Fact-source tier caps | `research.ts:344-351` |
| Prior-thread check | `loop.ts:387-392`, now with an address-level companion |
| Draft grounding check | `loop.ts:419-423` |
| Dry run persists observation, never obligation | `loop.ts:411-415` |
| Hook gate before any paid call | now `passHookGate`, plus `test/ordering.test.ts` |
| Loop gate ORDER (hook before email) | `loop.ts:372-386` |

## Verification

Baseline measured 2026-08-03: **47 files, 529 tests, all passing, 3.43s.** Per the project
rule, demonstrate against reality rather than asserting from artifacts.

1. **The hook gate is a compile error, not a test failure.** Move `enrich` above
   `passHookGate` in the orchestrator and run `npm run typecheck`. It must fail. Restore.
   Then run `test/ordering.test.ts` with the same mutation forced through an `as` cast and
   confirm it goes red too. If either step passes, that mechanism is worthless and the change
   is not done.
2. **Zero paid calls before the gate, on the new path.** Extend `test/ordering.test.ts`'s
   fixtures (not its assertions) with an anchored candidate carrying `statedAnchors:
   [{kind:'github', ...}]` and no hook. Assert: zero `search`, zero `fetcher`, zero
   `getPaperText`. Fresh `:memory:` DB per case, as the hook-first spec requires, since
   `computeIntersections` reads accumulated facts (`intersect.ts:53`).
3. **Live demonstration on the owner, all three scenarios.** A script printing the verdict
   for: (A) `github:dittygoops` sourced from a repo under that login, (B) name plus "Arizona
   State University" with no stated anchor, (C) the LinkedIn slug. Expected output, which is
   the acceptance criterion for the whole spec:
   `A -> understood, anchorId 'github:dittygoops', displayName 'Aditya Gupta', address null`;
   `B -> unresolved`; `C -> unresolved (anchor unreachable without a session)`.
   Run it and paste the actual output. If A does not resolve, the design does not work.
4. **Migration on a copy of the live database.** `cp data/outreach.db /tmp/`, open it twice,
   assert idempotence: `people` count 234 both times, `person_anchors` count 189 both times,
   `anchor_id IS NULL` count 45 both times, `openalex_id` values unchanged. Then assert the
   unique index actually bites by attempting a duplicate insert and expecting
   `SQLITE_CONSTRAINT`.
5. **Anchor conflict is refused, not merged.** Two person rows with different anchors, one
   candidate stating both. Assert verdict `anchor_conflict`, assert `SELECT count(*) FROM
   people` is unchanged, assert no draft, assert a `draft_events` row with `draft_id IS NULL`
   and `type = 'anchor_conflict'`.
6. **Never-email-twice across split rows.** Two person rows, same address, one with a sent
   draft. Assert the second is refused by `priorThreadsByAddress`. Mutate the call out,
   confirm the test goes red, restore.
7. **Whole suite, zero edits to existing assertions.** 529 tests must stay green with only
   deliberately added tests changing the count. Any phase requiring an edit to an existing
   assertion has changed behavior and stops for review.
8. **Live cost check.** `GET https://api.tavily.com/usage` before and after one real cycle.
   Credits consumed must match the post-hook-first steady state. A jump means an anchor
   lookup leaked onto a paid seam.

## Risks

- **This unlocks the population the address matcher is worst at.** Non-academic candidates
  have no PDF header and often no institutional address, so tier 1 disappears and everything
  routes through the web tier, where the measured `nameMatches` surname defect lives (34 of
  180 stored addresses, at least 6 wrong-person sends in the 41-draft batch of
  2026-08-04 01:35-01:41 UTC). Change 5 keeps the *new* path off that mechanism, but the
  overall exposure of the unfixed defect rises with candidate volume. **If only one follow-up
  spec is written, it should be the `nameMatches` one, not this one's phase two.**
- **Anchor uniqueness is a weaker guarantee than the collision detector it replaces on the
  new path.** It cannot distinguish one anchor held by two humans (a shared organisation
  account, a role-based profile, a lab GitHub) from one anchor held by one human. There is no
  cheap detector for that and this spec does not propose a fake one.
- **`unresolved` remains terminal and invisible.** 78 rows already sit there and
  `strandedReport` does not print them. This spec adds a second reason to the same invisible
  bucket. Making it visible is a real gap, filed separately, and it is a genuine argument for
  doing that spec first.
- **Duplicate person rows are a real, accepted defect**, not a theoretical one. The owner
  will eventually see two rows for one human and the system will not explain why. The
  `asserted_by` and `evidence_url` columns exist so that a human merge tool can be written
  against real provenance rather than guesswork.
- **B3 is the loosest rule here and the one most likely to be wrong.** "The artifact page
  links to A.url" is a weaker claim than "the artifact is hosted under A". The one-hop
  restriction and the requirement that the linking page already be anchor-bound are what keep
  it from degenerating into search-adjacency, but it is the rule to attack in review, and the
  conservative fallback (drop B3, accept lower recall) is cheap.
- **LinkedIn, the highest-value non-academic anchor, is not solved by this spec.** Stated
  plainly rather than buried: the design names where it fits and refuses to pretend the free
  path reaches it.
- **A refactor that touches the gates is exactly the refactor this project's history says
  goes wrong.** Nine specs came back NEEDS REVISION, and the recurring cause was a claim
  about the code that evaporated on inspection. Mitigation: verification steps 1, 3, 4, and 8
  exercise real compilation, real APIs, the real database file, and real billing, not the
  test suite.

## Out of scope

Each of these is a separate spec with its own problem/solution pair. None may be folded in.

- **Tightening `nameMatches` against bare-surname matches.** The evidence is handed over
  here: 180 stored addresses, 71 passing without the first name, 34 passing on a
  non-segment-aligned surname, the eight-row table above, and the 41-draft send batch of
  2026-08-04. That spec must also decide what to do about the already-sent wrong-person
  emails, which this one deliberately does not touch.
- **Any `Source` implementation** (LinkedIn, corporate lead lists, conference programs,
  GitHub sourcing) and the `seen_papers` / `drafts` schema migration it requires.
- **The `Source` and `Reacher` interfaces themselves.** Still deferred, still for the reason
  `src/pipeline/intake.ts` records.
- **A second Reacher** (Hunter, Apollo, pattern-plus-verify, manual CSV) or any contact
  provider swap away from Tavily.
- **Implementing the browser agent.** Change 6 fixes where it may run, not how it works.
- **A human merge command for duplicate person rows**, and any automatic merge.
- **Making `identity unconfirmed` and `anchor_conflict` visible or retryable in `outreach
  stranded`.**
- **A metrics dashboard** of any kind.
- **Any change to drafting, approval, sending, the reply listener, or the persona
  subsystem.**
