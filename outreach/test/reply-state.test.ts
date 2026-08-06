import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db/db.js';
import {
  acquireLease, releaseLease, recordCycleSuccess, recordCycleFailure,
  markFailureNotified, pollState, LEASE_MS,
} from '../src/pipeline/replyState.js';

// An ON-DISK database, deliberately, not ':memory:'. The whole point of this
// table is that state survives PROCESS EXIT, and two ':memory:' handles share
// nothing, which is the same thing two processes do not share. A test that
// passed on ':memory:' would prove the opposite of what is needed here.
function diskDb() {
  return join(mkdtempSync(join(tmpdir(), 'reply-state-')), 'test.db');
}

// A *statically* imported recordCycleFailure is one JS module instance shared
// by every `it()` in this file. A module-level counter therefore survives
// db.close()+openDb() just fine, because closing a database handle does not
// unload the module that holds the variable: nothing in that sequence forces
// a fresh module graph, so the mutation this file exists to catch would slip
// through undetected (and did, verified by hand: the statically-imported
// version of this test still went green under the module-variable mutation
// when run alone, since the variable starts at 0 for this file's one import
// and simply counts 1,2,3, coincidentally matching the durable answer).
// vi.resetModules() + a fresh dynamic import before each simulated "process"
// closes that gap: it forces a brand new module instance, exactly as a real
// launchd-spawned process would have, so a module-level variable is
// observably back at its initializer every time while a value read from the
// database is not.
async function freshProcess() {
  vi.resetModules();
  return import('../src/pipeline/replyState.js') as Promise<typeof import('../src/pipeline/replyState.js')>;
}

describe('the 3-cycle alarm survives process exit', () => {
  it('fires on the third failure across three separate opens, not the first', async () => {
    const path = diskDb();
    const results: { consecutive: number; shouldNotify: boolean }[] = [];
    for (let i = 0; i < 3; i++) {
      const mod = await freshProcess();               // a fresh "process"
      const db = openDb(path);
      results.push(mod.recordCycleFailure(db, 'invalid_grant'));
      db.close();
    }
    expect(results.map((r) => r.consecutive)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.shouldNotify)).toEqual([false, false, true]);
  });

  // Without the durable row the counter resets every run and this is [1,1,1].
  it('does not re-notify on the fourth failure', async () => {
    const path = diskDb();
    for (let i = 0; i < 3; i++) {
      const mod = await freshProcess();
      const db = openDb(path);
      mod.recordCycleFailure(db, 'x');
      db.close();
    }
    { const mod = await freshProcess(); const db = openDb(path); mod.markFailureNotified(db); db.close(); }
    const mod = await freshProcess();
    const db = openDb(path);
    expect(mod.recordCycleFailure(db, 'x').shouldNotify).toBe(false);
    expect(mod.pollState(db).consecutiveCycleFailures).toBe(4);
  });

  it('a success resets the counter and re-arms the alarm', async () => {
    const path = diskDb();
    for (let i = 0; i < 3; i++) {
      const mod = await freshProcess();
      const db = openDb(path);
      mod.recordCycleFailure(db, 'x');
      db.close();
    }
    { const mod = await freshProcess(); const db = openDb(path);
      mod.markFailureNotified(db); mod.recordCycleSuccess(db); db.close(); }
    { const mod = await freshProcess(); const db = openDb(path); const s = mod.pollState(db);
      expect(s.consecutiveCycleFailures).toBe(0);
      expect(s.failureNotifiedAt).toBeNull();
      expect(s.lastSuccessAt).not.toBeNull();
      db.close(); }
    const results: { consecutive: number; shouldNotify: boolean }[] = [];
    for (let i = 0; i < 3; i++) {
      const mod = await freshProcess();
      const db = openDb(path);
      results.push(mod.recordCycleFailure(db, 'y'));
      db.close();
    }
    expect(results[2]!.shouldNotify).toBe(true);   // a SECOND alarm
  });

  it('stores err.message only, never an object', () => {
    const db = openDb(diskDb());
    recordCycleFailure(db, 'invalid_grant');
    expect(pollState(db).lastError).toBe('invalid_grant');
  });
});

describe('the run lease', () => {
  it('is exclusive: the second caller loses', () => {
    const db = openDb(diskDb());
    const now = new Date();
    expect(acquireLease(db, 111, now)).toBe(true);
    expect(acquireLease(db, 222, now)).toBe(false);
  });

  it('is released explicitly', () => {
    const db = openDb(diskDb());
    acquireLease(db, 111, new Date());
    releaseLease(db);
    expect(acquireLease(db, 222, new Date())).toBe(true);
  });

  // A process killed hard between taking the lease and its finally must block
  // at most one cycle, not forever.
  it('expires, so a crashed process cannot wedge the job permanently', () => {
    const db = openDb(diskDb());
    const t0 = new Date();
    expect(acquireLease(db, 111, t0)).toBe(true);
    expect(acquireLease(db, 222, new Date(t0.getTime() + LEASE_MS - 1000))).toBe(false);
    expect(acquireLease(db, 222, new Date(t0.getTime() + LEASE_MS + 1000))).toBe(true);
  });

  it('writes the lease expiry in the canonical form', () => {
    const db = openDb(diskDb());
    acquireLease(db, 111, new Date());
    const exp = (db.prepare('SELECT lock_expires_at AS e FROM reply_poll_state WHERE id = 1').get() as { e: string }).e;
    expect(exp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
