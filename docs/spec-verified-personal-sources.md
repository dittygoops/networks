# Technical Spec: Verified Personal Sources for the Interest Facet

> Amends the D5b domain gate defined in
> [`docs/spec-profile-mining.md`](./spec-profile-mining.md) (Resolved Decisions D5, D5b, D3,
> D6a). Touches `outreach/src/pipeline/research.ts`, `outreach/src/openalex/client.ts`, and
> `outreach/src/pipeline/orchestrate.ts`. Does not change draft generation
> ([`docs/spec-draft.md`](./spec-draft.md)) or the approval loop.
>
> **Problem/solution pair:** the `interest` facet is structurally unreachable because the
> D5b gate is keyed on institution domains only. Solution: admit a personal URL only when an
> authoritative record links that exact URL to that exact person.

## Recommendation: DO NOT BUILD THIS YET

Stated up front so it is not buried. Every number below was measured against the live
production database (`outreach/data/outreach.db`, 24 people, 23 with an OpenAlex id) and
against the live OpenAlex and ORCID APIs on 2026-07-27.

Three findings, in order of how decisive they are:

1. **The yield is 3 people out of 23 (13%).** Verified personal URLs exist for 5 of 23 mined
   researchers, and 2 of those 5 point back at institutional pages the gate already admits.
   Only 3 people gain a genuinely new personal domain.
2. **Academic personal sites do not contain hobby facts.** All three of those new personal
   sites were fetched and read. They are professional CVs. The only word resembling a
   personal interest was "interests", meaning research interests, and "travel", meaning a
   conference travel award. The single `interest` fact that exists anywhere in the database
   (Karate, third-degree black belt) came from a UCLA lab page, which is an institutional
   domain the current gate **already allows**. The facet is not empty because of the gate.
   It is empty because the fact class barely exists on the reachable academic web.
3. **If hobby facts did arrive, they would make hook quality worse, not better, and the
   genericness filter would not stop them.** This is the analysis in VP9 and it is the real
   reason to hold. `isGenericEntity` catches broad fields, commodity tools, and geography.
   It does not contain "chess", "running", "guitar", or any of the nine hobbies in the self
   ontology. An exact hobby match scores 0.95 in `entityMatches`, and `rankHook` sorts by
   strength before tier, so "we both run" would be ranked **above** the genuine 0.95 tier-B
   research overlap already in the database. Adding this feature would actively demote the
   hooks the user actually wants.

What should be built instead is recorded in VP12.

If the user overrides this recommendation, VP1 through VP11 are the design, and VP10 is the
smallest slice worth shipping (the OpenAlex/ORCID fix without the hobby-hook consequences).

## Overview

The recipient ontology has 3,502 facts across 24 people: academic 2,715, trajectory 786,
interest 1. The self ontology has 13 interest facts (9 hobby, 3 side_project, 1 writing).
The asymmetry is total: the user's own personal side is fully populated, and every
recipient's is empty, so no personal hook can ever be generated no matter how good the
intersection engine gets.

This spec establishes exactly why, measures whether verified-identity sources can fix it,
and specifies the gate change if the user chooses to proceed.

## Measured Evidence

All numbers reproduced from `outreach/data/outreach.db` and live API calls.

### E1. Facet distribution (24 people)

| Facet | Rows | Distinct values |
|---|---|---|
| academic | 2,715 | 2,577 |
| trajectory | 786 | 641 |
| interest | 1 | 1 |

The lone interest fact: `hobby / Karate / "Practiced martial arts for 14 years and holds a
third-degree black belt in Karate"`, sourced from
`https://chianglab.healthsciences.ucla.edu/people/aravinth-ruppa`, tier B, confidence 0.8.
That is a `ucla.edu` domain. The current gate admitted it. No gate change was needed to get
it.

### E2. Web-page throughput through the current gate

Of 3,502 person facts, 3,408 came from OpenAlex and 12 from arXiv paper extraction. Only 82
facts, spread over 8 distinct URLs and **7 of 24 people**, came from a fetched web page.
Every one of those 8 URLs is an institutional domain. Zero personal sites, zero GitHub.

