-- Profile-mining persistence (D11). Applied idempotently on first open.

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  openalex_id TEXT UNIQUE,                -- stable dedup key; NULL until resolved
  email TEXT, email_confidence REAL, email_source TEXT,
  affiliation TEXT, role TEXT,
  scholar_url TEXT, homepage_url TEXT, github_url TEXT,
  profile_summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ontology_facts (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,   -- NULL = self (persona subsystem)
  facet TEXT CHECK(facet IN ('academic','trajectory','interest')),
  key TEXT, value TEXT, detail TEXT, source_url TEXT,
  stance TEXT,   -- 'done' | 'exploring' | NULL (honesty marker; NULL = done)
  confidence REAL,
  usability_tier TEXT CHECK(usability_tier IN ('A','B','C')),
  retrieved_at TEXT DEFAULT (datetime('now')),
  -- Accumulate strategy (D11): the same fact re-seen upserts (refreshes
  -- retrieved_at) rather than inserting a duplicate.
  UNIQUE(person_id, facet, key, value)
);

CREATE INDEX IF NOT EXISTS idx_facts_person ON ontology_facts(person_id);

CREATE TABLE IF NOT EXISTS intersections (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  -- Intersections are derived: replacing a fact (e.g. a persona rebuild swapping
  -- the self ontology) invalidates any intersection built on it, so cascade.
  self_fact_id INTEGER REFERENCES ontology_facts(id) ON DELETE CASCADE,
  person_fact_id INTEGER REFERENCES ontology_facts(id) ON DELETE CASCADE,
  strength REAL,
  tier TEXT CHECK(tier IN ('A','B','C')),
  rationale TEXT
);

-- F5 approval loop (AL4). drafts + revisions are the edit-learning read contract
-- (docs/spec-edit-learning.md); do not rename without updating learning/.
-- MVP addition: decisions.via includes 'cli' (terminal approval, pre-iMessage).

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,   -- NEVER DELETE rows: short IDs are 'd'+id and rowids
                            -- can be reused after a max-rowid delete (AL5)
  short_id TEXT NOT NULL UNIQUE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  paper_arxiv_id TEXT,
  paper_title TEXT,
  intent TEXT,
  gist TEXT NOT NULL DEFAULT '',
  draft_input_json TEXT NOT NULL,
  sendable_revision_id INTEGER REFERENCES revisions(id),
  status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN
    ('awaiting_approval','approved','sent (stubbed)','sent','skipped')),
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  rev_no INTEGER NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('model','human')),
  prior_revision_id INTEGER REFERENCES revisions(id),
  instruction TEXT,
  context_json TEXT NOT NULL,
  grounded INTEGER NOT NULL DEFAULT 0,
  grounding_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(draft_id, rev_no)
);

-- One row per decided draft. UNIQUE(draft_id) IS the A9 first-write-wins guarantee.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL UNIQUE REFERENCES drafts(id),
  action TEXT NOT NULL CHECK(action IN ('send','skip')),
  reason TEXT,
  via TEXT NOT NULL CHECK(via IN ('imessage','web','cli')),
  created_at TEXT DEFAULT (datetime('now'))
);

-- Append-only event log (A6). draft_id NULL for non-draft events.
CREATE TABLE IF NOT EXISTS draft_events (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER REFERENCES drafts(id),
  type TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_draft ON draft_events(draft_id);
