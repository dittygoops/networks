import { describe, expect, it, vi } from 'vitest';
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

  it('merges derived authors with configured ones', () => {
    const db = dbWithGaps([]);
    const res = db.prepare("INSERT INTO people (name) VALUES ('Akshay Sajan')").run();
    const pid = Number(res.lastInsertRowid);
    // A person is only auto-derived once they have a real thread (sent or approved draft).
    db.prepare(
      `INSERT INTO drafts (short_id, person_id, paper_arxiv_id, paper_title, status, draft_input_json)
       VALUES ('d1', ?, '2508.09217', 'T', 'sent', '{}')`,
    ).run(pid);
    const p = writeYaml('authors:\n  add: ["Alexander Wiltschko"]\n');
    expect(loadConfig(db, p).authors).toEqual(['Akshay Sajan', 'Alexander Wiltschko']);
  });

  it('maps borderline_band through to borderlineBand', () => {
    const p = writeYaml('gate:\n  borderline_band: 0.25\n');
    expect(loadConfig(dbWithGaps([]), p).gate.borderlineBand).toBe(0.25);
  });

  it('stays silent when the config file is simply absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      loadConfig(dbWithGaps(['olfactory embedding space']), '/nonexistent/watchlist.yaml');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns and falls back to auto derivation when the file is malformed', () => {
    // Unclosed flow sequence: verified to throw in the yaml parser.
    const p = writeYaml('queries:\n  add: [unclosed\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = loadConfig(dbWithGaps(['olfactory embedding space']), p);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(p);
      // The run still proceeds on auto derived defaults rather than throwing.
      expect(cfg.queries).toEqual(['olfactory embedding space']);
      expect(cfg.gate.threshold).toBe(0.6);
    } finally {
      warn.mockRestore();
    }
  });
});
