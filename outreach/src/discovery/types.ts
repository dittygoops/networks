// Discovery layer types. Spec: docs/superpowers/specs/2026-07-26-discovery-outreach-loop-design.md
export type DiscoveredVia = 'saved_query' | 'author_watch' | 'recommend';

export type SeenStatus =
  | 'discovered'
  | 'filtered_low_relevance'
  | 'drafted_unsendable'
  | 'queued_for_message'
  | 'messaged'
  | 'sent'
  | 'rejected';

export interface Candidate {
  arxivId: string;
  title: string;
  discoveredVia: DiscoveredVia;
  sourceDetail: string; // which query, which author, which seed
  abstract?: string;
}

// What one source returns for one run. `errors` is how a source says
// "something upstream refused me", so a run that returned few or no candidates
// because arXiv or Semantic Scholar was refusing can never be mistaken for a
// quiet day in the summary the approver is texted. Sources report expected
// upstream failures here and do not throw; discoverAll still isolates a throw,
// but only as a backstop for a bug.
export interface SourceResult {
  candidates: Candidate[];
  errors: string[];
}

// One discovery source.
export interface DiscoverySource {
  readonly name: DiscoveredVia;
  fetch(): Promise<SourceResult>;
}
