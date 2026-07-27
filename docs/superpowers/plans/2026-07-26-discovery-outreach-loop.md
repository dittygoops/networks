# Autonomous Discovery and Scheduled Outreach Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover relevant new papers on a schedule, drive them through the existing pipeline, and send an iMessage only when a draft is genuinely sendable.

**Architecture:** A single `outreach loop` command runs one full cycle and exits: drain approvals, discover candidates from three precision sources, dedup against a `seen_papers` ledger, gate on relevance, run the existing `processPaper` pipeline, then emit at most N iMessages. `launchd` fires it daily. Every candidate rests in exactly one `seen_papers.status`, which is the whole audit trail.

**Tech Stack:** TypeScript ESM on Node, better-sqlite3 (synchronous), vitest, tsx, `spectrum-ts` for iMessage, OpenRouter LLM client, Tavily search.

**Design spec:** `docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md`

## Global Constraints

- Every source import uses an explicit `.js` extension, matching the existing ESM codebase (`import { openDb } from '../db/db.js'`).
- better-sqlite3 is **synchronous**. Never `await` a statement. Use `db.transaction(...)` for multi-statement writes.
- Tests use `openDb(':memory:')` and inject all network and LLM dependencies. No test may touch the network.
- No em dashes in any file content, comment, commit message, or generated message text. Use commas, periods, colons, or parentheses.
- Never fabricate facts about a person. Every claim in an outbound draft must trace to a stored fact.
- Nothing sends an email without an explicit human approval reply. The loop only ever messages.
- Run `npm test` and `npm run typecheck` from the `outreach/` directory.
- Commit after every task.

## Scope Boundary: approve and skip only

The design spec's flow lists an edit path (`edited -> new revision -> re-ground -> re-send`). That path belongs to F5 (`docs/spec-imessage-approval-loop.md`), which is **not yet built**. This plan implements a narrow `ApprovalChannel` seam supporting **approve and skip only**. Replies that are neither are logged and answered with a "not yet supported" message. When F5 is built it implements the same seam and the loop gains edits for free. Do not build the edit path in this plan.

## File Structure

| File | Responsibility |
| --- | --- |
| `outreach/src/db/schema.sql` (modify) | Add `seen_papers` table |
| `outreach/src/discovery/types.ts` (create) | `Candidate`, `DiscoverySource`, `SeenStatus` types |
| `outreach/src/discovery/seenLedger.ts` (create) | Dedup filter and status transitions |
| `outreach/src/discovery/gapSeeds.ts` (create) | Derive query seeds from `stance='exploring'` facts |
| `outreach/src/discovery/config.ts` (create) | Load and merge `watchlist.yaml` |
| `outreach/src/discovery/sources/savedQuery.ts` (create) | arXiv search source |
| `outreach/src/discovery/sources/authorWatch.ts` (create) | Watchlist author source |
| `outreach/src/discovery/sources/recommend.ts` (create) | Seed expansion source |
| `outreach/src/discovery/index.ts` (create) | Merge, dedup, per-source isolation |
| `outreach/src/discovery/relevanceGate.ts` (create) | Two stage keep or drop decision |
| `outreach/src/approval/channel.ts` (create) | `ApprovalChannel` seam plus stub |
| `outreach/src/approval/photonChannel.ts` (create) | Real Spectrum iMessage adapter |
| `outreach/src/pipeline/loop.ts` (create) | The orchestrator |
| `outreach/src/cli.ts` (modify) | Wire `outreach loop` |
| `outreach/scripts/com.aditya.outreach.plist` (create) | launchd schedule |

---

### Task 1: `seen_papers` ledger

**Files:**
- Modify: `outreach/src/db/schema.sql`
- Create: `outreach/src/discovery/types.ts`
- Create: `outreach/src/discovery/seenLedger.ts`
- Test: `outreach/test/seenLedger.test.ts`

**Interfaces:**
- Consumes: `openDb`, `DB` from `../db/db.js`
- Produces: `Candidate`, `SeenStatus`, `DiscoveredVia` types; `filterUnseen(db, candidates): Candidate[]`, `recordDiscovered(db, c): void`, `setStatus(db, arxivId, status, reason?, draftId?): void`, `getQueued(db, limit): SeenRow[]`

- [ ] **Step 1: Write the failing test**

Create `outreach/test/seenLedger.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { filterUnseen, recordDiscovered, setStatus, getQueued } from '../src/discovery/seenLedger.js';
import type { Candidate } from '../src/discovery/types.js';

const c = (arxivId: string, title = 'A Paper'): Candidate => ({
  arxivId,
  title,
  discoveredVia: 'saved_query',
  sourceDetail: 'query: olfactory embedding',
});

describe('seenLedger', () => {
  it('passes through candidates that have never been seen', () => {
    const db = openDb(':memory:');
    expect(filterUnseen(db, [c('2601.00001'), c('2601.00002')]).map((x) => x.arxivId)).toEqual([
      '2601.00001',
      '2601.00002',
    ]);
  });

  it('drops candidates already recorded, even from a different source', () => {
    const db = openDb(':memory:');
    recordDiscovered(db, c('2601.00001'));
    const fromOtherSource: Candidate = { ...c('2601.00001'), discoveredVia: 'author_watch', sourceDetail: 'author: X' };
    expect(filterUnseen(db, [fromOtherSource, c('2601.00002')]).map((x) => x.arxivId)).toEqual(['2601.00002']);
  });

  it('recordDiscovered is idempotent and keeps the first source', () => {
    const db = openDb(':memory:');
    recordDiscovered(db, c('2601.00001'));
    recordDiscovered(db, { ...c('2601.00001'), discoveredVia: 'recommend', sourceDetail: 'seed: 2306.12345' });
    const row = db.prepare('SELECT discovered_via AS v, COUNT(*) AS n FROM seen_papers').get() as { v: string; n: number };
    expect(row.n).toBe(1);
    expect(row.v).toBe('saved_query');
  });

  it('setStatus records status and reason', () => {
    const db = openDb(':memory:');
    recordDiscovered(db, c('2601.00001'));
    setStatus(db, '2601.00001', 'filtered_low_relevance', 'score 0.12 below threshold 0.6');
    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00001') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('filtered_low_relevance');
    expect(row.reason).toContain('below threshold');
  });

  it('getQueued returns queued_for_message rows ordered by relevance descending', () => {
    const db = openDb(':memory:');
    for (const [id, rel] of [['2601.00001', 0.7], ['2601.00002', 0.95], ['2601.00003', 0.8]] as const) {
      recordDiscovered(db, c(id));
      db.prepare('UPDATE seen_papers SET relevance = ? WHERE arxiv_id = ?').run(rel, id);
      setStatus(db, id, 'queued_for_message');
    }
    expect(getQueued(db, 2).map((r) => r.arxivId)).toEqual(['2601.00002', '2601.00003']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/seenLedger.test.ts`
Expected: FAIL, cannot resolve `../src/discovery/seenLedger.js`

- [ ] **Step 3: Add the table to the schema**

Append to `outreach/src/db/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS seen_papers (
  arxiv_id TEXT PRIMARY KEY,   -- natural dedup key, survives rowid reuse
  title TEXT NOT NULL,
  discovered_via TEXT NOT NULL CHECK(discovered_via IN ('saved_query','author_watch','recommend')),
  source_detail TEXT,
  relevance REAL,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN
    ('discovered','filtered_low_relevance','drafted_unsendable','queued_for_message','messaged','sent','rejected')),
  draft_id INTEGER REFERENCES drafts(id),
  reason TEXT,
  first_seen_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seen_status ON seen_papers(status);
```

- [ ] **Step 4: Write the types**

Create `outreach/src/discovery/types.ts`:

```typescript
// Discovery layer types. Spec: docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md
export type DiscoveredVia = 'saved_query' | 'author_watch' | 'recommend';

export type SeenStatus =
  | 'discovered'
  | 'filtered_low_relevance'
  | 'drafted_unsendable'
  | 'queued_for_message'
  | 'messaged'
  | 'sent'
  | 'rejected';

export interface Candidate {
  arxivId: string;
  title: string;
  discoveredVia: DiscoveredVia;
  sourceDetail: string; // which query, which author, which seed
  abstract?: string;
}

// One discovery source. Implementations must never throw for expected upstream
// failures; the orchestrator isolates them, but sources should degrade first.
export interface DiscoverySource {
  readonly name: DiscoveredVia;
  fetch(): Promise<Candidate[]>;
}
```

- [ ] **Step 5: Write the ledger**

Create `outreach/src/discovery/seenLedger.ts`:

```typescript
// Dedup ledger and audit trail: one row per paper, ever.
import type { DB } from '../db/db.js';
import type { Candidate, SeenStatus } from './types.js';

export interface SeenRow {
  arxivId: string;
  title: string;
  relevance: number | null;
  status: SeenStatus;
  reason: string | null;
}

// Drops any candidate already in the ledger. Also dedups within the batch so a
// paper surfaced by two sources in one run is processed once.
export function filterUnseen(db: DB, candidates: Candidate[]): Candidate[] {
  const stmt = db.prepare('SELECT 1 FROM seen_papers WHERE arxiv_id = ?');
  const batch = new Set<string>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    if (batch.has(c.arxivId)) continue;
    if (stmt.get(c.arxivId)) continue;
    batch.add(c.arxivId);
    out.push(c);
  }
  return out;
}

// First writer wins, so the recorded source is the one that found it first.
export function recordDiscovered(db: DB, c: Candidate): void {
  db.prepare(
    `INSERT OR IGNORE INTO seen_papers (arxiv_id, title, discovered_via, source_detail)
     VALUES (?, ?, ?, ?)`,
  ).run(c.arxivId, c.title, c.discoveredVia, c.sourceDetail);
}

export function setStatus(
  db: DB,
  arxivId: string,
  status: SeenStatus,
  reason?: string,
  draftId?: number,
): void {
  db.prepare(
    `UPDATE seen_papers
     SET status = ?, reason = COALESCE(?, reason), draft_id = COALESCE(?, draft_id),
         updated_at = datetime('now')
     WHERE arxiv_id = ?`,
  ).run(status, reason ?? null, draftId ?? null, arxivId);
}

export function setRelevance(db: DB, arxivId: string, relevance: number): void {
  db.prepare("UPDATE seen_papers SET relevance = ?, updated_at = datetime('now') WHERE arxiv_id = ?").run(
    relevance,
    arxivId,
  );
}

// Sendable drafts deferred by the per-run message cap, highest relevance first.
export function getQueued(db: DB, limit: number): SeenRow[] {
  return db
    .prepare(
      `SELECT arxiv_id AS arxivId, title, relevance, status, reason
       FROM seen_papers WHERE status = 'queued_for_message'
       ORDER BY relevance DESC, arxiv_id LIMIT ?`,
    )
    .all(limit) as SeenRow[];
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/seenLedger.test.ts && npm run typecheck`
Expected: 5 passed, typecheck clean

