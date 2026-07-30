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

  // CS7.3 (docs/spec-candidate-stranding.md): every row here already cleared
  // the relevance gate, so relevance has already done its job. Ordering by it
  // again would starve a resumed row (which scores lower without a fresh
  // abstract, CS1.3) behind every fresh arrival forever, so the queue is
  // age-first instead. This replaces the old relevance-descending assertion.
  it('getQueued returns queued_for_message rows ordered oldest first', () => {
    const db = openDb(':memory:');
    for (const [id, rel] of [['2601.00001', 0.7], ['2601.00002', 0.95], ['2601.00003', 0.8]] as const) {
      recordDiscovered(db, c(id));
      db.prepare('UPDATE seen_papers SET relevance = ? WHERE arxiv_id = ?').run(rel, id);
      setStatus(db, id, 'queued_for_message');
    }
    expect(getQueued(db, 2).map((r) => r.arxivId)).toEqual(['2601.00001', '2601.00002']);
  });
});