### E3. Identity-anchor coverage

21 of 23 people have at least one institution with a `homepage_url` in OpenAlex, so the
gate's allow-list is usually non-empty. The bottleneck is not anchor availability.

### E4. ORCID coverage (live measurement, all 23 people with OpenAlex ids)

| Measure | Count | Share |
|---|---|---|
| Has an ORCID on the OpenAlex author record | 18 / 23 | 78% |
| ORCID record exposes ≥ 1 `researcher-url` | 5 / 23 | 22% |
| ORCID exposes ≥ 1 **new personal** URL (not institutional, not an aggregator) | 3 / 23 | 13% |

The five people with researcher-urls, verbatim:

| Person | ORCID researcher-urls | New personal domain? |
|---|---|---|
| Livia Qian | `kth.se/profile/liviaq`, Google Scholar | No (KTH already admitted, Scholar is an aggregator) |
| Zhuo Li | `yanzhao.bjut.edu.cn/...` | No (institutional) |
| Weikai Li | `weikai-li.github.io`, Scholar, LinkedIn | Yes (1) |
| Yuejiang Liu | `sites.google.com/view/yuejiangliu`, Scholar, `github.com/YuejiangLIU` | Yes (2) |
| Mengqi Xue | `github.com/xmq1221`, `xmq1221.github.io` | Yes (2) |

### E5. What is actually on those personal pages

All three new personal sites were fetched and scanned for personal-interest vocabulary.

| URL | Text length | Personal-interest hits | Outlinks |
|---|---|---|---|
| `weikai-li.github.io` | 6.3 KB | "interests" (research interests), "travel" (travel award) | github.com, linkedin.com |
| `sites.google.com/view/yuejiangliu` | 0.3 KB | none (it is a redirect stub) | github.com, x.com |
| `xmq1221.github.io` | 4.1 KB | "interests" (research interests) | github.com |
| `chianglab.healthsciences.ucla.edu/...` (institutional, already admitted) | 1.1 KB | **karate, martial arts** | linkedin.com, twitter.com |

The only page carrying a real hobby is the institutional one. This is the finding that
decides the recommendation.

### E6. The current gate already leaks homonyms

`buildDomainGate` in `research.ts:424` matches on `parse(url).domainWithoutSuffix`, the
registrable domain **minus** its public suffix. Two production consequences, both verified:

- `english.qdio.cas.cn` and `english.ie.cas.cn` and `www.cas.cn` all reduce to the label
  `cas`. Person "Hanbo Bi" is an Aerospace Information Research Institute remote-sensing/CV
  researcher; the gate admitted `english.qdio.cas.cn` (Institute of Oceanology) and injected
  17 facts about Arctic sea ice variability. The stored profile summary now blends two
  different people. The label test cannot distinguish sibling institutes of one academy.
- `www.balliol.ox.ac.uk` and `www.maths.ox.ac.uk` both reduce to `ox`. Person "Robin
  Karlsson" was resolved to a merged OpenAlex identity spanning 8 institutions including
  Oxford, so a theoretical-physics Robin Karlsson at Balliol contributed 23 facts (AdS/CFT,
  conformal bootstrap, black holes) to a person whose paper is in a different field.

So "the gate protects us from homonyms" is only partly true today. Any change here must
improve that, not just preserve it.

### E7. Label matching is unusable for personal domains

Verified with `tldts`, the library already in use:

| URL | `domainWithoutSuffix` |
|---|---|
| `https://weikai-li.github.io` | `github` |
| `https://github.com/YuejiangLIU` | `github` |
| `https://sites.google.com/view/yuejiangliu` | `google` |

Adding a personal URL to the existing label-keyed allow-list would admit **all of
github.com, all of github.io, and all of google.com**. Any design that reuses `domainLabel`
for personal URLs is a catastrophic widening disguised as a one-line change. VP4 forbids it
explicitly.

## Root Cause

Precise, with the code paths verified by reading:

1. `minePersonalFacts` (`research.ts:504`) searches Tavily for
   `"<name> <affiliation> homepage"` and `"<name>" blog OR talk`, fetches up to 3 pages, and
   then filters every page through `gate(page)` at `research.ts:543`.