- [ ] **Step 7: Commit**

```bash
git add outreach/src/db/schema.sql outreach/src/discovery/types.ts outreach/src/discovery/seenLedger.ts outreach/test/seenLedger.test.ts
git commit -m "Add seen_papers ledger for discovery dedup and audit trail"
```

---

### Task 2: Derive query seeds from research gaps

**Files:**
- Create: `outreach/src/discovery/gapSeeds.ts`
- Test: `outreach/test/gapSeeds.test.ts`

**Interfaces:**
- Consumes: `DB` from `../db/db.js`
- Produces: `deriveGapQueries(db): string[]`

**Context:** Research gaps are the self ontology facts with `stance='exploring'` (`person_id IS NULL`). Verified 2026-07-26: 9 such facts exist, all `usability_tier='A'`. The complementary `stance='done'` facts are credibility material, not gap seeds.

**One query per fact, deliberately.** The current gap set spans two unrelated threads (3D Gaussian Splatting and olfaction). Blending them into combined queries would emit nonsense like "gaussian splatting olfactory embedding" that matches nothing. Emitting one query per fact makes cross-domain blending structurally impossible. Muting is handled by substring match in Task 3.

- [ ] **Step 1: Write the failing test**

Create `outreach/test/gapSeeds.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.js';
import { deriveGapQueries } from '../src/discovery/gapSeeds.js';

function seedFact(db: ReturnType<typeof openDb>, key: string, value: string, stance: string) {
  db.prepare(
    `INSERT INTO ontology_facts (person_id, facet, key, value, detail, stance, confidence, usability_tier)
     VALUES (NULL, 'academic', ?, ?, NULL, ?, 0.9, 'A')`,
  ).run(key, value, stance);
}

describe('deriveGapQueries', () => {
  it('uses only exploring facts, never done facts', () => {
    const db = openDb(':memory:');
    seedFact(db, 'research_area', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', '3D Gaussian Splatting', 'done');
    expect(deriveGapQueries(db)).toEqual(['olfactory embedding space']);
  });

  it('emits one query per fact so unrelated threads never blend', () => {
    const db = openDb(':memory:');
    seedFact(db, 'research_area', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', 'Mirror-3DGS', 'exploring');
    const queries = deriveGapQueries(db);
    expect(queries).toEqual(['olfactory embedding space', 'Mirror-3DGS']);
    expect(queries.some((q) => q.includes('olfactory') && q.includes('3DGS'))).toBe(false);
  });

  it('dedups repeated values and ignores blank ones', () => {
    const db = openDb(':memory:');
    seedFact(db, 'research_area', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', 'olfactory embedding space', 'exploring');
    seedFact(db, 'method', '   ', 'exploring');
    expect(deriveGapQueries(db)).toEqual(['olfactory embedding space']);
  });

  it('returns an empty list when no gaps are recorded', () => {
    expect(deriveGapQueries(openDb(':memory:'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/gapSeeds.test.ts`
Expected: FAIL, cannot resolve `../src/discovery/gapSeeds.js`

- [ ] **Step 3: Write the implementation**

Create `outreach/src/discovery/gapSeeds.ts`:

```typescript
// Research gaps are self ontology facts with stance='exploring'. One query per
// fact: the gap set spans unrelated threads (3DGS and olfaction as of
// 2026-07-26), and blending them yields queries that match nothing.
import type { DB } from '../db/db.js';

interface GapRow {
  value: string;
}

export function deriveGapQueries(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT value FROM ontology_facts
       WHERE person_id IS NULL AND stance = 'exploring'
       ORDER BY confidence DESC, id`,
    )
    .all() as GapRow[];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const q = (r.value ?? '').trim();
    if (!q) continue;
    const norm = q.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(q);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/gapSeeds.test.ts`
Expected: 4 passed

- [ ] **Step 5: Verify against the real database**

Run: `cd outreach && npx tsx -e "import{openDb}from'./src/db/db.js';import{deriveGapQueries}from'./src/discovery/gapSeeds.js';console.log(deriveGapQueries(openDb('data/outreach.db')))"`
Expected: an array of about 9 gap strings including `olfactory embedding space` and `Mirror-3DGS`. If it prints `[]`, stop and investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add outreach/src/discovery/gapSeeds.ts outreach/test/gapSeeds.test.ts
git commit -m "Derive discovery query seeds from exploring-stance gap facts"
```

---

### Task 3: Watchlist config with auto-derived defaults

**Files:**
- Create: `outreach/src/discovery/config.ts`
- Create: `outreach/config/watchlist.example.yaml`
- Modify: `outreach/package.json` (add `yaml` dependency)
- Test: `outreach/test/discoveryConfig.test.ts`

**Interfaces:**
- Consumes: `deriveGapQueries(db)` from `./gapSeeds.js`
- Produces: `LoopConfig` interface; `loadConfig(db, path?): LoopConfig`

- [ ] **Step 1: Install the yaml dependency**

Run: `cd outreach && npm install yaml@^2.6.0`
Expected: `yaml` appears under `dependencies` in `package.json`

- [ ] **Step 2: Write the failing test**

Create `outreach/test/discoveryConfig.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/db.js';
import { loadConfig } from '../src/discovery/config.js';

function dbWithGaps(values: string[]) {
  const db = openDb(':memory:');
  for (const v of values) {
    db.prepare(
      `INSERT INTO ontology_facts (person_id, facet, key, value, stance, confidence, usability_tier)
       VALUES (NULL, 'academic', 'method', ?, 'exploring', 0.9, 'A')`,
    ).run(v);
  }
  return db;
}

function writeYaml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'outreach-cfg-'));
  const p = join(dir, 'watchlist.yaml');
  writeFileSync(p, body);
  return p;
}

describe('loadConfig', () => {
  it('falls back to pure auto derivation when the file is absent', () => {
    const cfg = loadConfig(dbWithGaps(['olfactory embedding space']), '/nonexistent/watchlist.yaml');
    expect(cfg.queries).toEqual(['olfactory embedding space']);
    expect(cfg.gate.threshold).toBe(0.6);
    expect(cfg.gate.borderlineBand).toBe(0.1);
    expect(cfg.gate.maxMessagesPerRun).toBe(3);
  });

  it('merges added queries with derived ones', () => {
    const p = writeYaml('queries:\n  add: ["principal odor map"]\n');
    expect(loadConfig(dbWithGaps(['olfactory embedding space']), p).queries).toEqual([
      'olfactory embedding space',
      'principal odor map',
    ]);
  });

  it('mutes derived queries by case-insensitive substring match', () => {
    const p = writeYaml('queries:\n  mute: ["gaussian splatting"]\n');
    const db = dbWithGaps(['olfactory embedding space', 'Depth-supervised 3DGS Gaussian Splatting']);
    expect(loadConfig(db, p).queries).toEqual(['olfactory embedding space']);
  });

  it('reads authors, seeds, and gate overrides', () => {
    const p = writeYaml(
      'authors:\n  add: ["Alexander Wiltschko"]\nseeds:\n  add: ["2306.12345"]\ngate:\n  threshold: 0.75\n  max_messages_per_run: 1\n',
    );
    const cfg = loadConfig(dbWithGaps([]), p);
    expect(cfg.authors).toEqual(['Alexander Wiltschko']);
    expect(cfg.seeds).toEqual(['2306.12345']);
    expect(cfg.gate.threshold).toBe(0.75);
    expect(cfg.gate.maxMessagesPerRun).toBe(1);
    expect(cfg.gate.borderlineBand).toBe(0.1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/discoveryConfig.test.ts`
Expected: FAIL, cannot resolve `../src/discovery/config.js`

- [ ] **Step 4: Write the implementation**

Create `outreach/src/discovery/config.ts`:

```typescript
// Auto derived defaults, with an optional override file merged in. Absent file
// means pure auto derivation.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { DB } from '../db/db.js';
import { deriveGapQueries } from './gapSeeds.js';

export interface GateConfig {
  threshold: number;
  borderlineBand: number;
  maxMessagesPerRun: number;
}

export interface LoopConfig {
  queries: string[];
  authors: string[];
  seeds: string[];
  gate: GateConfig;
}

interface RawFile {
  queries?: { add?: string[]; mute?: string[] };
  authors?: { add?: string[] };
  seeds?: { add?: string[] };
  gate?: { threshold?: number; borderline_band?: number; max_messages_per_run?: number };
}

const DEFAULT_GATE: GateConfig = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3 };

function readFile(path: string): RawFile {
  try {
    return (parse(readFileSync(path, 'utf8')) as RawFile) ?? {};
  } catch {
    return {}; // absent or unreadable means pure auto derivation
  }
}

export function loadConfig(db: DB, path = 'config/watchlist.yaml'): LoopConfig {
  const raw = readFile(path);
  const mute = (raw.queries?.mute ?? []).map((m) => m.toLowerCase());
  const derived = deriveGapQueries(db).filter((q) => !mute.some((m) => q.toLowerCase().includes(m)));

  const queries: string[] = [];
  for (const q of [...derived, ...(raw.queries?.add ?? [])]) {
    if (!queries.some((e) => e.toLowerCase() === q.toLowerCase())) queries.push(q);
  }

  return {
    queries,
    authors: raw.authors?.add ?? [],
    seeds: raw.seeds?.add ?? [],
    gate: {
      threshold: raw.gate?.threshold ?? DEFAULT_GATE.threshold,
      borderlineBand: raw.gate?.borderline_band ?? DEFAULT_GATE.borderlineBand,
      maxMessagesPerRun: raw.gate?.max_messages_per_run ?? DEFAULT_GATE.maxMessagesPerRun,
    },
  };
}
```

