// Task A intake: resolve the author's CURRENT affiliation via OpenAlex (D3a/D5b)
// before contact extraction, so the web query and D5a guard target where the
// person is now (e.g. Kerbl's paper says INRIA, OpenAlex says TU Wien), not the
// paper's stale affiliation. Spec: docs/spec-profile-mining.md (D1a, D1c, D3a,
// D5a, D5b).
import { fetchAuthorCandidates, currentAffiliation, type FetchFn } from '../openalex/client.js';
import { resolveAuthor } from './research.js';
import {
  extractContact,
  type ContactDeps,
  type ExtractOptions,
  type PaperContext,
  type SelectedEmail,
  type TargetPerson,
} from './contacts.js';

// Existing contact deps plus an injectable fetch for OpenAlex (offline tests).
export interface IntakeDeps extends ContactDeps {
  fetchFn?: FetchFn;
}

export interface IntakeOptions extends ExtractOptions {
  paperText?: string | null;
}

// Resolve the paper author to a single OpenAlex identity, then extract their
// contact. If resolved, the resolved author's current affiliation drives the web
// query and the D5a guard. If UNRESOLVED, fall back to the paper affiliation
// (unchanged extractContact behavior).
export async function resolveAndExtractContact(
  deps: IntakeDeps,
  person: TargetPerson,
  paperContext: PaperContext,
  options: IntakeOptions = {},
): Promise<SelectedEmail | null> {
  const { fetchFn } = deps;

  // OpenAlex is an enrichment, not a dependency: if it fails (rate limit,
  // outage, bad JSON) we degrade to the paper affiliation rather than aborting
  // extraction. The fresh-paper fast path needs no affiliation at all.
  let resolvedAffiliation: string | undefined;
  try {
    const fetched = await fetchAuthorCandidates(person.name, { fetchFn });
    const resolution = resolveAuthor(fetched.map((f) => f.candidate), person.name, paperContext);
    if (resolution) {
      const raw = fetched.find((f) => f.candidate.id === resolution.author.id)?.raw;
      if (raw) resolvedAffiliation = currentAffiliation(raw) ?? undefined;
    }
  } catch {
    resolvedAffiliation = undefined; // fall back to the paper affiliation
  }

  return extractContact(deps, person, options.paperText ?? null, {
    paperAgeMonths: options.paperAgeMonths,
    paperContext,
    // Precedence handled inside extractContact: currentAffiliation wins when set,
    // otherwise it falls back to paperContext.affiliationHint / person.affiliation.
    currentAffiliation: resolvedAffiliation ?? options.currentAffiliation,
  });
}
