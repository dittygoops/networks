// Author-watch source: checks a watchlist of researchers for new postings.
// Auto derives from people already in the database, extended by config.
import type { DB } from '../../db/db.js';
import type { DiscoverySource } from '../types.js';
import { queryArxivFeed, type ArxivQueryOptions } from './arxivQuery.js';

export type AuthorWatchOptions = ArxivQueryOptions;

export function deriveWatchAuthors(db: DB): string[] {
  const rows = db.prepare('SELECT DISTINCT name FROM people WHERE name IS NOT NULL').all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter(Boolean);
}

export function createAuthorWatchSource(authors: string[], opts: AuthorWatchOptions = {}): DiscoverySource {
  return {
    name: 'author_watch',
    fetch: () => queryArxivFeed('au', authors, 'author_watch', (a) => `author: ${a}`, { maxResults: 10, ...opts }),
  };
}