Note: `authors` and `seeds` are override-only in this task. Task 5 extends them with auto derivation from the database.

- [ ] **Step 5: Write the example config**

Create `outreach/config/watchlist.example.yaml`:

```yaml
# Optional overrides. Delete this file entirely to run on pure auto derivation.
# Copy to config/watchlist.yaml to activate.
queries:
  add: ["principal odor map", "olfactory embedding"]
  mute: ["gaussian splatting"]   # suppress a research thread you are not pursuing
authors:
  add: ["Alexander Wiltschko"]
seeds:
  add: ["2306.12345"]
gate:
  threshold: 0.6
  borderline_band: 0.1           # scores within this of threshold go to the LLM judge
  max_messages_per_run: 3        # hard cap so the phone never floods
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/discoveryConfig.test.ts && npm run typecheck`
Expected: 4 passed, typecheck clean

- [ ] **Step 7: Commit**

```bash
git add outreach/src/discovery/config.ts outreach/config/watchlist.example.yaml outreach/test/discoveryConfig.test.ts outreach/package.json outreach/package-lock.json
git commit -m "Add watchlist config with auto-derived defaults and mute support"
```

---

### Task 4: Saved-query discovery source

**Files:**
- Create: `outreach/src/discovery/sources/arxivQuery.ts` (shared arXiv feed helper)
- Create: `outreach/src/discovery/sources/savedQuery.ts`
- Test: `outreach/test/savedQuerySource.test.ts`

**Interfaces:**
- Consumes: `Candidate`, `DiscoverySource`, `DiscoveredVia` from `../types.js`
- Produces (from `arxivQuery.ts`): `parseSearchFeed(xml)`, `sleep(ms)`, `ArxivQueryOptions`, `queryArxivFeed(prefix, terms, via, label, opts): Promise<Candidate[]>`
- Produces (from `savedQuery.ts`): `createSavedQuerySource(queries, opts): DiscoverySource`

**Why a shared helper:** the saved-query and author-watch sources differ only by the arXiv search prefix (`all:` vs `au:`) and the `sourceDetail` label. Task 5 builds author-watch on this same helper, so the sequential-with-delay loop, the per-term try/catch, and the feed parsing exist once.

**Context:** arXiv's search API returns the same Atom format the existing `parseArxivAtom` handles, but for multiple entries. Etiquette is roughly one request per three seconds, so queries run sequentially with a delay.

- [ ] **Step 1: Write the failing test**

Create `outreach/test/savedQuerySource.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { createSavedQuerySource } from '../src/discovery/sources/savedQuery.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00001v1</id>
    <title>Olfactory Embeddings for Sensor Arrays</title>
    <summary>We map sensor readings into an odor space.</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2601.00002v2</id>
    <title>Another Paper</title>
    <summary>Unrelated.</summary>
  </entry>
</feed>`;

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;

