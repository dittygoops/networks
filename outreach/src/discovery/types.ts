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

// One discovery source. Implementations must never throw for expected upstream
// failures; the orchestrator isolates them, but sources should degrade first.
export interface DiscoverySource {
  readonly name: DiscoveredVia;
  fetch(): Promise<Candidate[]>;
}
