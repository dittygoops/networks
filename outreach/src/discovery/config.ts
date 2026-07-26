// Auto derived defaults, with an optional override file merged in. Absent file
// means pure auto derivation.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { DB } from '../db/db.js';
import { deriveGapQueries } from './gapSeeds.js';

export interface GateConfig {
  threshold: number;
  borderlineBand: number;
  maxMessagesPerRun: number;
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
  gate?: { threshold?: number; borderline_band?: number; max_messages_per_run?: number };
}

const DEFAULT_GATE: GateConfig = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3 };

function readFile(path: string): RawFile {
  try {
    return (parse(readFileSync(path, 'utf8')) as RawFile) ?? {};
  } catch {
    return {}; // absent or unreadable means pure auto derivation
  }
}

export function loadConfig(db: DB, path = 'config/watchlist.yaml'): LoopConfig {
  const raw = readFile(path);
  const mute = (raw.queries?.mute ?? []).map((m) => m.toLowerCase());
  const derived = deriveGapQueries(db).filter((q) => !mute.some((m) => q.toLowerCase().includes(m)));

  const queries: string[] = [];
  for (const q of [...derived, ...(raw.queries?.add ?? [])]) {
    if (!queries.some((e) => e.toLowerCase() === q.toLowerCase())) queries.push(q);
  }

  return {
    queries,
    authors: raw.authors?.add ?? [],
    seeds: raw.seeds?.add ?? [],
    gate: {
      threshold: raw.gate?.threshold ?? DEFAULT_GATE.threshold,
      borderlineBand: raw.gate?.borderline_band ?? DEFAULT_GATE.borderlineBand,
      maxMessagesPerRun: raw.gate?.max_messages_per_run ?? DEFAULT_GATE.maxMessagesPerRun,
    },
  };
}