2. `buildDomainGate` (`research.ts:424`) builds its allow-list exclusively from
   `author.homepageUrls`.
3. `author.homepageUrls` is assigned in exactly one place, `orchestrate.ts:105`, from
   `fetchIdentityAnchors`.
4. `fetchIdentityAnchors` (`openalex/client.ts:87`) walks `author.affiliations`, takes each
   `institution.id`, caps at the **first 4 institutions**, and fetches
   `GET /institutions/<id>`, keeping only `homepage_url`. It never touches the author record's
   own fields.
5. Therefore the allow-list is a set of institution-domain labels, and every page not on an
   institution domain is dropped before `extractFactsFromPage` is ever called. A personal
   site, a personal blog, and github.com are all unreachable by construction.

Two secondary defects found while tracing this:

- **The 4-institution cap is arbitrary on merged identities.** Wenwen Zhang has 137
  institutions, Yitong Zhu 165, Zhuo Li 128. Taking the first 4 produces an allow-list that
  has no principled relationship to where the person actually works, which is how E6's leaks
  happen.
- **The OpenAlex author record has no `homepage_url` field at all.** Verified against the
  live API: the author payload's top-level keys are `affiliations, block_key, cited_by_count,
  counts_by_year, created_date, display_name, display_name_alternatives, full_name, id, ids,
  last_known_institutions, orcid, raw_author_names, summary_stats, topic_share, topics,
  updated_date, works_api_url, works_count, x_concepts`. There is no homepage. `ids` contains
  only `{openalex, orcid}`. So the hypothesis that `fetchIdentityAnchors` merely forgot to
  read an author homepage is **false**. The only author-level identity link OpenAlex offers
  is the ORCID, and the URLs live one hop further, inside the ORCID record.

## Resolved Decisions

### VP1. What counts as a verified personal source

A URL is a **verified personal source** for person P only if an authoritative record that is
already bound to P names that URL. Exactly three admissible provenances, in descending
strength:

| Provenance | Binding evidence | Availability |
|---|---|---|
| `orcid_researcher_url` | OpenAlex author record carries `orcid`; the ORCID record's `researcher-urls` names the URL. ORCID is self-asserted but identity-verified and person-scoped. | 22% of people have any; 13% have a new personal one (E4) |
| `institution_outlink` | A page already admitted by the institutional gate, on the person's own profile path, contains an anchor to the URL. The institution vouches for the link. | Present on 3 of the 4 sampled admitted pages (E5), but see VP7 |
| `openalex_author_id` | Not available. The author record has no homepage field (root cause item 5). Listed only so it is not re-investigated. | 0% |

No other provenance is admissible. In particular, search-result adjacency is not evidence,
and a name appearing on a page is not evidence.

### VP2. ORCID as the primary verified source

`fetchIdentityAnchors` is extended, not replaced.

- Read `author.orcid` (or `author.ids.orcid`) off the OpenAlex author record already in hand.
  No extra OpenAlex call.
- If present, `GET https://pub.orcid.org/v3.0/<orcid>/researcher-urls` with
  `Accept: application/json`. Public API, no key, no auth. One request per person.
- Each returned `researcher-url[].url.value` becomes a **verified personal anchor**, kept
  separately from the institutional anchors, never merged into the same set (VP4).
- Failure of the ORCID call is non-fatal and yields zero personal anchors, matching the
  existing per-institution `catch` behavior in `fetchIdentityAnchors`.

### VP3. Aggregator and social exclusion for personal anchors

An ORCID researcher-url is discarded before it becomes an anchor when its host is on the
aggregator list already used by contact extraction (`scholar.google.com`, `researchgate.net`,
`academia.edu`, `dl.acm.org`, and similar) or the `SOCIAL_HOSTS` list in `research.ts:340`.
Measured effect: this removes the Google Scholar entry from 4 of the 5 people in E4 and the
LinkedIn entry from Weikai Li, without removing any page that carries extractable facts.

### VP4. The gate becomes two rules, not one wider rule

