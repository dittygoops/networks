# Technical Spec: iMessage Approval Loop (F5)

> PRD: [`docs/prd-imessage-approval-loop.md`](./prd-imessage-approval-loop.md). Sits between
> draft generation ([`docs/spec-draft.md`](./spec-draft.md)) and the future real sender (F6).
> Owns the `drafts` and `revisions` tables that edit learning reads
> ([`docs/spec-edit-learning.md`](./spec-edit-learning.md), "Read contract on the approval
> loop"). Supersedes parts of the master spec
> ([`docs/spec-networking-email-assistant.md`](./spec-networking-email-assistant.md)); every
> supersession is called out inline and collected in AL13.

## Overview

A long-running daemon (`src/index.ts`, new) that: persists every generated draft with a
permanent human-typeable short ID (`d7`), texts Aditya a ping through a hosted iMessage
provider within seconds, accepts decisions from two surfaces with identical effect (a reply
grammar over iMessage, and a tailnet-only review page with buttons plus inline editing), runs
the deterministic DR4 grounding check on every redraft and inline edit, records every
revision with provenance for edit learning (A7), and on `send` hands the draft to a stub
sender that archives the rendered email and marks it `sent (stubbed)` (A8, the F6 seam).
Every ping, command, revision, failure, and decision lands in an append-only event log that
is mirrored on the review page and, for failures, reported in the iMessage thread itself (A6).

Two ingress surfaces, strictly separated, and neither is public:

- **Review page**: Hono server bound to the tailnet interface only, port `7777`. Never
  public.
- **Provider stream**: the daemon opens an outbound, long-lived gRPC stream to Photon
  Spectrum and receives inbound texts over it. No inbound port, no public URL, nothing to
  expose. Aditya's sender number is verified on every message; everything else is dropped
  and logged. (A webhook + Tailscale Funnel design is retained as the documented fallback
  for webhook-only providers, AL11.)

Covers PRD A1 through A9. The master spec's native `imessage-kit` / chat.db channel (its
Stack table row and Steps 2 and 10) is superseded by the hosted provider behind an adapter
interface; the native path stays a documented fallback only (PRD non-goal).

## AL1. Provider selection (A1)

### Comparison (researched July 2026)

| | Sendblue | LoopMessage | Photon Spectrum |
|---|---|---|---|
| Free tier | Sandbox: shared number, full API access, up to 10 verified contacts, inbound-first messaging [1][2] | Sandbox $0, testing only, 5 contacts [4] | Managed shared line, up to 10 users on iMessage, unlimited daily messages [6][7] |
| Cheapest paid | AI Agent plan $100/mo per dedicated line, unlimited send/receive [2][3] | Shared sender $20/mo (50 monthly contacts); dedicated Light $59.99/mo plus $15/mo phone number [4] | Pro $25/mo (managed shared number, 100 users); Business $250/line/mo dedicated [7] |
| Sender identity | Service number (shared on sandbox, dedicated on paid) [1][2] | Service number (shared or dedicated) [4] | Managed: Photon service number. Self-hosted open source on Aditya's own Mac uses his own iCloud account as the sender [6][7] |
| Inbound delivery | Webhooks and callbacks on all plans, delivery receipts, Node SDK, `POST /send-message` [1][2][3] | Webhooks (`message_inbound`, `message_delivered`, `message_failed`, `message_reaction`); dashboard-configured Authorization header the server must verify on every event; 30 retries over roughly 3 hours (10 x 30s, 10 x 3min, 10 x 15min), 15s timeout per attempt [5] | Long-lived bidirectional gRPC stream the client opens outbound; replaced their earlier webhook design, removing the public-URL requirement [8] |
| Inbound auth | Exists per [1][2][3]; exact scheme (signature vs secret) unverified | Verified: shared secret via configurable Authorization header [5] | Device-code OAuth (RFC 8628) against app.photon.codes; project secret rotation [8] |
| Inbound polling API | Unverified | Not documented; webhooks only per [5] | Not needed for liveness (persistent stream); replay-after-disconnect behavior unverified, Step 1 spike item |
| Mac-online requirement | No (hosted) | No (hosted) | Self-hosted mode: yes (it runs on the Mac); managed mode: no |

Sources:
[1] sendblue.com/blog/best-business-texting-api, [2] sendara.io/blog/sendblue-pricing-2026,
[3] tuco.ai/blog/sendblue-pricing-2026-complete-breakdown (all three verified by prior
research), [4] loopmessage.com/pricing/, [5]
docs.loopmessage.com/imessage-conversation-api/webhooks.md, [6]
photon.codes/platform/imessage and photon.codes/, [7] photon.codes/pricing, [8]
arapaholabs.com/blog/2026-06-22-photon-imessage-grpc-no-mac (June 2026 integration
writeup of the managed Spectrum service; its claims about the gRPC transport, device-code
OAuth, and shared-line-pool behavior are re-verified by the Step 1 spike before any code
depends on them).

### Decision: Photon Spectrum (managed, free shared-line tier)

Decided with Aditya (Jul 16): the shared-number caveat is acceptable, which unlocks the
free tier.

- **No public surface at all.** Inbound arrives over a gRPC stream the daemon opens
  outbound [8], so the Tailscale Funnel, the second Hono app, and the webhook secret all
  disappear from the primary design. Zero exposed endpoints beats a well-secured one, and
  it satisfies A1's ingress-security intent by construction.
