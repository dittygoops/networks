import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb, upsertPerson, saveFacts, getFacts, getPerson } from '../src/db/db.js';
import type { OntologyFact } from '../src/pipeline/research.js';

// D11: thin SQLite data layer. Tests run against an in-memory database.

const fact = (partial: Partial<OntologyFact> = {}): OntologyFact => ({
  facet: 'academic', key: 'research_area', value: 'Computer graphics',
  sourceUrl: 'https://openalex.org/A1', confidence: 0.85, tier: 'A', ...partial,
});

describe('upsertPerson (D11 dedup)', () => {
  test('inserts a new person and returns its id', () => {
    const db = openDb(':memory:');
    const id = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1', affiliation: 'TU Wien' });
    expect(id).toBeGreaterThan(0);
    expect(getPerson(db, id)?.name).toBe('Bernhard Kerbl');
  });

  test('re-upserting the same openalex_id updates in place, not duplicates', () => {
    const db = openDb(':memory:');
    const first = upsertPerson(db, { name: 'B. Kerbl', openalexId: 'A1', affiliation: 'INRIA' });
    const second = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1', affiliation: 'TU Wien', profileSummary: 'Graphics researcher.' });
    expect(second).toBe(first); // same row
    const person = getPerson(db, first);
    expect(person?.affiliation).toBe('TU Wien'); // updated
    expect(person?.name).toBe('Bernhard Kerbl');
    expect(person?.profile_summary).toBe('Graphics researcher.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
  });

  test('a person without an openalex_id inserts fresh each time', () => {
    const db = openDb(':memory:');
    upsertPerson(db, { name: 'Anon One' });
    upsertPerson(db, { name: 'Anon Two' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 2 });
  });
});

describe('saveFacts / getFacts (D11 replace strategy)', () => {
  test('persists facts and reads them back mapped to the ontology shape', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
    saveFacts(db, pid, [fact(), fact({ facet: 'trajectory', key: 'institution', value: 'TU Wien', confidence: 0.9 })]);
    const facts = getFacts(db, pid);
    expect(facts).toHaveLength(2);
    const inst = facts.find((f) => f.key === 'institution');
    expect(inst).toMatchObject({ facet: 'trajectory', value: 'TU Wien', confidence: 0.9, tier: 'A' });
    expect(inst?.sourceUrl).toBe('https://openalex.org/A1');
  });

  test('re-saving accumulates: keeps old facts, adds new ones, dedupes exact repeats', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Bernhard Kerbl', openalexId: 'A1' });
    saveFacts(db, pid, [fact({ value: 'Area A' }), fact({ value: 'Area B' })]);
    saveFacts(db, pid, [fact({ value: 'Area B' }), fact({ value: 'Area C' })]); // B repeats, C is new
    const values = getFacts(db, pid).map((f) => f.value).sort();
    expect(values).toEqual(['Area A', 'Area B', 'Area C']); // union, no duplicate B
  });

  test('an exact-duplicate fact does not create a second row', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'X', openalexId: 'A1' });
    saveFacts(db, pid, [fact()]);
    saveFacts(db, pid, [fact()]);
    expect(getFacts(db, pid)).toHaveLength(1);
  });

  test('re-sighting a fact refreshes its retrieved_at (D7 staleness signal)', () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'X', openalexId: 'A1' });
    saveFacts(db, pid, [fact()]);
    db.prepare("UPDATE ontology_facts SET retrieved_at = '2000-01-01' WHERE person_id = ?").run(pid);
    saveFacts(db, pid, [fact()]); // seen again
    const row = db.prepare('SELECT retrieved_at FROM ontology_facts WHERE person_id = ?').get(pid) as { retrieved_at: string };
    expect(row.retrieved_at).not.toBe('2000-01-01');
  });

  test('saving facts for one person leaves another person facts intact', () => {
    const db = openDb(':memory:');
    const a = upsertPerson(db, { name: 'Person A', openalexId: 'A1' });
    const b = upsertPerson(db, { name: 'Person B', openalexId: 'A2' });
    saveFacts(db, a, [fact({ value: 'A fact' })]);
    saveFacts(db, b, [fact({ value: 'B fact' })]);
    saveFacts(db, a, [fact({ value: 'A fact v2' })]);
    expect(getFacts(db, b)).toHaveLength(1);
    expect(getFacts(db, b)[0]?.value).toBe('B fact');
  });
});

// docs/spec-candidate-stranding.md, CS10.1: schema.sql's CREATE TABLE body is
// a no-op on an existing database (CREATE TABLE IF NOT EXISTS), so the
// attempts and abstract columns it added can only reach a database created
// before they existed via a guarded ALTER in openDb.
describe('openDb migration (CS10.1)', () => {
  test('adds attempts and abstract to a seen_papers table created before they existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outreach-migrate-'));
    const path = join(dir, 'old.db');

    // Build a pre-migration seen_papers, standing in for the live database
    // created before this spec (no attempts, no abstract).
    const old = new Database(path);
    old.exec(`
      CREATE TABLE seen_papers (
        arxiv_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        discovered_via TEXT NOT NULL,
        source_detail TEXT,
        relevance REAL,
        status TEXT NOT NULL DEFAULT 'discovered',
        draft_id INTEGER,
        reason TEXT,
        first_seen_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    old.prepare(
      `INSERT INTO seen_papers (arxiv_id, title, discovered_via) VALUES ('2601.00001', 'Pre-migration row', 'saved_query')`,
    ).run();
    old.close();

    const db = openDb(path);
    const cols = (db.prepare('PRAGMA table_info(seen_papers)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('attempts');
    expect(cols).toContain('abstract');
    const row = db.prepare("SELECT attempts, abstract FROM seen_papers WHERE arxiv_id = '2601.00001'").get() as {
      attempts: number;
      abstract: string | null;
    };
    expect(row.attempts).toBe(0);
    expect(row.abstract).toBeNull();

    // Idempotent: reopening (which re-applies schema.sql and the migration
    // guard) must not throw a duplicate-column error.
    expect(() => openDb(path)).not.toThrow();
  });
});