describe('savedQuery source', () => {
  it('parses entries into candidates tagged with the originating query', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(FEED, { status: 200 }));
    const src = createSavedQuerySource(['olfactory embedding'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('saved_query');
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({
      arxivId: '2601.00001',
      title: 'Olfactory Embeddings for Sensor Arrays',
      discoveredVia: 'saved_query',
      sourceDetail: 'query: olfactory embedding',
    });
    expect(got[0].abstract).toContain('odor space');
  });

  it('handles an empty feed without throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(EMPTY, { status: 200 }));
    const src = createSavedQuerySource(['nothing'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });

  it('skips a query that errors and still returns results from the others', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(FEED, { status: 200 }));
    const src = createSavedQuerySource(['bad', 'good'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toHaveLength(2);
  });

  it('makes no requests when there are no queries', async () => {
    const fetchFn = vi.fn();
    const src = createSavedQuerySource([], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/savedQuerySource.test.ts`
Expected: FAIL, cannot resolve `../src/discovery/sources/savedQuery.js`

- [ ] **Step 3: Write the shared arXiv feed helper**

Create `outreach/src/discovery/sources/arxivQuery.ts`:

```typescript
// Shared arXiv query machinery. The saved-query and author-watch sources differ
// only by search prefix and label, so the sequential-with-delay loop, the
// per-term isolation, and the Atom parsing live here once.
import { XMLParser } from 'fast-xml-parser';
import type { Candidate, DiscoveredVia } from '../types.js';

export interface ArxivQueryOptions {
  fetchFn?: typeof fetch;
  maxResults?: number;
  delayMs?: number;
}

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function parseSearchFeed(xml: string): Array<{ arxivId: string; title: string; abstract: string }> {
  const feed = parser.parse(xml)?.feed;
  return asArray<AtomEntry>(feed?.entry)
    .map((e) => {
      const m = String(e.id ?? '').match(/abs\/([^v]+)/);
      return m ? { arxivId: m[1], title: clean(e.title), abstract: clean(e.summary) } : null;
    })
    .filter((x): x is { arxivId: string; title: string; abstract: string } => x !== null);
}

// arXiv etiquette is roughly one request per three seconds, so terms run
// sequentially with a delay between them.
export const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export async function queryArxivFeed(
  prefix: 'all' | 'au',
  terms: string[],
  via: DiscoveredVia,
  label: (term: string) => string,
  opts: ArxivQueryOptions = {},
): Promise<Candidate[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxResults = opts.maxResults ?? 20;
  const delayMs = opts.delayMs ?? 3000;

  const out: Candidate[] = [];
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (i > 0) await sleep(delayMs);
    try {
      const url =
        `http://export.arxiv.org/api/query?search_query=${prefix}:${encodeURIComponent(`"${term}"`)}` +
        `&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;
      const res = await fetchFn(url);
      if (!res.ok) continue; // one bad term must not sink the rest
      for (const e of parseSearchFeed(await res.text())) {
        out.push({
          arxivId: e.arxivId,
          title: e.title,
          abstract: e.abstract,
          discoveredVia: via,
          sourceDetail: label(term),
        });
      }
    } catch {
      continue;
    }
  }
  return out;
}
```

- [ ] **Step 4: Write the saved-query source**

Create `outreach/src/discovery/sources/savedQuery.ts`:

```typescript
// Saved-query source: runs each derived or configured query against arXiv.
import type { DiscoverySource } from '../types.js';
import { queryArxivFeed, type ArxivQueryOptions } from './arxivQuery.js';

export type SavedQueryOptions = ArxivQueryOptions;

export function createSavedQuerySource(queries: string[], opts: SavedQueryOptions = {}): DiscoverySource {
  return {
    name: 'saved_query',
    fetch: () => queryArxivFeed('all', queries, 'saved_query', (q) => `query: ${q}`, opts),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/savedQuerySource.test.ts && npm run typecheck`
Expected: 4 passed, typecheck clean

- [ ] **Step 6: Commit**

```bash
git add outreach/src/discovery/sources/arxivQuery.ts outreach/src/discovery/sources/savedQuery.ts outreach/test/savedQuerySource.test.ts
git commit -m "Add shared arXiv feed helper and saved-query discovery source"
```

---

### Task 5: Author-watch and recommend sources

**Files:**
- Create: `outreach/src/discovery/sources/authorWatch.ts`
- Create: `outreach/src/discovery/sources/recommend.ts`
- Modify: `outreach/src/discovery/config.ts`
- Test: `outreach/test/otherSources.test.ts`

**Interfaces:**
- Consumes: `queryArxivFeed`, `sleep`, `ArxivQueryOptions` from `./arxivQuery.js` (Task 4); `DB` from `../../db/db.js`
- Produces: `deriveWatchAuthors(db): string[]`, `deriveSeedPapers(db): string[]`, `createAuthorWatchSource(authors, opts): DiscoverySource`, `createRecommendSource(seeds, opts): DiscoverySource`

- [ ] **Step 1: Write the failing test**

Create `outreach/test/otherSources.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { createAuthorWatchSource, deriveWatchAuthors } from '../src/discovery/sources/authorWatch.js';
import { createRecommendSource, deriveSeedPapers } from '../src/discovery/sources/recommend.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2601.00003v1</id>
    <title>New Work</title>
    <summary>Fresh results.</summary>
  </entry>
</feed>`;

describe('deriveWatchAuthors', () => {
  it('returns people already in the database', () => {
    const db = openDb(':memory:');
    upsertPerson(db, { name: 'Akshay Sajan' });
    upsertPerson(db, { name: 'Wenwen Zhang' });
    expect(deriveWatchAuthors(db).sort()).toEqual(['Akshay Sajan', 'Wenwen Zhang']);
  });
});

describe('authorWatch source', () => {
  it('tags candidates with the author that surfaced them', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(FEED, { status: 200 }));
    const src = createAuthorWatchSource(['Akshay Sajan'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('author_watch');
    expect(got[0]).toMatchObject({
      arxivId: '2601.00003',
      discoveredVia: 'author_watch',
      sourceDetail: 'author: Akshay Sajan',
    });
  });

  it('skips an author whose request fails', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const src = createAuthorWatchSource(['X'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });
});

describe('deriveSeedPapers', () => {
  it('returns distinct arXiv ids already drafted against', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'A' });
    for (const id of ['2508.09217', '2508.09217', '2604.09758']) {
      db.prepare(
        `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, draft_input_json)
         VALUES (?, ?, ?, 'T', '{}')`,
      ).run(`d${Math.random()}`, pid, id);
    }
    expect(deriveSeedPapers(db).sort()).toEqual(['2508.09217', '2604.09758']);
  });
});

describe('recommend source', () => {
  it('expands a seed into related candidates', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ paper: { externalIds: { ArXiv: '2601.00004' }, title: 'Related' } }] }), {
        status: 200,
      }),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    const got = await src.fetch();
    expect(src.name).toBe('recommend');
    expect(got[0]).toMatchObject({
      arxivId: '2601.00004',
      title: 'Related',
      discoveredVia: 'recommend',
      sourceDetail: 'seed: 2508.09217',
    });
  });

  it('ignores recommendations that have no arXiv id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ paper: { externalIds: {}, title: 'No arXiv' } }] }), { status: 200 }),
    );
    const src = createRecommendSource(['2508.09217'], { fetchFn: fetchFn as unknown as typeof fetch, delayMs: 0 });
    expect(await src.fetch()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/otherSources.test.ts`
Expected: FAIL, cannot resolve the two new modules

- [ ] **Step 3: Write the author-watch source**

Create `outreach/src/discovery/sources/authorWatch.ts`:

```typescript
// Author-watch source: checks a watchlist of researchers for new postings.
// Auto derives from people already in the database, extended by config.
import type { DB } from '../../db/db.js';
import type { DiscoverySource } from '../types.js';
import { queryArxivFeed, type ArxivQueryOptions } from './arxivQuery.js';

export type AuthorWatchOptions = ArxivQueryOptions;

export function deriveWatchAuthors(db: DB): string[] {
  const rows = db.prepare('SELECT DISTINCT name FROM people WHERE name IS NOT NULL').all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter(Boolean);
}

export function createAuthorWatchSource(authors: string[], opts: AuthorWatchOptions = {}): DiscoverySource {
  return {
    name: 'author_watch',
    fetch: () => queryArxivFeed('au', authors, 'author_watch', (a) => `author: ${a}`, { maxResults: 10, ...opts }),
  };
}
```

- [ ] **Step 4: Write the recommend source**

Create `outreach/src/discovery/sources/recommend.ts`:

```typescript
// Recommend source: expands seed papers via the Semantic Scholar
// recommendations API. Seeds auto derive from papers already drafted against.
import type { DB } from '../../db/db.js';
import type { Candidate, DiscoverySource } from '../types.js';
import { sleep, type ArxivQueryOptions } from './arxivQuery.js';

// Semantic Scholar, not arXiv, but the same pacing and isolation apply.
export type RecommendOptions = ArxivQueryOptions;

interface S2Recommendation {
  paper?: { externalIds?: { ArXiv?: string }; title?: string; abstract?: string };
}

export function deriveSeedPapers(db: DB): string[] {
  const rows = db
    .prepare('SELECT DISTINCT paper_arxiv_id AS id FROM drafts WHERE paper_arxiv_id IS NOT NULL')
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id).filter(Boolean);
}

export function createRecommendSource(seeds: string[], opts: RecommendOptions = {}): DiscoverySource {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxResults = opts.maxResults ?? 10;
  const delayMs = opts.delayMs ?? 3000;

  return {
    name: 'recommend',
    async fetch(): Promise<Candidate[]> {
      const out: Candidate[] = [];
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        if (i > 0) await sleep(delayMs);
        try {
          const url =
            `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/arXiv:${encodeURIComponent(s)}` +
            `?fields=title,abstract,externalIds&limit=${maxResults}`;
          const res = await fetchFn(url);
          if (!res.ok) continue;
          const body = (await res.json()) as { recommendedPapers?: S2Recommendation[]; data?: S2Recommendation[] };
          for (const rec of body.recommendedPapers ?? body.data ?? []) {
            const arxivId = rec.paper?.externalIds?.ArXiv;
            if (!arxivId) continue; // the pipeline is arXiv only
            out.push({
              arxivId,
              title: rec.paper?.title ?? '',
              abstract: rec.paper?.abstract ?? undefined,
              discoveredVia: 'recommend',
              sourceDetail: `seed: ${s}`,
            });
          }
        } catch {
          continue;
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 5: Extend config with author and seed auto derivation**

In `outreach/src/discovery/config.ts`, add these imports below the existing ones:

```typescript
import { deriveWatchAuthors } from './sources/authorWatch.js';
import { deriveSeedPapers } from './sources/recommend.js';
```

Then replace the `authors` and `seeds` lines in the returned object:

```typescript
    authors: mergeUnique(deriveWatchAuthors(db), raw.authors?.add ?? []),
    seeds: mergeUnique(deriveSeedPapers(db), raw.seeds?.add ?? []),
```

And add this helper above `loadConfig`, replacing the inline dedup loop in the `queries` block with a call to it:

```typescript
function mergeUnique(derived: string[], added: string[]): string[] {
  const out: string[] = [];
  for (const v of [...derived, ...added]) {
    if (v && !out.some((e) => e.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}
```

The `queries` block becomes:

```typescript
  const queries = mergeUnique(derived, raw.queries?.add ?? []);
```

- [ ] **Step 6: Update the config test for the new derivation**

In `outreach/test/discoveryConfig.test.ts`, the fourth test seeds no people or drafts, so `deriveWatchAuthors` and `deriveSeedPapers` return empty and the existing assertions still hold. Add one test to `describe('loadConfig')` confirming derivation merges:

```typescript
  it('merges derived authors with configured ones', () => {
    const db = dbWithGaps([]);
    db.prepare("INSERT INTO people (name) VALUES ('Akshay Sajan')").run();
    const p = writeYaml('authors:\n  add: ["Alexander Wiltschko"]\n');
    expect(loadConfig(db, p).authors).toEqual(['Akshay Sajan', 'Alexander Wiltschko']);
  });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/otherSources.test.ts test/discoveryConfig.test.ts && npm run typecheck`
Expected: all passed, typecheck clean

- [ ] **Step 8: Commit**

```bash
git add outreach/src/discovery/sources/authorWatch.ts outreach/src/discovery/sources/recommend.ts outreach/src/discovery/config.ts outreach/test/otherSources.test.ts outreach/test/discoveryConfig.test.ts
git commit -m "Add author-watch and recommend discovery sources"
```

---

### Task 6: Discovery orchestration with per-source isolation

**Files:**
- Create: `outreach/src/discovery/index.ts`
- Test: `outreach/test/discovery.test.ts`

**Interfaces:**
- Consumes: `DiscoverySource`, `Candidate` from `./types.js`
- Produces: `discoverAll(sources): Promise<{ candidates: Candidate[]; errors: string[] }>`

- [ ] **Step 1: Write the failing test**

Create `outreach/test/discovery.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { discoverAll } from '../src/discovery/index.js';
import type { Candidate, DiscoverySource } from '../src/discovery/types.js';

const cand = (arxivId: string, via: Candidate['discoveredVia']): Candidate => ({
  arxivId,
  title: `Paper ${arxivId}`,
  discoveredVia: via,
  sourceDetail: 'detail',
});

const src = (name: Candidate['discoveredVia'], result: Candidate[] | Error): DiscoverySource => ({
  name,
  fetch: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

describe('discoverAll', () => {
  it('merges candidates from every source', async () => {
    const got = await discoverAll([
      src('saved_query', [cand('2601.00001', 'saved_query')]),
      src('author_watch', [cand('2601.00002', 'author_watch')]),
    ]);
    expect(got.candidates.map((c) => c.arxivId).sort()).toEqual(['2601.00001', '2601.00002']);
    expect(got.errors).toEqual([]);
  });

  it('dedups the same paper found by two sources, keeping the first', async () => {
    const got = await discoverAll([
      src('saved_query', [cand('2601.00001', 'saved_query')]),
      src('recommend', [cand('2601.00001', 'recommend')]),
    ]);
    expect(got.candidates).toHaveLength(1);
    expect(got.candidates[0].discoveredVia).toBe('saved_query');
  });

  it('isolates a throwing source and still returns the others', async () => {
    const got = await discoverAll([
      src('saved_query', new Error('arXiv 429')),
      src('author_watch', [cand('2601.00002', 'author_watch')]),
    ]);
    expect(got.candidates.map((c) => c.arxivId)).toEqual(['2601.00002']);
    expect(got.errors).toHaveLength(1);
    expect(got.errors[0]).toContain('saved_query');
    expect(got.errors[0]).toContain('arXiv 429');
  });

  it('returns empty results when every source fails', async () => {
    const got = await discoverAll([src('saved_query', new Error('down')), src('recommend', new Error('down'))]);
    expect(got.candidates).toEqual([]);
    expect(got.errors).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/discovery.test.ts`
Expected: FAIL, cannot resolve `../src/discovery/index.js`

- [ ] **Step 3: Write the implementation**

Create `outreach/src/discovery/index.ts`:

```typescript
// Runs every discovery source, isolating failures so one dead API cannot sink
// the run, then dedups the merged batch by arXiv id (first source wins).
import type { Candidate, DiscoverySource } from './types.js';

export interface DiscoveryResult {
  candidates: Candidate[];
  errors: string[];
}

export async function discoverAll(sources: DiscoverySource[]): Promise<DiscoveryResult> {
  const settled = await Promise.allSettled(sources.map((s) => s.fetch()));
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  settled.forEach((r, i) => {
    const name = sources[i].name;
    if (r.status === 'rejected') {
      errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    for (const c of r.value) {
      if (seen.has(c.arxivId)) continue;
      seen.add(c.arxivId);
      candidates.push(c);
    }
  });

  return { candidates, errors };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/discovery.test.ts && npm run typecheck`
Expected: 4 passed, typecheck clean

- [ ] **Step 5: Commit**

```bash
git add outreach/src/discovery/index.ts outreach/test/discovery.test.ts
git commit -m "Add discovery orchestration with per-source failure isolation"
```

---

### Task 7: Relevance gate

**Files:**
- Create: `outreach/src/discovery/relevanceGate.ts`
- Test: `outreach/test/relevanceGate.test.ts`

**Interfaces:**
- Consumes: `Candidate` from `./types.js`; `GateConfig` from `./config.js`; `LLMClient` from `../llm/client.js`
- Produces: `scoreOverlap(candidate, terms): number`, `gateCandidate(candidate, terms, gate, llm?): Promise<GateVerdict>` where `GateVerdict = { keep: boolean; score: number; reason: string }`

**Context:** Cheap first cascade. Stage 1 is deterministic term overlap. Only candidates inside `threshold +/- borderlineBand` reach the LLM judge, so clear keeps and clear drops cost nothing.

- [ ] **Step 1: Write the failing test**

Create `outreach/test/relevanceGate.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { gateCandidate, scoreOverlap } from '../src/discovery/relevanceGate.js';
import type { Candidate } from '../src/discovery/types.js';
import type { LLMClient } from '../src/llm/client.js';

const TERMS = ['olfactory embedding space', 'principal odor map', 'gas sensor array'];
const GATE = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3 };

const cand = (title: string, abstract = ''): Candidate => ({
  arxivId: '2601.00001',
  title,
  abstract,
  discoveredVia: 'saved_query',
  sourceDetail: 'query: olfactory embedding space',
});

const llmReturning = (text: string): LLMClient => ({ complete: vi.fn().mockResolvedValue(text) });

describe('scoreOverlap', () => {
  it('scores a full term match at 1', () => {
    expect(scoreOverlap(cand('Olfactory Embedding Space for Robots'), ['olfactory embedding space'])).toBe(1);
  });

  it('scores an unrelated paper at 0', () => {
    expect(scoreOverlap(cand('Distributed Consensus in Byzantine Networks'), TERMS)).toBe(0);
  });

  it('searches the abstract as well as the title', () => {
    expect(scoreOverlap(cand('A Study', 'we build a principal odor map'), TERMS)).toBeGreaterThan(0);
  });

  it('returns 0 when there are no terms', () => {
    expect(scoreOverlap(cand('Anything'), [])).toBe(0);
  });
});

describe('gateCandidate', () => {
  it('keeps a clear match without calling the LLM', async () => {
    const llm = llmReturning('{"score":0.1,"reason":"should not be called"}');
    const v = await gateCandidate(cand('Olfactory Embedding Space for Sensor Arrays'), TERMS, GATE, llm);
    expect(v.keep).toBe(true);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(v.reason).toContain('olfactory embedding space');
  });

  it('drops a clear miss without calling the LLM', async () => {
    const llm = llmReturning('{"score":0.9,"reason":"should not be called"}');
    const v = await gateCandidate(cand('Byzantine Consensus Protocols'), TERMS, GATE, llm);
    expect(v.keep).toBe(false);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(v.reason).toContain('below');
  });

  it('consults the LLM for a borderline score and honours its verdict', async () => {
    const llm = llmReturning('{"score":0.82,"reason":"matches sensor to POM mapping gap"}');
    const borderline = cand('Sensor Arrays', 'partial mention of gas sensor array only');
    const raw = scoreOverlap(borderline, TERMS);
    expect(raw).toBeGreaterThan(GATE.threshold - GATE.borderlineBand);
    expect(raw).toBeLessThan(GATE.threshold + GATE.borderlineBand);
    const v = await gateCandidate(borderline, TERMS, GATE, llm);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(v.keep).toBe(true);
    expect(v.score).toBe(0.82);
    expect(v.reason).toBe('matches sensor to POM mapping gap');
  });

  it('falls back to the deterministic score when the LLM output is unparseable', async () => {
    const llm = llmReturning('not json at all');
    const borderline = cand('Sensor Arrays', 'partial mention of gas sensor array only');
    const v = await gateCandidate(borderline, TERMS, GATE, llm);
    expect(v.score).toBeCloseTo(scoreOverlap(borderline, TERMS), 5);
    expect(v.reason).toContain('judge unavailable');
  });

  it('uses the deterministic score when no LLM is supplied', async () => {
    const borderline = cand('Sensor Arrays', 'partial mention of gas sensor array only');
    const v = await gateCandidate(borderline, TERMS, GATE);
    expect(v.score).toBeCloseTo(scoreOverlap(borderline, TERMS), 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/relevanceGate.test.ts`
Expected: FAIL, cannot resolve `../src/discovery/relevanceGate.js`

- [ ] **Step 3: Write the implementation**

Create `outreach/src/discovery/relevanceGate.ts`:

```typescript
// Two stage gate. Stage 1 is deterministic term overlap against the research
// gap terms. Only borderline scores reach the LLM judge, so clear keeps and
// clear drops cost nothing. Reasons are quoted from real terms, never invented.
import type { LLMClient } from '../llm/client.js';
import type { GateConfig } from './config.js';
import type { Candidate } from './types.js';

export interface GateVerdict {
  keep: boolean;
  score: number;
  reason: string;
}

function haystack(c: Candidate): string {
  return `${c.title} ${c.abstract ?? ''}`.toLowerCase();
}

// Fraction of gap terms present in the title or abstract, weighted so that a
// single strong multi-word match already scores well.
export function scoreOverlap(c: Candidate, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = haystack(c);
  let best = 0;
  let hits = 0;
  for (const term of terms) {
    const t = term.toLowerCase().trim();
    if (!t) continue;
    if (hay.includes(t)) {
      hits++;
      best = Math.max(best, 1);
      continue;
    }
    const words = t.split(/\s+/).filter((w) => w.length > 3);
    if (!words.length) continue;
    const matched = words.filter((w) => hay.includes(w)).length;
    best = Math.max(best, matched / words.length);
  }
  if (hits > 0) return 1;
  return Math.min(1, best);
}

export function matchedTerms(c: Candidate, terms: string[]): string[] {
  const hay = haystack(c);
  return terms.filter((t) => t.trim() && hay.includes(t.toLowerCase().trim()));
}

const JUDGE_SYSTEM = [
  'You judge whether a paper is relevant to a researcher\'s stated open research gaps.',
  'Reply with JSON only: {"score": <0..1>, "reason": "<one short sentence>"}.',
  'Ground the reason in the supplied gap terms. Never invent facts about the paper or the researcher.',
].join(' ');

interface JudgeReply {
  score?: number;
  reason?: string;
}

export async function gateCandidate(
  c: Candidate,
  terms: string[],
  gate: GateConfig,
  llm?: LLMClient,
): Promise<GateVerdict> {
  const raw = scoreOverlap(c, terms);
  const low = gate.threshold - gate.borderlineBand;
  const high = gate.threshold + gate.borderlineBand;

  if (raw >= high) {
    const hit = matchedTerms(c, terms);
    return {
      keep: true,
      score: raw,
      reason: `matches gap term: ${hit.length ? hit.join(', ') : terms[0]}`,
    };
  }
  if (raw <= low) {
    return { keep: false, score: raw, reason: `overlap ${raw.toFixed(2)} below threshold ${gate.threshold}` };
  }

  if (!llm) return { keep: raw >= gate.threshold, score: raw, reason: `borderline ${raw.toFixed(2)}, no judge configured` };

  const user = [
    `Research gaps: ${terms.join('; ')}`,
    `Paper title: ${c.title}`,
    `Paper abstract: ${c.abstract ?? '(none)'}`,
  ].join('\n');

  try {
    const text = await llm.complete(JUDGE_SYSTEM, user);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no json');
    const parsed = JSON.parse(match[0]) as JudgeReply;
    if (typeof parsed.score !== 'number' || Number.isNaN(parsed.score)) throw new Error('no score');
    return {
      keep: parsed.score >= gate.threshold,
      score: parsed.score,
      reason: parsed.reason?.trim() || `judge scored ${parsed.score.toFixed(2)}`,
    };
  } catch {
    return { keep: raw >= gate.threshold, score: raw, reason: `borderline ${raw.toFixed(2)}, judge unavailable` };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/relevanceGate.test.ts && npm run typecheck`
Expected: 10 passed, typecheck clean

If the borderline assertions in step 1 fail because the fixture scores outside the band, adjust the fixture abstract text (not the implementation) until `scoreOverlap` lands strictly between `low` and `high`, then rerun.

- [ ] **Step 5: Commit**

```bash
git add outreach/src/discovery/relevanceGate.ts outreach/test/relevanceGate.test.ts
git commit -m "Add two-stage relevance gate with cheap-first cascade"
```

---

### Task 8: Approval channel seam, stub, and Photon adapter

**Files:**
- Create: `outreach/src/approval/channel.ts`
- Create: `outreach/src/approval/photonChannel.ts`
- Test: `outreach/test/channel.test.ts`

**Interfaces:**
- Consumes: `spectrum-ts`, `PersistedDraft` shape from `./ledger.js`
- Produces: `ApprovalChannel`, `OutboundDraftMessage`, `InboundReply`, `ParsedReply`; `parseReply(text): ParsedReply`; `createStubChannel(): StubChannel`; `createPhotonChannel(opts): Promise<ApprovalChannel>`

**Scope reminder:** approve and skip only. Edit replies parse to `{ kind: 'unsupported' }`.

- [ ] **Step 1: Write the failing test**

Create `outreach/test/channel.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createStubChannel, parseReply } from '../src/approval/channel.js';

describe('parseReply', () => {
  it('parses approvals with a short id', () => {
    expect(parseReply('yes d7')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('  Y D7 ')).toEqual({ kind: 'approve', shortId: 'd7' });
    expect(parseReply('send d12')).toEqual({ kind: 'approve', shortId: 'd12' });
  });

  it('parses skips', () => {
    expect(parseReply('skip d7')).toEqual({ kind: 'skip', shortId: 'd7' });
    expect(parseReply('n d7')).toEqual({ kind: 'skip', shortId: 'd7' });
    expect(parseReply('no d7')).toEqual({ kind: 'skip', shortId: 'd7' });
  });

  it('accepts a bare id as approval', () => {
    expect(parseReply('d7')).toEqual({ kind: 'approve', shortId: 'd7' });
  });

  it('treats an edit instruction as unsupported, not as approval', () => {
    expect(parseReply('d7 make it shorter')).toEqual({ kind: 'unsupported', shortId: 'd7' });
  });

  it('returns unparseable for text with no short id', () => {
    expect(parseReply('what is this')).toEqual({ kind: 'unparseable' });
  });
});

describe('createStubChannel', () => {
  it('records sent messages and replays queued replies', async () => {
    const ch = createStubChannel();
    await ch.sendDraftMessage({ shortId: 'd7', subject: 's', body: 'b', to: 'x@y.z', personName: 'X' });
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0].shortId).toBe('d7');

    ch.queueReply('yes d7');
    expect(await ch.captureReplies(0)).toEqual([{ text: 'yes d7', messageId: 'stub-1' }]);
    expect(await ch.captureReplies(0)).toEqual([]);
  });

  it('records notices', async () => {
    const ch = createStubChannel();
    await ch.notify('seen 3, messaged 1');
    expect(ch.notices).toEqual(['seen 3, messaged 1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/channel.test.ts`
Expected: FAIL, cannot resolve `../src/approval/channel.js`

- [ ] **Step 3: Write the seam and the stub**

Create `outreach/src/approval/channel.ts`:

```typescript
// The approval channel seam. This plan implements approve and skip only; F5
// (docs/spec-imessage-approval-loop.md) owns the edit path and will implement
// this same interface.
import { parseShortId, formatShortId } from './ids.js';

export interface OutboundDraftMessage {
  shortId: string;
  subject: string;
  body: string;
  to: string;
  personName: string;
}

export interface InboundReply {
  text: string;
  messageId: string;
}

export type ParsedReply =
  | { kind: 'approve'; shortId: string }
  | { kind: 'skip'; shortId: string }
  | { kind: 'unsupported'; shortId: string }
  | { kind: 'unparseable' };

export interface ApprovalChannel {
  sendDraftMessage(msg: OutboundDraftMessage): Promise<void>;
  notify(text: string): Promise<void>;
  captureReplies(windowMs: number): Promise<InboundReply[]>;
  close?(): Promise<void>;
}

const APPROVE = new Set(['y', 'yes', 'send', 'ok', 'approve']);
const SKIP = new Set(['n', 'no', 'skip', 'reject']);

export function parseReply(text: string): ParsedReply {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { kind: 'unparseable' };

  let shortId: string | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    const id = parseShortId(t);
    if (id !== null && shortId === undefined) shortId = formatShortId(id);
    else rest.push(t);
  }
  if (shortId === undefined) return { kind: 'unparseable' };

  if (rest.length === 0) return { kind: 'approve', shortId };
  if (rest.length === 1 && APPROVE.has(rest[0])) return { kind: 'approve', shortId };
  if (rest.length === 1 && SKIP.has(rest[0])) return { kind: 'skip', shortId };
  return { kind: 'unsupported', shortId }; // an edit instruction: F5 owns this
}

export interface StubChannel extends ApprovalChannel {
  sent: OutboundDraftMessage[];
  notices: string[];
  queueReply(text: string): void;
}

export function createStubChannel(): StubChannel {
  const sent: OutboundDraftMessage[] = [];
  const notices: string[] = [];
  let pending: InboundReply[] = [];
  let n = 0;
  return {
    sent,
    notices,
    queueReply(text: string) {
      pending.push({ text, messageId: `stub-${++n}` });
    },
    async sendDraftMessage(msg) {
      sent.push(msg);
    },
    async notify(text) {
      notices.push(text);
    },
    async captureReplies() {
      const out = pending;
      pending = [];
      return out;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/channel.test.ts`
Expected: 7 passed

`parseShortId` returns `number | null` (it matches `/^[dD]?(\d+)$/`), so non-id tokens like `yes` return null and fall through to `rest`. No try/catch is needed.

- [ ] **Step 5: Write the Photon adapter**

Create `outreach/src/approval/photonChannel.ts`:

```typescript
// Real iMessage transport over Photon Spectrum. Mirrors the proven spike in
// scripts/spike-photon.ts, including the sender allowlist (AL3): a shared
// service line can receive strangers' texts, and reacting to them would make
// this an open reflector.
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers';
import type { ApprovalChannel, InboundReply, OutboundDraftMessage } from './channel.js';

export interface PhotonOptions {
  projectId: string;
  projectSecret: string;
  approverPhone: string;
}

export function photonOptionsFromEnv(): PhotonOptions {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  const approverPhone = process.env.APPROVER_PHONE;
  if (!projectId || !projectSecret || !approverPhone) {
    throw new Error('SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET / APPROVER_PHONE missing (use --env-file=.env)');
  }
  return { projectId, projectSecret, approverPhone };
}

export function formatDraftMessage(msg: OutboundDraftMessage): string {
  return [
    `${msg.shortId}: ${msg.personName} (${msg.to})`,
    `Subject: ${msg.subject}`,
    '',
    msg.body,
    '',
    `Reply "${msg.shortId} y" to send, "${msg.shortId} n" to skip.`,
  ].join('\n');
}

export async function createPhotonChannel(opts: PhotonOptions): Promise<ApprovalChannel> {
  const app = await Spectrum({
    projectId: opts.projectId,
    projectSecret: opts.projectSecret,
    platforms: [imessage.config()],
  });
  const im = imessage(app);
  const approver = await im.user(opts.approverPhone);
  const dm = await im.space.create(approver);

  return {
    async sendDraftMessage(msg) {
      await dm.send(formatDraftMessage(msg));
    },
    async notify(text) {
      await dm.send(text);
    },
    // Drains inbound for a bounded window, then returns. The loop is a batch
    // job: replies that arrive later are picked up by the next run.
    async captureReplies(windowMs: number): Promise<InboundReply[]> {
      const out: InboundReply[] = [];
      const deadline = Date.now() + windowMs;
      const iterator = app.messages[Symbol.asyncIterator]();
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const next = await Promise.race([
          iterator.next(),
          new Promise<null>((r) => setTimeout(() => r(null), remaining)),
        ]);
        if (!next || next.done) break;
        const [, message] = next.value as [unknown, { id: string; sender?: { id?: string }; content?: { type?: string; text?: string } }];
        if (message.sender?.id !== opts.approverPhone) continue; // allowlist
        if (message.content?.type !== 'text' || !message.content.text) continue;
        out.push({ text: message.content.text, messageId: message.id });
      }
      return out;
    },
    async close() {
      await (app as unknown as { close?: () => Promise<void> }).close?.();
    },
  };
}
```

- [ ] **Step 6: Verify typecheck**

Run: `cd outreach && npm run typecheck`
Expected: clean. If `spectrum-ts` types disagree with the `app.messages` access, keep the runtime shape from `scripts/spike-photon.ts` and narrow with a local `as` cast rather than changing behaviour.

- [ ] **Step 7: Commit**

```bash
git add outreach/src/approval/channel.ts outreach/src/approval/photonChannel.ts outreach/test/channel.test.ts
git commit -m "Add approval channel seam with stub and Photon iMessage adapter"
```

---

### Task 9: The loop orchestrator

**Files:**
- Create: `outreach/src/pipeline/loop.ts`
- Test: `outreach/test/loop.test.ts`

**Interfaces:**
- Consumes: `discoverAll`, `filterUnseen`, `recordDiscovered`, `setStatus`, `setRelevance`, `getQueued`, `gateCandidate`, `loadConfig`, `processPaper`, `generateDraft`, `persistDraft`, `decide`, `markSent`, `markSendFailed`, `priorThreads`, `parseReply`, `ApprovalChannel`, `Sender`
- Produces: `runLoop(deps, opts): Promise<LoopSummary>`

**Context:** This is the only task that composes everything. Read the design spec's run flow (Section 4) before starting.

- [ ] **Step 1: Write the failing test**

Create `outreach/test/loop.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { runLoop } from '../src/pipeline/loop.js';
import { createStubChannel } from '../src/approval/channel.js';
import { persistDraft } from '../src/approval/ledger.js';
import type { Candidate, DiscoverySource } from '../src/discovery/types.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';
import type { OrchestrateResult } from '../src/pipeline/orchestrate.js';

const GATE = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3 };

const cand = (arxivId: string, title: string): Candidate => ({
  arxivId,
  title,
  abstract: title,
  discoveredVia: 'saved_query',
  sourceDetail: 'query: olfactory embedding space',
});

const source = (cs: Candidate[]): DiscoverySource => ({ name: 'saved_query', fetch: async () => cs });

const groundedDraft: Draft = { subject: 'a subject', body: 'a body', grounded: true, wordCount: 2, notes: [] };
const draftInput: DraftInput = {
  recipient: { name: 'Someone', paperTitle: 'T' },
  hooks: [],
  intent: 'seeking direction',
  senderName: 'Aditya Gupta',
};

function baseDeps(db: ReturnType<typeof openDb>, overrides: Partial<Parameters<typeof runLoop>[0]> = {}) {
  const channel = createStubChannel();
  return {
    deps: {
      db,
      channel,
      config: { queries: ['olfactory embedding space'], authors: [], seeds: [], gate: GATE },
      sources: [source([])],
      terms: ['olfactory embedding space'],
      processPaper: vi.fn(),
      generateDraft: vi.fn().mockResolvedValue(groundedDraft),
      buildDraftInput: () => draftInput,
      sender: { send: vi.fn().mockResolvedValue({ sentId: 'msg-1' }) },
      ...overrides,
    },
    channel,
  };
}

const resolvedResult = (arxivId: string, personId: number): OrchestrateResult => ({
  arxivId,
  target: 'Someone',
  paperTitle: 'A Paper',
  resolved: true,
  email: { email: 'someone@uni.edu', confidence: 0.9, source: 'homepage' } as OrchestrateResult['email'],
  personId,
  factCount: 10,
  hooks: [{ tier: 'A' } as never],
  noStrongHook: false,
  notes: [],
});

describe('runLoop discovery', () => {
  it('filters a low relevance candidate without drafting it', async () => {
    const db = openDb(':memory:');
    const { deps } = baseDeps(db, { sources: [source([cand('2601.00001', 'Byzantine Consensus Protocols')])] });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.filtered).toBe(1);
    expect(deps.processPaper).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00001') as { status: string };
    expect(row.status).toBe('filtered_low_relevance');
  });

  it('marks a relevant paper unsendable when no email resolves', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const noEmail = { ...resolvedResult('2601.00002', pid), email: null };
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00002', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(noEmail),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.unsendable).toBe(1);
    expect(channel.sent).toHaveLength(0);
    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00002') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('email');
  });

  it('messages a sendable draft and records it', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00003', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00003', pid)),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].to).toBe('someone@uni.edu');
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00003') as { status: string };
    expect(row.status).toBe('messaged');
  });

  it('queues sendable drafts beyond the per-run cap', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const cands = ['2601.00010', '2601.00011'].map((id) => cand(id, 'Olfactory Embedding Space Sensors'));
    const { deps, channel } = baseDeps(db, {
      config: { queries: [], authors: [], seeds: [], gate: { ...GATE, maxMessagesPerRun: 1 } },
      sources: [source(cands)],
      processPaper: vi.fn(async (_d: unknown, id: string) => resolvedResult(id, pid)),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(1);
    expect(channel.sent).toHaveLength(1);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM seen_papers WHERE status = 'queued_for_message'").get() as {
      n: number;
    };
    expect(queued.n).toBe(1);
  });

  it('dry run messages nothing and sends nothing', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00004', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00004', pid)),
    });
    const summary = await runLoop(deps, { dryRun: true });
    expect(channel.sent).toHaveLength(0);
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
  });

  it('skips a person who already has a thread', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2500.00001',
      paperTitle: 'Earlier',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00005', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00005', pid)),
    });
    await runLoop(deps, { dryRun: false });
    expect(channel.sent).toHaveLength(0);
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00005') as { reason: string };
    expect(row.reason).toContain('prior thread');
  });
});

describe('runLoop approvals', () => {
  it('sends the email when the reply approves', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00006',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const { deps, channel } = baseDeps(db);
    channel.queueReply(`${p.shortId} y`);
    const summary = await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(1);
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('sent');
  });

  it('does not send when the reply skips', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00007',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const { deps, channel } = baseDeps(db);
    channel.queueReply(`${p.shortId} n`);
    await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('skipped');
  });

  it('answers an edit reply with a not-supported notice and does not send', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00008',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const { deps, channel } = baseDeps(db);
    channel.queueReply(`${p.shortId} make it shorter`);
    await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(channel.notices.join(' ')).toContain('not yet supported');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd outreach && npx vitest run test/loop.test.ts`
Expected: FAIL, cannot resolve `../src/pipeline/loop.js`

- [ ] **Step 3: Write the implementation**

Create `outreach/src/pipeline/loop.ts`:

```typescript
// One full outreach cycle, then exit. Order matters: approvals drain first so a
// reply to yesterday's message is acted on before today's discovery adds more.
// Spec: docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md
import type { DB } from '../db/db.js';
import { getPerson } from '../db/db.js';
import type { ApprovalChannel } from '../approval/channel.js';
import { parseReply } from '../approval/channel.js';
import { decide, markSendFailed, markSent, persistDraft, priorThreads, logEvent } from '../approval/ledger.js';
import { parseShortId } from '../approval/ids.js';
import type { LoopConfig } from '../discovery/config.js';
import { discoverAll } from '../discovery/index.js';
import { filterUnseen, getQueued, recordDiscovered, setRelevance, setStatus } from '../discovery/seenLedger.js';
import { gateCandidate } from '../discovery/relevanceGate.js';
import type { Candidate, DiscoverySource } from '../discovery/types.js';
import type { Draft, DraftInput } from './draft.js';
import type { OrchestrateResult } from './orchestrate.js';
import type { Sender } from '../sender/types.js';
import type { LLMClient } from '../llm/client.js';

export interface LoopDeps {
  db: DB;
  channel: ApprovalChannel;
  config: LoopConfig;
  sources: DiscoverySource[];
  terms: string[];
  processPaper: (deps: unknown, arxivId: string) => Promise<OrchestrateResult>;
  generateDraft: (llm: LLMClient, input: DraftInput) => Promise<Draft>;
  buildDraftInput: (r: OrchestrateResult) => DraftInput;
  sender: Sender;
  llm?: LLMClient;
  orchestrateDeps?: unknown;
  replyWindowMs?: number;
  senderEmail?: string; // OutboundEmail.from; defaults to SENDER_EMAIL
}

export interface LoopOptions {
  dryRun: boolean;
}

export interface LoopSummary {
  dryRun: boolean;
  sent: number;
  seen: number;
  filtered: number;
  unsendable: number;
  messaged: number;
  queued: number;
  errors: string[];
}

async function drainApprovals(deps: LoopDeps, opts: LoopOptions, summary: LoopSummary): Promise<void> {
  const replies = await deps.channel.captureReplies(deps.replyWindowMs ?? 0);
  for (const reply of replies) {
    const parsed = parseReply(reply.text);
    if (parsed.kind === 'unparseable') {
      await deps.channel.notify(`Could not read "${reply.text}". Reply like "d7 y" or "d7 n".`);
      continue;
    }
    const draftId = parseShortId(parsed.shortId);
    if (draftId === null) continue;

    if (parsed.kind === 'unsupported') {
      // Edits are F5 territory (docs/spec-imessage-approval-loop.md).
      logEvent(deps.db, draftId, 'edit_reply_unsupported', { text: reply.text });
      await deps.channel.notify(`Edits are not yet supported for ${parsed.shortId}. Reply "y" to send or "n" to skip.`);
      continue;
    }

    if (parsed.kind === 'skip') {
      const res = decide(deps.db, draftId, 'skip', 'imessage');
      await deps.channel.notify(
        res.applied ? `${parsed.shortId} skipped.` : `${parsed.shortId} was already ${res.existing.action}.`,
      );
      continue;
    }

    const res = decide(deps.db, draftId, 'send', 'imessage');
    if (!res.applied) {
      await deps.channel.notify(`${parsed.shortId} was already ${res.existing.action}.`);
      continue;
    }
    if (opts.dryRun) {
      await deps.channel.notify(`${parsed.shortId} approved (dry run, nothing sent).`);
      continue;
    }

    const row = deps.db
      .prepare(
        `SELECT d.person_id AS personId, r.subject AS subject, r.body AS body
         FROM drafts d JOIN revisions r ON r.id = d.sendable_revision_id
         WHERE d.id = ?`,
      )
      .get(draftId) as { personId: number; subject: string; body: string } | undefined;
    if (!row) {
      await deps.channel.notify(`${parsed.shortId} has no grounded revision to send.`);
      continue;
    }
    const person = getPerson(deps.db, row.personId);
    if (!person?.email) {
      await deps.channel.notify(`${parsed.shortId} has no email on record.`);
      continue;
    }
    try {
      const { sentId } = await deps.sender.send({
        to: person.email,
        from: deps.senderEmail ?? process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
        subject: row.subject,
        body: row.body,
        draftShortId: parsed.shortId,
      });
      markSent(deps.db, draftId, sentId);
      summary.sent++;
      await deps.channel.notify(`${parsed.shortId} sent to ${person.email}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      markSendFailed(deps.db, draftId, msg);
      await deps.channel.notify(`${parsed.shortId} failed to send: ${msg}`);
    }
  }
}

// Emits a sendable draft, or queues it when the per-run cap is already spent.
async function emit(
  deps: LoopDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  c: Candidate,
  shortId: string,
  subject: string,
  body: string,
  to: string,
  personName: string,
): Promise<void> {
  if (summary.messaged >= deps.config.gate.maxMessagesPerRun) {
    setStatus(deps.db, c.arxivId, 'queued_for_message', 'deferred by max_messages_per_run');
    summary.queued++;
    return;
  }
  if (opts.dryRun) {
    setStatus(deps.db, c.arxivId, 'queued_for_message', 'dry run, not messaged');
    summary.queued++;
    return;
  }
  await deps.channel.sendDraftMessage({ shortId, subject, body, to, personName });
  setStatus(deps.db, c.arxivId, 'messaged');
  summary.messaged++;
}

async function processCandidate(
  deps: LoopDeps,
  opts: LoopOptions,
  summary: LoopSummary,
  c: Candidate,
): Promise<void> {
  const verdict = await gateCandidate(c, deps.terms, deps.config.gate, deps.llm);
  setRelevance(deps.db, c.arxivId, verdict.score);
  if (!verdict.keep) {
    setStatus(deps.db, c.arxivId, 'filtered_low_relevance', verdict.reason);
    summary.filtered++;
    return;
  }

  let result: OrchestrateResult;
  try {
    result = await deps.processPaper(deps.orchestrateDeps, c.arxivId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', `pipeline failed: ${msg}`);
    summary.unsendable++;
    summary.errors.push(`${c.arxivId}: ${msg}`);
    return;
  }

  if (!result.personId) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'identity unconfirmed');
    summary.unsendable++;
    return;
  }
  if (!result.email) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no email resolved');
    summary.unsendable++;
    return;
  }
  if (result.noStrongHook || result.hooks.length === 0) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', 'no grounded hook');
    summary.unsendable++;
    return;
  }
  const prior = priorThreads(deps.db, result.personId);
  if (prior.length > 0) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', `prior thread exists (${prior[0].shortId})`);
    summary.unsendable++;
    return;
  }

  const input = deps.buildDraftInput(result);
  const draft = await deps.generateDraft(deps.llm as LLMClient, input);
  if (!draft.grounded) {
    setStatus(deps.db, c.arxivId, 'drafted_unsendable', `grounding failed: ${draft.notes.join('; ')}`);
    summary.unsendable++;
    return;
  }

  const persisted = persistDraft(deps.db, {
    personId: result.personId,
    paperArxivId: result.arxivId,
    paperTitle: result.paperTitle,
    intent: input.intent,
    draftInput: input,
    draft,
    contextJson: { discoveredVia: c.discoveredVia, sourceDetail: c.sourceDetail, relevance: verdict.score },
  });
  setStatus(deps.db, c.arxivId, 'discovered', verdict.reason, persisted.draftId);
  await emit(deps, opts, summary, c, persisted.shortId, draft.subject, draft.body, result.email.email, result.target);
}

