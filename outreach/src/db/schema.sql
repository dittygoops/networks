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
  -- The approved recipient, frozen at draft creation next to the already-frozen
  -- subject and body in revisions (D2). people.email is mutable: upsertPerson
  -- coalesces a new non-null value in every time another paper by the same
  -- author is discovered, so resolving the address fresh at send time can mail
  -- an address no human ever approved. Guarded ALTER in db.ts covers a database
  -- created before this column existed.
  to_email TEXT,
  -- At-most-once send claim (D1). Written and COMMITTED BEFORE the network
  -- call, so a send that times out after Gmail accepted it still leaves the
  -- claim behind and no automatic path can re-send it. Never cleared by a
  -- failure; clearing it is a deliberate human act (see the send-path plan).
  send_attempted_at TEXT,
  send_attempts INTEGER NOT NULL DEFAULT 0,
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
  -- Bounds how many times the resume step will retry a row stuck at
  -- 'discovered' (docs/spec-candidate-stranding.md, CS3). Guarded ALTER in
  -- db.ts covers a database created before this column existed.
  attempts INTEGER NOT NULL DEFAULT 0,
  -- The gate scores title plus abstract; a resumed row reconstructed without
  -- one would score lower than it did fresh (CS1.3). Guarded ALTER in db.ts.
  abstract TEXT,
  first_seen_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_seen_status ON seen_papers(status);
CREATE INDEX IF NOT EXISTS idx_seen_resume ON seen_papers(status, first_seen_at);