This is the requirement most at risk of being misread. **The institutional gate is not
loosened. Nothing about "allow any domain" is being proposed.** `buildDomainGate` returns a
predicate that is the OR of two independently-scoped rules:

```
admit(page) =
     institutionalRule(page)      // UNCHANGED semantics, see VP5 for a tightening
  || verifiedPersonalRule(page)   // NEW
```

- `institutionalRule` is today's label test over institution homepage anchors.
- `verifiedPersonalRule(page)` is **exact-origin-plus-path-prefix** matching against the
  verified personal anchor set. `https://github.com/xmq1221` admits
  `https://github.com/xmq1221` and `https://github.com/xmq1221/some-repo`. It does **not**
  admit `https://github.com/anyone-else`, and it does not admit `github.com` as a domain.
  `https://weikai-li.github.io` admits only that origin, not `github.io`.
- `domainLabel` must never be applied to a personal anchor. E7 shows this collapses
  `github.io`, `github.com`, and `google.com` to admit-everything labels. A lint-level
  comment plus test T6 enforces this.

The homonym guard therefore survives intact: a same-named stranger's GitHub profile is at a
different path than the ORCID-declared one, so the exact-prefix rule rejects it. The guard
is in fact stronger than today's, because the personal rule is exact where the institutional
rule is fuzzy.

### VP5. Tightening the institutional rule at the same time

E6 shows two live leaks caused by label matching plus the arbitrary 4-institution cap. Ship
these with VP2 or the net effect on fabrication risk is negative:

- Match institutional anchors on the **full registrable domain** (`parse(url).domain`, e.g.
  `ox.ac.uk`), plus an explicit subdomain-label check that the page's host is a subdomain of
  an anchor host, rather than on the suffix-stripped label. This alone does not fix the
  `ox.ac.uk` leak, so:
- Restrict the institutional anchor set to institutions from the person's **most recent 3
  affiliation years** rather than the first 4 in list order. On merged identities this
  shrinks a 137-institution allow-list to the handful the person is plausibly at now.
- When `detectIdentityCollision` (`research.ts:170`) reports `suspected: true`, mine **no**
  web pages at all. The profile is already known to be two or more people; every fact
  attributed from a web page under that identity is a coin flip. This is the change that
  would have prevented both E6 leaks.

### VP6. Trust, tier, and confidence for personal-source facts

- Source class for a verified personal page is `homepage` if it is the person's own site,
  `github_profile` for a `github.com/<user>` page, `blog` under a `/blog|/posts|/writing|
  /notes/` path. `pageSourceClass` (`research.ts:357`) already does this and needs no change.
- The D3 tier caps in `TIER_CAP` are **not** raised. `homepage` and `github_profile` remain
  capped at A, which is correct only because VP1 makes the identity binding authoritative.
- Facts from a personal source additionally carry `provenance = 'verified_personal'` in the
  fact row so downstream code can reason about them. This requires an `ontology_facts`
  column, nullable, defaulting NULL for every existing row.
- **A `verified_personal` fact may never be the sole basis for an email.** Concretely: if
  every hook for a person traces to a `verified_personal` source, the draft is treated the
  same way `draft.ts:89` already treats all-paper-derived hooks, that is, it is flagged and
  the body must additionally cite something from the person's published work. Rationale: the
  gate is only as good as ORCID's self-assertion, and a cold email whose entire premise is
  "I saw on your GitHub that you like X" is both the highest-fabrication-risk and the
  lowest-value opening in the system.

### VP7. Institution outlinks are specified but deferred

`institution_outlink` (VP1) is real and available: 3 of the 4 sampled institution pages carry
a github.com or linkedin.com anchor (E5). It is deferred out of the first slice because:

- The admitted page is often a lab or department page listing many people, so an anchor on it
  is not necessarily bound to the target person. Binding requires that the anchor sit inside
  the person's own profile block, which needs DOM-level extraction that the current pipeline
  does not do (Tavily `extract` returns flattened text, and `WebPage.content` in
  `contacts.ts` is text, not HTML).