export async function runLoop(deps: LoopDeps, opts: LoopOptions): Promise<LoopSummary> {
  const summary: LoopSummary = {
    dryRun: opts.dryRun,
    sent: 0,
    seen: 0,
    filtered: 0,
    unsendable: 0,
    messaged: 0,
    queued: 0,
    errors: [],
  };

  await drainApprovals(deps, opts, summary);

  // Queued drafts from earlier runs go out before anything newly discovered.
  if (!opts.dryRun) {
    for (const q of getQueued(deps.db, deps.config.gate.maxMessagesPerRun)) {
      if (summary.messaged >= deps.config.gate.maxMessagesPerRun) break;
      const row = deps.db
        .prepare(
          `SELECT d.short_id AS shortId, d.person_id AS personId, r.subject AS subject, r.body AS body
           FROM seen_papers s JOIN drafts d ON d.id = s.draft_id
           JOIN revisions r ON r.id = d.sendable_revision_id
           WHERE s.arxiv_id = ?`,
        )
        .get(q.arxivId) as { shortId: string; personId: number; subject: string; body: string } | undefined;
      if (!row) continue;
      const person = getPerson(deps.db, row.personId);
      if (!person?.email) continue;
      await deps.channel.sendDraftMessage({
        shortId: row.shortId,
        subject: row.subject,
        body: row.body,
        to: person.email,
        personName: person.name,
      });
      setStatus(deps.db, q.arxivId, 'messaged');
      summary.messaged++;
    }
  }

  const discovered = await discoverAll(deps.sources);
  summary.errors.push(...discovered.errors);

  const fresh = filterUnseen(deps.db, discovered.candidates);
  summary.seen = fresh.length;
  for (const c of fresh) recordDiscovered(deps.db, c);

  for (const c of fresh) {
    await processCandidate(deps, opts, summary, c);
  }

  const line =
    `outreach loop${opts.dryRun ? ' (dry run)' : ''}: seen ${summary.seen}, filtered ${summary.filtered}, ` +
    `unsendable ${summary.unsendable}, messaged ${summary.messaged}, queued ${summary.queued}, sent ${summary.sent}` +
    (summary.errors.length ? `, errors: ${summary.errors.join(' | ')}` : '');
  await deps.channel.notify(line);

  return summary;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd outreach && npx vitest run test/loop.test.ts && npm run typecheck`
Expected: 9 passed, typecheck clean

- [ ] **Step 5: Run the whole suite for regressions**

Run: `cd outreach && npm test`
Expected: all previously passing tests still pass (175 plus the new ones)

- [ ] **Step 6: Commit**

```bash
git add outreach/src/pipeline/loop.ts outreach/test/loop.test.ts
git commit -m "Add outreach loop orchestrator"
```

---

### Task 10: CLI wiring, launchd schedule, and live dry run

**Files:**
- Modify: `outreach/src/cli.ts`
- Create: `outreach/scripts/com.aditya.outreach.plist`
- Modify: `outreach/config/watchlist.example.yaml` (no change if already correct)

**Interfaces:**
- Consumes: everything above
- Produces: `outreach loop [--dry-run] [--once]` command

- [ ] **Step 1: Read the existing CLI**

Run: `cd outreach && grep -n "process.argv\|async function main\|case '\|command" src/cli.ts | head -40`

Note the existing command dispatch shape and the existing `makeSender()` helper. Follow that structure exactly rather than inventing a new one.

- [ ] **Step 2: Add the loop command**

`outreach/src/cli.ts` already imports `processPaper`, `generateDraft`, `createTavilyClient`, `createOpenRouterClient`, `openDb`, and `makeSender`, and already defines `const DB_PATH = process.env.OUTREACH_DB ?? 'data/outreach.db'`. Reuse all of those. Add only these new imports:

```typescript
import { runLoop } from './pipeline/loop.js';
import { loadConfig } from './discovery/config.js';
import { createSavedQuerySource } from './discovery/sources/savedQuery.js';
import { createAuthorWatchSource } from './discovery/sources/authorWatch.js';
import { createRecommendSource } from './discovery/sources/recommend.js';
import { createStubChannel } from './approval/channel.js';
import { createPhotonChannel, photonOptionsFromEnv } from './approval/photonChannel.js';
```

Then add a `loop` branch to the command dispatch:

```typescript
async function cmdLoop(argv: string[]): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const db = openDb(DB_PATH);
  const config = loadConfig(db);
  const llm = createOpenRouterClient();

  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set');
  const tavily = createTavilyClient(tavilyKey);

  const sources = [
    createSavedQuerySource(config.queries),
    createAuthorWatchSource(config.authors),
    createRecommendSource(config.seeds),
  ];

  // A dry run must never touch the real iMessage thread.
  const channel = dryRun ? createStubChannel() : await createPhotonChannel(photonOptionsFromEnv());

  const summary = await runLoop(
    {
      db,
      channel,
      config,
      sources,
      terms: config.queries,
      processPaper,
      generateDraft,
      buildDraftInput: (r) => ({
        recipient: { name: r.target, paperTitle: r.paperTitle },
        hooks: r.hooks,
        intent: 'seeking direction',
        senderName: 'Aditya Gupta',
      }),
      sender: makeSender(),
      senderEmail: process.env.SENDER_EMAIL ?? 'apgupta3@asu.edu',
      llm,
      orchestrateDeps: { db, search: tavily, fetcher: tavily, llm },
      replyWindowMs: dryRun ? 0 : 20000,
    },
    { dryRun },
  );

  console.log(JSON.stringify(summary, null, 2));
  await channel.close?.();
}
```

Register the command in the dispatch block the same way `add` is registered, matching the file's existing style.

- [ ] **Step 3: Typecheck and run the full suite**

Run: `cd outreach && npm run typecheck && npm test`
Expected: clean typecheck, all tests pass

- [ ] **Step 4: Live dry run against the real database**

Run: `cd outreach && npx tsx --env-file=.env src/cli.ts loop --dry-run`

Expected: a JSON summary printed with `"dryRun": true`. Confirm all of the following before continuing:
- `sent` is `0`
- no iMessage arrived on the phone
- `seen` is greater than `0` (if it is `0`, discovery found nothing; check `deriveGapQueries` output from Task 2 step 5 before assuming this is correct)

Inspect what the loop decided:

```bash
cd outreach && npx tsx -e "import{openDb}from'./src/db/db.js';const d=openDb('data/outreach.db');console.table(d.prepare('SELECT arxiv_id,status,ROUND(relevance,2) rel,substr(reason,1,60) reason FROM seen_papers ORDER BY relevance DESC LIMIT 20').all())"
```

Expected: a table where every row has a status and a reason explaining why it stopped there.

- [ ] **Step 5: Commit the CLI wiring**

```bash
git add outreach/src/cli.ts
git commit -m "Wire outreach loop command with dry-run support"
```

- [ ] **Step 6: Write the launchd schedule**

Create `outreach/scripts/com.aditya.outreach.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aditya.outreach</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd REPLACE_WITH_ABSOLUTE_PATH/outreach &amp;&amp; npx tsx --env-file=.env src/cli.ts loop</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>REPLACE_WITH_ABSOLUTE_PATH/outreach/data/loop.log</string>
  <key>StandardErrorPath</key>
  <string>REPLACE_WITH_ABSOLUTE_PATH/outreach/data/loop.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
