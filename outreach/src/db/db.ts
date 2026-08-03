// Profile-mining persistence (D11): a thin SQLite data layer. No network/LLM.
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { OntologyFact } from '../pipeline/research.js';

export type DB = Database.Database;

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

// Open (or create) the database and apply the schema idempotently. Pass
// ':memory:' for tests.
export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(schemaPath, 'utf8'));
  migrateSeenPapers(db);
  migrateDrafts(db);
  return db;
}

// schema.sql is applied with CREATE TABLE IF NOT EXISTS, which is a no-op on
// an existing database, so an edit to the CREATE TABLE body (the attempts and
// abstract columns added for docs/spec-candidate-stranding.md) never reaches
// a live file. This guarded ALTER is the only way those columns land on a
// database created before they existed; it is idempotent, so it is safe to
// run on every open.
function migrateSeenPapers(db: DB): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(seen_papers)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has('attempts')) db.exec('ALTER TABLE seen_papers ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('abstract')) db.exec('ALTER TABLE seen_papers ADD COLUMN abstract TEXT');
}

// Same mechanism as migrateSeenPapers, for the send-path columns (D1/D2).
// schema.sql cannot reach an existing database, so this guarded ALTER is the
// only way to_email / send_attempted_at / send_attempts land on the live file.
// Idempotent, so it is safe on every open.
//
// The backfills run exactly once each, inside the branch that adds the column,
// so a later change to people.email can never silently rewrite a snapshot.
function migrateDrafts(db: DB): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((c) => c.name),
  );
  if (!cols.has('to_email')) {
    db.exec('ALTER TABLE drafts ADD COLUMN to_email TEXT');
    // Pre-migration drafts were messaged to Aditya's phone with whatever
    // people.email held at message time, and nothing has changed those
    // addresses since (there is no address history to consult, so this is the
    // only defensible snapshot). Adopting the current value now is exactly the
    // behavior these drafts already had, and from this point on it is frozen.
    db.exec(
      'UPDATE drafts SET to_email = (SELECT email FROM people WHERE people.id = drafts.person_id) WHERE to_email IS NULL',
    );
  }
  // send_attempts must exist before the send_attempted_at backfill below sets
  // it, so keep this ALTER first.
  if (!cols.has('send_attempts')) {
    db.exec('ALTER TABLE drafts ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.has('send_attempted_at')) {
    db.exec('ALTER TABLE drafts ADD COLUMN send_attempted_at TEXT');
    // An already-sent draft did consume its one attempt. Recording that keeps
    // the audit trail honest and is defense in depth: status alone already
    // blocks a re-claim.
    db.exec(
      "UPDATE drafts SET send_attempted_at = coalesce(decided_at, created_at, datetime('now')), send_attempts = 1 WHERE status LIKE 'sent%'",
    );
  }
}

export interface PersonInput {
  name: string;
  openalexId?: string | null;
  email?: string | null;
  emailConfidence?: number | null;
  emailSource?: string | null;
  affiliation?: string | null;
  role?: string | null;
  homepageUrl?: string | null;
  profileSummary?: string | null;
}

export interface PersonRow {
  id: number;
  name: string;
  openalex_id: string | null;
  affiliation: string | null;
  email: string | null;
  profile_summary: string | null;
}