- It costs an extra fetch per outlink, against a hard budget of 3 fetches per person
  (`D4_MAX_FETCH`, `research.ts:345`).

If it is built later, the binding rule is: the anchor must appear on a page whose
`classifyWebPage` result is `homepage` (not `directory`), and the anchor's link text or
surrounding 100 characters must satisfy the D2 name-match against the target. A `directory`
page never vouches.

### VP8. Budget

No change to the per-person budget. VP2 adds exactly one HTTP request per person that has an
ORCID (18 of 23), to a free unauthenticated API. Fetch and LLM-extraction counts stay at
`D4_MAX_FETCH = 3` and `D4_MAX_EXTRACT_PAGES = 3`. A verified personal page competes for the
same 3 fetch slots as institutional pages, and is ranked ahead of them because its identity
binding is stronger.

### VP9. Interaction with hook quality (the decisive analysis)

The question is whether `isGenericEntity` (`intersect.ts:150`) would filter incoming hobby
facts anyway, making the whole effort pointless. The answer is worse than "yes". It is "no,
and that is the problem."

**Step 1: the filter does not catch hobbies.** `GENERIC_ENTITIES` (`intersect.ts:130`)
contains broad fields, commodity tools, and geography. The self ontology's nine hobbies are
Chess, Drums, Flute, Football, Guitar, Latin, Running, Singing, Weightlifting. None is in the
list. `isGenericEntity` matches the whole normalized entity, so none would be filtered.

**Step 2: hobby matches score at the top of the scale.** `entityMatches`
(`intersect.ts:161`) is facet-blind. A recipient fact `hobby / Running` against the self fact
`hobby / Running` normalizes to an exact string match and scores **0.95**, the maximum the
deterministic path can emit. It requires no LLM judgment and cannot be argued down.

**Step 3: that outranks the genuine research hooks.** `rankHook` (`intersect.ts:210`) sorts
by strength first and uses tier only as a tie-break. The strongest real hook in the
production database is `hierarchical mixture of experts` at 0.95, **tier B** (paper-derived,
capped by `PAPER_TIER_CAP`). A hobby fact from a verified personal homepage caps at **tier
A** (VP6). Same strength, better tier, so the hobby wins the tie-break and becomes the
opening hook. The system would surface "we both run" ahead of "we both work on hierarchical
mixture of experts."

**Step 4: this is exactly the failure the user already rejected.** The rejected draft opened
with "I used Claude in my Content Farm project", rejected as "everyone does it." That failure
mode was fixed by adding `anthropic claude` to `GENERIC_ENTITIES`. Hobbies are the same
failure mode in a form the filter cannot see: high-frequency, low-information, shared by
millions. Running is more generic than Claude, not less.

**Step 5: patching the filter does not rescue the feature.** Suppose `GENERIC_ENTITIES` is
extended with running, chess, guitar, and so on. Then the surviving hobby matches are the
rare ones, and the pool was already 1 fact across 24 people (E1). The feature's entire
remaining value is the rare-hobby case, at a measured base rate near zero, in exchange for a
new class of fabrication risk.

**Conclusion.** The genericness filter would not neutralize the benefit. It would fail to
catch the harm. Any build of this feature must be preceded by the ranking work in VP12, or it
ships a regression.

### VP10. Smallest slice worth shipping, if the user overrides

Ship VP5 and only VP5. It requires no new data source, closes two verified live
contaminations (E6), and reduces fabrication risk immediately. It also makes the
institutional gate honest enough that VP2 could be layered on later without compounding an
existing leak.

Do not ship VP2 through VP4 until VP12 is done.

### VP11. Rollback

The personal rule is behind a single boolean in `MineDeps` (default off). Turning it off
restores the current behavior exactly, because the institutional rule is untouched by VP2
through VP4. VP5's tightening is not behind a flag; it is a bug fix.

### VP12. What to build instead

Ranked by expected effect on hook quality, which is the actual problem:

1. **Facet-aware hook scoring.** `entityMatches` should not award 0.95 to any exact match
   regardless of what matched. An academic entity match and a hobby match are not the same
   evidence about whether two people should talk. A facet weight applied before ranking would
   have prevented the Step 3 regression and improves today's rankings independently of this
   spec.
