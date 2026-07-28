// Credibility facts: what makes Aditya worth replying to. This is a SEPARATE
// job from the hook, which is the shared ground the email opens on.
//
// Why this module exists: the scheduled loop used to pass no sender facts at
// all, while the interactive `add` path passed eight. With nothing else to
// draw on, the drafter mined the hook list for a credential, which is how a
// real draft came to open "I used Claude in my Content Farm project": true,
// but table stakes, and unrelated to the ask.
import { factRows, type DB } from '../db/db.js';

export interface SenderFact {
  text: string;
  stance?: 'done' | 'exploring';
}

export const DEFAULT_SENDER_FACT_LIMIT = 8;

// Only stance 'done' qualifies: presenting an 'exploring' direction as finished
// work would be dishonest, and the drafter is told never to do it. Facts
// carrying a `detail` sort first, because "nuScenes: benchmarked a lidar
// clustering detector against its ground truth" earns a reply in a way a bare
// entity name does not.
export function buildSenderFacts(db: DB, limit = DEFAULT_SENDER_FACT_LIMIT): SenderFact[] {
  return factRows(db, null)
    .filter((f) => f.facet === 'academic' && f.stance !== 'exploring')
    .sort((a, b) => Number(Boolean(b.detail)) - Number(Boolean(a.detail)))
    .slice(0, limit)
    .map((f) => ({ text: f.detail ? `${f.value}: ${f.detail}` : f.value, stance: f.stance }));
}
