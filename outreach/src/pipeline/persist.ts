// D11 wiring: map a resolve+mine result into the persistence layer. Pure over
// the store (no network/LLM); keeps db.ts a plain data layer and minePerson pure.
import { upsertPerson, saveFacts, type DB } from '../db/db.js';
import { currentAffiliation, type OpenAlexAuthorRaw } from '../openalex/client.js';
import type { AuthorResolution, OntologyFact } from './research.js';

export function persistPerson(
  db: DB,
  resolution: AuthorResolution,
  raw: OpenAlexAuthorRaw,
  mineResult: { facts: OntologyFact[]; profileSummary: string },
): number {
  const id = upsertPerson(db, {
    name: resolution.author.displayName,
    openalexId: resolution.author.id,
    affiliation: currentAffiliation(raw),
    homepageUrl: resolution.author.homepageUrls?.[0] ?? null,
    profileSummary: mineResult.profileSummary,
  });
  saveFacts(db, id, mineResult.facts);
  return id;
}
