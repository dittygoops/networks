// Runs every discovery source, isolating failures so one dead API cannot sink
// the run, then dedups the merged batch by arXiv id (first source wins).
import type { Candidate, DiscoverySource } from './types.js';

export interface DiscoveryResult {
  candidates: Candidate[];
  errors: string[];
}

export async function discoverAll(sources: DiscoverySource[]): Promise<DiscoveryResult> {
  const settled = await Promise.allSettled(sources.map((s) => s.fetch()));
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  settled.forEach((r, i) => {
    const source = sources[i];
    const name = source ? source.name : 'unknown';
    if (r.status === 'rejected') {
      errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    for (const c of r.value) {
      if (seen.has(c.arxivId)) continue;
      seen.add(c.arxivId);
      candidates.push(c);
    }
  });

  return { candidates, errors };
}