2. **Specificity scoring rather than a blocklist.** `GENERIC_ENTITIES` is a hand-maintained
   list of 30 strings. It caught "Anthropic Claude" only after a human rejected a draft that
   used it. A corpus-frequency or token-rarity score generalizes; a blocklist requires a bad
   draft per entry.
3. **Fix the 17 out of 24 people who get zero web facts at all** (E2). The academic facet
   dwarfs everything else in volume but is thin per person outside OpenAlex. That is a larger
   quality lever than the interest facet will ever be.

## Data Model

One additive change, applied only if VP2 ships.

```sql
ALTER TABLE ontology_facts ADD COLUMN provenance TEXT;
-- NULL for every existing row. 'verified_personal' for facts from a VP1 source.
-- Read by draft.ts for the VP6 sole-basis rule. No index needed at current volume.
```

## Interfaces

Illustrative only, not implementation.

```ts
// openalex/client.ts
export interface IdentityAnchors {
  institutional: string[];   // institution homepage URLs, as today
  personal: string[];        // VP1-verified personal URLs, exact-match only
}
export function fetchIdentityAnchors(
  author: OpenAlexAuthorRaw,
  opts?: { fetchFn?: FetchFn; maxInstitutions?: number },
): Promise<IdentityAnchors>;

// research.ts
// Returns a predicate that is institutionalRule(page) || verifiedPersonalRule(page).
// verifiedPersonalRule NEVER uses domainLabel (VP4, see E7).
function buildDomainGate(author: OpenAlexCandidate): (page: WebPage) => boolean;
```

`OpenAlexCandidate.homepageUrls` is replaced by the two-field `IdentityAnchors` shape.
`persist.ts:17` currently reads `homepageUrls?.[0]` for the `people.homepage_url` column and
must be updated to prefer a personal anchor, falling back to an institutional one.

## Test Requirements

Numbered so implementation and tests trace to them. All are unit tests with injected fetch
and search; none hit the network.

**T1.** `fetchIdentityAnchors` returns `personal: []` and today's institutional list when the
author record has no `orcid` field. Traces to VP2.

**T2.** With an `orcid` present, exactly one request is made to
`https://pub.orcid.org/v3.0/<id>/researcher-urls`, and each returned `url.value` appears in
`personal`. Traces to VP2.

**T3.** An ORCID call that throws, returns non-JSON, or returns HTTP 404 yields
`personal: []` and leaves `institutional` fully populated. No exception escapes. Traces to
VP2.

**T4.** Aggregator and social researcher-urls are dropped: given
`[scholar.google.com/citations?user=X, linkedin.com/in/y, https://y.github.io]`, only the
last survives into `personal`. Traces to VP3.

**T5 (personal admit).** With `personal: ['https://github.com/xmq1221']`, the gate admits
`https://github.com/xmq1221` and `https://github.com/xmq1221/paper-code`. Traces to VP4.

**T6 (homonym rejection, the load-bearing test).** With
`personal: ['https://github.com/xmq1221']`, the gate **rejects** every one of:
`https://github.com/someone-else`, `https://github.com`, `https://xmq1221.github.io`
(different origin, not declared), `https://sites.google.com/view/other-person`. This is the
test that proves VP4's exact-origin rule did not degrade into label matching. It must fail
if anyone reintroduces `domainLabel` on the personal path. Traces to VP4, E7.

**T7 (institutional rule unchanged).** With the personal set empty, the gate's admit/reject
decisions are byte-identical to the pre-change implementation over a fixture of 20 URLs.
Traces to VP4.

**T8 (sibling-institute rejection).** With institutional anchors `['https://english.ie.cas.cn']`,
the gate rejects `http://english.qdio.cas.cn/people2016/...`. This is E6's live Hanbo Bi
contamination expressed as a test, and it fails against the current code. Traces to VP5.

**T9 (collision suppression).** When `detectIdentityCollision` returns `suspected: true`,
`minePersonalFacts` performs zero searches, zero fetches, and zero LLM calls, and
`minePerson` still returns the full OpenAlex fact set. Traces to VP5.

