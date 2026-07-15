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
  key TEXT, value TEXT, source_url TEXT,
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
  self_fact_id INTEGER REFERENCES ontology_facts(id),
  person_fact_id INTEGER REFERENCES ontology_facts(id),
  strength REAL,
  tier TEXT CHECK(tier IN ('A','B','C')),
  rationale TEXT
);
