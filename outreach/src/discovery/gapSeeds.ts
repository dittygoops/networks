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