**T10 (recency-bounded anchors).** For an author with 137 affiliations spanning 2005 to 2026,
the institutional anchor set contains only institutions whose `years` include one of the
three most recent affiliation years. Traces to VP5.

**T11 (tier and provenance).** A fact extracted from a verified `github_profile` page is
stored with `tier: 'A'` and `provenance: 'verified_personal'`; a fact from an institutional
page is stored with `provenance: null`. Traces to VP6.

**T12 (sole-basis refusal).** Given a hook set in which every hook's person fact has
`provenance = 'verified_personal'`, `draft.ts` sets the same unsendable-without-grounding
condition it sets for all-paper-derived hooks. Given a mixed set, it does not. Traces to VP6.

**T13 (ranking regression guard).** Given a self fact `interest/hobby/Running` (tier B) and a
person fact `interest/hobby/Running` (tier A) alongside a self fact
`academic/method/hierarchical mixture of experts` (tier B) and a matching person fact (tier
B), the top-ranked hook must **not** be the hobby. This test fails against the current
`rankHook` and is the acceptance criterion for VP12 item 1. It gates VP2 through VP4 shipping
at all. Traces to VP9.

**T14 (flag off).** With the personal-source flag off, T7's fixture plus a full ORCID fixture
produces zero personal anchors and zero extra HTTP requests. Traces to VP11.

## Do Not Do This

Recorded so it is not re-proposed. Each entry was tried or analyzed and rejected on measured
evidence.

### DN1. Matching GitHub profiles by username against the person's name

**Implemented, measured, reverted.** The approach reused `nameMatches` (D2) against a GitHub
username. Measurements:

- `nameMatches('dittygoops', 'Aditya Gupta')` is **false**. That is the user's own real
  GitHub username. Usernames are frequently pseudonymous, so recall is poor.
- `nameMatches('guptaa', 'Anika Gupta')` is **true**. A different person sharing a surname
  passes, so precision is poor.

Weak precision and weak recall, feeding irreversible cold emails, is a bad trade in both
directions. A wrong hobby in a sent email is fabrication that cannot be retracted. The
comment at `research.ts:513` records this; do not delete it.

Corollary: the `"${name}" github` search query was removed from `minePersonalFacts` because
its results were unconditionally discarded by the gate. Re-adding the query is only justified
alongside VP1-grade verification, never alongside a name heuristic.

### DN2. Widening the gate to allow "personal-looking" domains

Admitting `github.io`, `github.com`, `sites.google.com`, or any host pattern as a class. E7
shows `domainWithoutSuffix` collapses all three to `github`, `github`, and `google`, so this
is indistinguishable from disabling the gate for the largest hosting platforms on the web.
The gate must bind to a URL, never to a host class.

### DN3. Trusting search-result adjacency

Treating a page as the person's because it ranked highly for `"<name>" homepage`. This is the
pre-D5b behavior the gate was introduced to stop. Search rank is a relevance signal, not an
identity signal.

### DN4. Extending `GENERIC_ENTITIES` as the fix for hobby-hook quality

Analyzed in VP9 Step 5. It converts the feature's value into the rare-hobby case, whose
measured base rate is 1 fact across 24 people, while leaving the ranking regression (VP9
Step 3) unaddressed. The blocklist is a symptom-level tool; VP12 item 2 is the fix.

## Open Questions

1. **Is the user's actual goal personal hooks, or better hooks?** The evidence says the
   rejected draft failed on specificity, not on facet. If the goal is better hooks, VP12 is
   the work and this spec should be closed unbuilt.
2. **Should VP5 ship on its own, immediately?** It is a bug fix for two verified live
   contaminations and is independent of everything else here. Recommended: yes, as its own
   change, referencing E6.
3. **Does ORCID coverage improve for the target population?** The 23 measured people came
   from arXiv-discovered papers across mixed fields. If the user's real targets are, say,
   senior US faculty, ORCID researcher-url coverage may differ from 22%. Worth a 50-person
   measurement before any build decision is revisited.