```

Do not install it yet. Installation is a separate deliberate act:

```bash
# only after a successful live dry run and one successful real run
sed -i '' "s|REPLACE_WITH_ABSOLUTE_PATH|$(cd .. && pwd)|g" scripts/com.aditya.outreach.plist
cp scripts/com.aditya.outreach.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.aditya.outreach.plist
```

- [ ] **Step 7: Commit**

```bash
git add outreach/scripts/com.aditya.outreach.plist
git commit -m "Add launchd schedule for the daily outreach loop"
```

---

## Post-Implementation Checklist

- [ ] `npm test` passes from `outreach/`
- [ ] `npm run typecheck` is clean
- [ ] `outreach loop --dry-run` produces a summary with `sent: 0` and sends no iMessage
- [ ] `seen_papers` has a status and reason for every row
- [ ] One real (non dry run) loop has been observed end to end before `launchctl load`

## Deferred to other specs

- **Inline edits** with revision re-grounding: F5, `docs/spec-imessage-approval-loop.md`
- **Edit learning** from approvals and edits: `docs/spec-edit-learning.md`
- **Eval sets** for the relevance gate and draft groundedness: run the `product-agnostic-eval-guide` plugin against the labeled seeds in `people` (Zanineli and Sajan as positives, Sinigaglia and Zhang as hard negatives)
