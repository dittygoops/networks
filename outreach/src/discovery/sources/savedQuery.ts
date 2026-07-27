// Saved-query source: runs each derived or configured query against arXiv.
import type { DiscoverySource } from '../types.js';
import { queryArxivFeed, type ArxivQueryOptions } from './arxivQuery.js';

export type SavedQueryOptions = ArxivQueryOptions;

export function createSavedQuerySource(queries: string[], opts: SavedQueryOptions = {}): DiscoverySource {
  return {
    name: 'saved_query',
    fetch: () => queryArxivFeed('all', queries, 'saved_query', (q) => `query: ${q}`, opts),
  };
}
