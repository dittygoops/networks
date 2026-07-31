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
      // Backstop only. Sources report expected upstream failures by returning
      // errors (see SourceResult), so a rejection here means a source threw
      // unexpectedly, which is a bug rather than a 429. It must still surface.
      errors.push(`${name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      return;
    }
    // A source that RESOLVED can still have failed, wholly or partly. Before
    // this, discoverAll recorded an error only for a rejected promise, so a
    // source that swallowed every failure and returned [] was indistinguishable
    // from a quiet day, and one that partly failed had no channel at all.
    for (const e of r.value.errors) errors.push(`${name}: ${e}`);
    for (const c of r.value.candidates) {
      if (seen.has(c.arxivId)) continue;
      seen.add(c.arxivId);
      candidates.push(c);
    }
  });

  return { candidates, errors };
}
