// Auto derived defaults, with an optional override file merged in. Absent file
// means pure auto derivation.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { DB } from '../db/db.js';
import { deriveGapQueries } from './gapSeeds.js';
import { deriveWatchAuthors } from './sources/authorWatch.js';
import { deriveSeedPapers } from './sources/recommend.js';

export interface GateConfig {
  threshold: number;
  borderlineBand: number;
  maxMessagesPerRun: number;
  // docs/spec-candidate-stranding.md: bounds the resume step's per-run and
  // per-row work so a large backlog cannot starve fresh discovery (CS7.4) and
  // so nothing retries a poison candidate forever (CS3.3).
  maxResumePerRun: number;
  maxResumeAttempts: number;
  // Its own bound, deliberately not shared with maxMessagesPerRun: a draft
  // message can be approved with one tap, an address request costs a human
  // lookup, so sharing the cap would let a request silently displace an
  // approvable draft. OPTIONAL because three test files build a
  // GateConfig-shaped literal and a required field breaks all three.
  maxAddressRequestsPerRun?: number;
}

export interface LoopConfig {
  queries: string[];
  authors: string[];
  seeds: string[];
  gate: GateConfig;
}

interface RawFile {
  queries?: { add?: string[]; mute?: string[] };
  authors?: { add?: string[] };
  seeds?: { add?: string[] };
  gate?: {
    threshold?: number;
    borderline_band?: number;
    max_messages_per_run?: number;
    max_resume_per_run?: number;
    max_resume_attempts?: number;
    max_address_requests_per_run?: number;
  };
}

const DEFAULT_GATE: GateConfig = {
  threshold: 0.6,
  borderlineBand: 0.1,
  maxMessagesPerRun: 3,
  maxResumePerRun: 10,
  maxResumeAttempts: 3,
  maxAddressRequestsPerRun: 3,
};

// An absent file is the normal zero-config path, so it stays quiet. A file that
// exists but cannot be read or parsed is reported: silently ignoring it would
// un-mute queries and reset gate values that the user believes are in force.
function readFile(path: string): RawFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.warn(`watchlist config at ${path} could not be read, falling back to auto derivation: ${String(e)}`);
    return {};
  }
  try {
    return (parse(text) as RawFile) ?? {};
  } catch (e) {
    console.warn(`watchlist config at ${path} could not be parsed, falling back to auto derivation: ${String(e)}`);
    return {};
  }
}

function mergeUnique(derived: string[], added: string[]): string[] {
  const out: string[] = [];
  for (const v of [...derived, ...added]) {
    if (v && !out.some((e) => e.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

export function loadConfig(db: DB, path = 'config/watchlist.yaml'): LoopConfig {
  const raw = readFile(path);
  const mute = (raw.queries?.mute ?? []).map((m) => m.toLowerCase());
  const derived = deriveGapQueries(db).filter((q) => !mute.some((m) => q.toLowerCase().includes(m)));

  const queries = mergeUnique(derived, raw.queries?.add ?? []);

  return {
    queries,
    authors: mergeUnique(deriveWatchAuthors(db), raw.authors?.add ?? []),
    seeds: mergeUnique(deriveSeedPapers(db), raw.seeds?.add ?? []),
    gate: {
      threshold: raw.gate?.threshold ?? DEFAULT_GATE.threshold,
      borderlineBand: raw.gate?.borderline_band ?? DEFAULT_GATE.borderlineBand,
      maxMessagesPerRun: raw.gate?.max_messages_per_run ?? DEFAULT_GATE.maxMessagesPerRun,
      maxResumePerRun: raw.gate?.max_resume_per_run ?? DEFAULT_GATE.maxResumePerRun,
      maxResumeAttempts: raw.gate?.max_resume_attempts ?? DEFAULT_GATE.maxResumeAttempts,
      maxAddressRequestsPerRun: raw.gate?.max_address_requests_per_run ?? DEFAULT_GATE.maxAddressRequestsPerRun,
    },
  };
}
