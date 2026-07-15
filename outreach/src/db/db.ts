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
  return db;
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

// D11 replace strategy: a re-mine yields a complete fresh fact set, so swap the
// person's facts atomically.
export function saveFacts(db: DB, personId: number, facts: OntologyFact[]): void {
  const del = db.prepare('DELETE FROM ontology_facts WHERE person_id = ?');
  const ins = db.prepare(
    `INSERT INTO ontology_facts (person_id, facet, key, value, source_url, confidence, usability_tier)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: OntologyFact[]) => {
    del.run(personId);
    for (const f of rows) ins.run(personId, f.facet, f.key, f.value, f.sourceUrl, f.confidence, f.tier);
  });
  tx(facts);
}

interface FactRow {
  facet: OntologyFact['facet'];
  key: string;
  value: string;
  source_url: string;
  confidence: number;
  usability_tier: OntologyFact['tier'];
}

export function getFacts(db: DB, personId: number): OntologyFact[] {
  const rows = db.prepare(
    'SELECT facet, key, value, source_url, confidence, usability_tier FROM ontology_facts WHERE person_id = ?',
  ).all(personId) as FactRow[];
  return rows.map((r) => ({
    facet: r.facet,
    key: r.key,
    value: r.value,
    sourceUrl: r.source_url,
    confidence: r.confidence,
    tier: r.usability_tier,
  }));
}