// Upsert by openalex_id when present (dedup), else insert. Returns the row id.
export function upsertPerson(db: DB, p: PersonInput): number {
  if (p.openalexId) {
    const existing = db.prepare('SELECT id FROM people WHERE openalex_id = ?').get(p.openalexId) as { id: number } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE people SET name = ?, affiliation = coalesce(?, affiliation),
           email = coalesce(?, email), email_confidence = coalesce(?, email_confidence),
           email_source = coalesce(?, email_source), homepage_url = coalesce(?, homepage_url),
           profile_summary = coalesce(?, profile_summary), updated_at = datetime('now')
         WHERE id = ?`,
      ).run(p.name, p.affiliation ?? null, p.email ?? null, p.emailConfidence ?? null, p.emailSource ?? null, p.homepageUrl ?? null, p.profileSummary ?? null, existing.id);
      return existing.id;
    }
  }
  const info = db.prepare(
    `INSERT INTO people (name, openalex_id, email, email_confidence, email_source, affiliation, homepage_url, profile_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.name, p.openalexId ?? null, p.email ?? null, p.emailConfidence ?? null, p.emailSource ?? null, p.affiliation ?? null, p.homepageUrl ?? null, p.profileSummary ?? null);
  return Number(info.lastInsertRowid);
}

export function getPerson(db: DB, id: number): PersonRow | undefined {
  return db.prepare('SELECT id, name, openalex_id, affiliation, email, profile_summary FROM people WHERE id = ?').get(id) as
    | PersonRow
    | undefined;
}

// D11 accumulate strategy: facts persist across mines. A fact re-seen refreshes
// its retrieved_at and metadata (D7 staleness signal); a new fact is inserted;
// facts not in this batch are kept.
export function saveFacts(db: DB, personId: number, facts: OntologyFact[]): void {
  const upsert = db.prepare(
    `INSERT INTO ontology_facts (person_id, facet, key, value, detail, source_url, stance, confidence, usability_tier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id, facet, key, value) DO UPDATE SET
       detail = excluded.detail,
       stance = excluded.stance,
       source_url = excluded.source_url,
       confidence = excluded.confidence,
       usability_tier = excluded.usability_tier,
       retrieved_at = datetime('now')`,
  );
  const tx = db.transaction((rows: OntologyFact[]) => {
    for (const f of rows) upsert.run(personId, f.facet, f.key, f.value, f.detail ?? null, f.sourceUrl, f.stance ?? null, f.confidence, f.tier);
  });
  tx(facts);
}

interface FactRow {
  id: number;
  facet: OntologyFact['facet'];
  key: string;
  value: string;
  detail: string | null;
  stance: string | null;
  source_url: string;
  confidence: number;
  usability_tier: OntologyFact['tier'];
}

const rowToFact = (r: FactRow): OntologyFact => ({
  facet: r.facet,
  key: r.key,
  value: r.value,
  detail: r.detail ?? undefined,
  stance: (r.stance as OntologyFact['stance']) ?? undefined,
  sourceUrl: r.source_url,
  confidence: r.confidence,
  tier: r.usability_tier,
});

export function getFacts(db: DB, personId: number): OntologyFact[] {
  return factRows(db, personId).map(({ id: _id, ...fact }) => fact);
}

export type StoredFact = OntologyFact & { id: number };

// Fact rows including their ids (needed to link intersections). personId = null
// selects the self ontology (person_id IS NULL).
export function factRows(db: DB, personId: number | null): StoredFact[] {
  const where = personId === null ? 'person_id IS NULL' : 'person_id = ?';
  const stmt = db.prepare(
    `SELECT id, facet, key, value, detail, stance, source_url, confidence, usability_tier FROM ontology_facts WHERE ${where}`,
  );
  const rows = (personId === null ? stmt.all() : stmt.all(personId)) as FactRow[];
  return rows.map((r) => ({ id: r.id, ...rowToFact(r) }));
}

// Insert self-ontology facts (person_id NULL). Written by the persona subsystem;
// exposed here for the D9 dev seed and tests until that subsystem exists.
export function saveSelfFacts(db: DB, facts: OntologyFact[]): void {
  const ins = db.prepare(
    `INSERT INTO ontology_facts (person_id, facet, key, value, detail, source_url, stance, confidence, usability_tier)
     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: OntologyFact[]) => {
    for (const f of rows) ins.run(f.facet, f.key, f.value, f.detail ?? null, f.sourceUrl, f.stance ?? null, f.confidence, f.tier);
  });
  tx(facts);
}

// P1: a persona build is authoritative, so replace the whole self ontology
// atomically (NULL person_id can't use the accumulate upsert, and rebuilds
// should never duplicate).
export function replaceSelfFacts(db: DB, facts: OntologyFact[]): void {
  const tx = db.transaction((rows: OntologyFact[]) => {
    db.prepare('DELETE FROM ontology_facts WHERE person_id IS NULL').run();
    saveSelfFacts(db, rows);
  });
  tx(facts);
}

export interface IntersectionRow {
  selfFactId: number;
  personFactId: number;
  strength: number;
  tier: OntologyFact['tier'];
  rationale: string;
}

// Intersections are derived: replace a person's set on each recompute (D6).
export function saveIntersections(db: DB, personId: number, rows: IntersectionRow[]): void {
  const del = db.prepare('DELETE FROM intersections WHERE person_id = ?');
  const ins = db.prepare(
    `INSERT INTO intersections (person_id, self_fact_id, person_fact_id, strength, tier, rationale)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((items: IntersectionRow[]) => {
    del.run(personId);
    for (const r of items) ins.run(personId, r.selfFactId, r.personFactId, r.strength, r.tier, r.rationale);
  });
  tx(rows);
}

// Used when a person is flagged as an identity collision after previously
// producing hooks: saveIntersections' DELETE+INSERT will not run for them
// again, so the stale rows would survive forever.
export function clearIntersections(db: DB, personId: number): void {
  db.prepare('DELETE FROM intersections WHERE person_id = ?').run(personId);
}
