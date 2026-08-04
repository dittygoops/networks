// Is the approval daemon running the code that is currently on disk?
//
// It silently was not, on 2026-08-04. Three tasks shipped, 606 tests passed,
// and a live probe of the new address-correction path failed: the reply was
// recorded as `edit_reply_unsupported` and a tapback was ignored, both of which
// are the OLD behaviour. launchd holds `com.aditya.outreach-listen` for days at
// a time and tsx compiles the source once at startup, so shipping code does
// nothing until something restarts the process. No test can catch that, because
// every test runs against the files, not against the running daemon.
//
// The daily batch is immune (a fresh process every morning). Only the
// long-lived listener can go stale, and it is the one that handles approvals,
// which are irreversible.
//
// Usage:
//   npx tsx scripts/check-listener-fresh.ts           # report only, exit 1 if stale
//   npx tsx scripts/check-listener-fresh.ts --restart  # restart it if stale
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.aditya.outreach-listen';
const restart = process.argv.includes('--restart');
const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function newestSourceMtime(dir: string): { path: string; mtime: Date } {
  let newest = { path: '', mtime: new Date(0) };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = newestSourceMtime(p);
      if (inner.mtime > newest.mtime) newest = inner;
    } else if (entry.name.endsWith('.ts')) {
      const m = statSync(p).mtime;
      if (m > newest.mtime) newest = { path: p, mtime: m };
    }
  }
  return newest;
}

function listenerPid(): number | null {
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes(LABEL)) continue;
      const pid = Number(line.split('\t')[0]);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch {
    // launchctl missing or the job is not loaded; treated as "not running".
  }
  return null;
}

function processStart(pid: number): Date | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const d = new Date(out);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

const pid = listenerPid();
if (pid === null) {
  console.log(`${LABEL}: NOT RUNNING. Approvals are not being received at all.`);
  if (restart) {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
    console.log('kickstarted.');
  }
  process.exit(1);
}

const started = processStart(pid);
const newest = newestSourceMtime(srcDir);
if (!started) {
  console.log(`${LABEL}: pid ${pid} running, but its start time could not be read. Cannot judge freshness.`);
  process.exit(1);
}

// A tie is treated as fresh: same-second edits during a restart are noise, and
// falsely restarting an approval daemon is worse than a second of staleness.
const stale = newest.mtime.getTime() > started.getTime();
console.log(`${LABEL}: pid ${pid}`);
console.log(`  process started : ${started.toISOString()}`);
console.log(`  newest src file : ${newest.mtime.toISOString()}  ${newest.path.replace(/.*\/src\//, 'src/')}`);
console.log(`  verdict         : ${stale ? 'STALE, running code older than the source on disk' : 'fresh'}`);

if (stale && restart) {
  execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
  console.log('  restarted.');
  process.exit(0);
}
process.exit(stale ? 1 : 0);
