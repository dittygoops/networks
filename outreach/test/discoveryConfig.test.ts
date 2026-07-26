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