- **$0/month at this volume.** The managed free tier's shared line pool covers a
  few messages a day to exactly one recipient [6][7]. Different recipients can see
  different sending numbers on the shared pool, but each conversation stays stable [8];
  this system has one conversation (Aditya's), so the dedicated-number tiers buy nothing.
- **Same maker as `imessage-kit`** (photon-hq), the library the master spec already
  trusted for the native path.
- **Honest unknown, gated by the Step 1 spike**: whether messages sent while the stream is
  disconnected (Mac asleep) are queued server-side and replayed on reconnect. LoopMessage's
  3-hour webhook retry schedule [5] covered this; Photon's equivalent is undocumented. The
  spike tests it explicitly (text while disconnected, reconnect, observe). If replay does
  not exist and matters in practice, see the fallback below.
- **LoopMessage is the fallback** (previously the primary in this spec's first draft): its
  webhook path is fully verified from public docs (shared-secret Authorization header, 30
  retries over roughly 3 hours [5]), $20/mo shared sender in production [4]. The complete
  webhook + Tailscale Funnel ingress design is preserved in AL11 as the fallback
  appendix, so switching costs one adapter file plus that documented setup.
- Sendblue remains third: generous sandbox [1][2] but $100/mo production [2][3] and an
  unverified verification scheme.

The `ChannelProvider` adapter (AL3) makes this decision cheap to reverse: switching
providers is one new file plus an env var.

## AL2. Module layout

Follows the existing conventions: prompts in the single `src/llm/prompts.ts`, DDL in
`src/db/schema.sql` applied idempotently by `openDb`, injectable deps for offline tests.

```
outreach/
├── launchd/com.apgupta.outreach.plist   # NEW: daemon (KeepAlive), master spec Step 14 layout
├── data/sent/                           # NEW: stub-sender archive (.eml files)
└── src/
    ├── index.ts              # NEW daemon entry: review app + channel stream + pollers
    ├── config.ts             # NEW: env access, ports, poll intervals, phone allowlist
    ├── cli.ts                # CHANGED: `add` persists the draft (was print-only)
    ├── channel/
    │   ├── types.ts          # ChannelProvider interface, InboundMessage
    │   ├── photon.ts         # Photon Spectrum adapter (send + gRPC stream subscribe)
    │   ├── inbound.ts        # provider-agnostic inbound pipeline: dedup, allowlist, dispatch
    │   └── outbox.ts         # durable outbound queue + retry/backoff (provider outage)
    │                         # (loopmessage.ts: fallback adapter, only if AL11 fallback fires)
    ├── approval/
    │   ├── ids.ts            # short-ID scheme
    │   ├── grammar.ts        # inbound text -> Command (pure, unit-testable)
    │   ├── actions.ts        # state machine: send/skip/list/help, idempotency, first-write-wins
    │   ├── revise.ts         # instruction redrafts + inline edits, grounding, revision writes
    │   ├── ping.ts           # ping + failure + reply message templates (A2, A6)
    │   └── events.ts         # draft_events helpers
    ├── sender/
    │   ├── types.ts          # Sender interface (F6 seam)
    │   └── stub.ts           # v1: ledger + data/sent/ archive + iMessage confirm
    ├── review/
    │   └── server.ts         # Hono routes + server-rendered HTML (tailnet only)
    ├── pipeline/draft.ts     # CHANGED: export checkGrounding() (DR4 logic, extracted)
    ├── llm/prompts.ts        # + REDRAFT builder (buildRedraftUser)
    └── db/
        ├── schema.sql        # + drafts, revisions, decisions, draft_events,
        │                     #   channel_outbox, channel_inbound
        └── db.ts             # + typed helpers for the new tables
```

## AL3. Channel provider adapter (A1)

```ts
// src/channel/types.ts
export interface InboundMessage {
  providerMessageId: string;   // provider's unique id, dedup key
  from: string;                // E.164, e.g. '+14806928263'
  text: string;
  receivedAt: string;          // ISO
}

export interface ChannelProvider {
  readonly name: string;                                   // 'photon' | 'loopmessage' | ...
  send(to: string, text: string): Promise<{ providerMessageId: string }>;
  // Inbound: the provider pushes InboundMessage/DeliveryFailure into the callbacks.
  // Stream providers (Photon) hold an outbound gRPC stream open and reconnect with
  // backoff; webhook providers (fallback, AL11) register an HTTP route instead. Either
  // way, everything downstream of the callbacks is provider-agnostic (inbound.ts).
  start(handlers: {
    onInbound: (msg: InboundMessage) => Promise<void>;
    onDeliveryFailure: (providerMessageId: string, reason: string) => Promise<void>;
  }): Promise<void>;
  stop(): Promise<void>;
  health(): { connected: boolean; lastInboundAt: string | null };
}
```

`src/channel/photon.ts` implements it over the Spectrum SDK/gRPC API: `send` posts the
outbound message; `start` opens the long-lived bidirectional stream (credentials from the
device-code OAuth flow, AL12) and maps inbound texts to `InboundMessage`, reconnecting with
the outbox's backoff schedule on disconnect and logging `channel_disconnected` /
`channel_connected` events. Exact SDK call shapes and payload fields are recorded by the
Step 1 spike before this file is written [8]. Delivery failures are not dropped: they are
logged as `ping_failed` events and, on retry exhaustion in the outbox, reported per A6.

`src/channel/inbound.ts` is the provider-agnostic pipeline every inbound message passes
through, regardless of transport: dedup on `provider_message_id` (`INSERT OR IGNORE INTO
channel_inbound`), E.164 allowlist against `APPROVER_PHONE` (mismatch: record with
`accepted=0`, log `inbound_rejected`, count toward the daily digest, never reply), then
`parseCommand` and execute (AL7/AL8). The redraft LLM call for `edit` runs after the
synchronous state write, with the re-ping or failure text following via the outbox;
send/skip/list act well inside the 5s budget.

A future native on-Mac channel (or LoopMessage, or Sendblue) is one more file implementing
`ChannelProvider`, selected by `CHANNEL_PROVIDER` in env. Nothing outside `channel/` knows
which provider is live. This supersedes the master spec's `imessage/channel.ts` plan.

**Outbox** (`src/channel/outbox.ts`): every outbound text is first inserted into
`channel_outbox`; the enqueue call triggers an immediate first send attempt in-process
(this is what closes the 10s ping budget in AL6, not the drain loop). The drain loop then
retries failures with exponential backoff (30s, 2min, 10min, 30min, then hourly; capped
attempts per AL12 config). The PRD provider-outage edge
case falls out: pings queue locally, the tailnet review page keeps working, nothing blocks.

## AL4. Data model (DDL in `src/db/schema.sql`)

The master spec sketched `drafts` (keyed by `outreach_id`, `version` column, `superseded`
status) and `approvals` (`action IN ('send','skip','edit')`, `edit_instructions`). Both are
**superseded** here: no `outreach` table exists in code yet, revisions replace the
version-and-supersede scheme, and `edit` is not a decision (it produces a revision; only
`send` and `skip` decide a draft). The edit-learning read contract is matched exactly, plus
additive columns it does not constrain.

```sql
-- F5 approval loop. drafts + revisions are the edit-learning read contract
-- (docs/spec-edit-learning.md); do not rename without updating learning/.

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,   -- NEVER DELETE rows: short IDs are 'd'+id and rowids
                            -- can be reused after a max-rowid delete (AL5)
  short_id TEXT NOT NULL UNIQUE,           -- 'd' || id, assigned at insert (AL5)
  person_id INTEGER NOT NULL REFERENCES people(id),
  paper_arxiv_id TEXT,                     -- denormalized: no papers table in code yet
  paper_title TEXT,
  intent TEXT,
  gist TEXT NOT NULL DEFAULT '',           -- one-line gist for pings (A2) = subject of rev 1
  draft_input_json TEXT NOT NULL,          -- full DraftInput used at creation; redrafts and
                                           -- inline-edit grounding replay from this (AL8)
  sendable_revision_id INTEGER REFERENCES revisions(id),  -- last grounding-passing revision;
                                           -- NULL means nothing is sendable yet (A5)
  status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN
    ('awaiting_approval','approved','sent (stubbed)','sent','skipped')),
  decided_at TEXT,                         -- when send/skip landed; NULL while pending
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  rev_no INTEGER NOT NULL,                 -- monotonic per draft, 1-based
  subject TEXT,
  body TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('model','human')),
  prior_revision_id INTEGER REFERENCES revisions(id),     -- NULL only for rev_no = 1
  instruction TEXT,                        -- edit-instruction text; NULL for inline edits
                                           -- and first drafts
  context_json TEXT NOT NULL,              -- { intent, hook: { intersectionId, entity,
                                           --   facet, tier }, recipientProfileSummary,
                                           --   groundingTerms } (last key additive, AL8)
  grounded INTEGER NOT NULL DEFAULT 0,     -- DR4 result for this revision (additive)
  grounding_notes TEXT,                    -- which requirement failed, human-readable
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(draft_id, rev_no)
);

-- One row per decided draft. UNIQUE(draft_id) IS the A9 first-write-wins guarantee:
-- the losing surface's INSERT is ignored and it reports the existing outcome.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL UNIQUE REFERENCES drafts(id),
  action TEXT NOT NULL CHECK(action IN ('send','skip')),
  reason TEXT,                             -- skip reason, verbatim trailing text
  via TEXT NOT NULL CHECK(via IN ('imessage','web')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Append-only event log (A6). draft_id NULL for non-draft events (rejected inbound,
-- daemon lifecycle). Mirrored per-draft on the review page.
CREATE TABLE IF NOT EXISTS draft_events (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER REFERENCES drafts(id),
  type TEXT NOT NULL,                      -- 'draft_created','ping_sent','ping_failed',
                                           -- 'command','command_rejected','revision',
                                           -- 'grounding_failed','redraft_failed','decision',
                                           -- 'stub_sent','stub_failed','inbound_rejected',
                                           -- 'channel_disconnected','channel_connected',
                                           -- 'provider_error','daemon_start'
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_draft ON draft_events(draft_id);

-- Durable outbound queue (AL3).
CREATE TABLE IF NOT EXISTS channel_outbox (
  id INTEGER PRIMARY KEY,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Inbound dedup: providers can redeliver (stream replay on reconnect, or webhook
-- retries on the fallback path [5]); the UNIQUE key
-- makes reprocessing impossible, so retries are free idempotency instead of a hazard.
CREATE TABLE IF NOT EXISTS channel_inbound (
  id INTEGER PRIMARY KEY,
  provider_message_id TEXT NOT NULL UNIQUE,
  from_number TEXT NOT NULL,
  text TEXT NOT NULL,
  accepted INTEGER NOT NULL,               -- 0 = rejected (bad sender), still recorded
  received_at TEXT DEFAULT (datetime('now'))
);
```

Status semantics: `awaiting_approval` is pending; `approved` is the transient state between
the decision insert and the stub-sender write (a crash between them is healed on daemon
start by re-running the stub for `approved` drafts); `sent (stubbed)` is the terminal state
in this milestone (the literal the edit-learning metrics already tolerate); `sent` is
reserved for F6; `skipped` is terminal. `decided_at` is set in the same transaction as the
`decisions` insert.

`context_json.hook.intersectionId` requires the intersections row id, which the
`Intersection` type in `src/pipeline/intersect.ts` does not currently carry (it has
`selfFactId`/`personFactId` only). Plumbing change: `computeIntersections` returns the
persisted row id per hook (lookup by `(self_fact_id, person_fact_id)` against the
`intersections` table, or extend the type with `id`). `entity` = the hook's `personValue`,
`facet` = the person fact's facet (one lookup by `personFactId`), `tier` = the hook tier.

## AL5. Short IDs (A9)

`short_id = 'd' + String(drafts.id)`. Rowids are monotonic and never reused for our insert
pattern, so IDs are permanent, unique, strictly increasing, and never shift as new drafts
arrive. This rests on a hard rule made mechanical in the DDL: rows in `drafts` are never
DELETEd (a comment in the schema says so), because SQLite can reuse a plain
INTEGER PRIMARY KEY rowid after a max-rowid delete. If a delete ever becomes necessary,
switch the column to AUTOINCREMENT first. `src/approval/ids.ts` owns formatting and parsing:
`parseShortId('d7' | 'D7' | '7') -> 7` (bare digits accepted for phone ergonomics), format
always renders the canonical `d7`. No per-session renumbering, ever.

## AL6. Draft persistence and pings (A2)

**CLI change** (`src/cli.ts` `add` path, replacing DR6's print-only ending): after
`generateDraft`, in one transaction insert the `drafts` row (with `draft_input_json`,
`gist` = the draft subject), the rev-1 `revisions` row (`provenance='model'`,
`instruction=NULL`, `prior_revision_id=NULL`, `grounded` from DR4), set
`sendable_revision_id` if grounded, and log `draft_created`. Then the EL6 wiring: insert
the `prompt_inputs` row for the model revision (exemplar IDs and style-notes version from
`selectLearnedBlock`, or `[]`/NULL while `learning/` selection is not yet wired into the
draft call site). The CLI still prints the draft; it now also prints the short ID and
review URL.

**EL sequencing guard**: `learning/` and its tables do not exist yet (the edit-learning
spec's Step 1 creates them). All EL wiring here and in AL8 goes through one seam module,
`src/approval/el-seam.ts`, whose functions no-op (log `el_skipped`, return) when the
`learning_examples`/`prompt_inputs` tables are absent. Build order: edit-learning Step 1
(schema + constants, unblocked today) should land before F5 Step 2 so `prompt_inputs` rows
are real from the start, and edit-learning Step 2 (`derive.ts`) before F5 Step 7; but the
seam means F5 never breaks if built first.

**Gist** (PRD Open Question 3, resolved): the gist is the draft subject of revision 1.
DR3 already forces subjects to be short, specific, and lowercase-casual; reusing it costs
zero latency and zero extra LLM calls. No separate gist call.

**Ping dispatch**: the daemon polls every `PING_POLL_MS` (3s) for
`drafts WHERE status='awaiting_approval' AND id NOT IN (SELECT draft_id FROM draft_events
WHERE type='ping_sent')`, enqueues the ping into the outbox, and logs `ping_sent` when the
provider accepts it. Poll interval 3s against the 10s latency budget leaves margin for one
outbox attempt. Polling (rather than an in-process call) keeps the CLI and daemon decoupled:
`add` works whether or not the daemon is up, and pings fire when it is.

Ping template (`src/approval/ping.ts`):

```
d7 · Jane Doe (MIT)
"Attention Is Not All You Need" (short title)
gist: your rss-gap framing vs my crawler results
send d7 | skip d7 | edit d7: <how>
http://<mac-tailnet-name>:7777/review/d7
```

**Tier C guard (A2, mechanical)**: the ping and failure template functions take a narrow
`PingFields` type (`shortId`, `personName`, `affiliation`, `paperTitleShort`, `gist`,
`url`, and for failures a `reason` drawn from a fixed enum plus the grounding requirement
name). Ontology fact values, intersection rationales, and tiers are not in the type, so
Tier C content cannot be interpolated into a text by construction. The gist is a draft
subject, which is model output already constrained to Tier A/B hooks by the drafter.

## AL7. Grammar and actions (A3, A9)

`src/approval/grammar.ts`, a pure function:

```ts
export type Command =
  | { kind: 'send'; shortId: string | null }            // null = bare form
  | { kind: 'skip'; shortId: string | null; reason: string | null }
  | { kind: 'edit'; shortId: string | null; instructions: string }
  | { kind: 'list' }
  | { kind: 'help' };                                    // anything unrecognized

export function parseCommand(text: string): Command;
```

Rules (case-insensitive, whitespace-tolerant):

| Input | Parse |
|---|---|
| `send d7` / `send 7` | send, id 7 |
| `send` | send, id null (single-pending shortcut) |
| `skip d7 too salesy` | skip, id 7, reason "too salesy" |
| `skip` | skip, id null |
| `edit d7: mention the RSS gap instead` | edit, id 7, instructions after the colon |
| `edit: shorter` | edit, id null |
| `edit d7 shorter` (no colon) | help (colon is the instruction delimiter, per PRD A3) |
| `list` | list |
| anything else | help |

`src/approval/actions.ts` executes commands. Resolution of `shortId: null`: exactly one
pending draft applies to it; zero pending replies "nothing pending"; more than one replies
with the ID'd pending list and takes no action. Unknown or decided IDs get an informative
reply from the ledger ("d7 was already sent (stubbed) Tue Jul 14, 4:12pm via web"), never
an action.

**Idempotency and first-write-wins**: `send`/`skip` run in one `better-sqlite3` transaction:
`INSERT OR IGNORE INTO decisions ...`; if `changes = 0`, read the existing decision and
reply with the existing outcome (the losing surface's report, A9). If the insert landed,
update `drafts.status` and `decided_at` in the same transaction. Both surfaces run in the
same daemon process over one synchronous connection, so serialization is natural; the
UNIQUE constraint is the backstop, not the mechanism. `send` on a draft with
`sendable_revision_id IS NULL` is refused: "d7 has no revision that passes grounding; edit
or skip" (A5).

Replies (`list` output, help text, already-decided notices) go through the outbox like any
other text. Help text is the grammar in four short lines.

## AL8. Revisions: instruction redrafts and inline edits (A5, A7)

`src/approval/revise.ts` owns both write paths; there is no other way a revision is created.

**Grounding, extracted**: `pipeline/draft.ts` currently computes DR4 inline in
`generateDraft` (the `stems`/`shares` helpers, lines 22-27, and the recipient/sender checks
at lines 53-60). Extract:

```ts
// pipeline/draft.ts (new export; generateDraft now calls it too)
export interface GroundingTerms { recipientTerms: string[]; senderTerms: string[] }
export interface GroundingResult { grounded: boolean; missing: ('recipient' | 'sender')[] }
export function checkGrounding(body: string, terms: GroundingTerms): GroundingResult;
```

`recipientTerms` = each hook's `personValue` and `personDetail` plus the paper title;
`senderTerms` = each hook's `selfValue` and `selfDetail` plus the sender facts. These are
computed once at draft creation and stored in `context_json.groundingTerms` (additive key
beyond the EL contract), so inline edits and redrafts re-check deterministically, offline,
with zero LLM calls, against exactly the terms the original draft was grounded on.

**Instruction redraft** (`edit d7: <instructions>`, from either surface):
1. Rebuild `DraftInput` from `drafts.draft_input_json`.
2. `buildRedraftUser(input, currentRevision, instruction)` (new builder in
   `src/llm/prompts.ts`, same `DRAFT_SYSTEM`): the current subject/body plus "revise per
   this instruction; change nothing else that was not asked for". Frontier tier,
   temperature 0.4 (DR1).
3. Run `checkGrounding` on the result. Insert the revision in one transaction:
   `provenance='model'`, `instruction=<verbatim>`, `prior_revision_id=<current latest>`,
   `rev_no = max(rev_no)+1`, `grounded`, `grounding_notes`. If grounded, update
   `drafts.sendable_revision_id`; if not, leave it pointing at the last passing revision (A5).
4. Post-commit, fire-and-forget the EL wiring via the AL6 seam: `deriveFromRevision(deps,
   revisionId)` (instruction redrafts qualify per EL2) and insert the `prompt_inputs` row
   for the model revision (EL6). Failures there are logged, never surfaced to the phone,
   never block; if `learning/` has not landed yet, the seam no-ops.
5. Re-ping: grounded gets the normal ping with `rev <n>` noted; ungrounded gets the A6
   failure text instead (AL10 template), draft stays pending.

**Inline edit** (review page only): Aditya posts edited subject/body. Same transaction
shape with `provenance='human'`, `instruction=NULL`, and `checkGrounding` on his text. A
failing human revision is stored (auditability) but `sendable_revision_id` does not move:
the page shows exactly which requirement failed (missing recipient-work reference, missing
own-work reference, straight from `GroundingResult.missing`) and that the last passing
revision remains what `send` would send. Post-commit: `deriveFromRevision` fire-and-forget
(human revisions always qualify for derivation; via the AL6 seam). No `prompt_inputs` row
(that is for model revisions only). Then re-ping per the PRD edge case (each new revision
re-pings): a passing inline edit enqueues `d7 rev <n> saved (your edit). send d7 when
ready.`; a failing one enqueues the AL10 grounding-failure text. The editor is usually
still on the page, but the text keeps the thread as a complete, self-sufficient record of
every revision.

Near-simultaneous edits from both surfaces serialize on the single DB connection;
`UNIQUE(draft_id, rev_no)` with `rev_no` computed inside the transaction is the backstop.
`send` always sends `sendable_revision_id`, which is the latest passing revision, matching
the PRD edge case.

## AL9. Review page (A4)

`src/review/server.ts`, Hono, server-rendered HTML (no client framework), bound via
`config.ts` to the tailnet IP (`tailscale ip -4` at startup) plus `127.0.0.1`, port `7777`.
Never `0.0.0.0`. This supersedes the master spec's `REVIEW_TOKEN` bearer idea: the tailnet
binding is the v1 auth boundary (PRD A4, no page auth).

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Pending drafts (short ID, recipient, gist, age); links to decided ones below |
| `/review/:shortId` | GET | The review page (below) |
| `/review/:shortId/action` | POST | Form: `action = send \| skip \| edit`, `reason?`, `instructions?`. Calls the exact same `actions.ts` / `revise.ts` functions the grammar calls, `via='web'` |
| `/review/:shortId/revision` | POST | Inline edit: `subject`, `body`. The AL8 human-revision path |
| `/health` | GET | Daemon status: outbox depth, stream connected + last inbound seen, pending count |

The master spec's `/review/:draftId/action` sketch is kept in spirit; the key is now the
short ID and `edit` arrives with `instructions` (a decision never carries edit text).

Per-draft page content, top to bottom:
1. Header: `d7`, status, recipient name + affiliation + email, paper title (linked to arXiv).
2. Current revision: subject + body, grounded badge; if the latest revision failed
   grounding, a banner naming the missing requirement and stating which revision is still
   sendable.
3. Actions: Send (disabled with explanation when nothing is sendable), Skip with a reason
   field, Edit-with-instructions textarea (grammar parity), and the inline editor
   (subject + body pre-filled, Save as new revision).
4. Revision history: every revision with `rev_no`, provenance, instruction (if any),
   grounded flag, timestamp, and a body diff-friendly display (before/after collapsible).
5. Paper summary (title, abstract from `draft_input_json`), person profile
   (`people.profile_summary`), ranked intersections with tiers and rationale (from the
   `intersections` table). Tier C appears here and only here: this page never leaves the
   tailnet.
6. Event log: every `draft_events` row for this draft, timestamped (A6 mirror).

Decided drafts render read-only with the outcome banner ("sent (stubbed) Tue via imessage").

## AL10. Failure reporting (A6)

Every failure writes a `draft_events` row and (except where noted) enqueues an iMessage
text. Templates live in `src/approval/ping.ts`; each states what happened, the draft ID,
and the draft's current state:

| Event | Text template |
|---|---|
| Grounding failure on redraft or inline edit | `d7 edit failed grounding: missing a specific reference to their work. d7 still pending; rev 2 remains sendable. Fix on the page or send another edit.` |
| Redraft LLM error | `d7 redraft failed (model error). d7 unchanged and still pending; try again or use the page.` |
| Stub-sender error | `d7 approved but archiving failed: <reason>. d7 held at approved; will retry on daemon restart.` |
| Ping delivery failure, retries exhausted | logged as `ping_failed`; when the channel recovers, next successful text includes `(1 earlier message failed to deliver, see d7 page)` |
| Rejected inbound messages (unknown sender) | daily digest, only when count > 0: `ignored 2 messages from unknown numbers today` (no draft ID; event has no draft) |
| Unrecognized command | help reply (A3), logged as `command_rejected` |

The review page event log renders the same rows, so phone and page never disagree about
history.

## AL11. Stub sender (A8) and inbound ingress (A1)

**Sender seam** (`src/sender/types.ts`):

```ts
export interface OutboundEmail {
  to: string; from: string;                // from = 'apgupta3@asu.edu'
  subject: string; body: string;
  draftShortId: string;
}
export interface Sender { send(email: OutboundEmail): Promise<{ sentId: string }>; }
```

`src/sender/stub.ts`: renders the full email (headers + body) as RFC-822-ish text, writes
`data/sent/<short_id>-<ISO timestamp>.eml`, and returns the archive path as `sentId`. That
is all it does: the `Sender` interface has no DB access, so everything ledger-shaped lives
in the caller (`actions.ts`), which on a successful `send()` sets
`drafts.status = 'sent (stubbed)'`, logs `stub_sent` with the returned `sentId`, and
enqueues the confirmation text (`d7 sent (stubbed). Archived to data/sent/d7-....eml`).
F6 replaces only `stub.ts` with a Gmail implementation; `actions.ts` changes one status
literal to `sent` and the confirmation wording, and nothing else in `approval/` changes.

**Stream ingress** (primary, Photon): `src/index.ts` calls `provider.start(...)` at boot.
Every message the stream delivers goes through the `inbound.ts` pipeline (AL3: dedup,
allowlist, parse, execute). There is no inbound HTTP surface at all: no funnel, no webhook
secret, no public URL. Disconnects are expected (Mac sleep): the adapter reconnects with
backoff and logs `channel_disconnected`/`channel_connected` so gaps are visible in the
event log.

**Catch-up after disconnect**: log `daemon_start`; whether Photon queues messages sent
while the stream was down and replays them on reconnect is unverified [8] and is settled
by the Step 1 spike (text while disconnected, reconnect, observe). If replay exists, the
dedup key makes it safe. If it does not: on reconnect after a gap longer than
`RETRY_WINDOW_H` (3h) with any draft pending, the daemon re-sends the pending `list`, so
Aditya knows to re-issue anything that fell in the gap. See Open Question 2.

**Fallback appendix: webhook ingress (LoopMessage)**. If the spike disqualifies Photon
(broken replay with real message loss, unusable SDK, or shared-pool behavior that breaks
the single-thread assumption), the fallback is LoopMessage with the following verified
design, preserved from this spec's first draft:
- A second, tiny Hono app on `127.0.0.1:7788`. `POST /hooks/imessage`: verify the
  dashboard-configured Authorization header against `CHANNEL_WEBHOOK_SECRET`
  (constant-time compare; 401 + `inbound_rejected` on failure), then hand the parsed
  message to the same `inbound.ts` pipeline. Respond 200 immediately after the synchronous
  state write (LoopMessage times out webhooks at 15s [5]; a frontier redraft call can
  exceed that). Dedup also covers LoopMessage's 30-attempt retry policy [5].
- Public exposure via Tailscale Funnel (verified against Tailscale docs:
  tailscale.com/kb/1242/tailscale-serve, kb/1311/tailscale-funnel, kb/1223/funnel): Funnel
  shares only the mounted resource, HTTPS only, ports 443/8443/10000. Setup:
  `tailscale funnel --bg --set-path=/hooks http://127.0.0.1:7788`. The review app on 7777
  is not in any funnel mount and stays tailnet-only (A4). Verify at build time whether the
  funnel proxy strips the `/hooks` prefix; register the route under both `/` and
  `/hooks/imessage` so either behavior works.
- LoopMessage's 3-hour webhook retry schedule [5] then covers the Mac-asleep window that
  motivated the catch-up logic above.

## AL12. Security, privacy, config

- **No public surface**: inbound arrives on the outbound gRPC stream; there is no inbound
  port and no funnel in the primary design. The sender allowlist still gates every message
  (A1); everything else is dropped and logged. (Fallback path only: the funnel to
  `127.0.0.1:7788` per AL11's appendix.)
- **Review page**: tailnet interface + localhost only; never `0.0.0.0`; never funneled.
  Tier C facts and full rationale render only here (A2, A4).
- **Texts**: `PingFields` type guard (AL6) keeps ontology facts and rationale out of every
  outbound text by construction.
- **Keys**: `.env` holds `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `CHANNEL_PROVIDER=photon`,
  and the Photon credentials produced by the device-code OAuth flow [8] (exact variable
  names recorded by the Step 1 spike; the flow writes runtime credentials to a local file,
  which must live in the project `.env`/`data/` with the same permissions, not a
  world-readable home path), plus `APPROVER_PHONE`, `SENDER_EMAIL`. Fallback-only:
  `LOOPMESSAGE_AUTH_KEY`, `LOOPMESSAGE_SECRET_KEY`, `CHANNEL_WEBHOOK_SECRET`. Build step 1
  sets `chmod 600 .env`; `outreach doctor`-style check in `/health` warns if permissions
  are wider.
- **Config** (`src/config.ts`): `REVIEW_PORT=7777`, `PING_POLL_MS=3000`, outbox backoff
  schedule (also the stream reconnect schedule), `RETRY_WINDOW_H=3`, digest hour.
  (`WEBHOOK_PORT=7788` exists but is used only if the AL11 fallback fires.)
- Message content transits Photon's servers: accepted PRD tradeoff, restated here so
  nobody later mistakes the texts for a private channel.

## AL13. Supersessions of the master spec (collected)

| Master spec item | Status |
|---|---|
| Stack row `iMessage: imessage-kit (photon-hq), FDA` and Steps 2, 10 | Superseded by hosted provider behind `channel/` (PRD A1). Native path is a documented fallback, not a build target |
| `imessage/channel.ts` module | Replaced by `channel/` + `approval/` split |
| `drafts` DDL (`outreach_id`, `kind`, `version`, `superseded`) | Superseded by AL4 `drafts` + `revisions` (EL read contract). `kind`/`outreach_id` return with F6/F7 as additive columns |
| `approvals` DDL (`action IN ('send','skip','edit')`) | Superseded by `decisions` (send/skip only, UNIQUE per draft) + `revisions` (edits). The `via` column and intent survive |
| Grammar `send <n>` positional numbering, `status` command | Superseded by permanent short IDs (`d7`) and `list` (PRD A3/A9) |
| Review server on `127.0.0.1:7777` with optional `REVIEW_TOKEN` | Tailnet-interface binding, no token (PRD A4) |
| `events` table sketch | Realized as `draft_events` (draft-keyed, typed) |

Unchanged and relied on: `openDb` idempotent schema application, `LLMClient` injection,
prompts in `llm/prompts.ts`, model tiering (frontier for redrafts per DR1), the DR4
grounding bar.

## Interfaces

| Interface | Shape | Consumer |
|---|---|---|
| `ChannelProvider` | AL3 | daemon, outbox, inbound pipeline |
| `parseCommand(text)` | `Command` (pure) | inbound pipeline, tests |
| `executeCommand(deps, cmd, via)` | decision/revision/reply | inbound pipeline, review POST routes |
| `checkGrounding(body, terms)` | `GroundingResult` (pure) | `generateDraft`, `revise.ts` |
| `Sender.send(email)` | `{ sentId }` | `actions.ts` on approval; F6 swaps impl |
| `deriveFromRevision`, `prompt_inputs` insert | EL2/EL6 | `revise.ts` and CLI `add`, post-commit fire-and-forget |

## Implementation Plan

Each step ends with a ✅ human-verifiable checkpoint; do not proceed until it passes.

1. **Provider spike** (scratch script, no app code): Photon account via the device-code
   OAuth flow [8]; from a one-file script, send a text to Aditya's phone over the API,
   open the gRPC stream, reply from the phone, and print the inbound event. Then the
   replay test: close the stream, text the line, reopen, and observe whether the missed
   message is delivered. Record: exact SDK call shapes, credential variable names and
   storage location, inbound payload fields, dedup key, the shared-pool sender number
   behavior, and the replay verdict.
   ✅ *Human: you got the text, your reply printed on the Mac, and the replay verdict is
   written into Open Question 2 (resolving it one way or the other). If the free tier
   blocks any of this or replay loss is unacceptable, fall back to the LoopMessage design
   (AL11 appendix) before writing any adapter code.*
2. **Schema + persistence**: AL4 DDL into `schema.sql`; `ids.ts`; typed helpers in `db.ts`;
   CLI `add` persists draft + rev 1 + `draft_created` event (AL6) and prints `d<n>` + URL,
   with `prompt_inputs` written through the `el-seam` guard (prefer landing edit-learning
   Step 1 first so the table exists; the seam no-ops otherwise).
   Unit tests: idempotent re-open, short-ID stability across inserts, EL read-contract
   columns present (a test that runs the edit-learning contract queries verbatim).
   ✅ *Human: run `add` on a real paper; confirm the printed draft now has a short ID, and
   `sqlite3` shows the draft, revision 1 with your intent/hook context in `context_json`,
   and the event row.*
3. **Channel adapter + outbox**: `channel/types.ts`, `photon.ts` (wired from the spike's
   recorded call shapes), `inbound.ts`, `outbox.ts` with the backoff schedule;
   fake-provider unit tests (dedup, allowlist, dispatch, drain retries, reconnect).
   ✅ *Human: with the daemon-less drain script, enqueue a text and watch it arrive; kill
   the network mid-drain and watch it retry and land after reconnect, with
   `channel_disconnected`/`channel_connected` events logged.*
4. **Grammar + actions**: `grammar.ts` + `actions.ts` with the full AL7 table as unit
   tests, including idempotent duplicate send, first-write-wins (two racing decisions),
   bare-form disambiguation, unknown ID, and send-refused-when-nothing-sendable.
   ✅ *Human: read the test table against PRD A3/A9 line by line; run a REPL script feeding
   raw strings and confirm every reply text reads right on a phone screen.*
5. **Live inbound wiring**: connect the stream adapter to the inbound pipeline end to end;
   digest counter for rejected senders.
   ✅ *Human: text `list` from your phone and get the pending list back. Text from a second
   number (or have a friend text the shared line) and confirm it is ignored, logged as
   `inbound_rejected`, and counted for the digest. Confirm `http://<mac>:7777` is NOT
   reachable from a non-tailnet device while the review page IS reachable from your phone
   on the tailnet, and that `lsof` shows no listening port besides 7777 (tailnet) for the
   daemon.*
6. **Ping loop + daemon skeleton**: `src/index.ts` (review app + channel stream + ping
   poller + outbox drain + `daemon_start` catch-up notice), `config.ts`.
   ✅ *Human: run `add`; your phone gets the A2 ping within 10 seconds, with short ID, gist,
   and a working review link. Confirm the ping contains no ontology facts.*
7. **Revisions**: `checkGrounding` extraction (with `generateDraft` regression tests),
   `buildRedraftUser`, `revise.ts` both paths (including the inline-edit re-ping), EL
   wiring (`deriveFromRevision`, `prompt_inputs`) fire-and-forget post-commit through the
   seam (edit-learning Step 2 should land before this step for live derivation).
   ✅ *Human: reply `edit d<n>: mention X instead`; get the re-ping with rev 2. Then force a
   grounding failure (instruct it to remove all specifics) and confirm the failure text
   names the missing requirement and `send` still sends the last passing revision.
   Check `revisions` rows carry provenance/instruction/context exactly per the EL contract.*
8. **Review page**: all AL9 routes and content, inline editor with the grounding banner.
   ✅ *Human: on your phone over the tailnet, review a real draft with full context (paper,
   profile, tiered intersections with rationale, event log). Make an inline edit that
   passes, then one that fails grounding; confirm the failing one is stored, flagged with
   the exact missing requirement, and not sendable.*
9. **Stub sender + decision flow end to end**: `sender/` + wiring in `actions.ts`;
   `approved`-state healing on daemon start.
   ✅ *Human: reply `send d<n>`; get the confirmation text; open `data/sent/` and read the
   archived email; ledger shows `sent (stubbed)` with `decided_at`. Reply `send d<n>` again
   and get the already-sent notice. Race it once: tap Send on the page and text `send`
   near-simultaneously; exactly one decision row exists and the loser reported the outcome.*
10. **Daemonize + full rehearsal**: launchd plist (`KeepAlive`, logs to `data/logs/`),
    `/health` green (stream connected).
    ✅ *Human: reboot the Mac; daemon and stream come back without touching anything. Run one
    real paper end to end: add, ping, `edit:` round trip, page inline edit, `send`, archive,
    confirmation. Sleep the Mac 10 minutes, text `list` while asleep, wake it, and confirm
    the command lands (replay per the spike's finding, or the on-start pending notice
    fires).*

## Open Questions

1. **Photon SDK specifics** (unverified until Step 1): the gRPC transport, device-code
   OAuth, and shared-pool behavior come from a third-party integration writeup [8], not
   first-party API docs. The Step 1 spike re-verifies all of it against the real service
   and records the exact call shapes before `photon.ts` is written.
2. **Replay after disconnect** (the decision-relevant unknown): whether Photon queues and
   redelivers messages sent while the stream is down. The spike answers it empirically.
   Queued: dedup makes replay safe and the Mac-asleep window closes. Not queued: v1 leans
   on the on-start/on-reconnect pending notice (AL11), and if commands get lost in
   practice, fall back to LoopMessage, whose 3-hour webhook retries are documented [5].
3. **Sendblue webhook verification scheme** (unverified): webhooks exist on all plans per
   [1][2][3], but the exact signature/secret mechanism was not verifiable from reachable
   docs (docs.sendblue.com returned 404 on the receiving-messages path). Needed only if the
   fallback is exercised.
4. **Funnel prefix stripping** (fallback path only): whether the `/hooks` mount prefix is
   stripped before proxying is unverified from the KB pages; if the AL11 fallback is ever
   built, register both route shapes and record the observed behavior.
5. **Photon free-tier terms**: [6][7] describe generous free quotas, but sustained
   single-user personal use over months is an assumption. If the tier tightens, the Pro
   plan is $25/mo [7] and LoopMessage's shared sender is $20/mo [4]; either fits.
6. **`intersections` row id plumbing** (AL4): extend `Intersection` with the persisted row
   id vs a lookup at persist time; decide in Step 2 (pure implementation detail, EL contract
   only needs the id present in `context_json.hook.intersectionId`).
