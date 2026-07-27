// Author-watch source: checks a watchlist of researchers for new postings.
// Auto derives from people already in the database, extended by config.
import type { DB } from '../../db/db.js';
import type { DiscoverySource } from '../types.js';
import { queryArxivFeed, type ArxivQueryOptions } from './arxivQuery.js';

export type AuthorWatchOptions = ArxivQueryOptions;

// Watching every person ever inserted grows unboundedly and re-checks
// researchers already looked at once and dismissed. The derived watchlist is
// limited to people with a real thread (a draft that was sent or approved),
// matching the never-email-twice guard in approval/ledger.ts's priorThreads.
// Anyone else can still be watched explicitly via watchlist.yaml's authors.add.
export function deriveWatchAuthors(db: DB): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.name FROM people p
         JOIN drafts d ON d.person_id = p.id
        WHERE d.status LIKE 'sent%' OR d.status = 'approved'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter(Boolean);
}

export function createAuthorWatchSource(authors: string[], opts: AuthorWatchOptions = {}): DiscoverySource {
  return {
    name: 'author_watch',
    fetch: () => queryArxivFeed('au', authors, 'author_watch', (a) => `author: ${a}`, { maxResults: 10, ...opts }),
  };
}
