// Orchestrator: arXiv id -> resolve -> contact -> mine -> persist -> intersect.
// Chains the profile-mining pipeline into one call. Spec: docs/spec-profile-mining.md.
import { fetchArxivPaper, selectTargetAuthor, buildPaperContext } from './arxiv.js';
import {
  fetchAuthorCandidates,
  fetchIdentityAnchors,
  currentAffiliation,
  type FetchFn,
  type OpenAlexAuthorRaw,
} from '../openalex/client.js';
import { resolveAuthor, minePerson } from './research.js';
import { extractContact, type PageFetcher, type SearchClient, type SelectedEmail } from './contacts.js';
import { persistPerson } from './persist.js';
import { computeIntersections, SelfOntologyMissingError, type Intersection } from './intersect.js';
import { upsertPerson, type DB } from '../db/db.js';
import type { LLMClient } from '../llm/client.js';
import { extractPdfText } from './pdf.js';

export interface OrchestrateDeps {
  db: DB;
  search: SearchClient;
  fetcher: PageFetcher;
  llm: LLMClient;
  fetchFn?: FetchFn; // arXiv + OpenAlex HTTP
  getPaperText?: (arxivId: string) => Promise<string | null>; // PDF text for tier-1; default fetches the arXiv PDF
}

export interface OrchestrateResult {
  arxivId: string;
  target: string;
  resolved: boolean;
  email: SelectedEmail | null;
  personId: number | null;
  factCount: number;
  hooks: Intersection[];
  noStrongHook: boolean;
  notes: string[];
}

// arXiv ids encode YYMM: 2308.x -> 2023-08. Used for D1 paper-email age decay.
export function arxivAgeMonths(arxivId: string, now = new Date()): number {
  const m = arxivId.match(/^(\d{2})(\d{2})/);
  if (!m) return 0;
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  return Math.max(0, (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month));
}

async function defaultPaperText(arxivId: string, fetchFn: FetchFn): Promise<string | null> {
  try {
    const res = await fetchFn(`https://arxiv.org/pdf/${arxivId}`);
    if (!res.ok) return null;
    return await extractPdfText(new Uint8Array(await res.arrayBuffer()));
  } catch {
    return null; // tier-1 is optional; the web tier still runs
  }
}

export async function processPaper(deps: OrchestrateDeps, arxivId: string): Promise<OrchestrateResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const notes: string[] = [];

  const paper = await fetchArxivPaper(arxivId, { fetchFn });
  const target = selectTargetAuthor(paper);
  const ctx = buildPaperContext(paper, target);

  // Resolve identity via OpenAlex; degrade to paper context on any failure.
  let resolution = null as Awaited<ReturnType<typeof resolveAuthor>>;
  let raw: OpenAlexAuthorRaw | undefined;
  let currentAff: string | undefined;
  try {
    const fetched = await fetchAuthorCandidates(target.name, { fetchFn });
    resolution = resolveAuthor(fetched.map((f) => f.candidate), target.name, ctx);
    if (resolution) {
      raw = fetched.find((f) => f.candidate.id === resolution!.author.id)?.raw;
      if (raw) currentAff = currentAffiliation(raw) ?? undefined;
    }
  } catch {
    notes.push('OpenAlex resolution failed; degraded to paper affiliation');
  }
  if (!resolution) notes.push('identity unconfirmed (UNRESOLVED)');

  // Contact extraction (tier-1 PDF + web tiers).
  const paperText = deps.getPaperText ? await deps.getPaperText(arxivId) : await defaultPaperText(arxivId, fetchFn);
  const email = await extractContact({ search: deps.search, fetcher: deps.fetcher }, { name: target.name }, paperText, {
    paperContext: ctx,
    currentAffiliation: currentAff,
    paperAgeMonths: arxivAgeMonths(arxivId),
  });

  let personId: number | null = null;
  let factCount = 0;
  let hooks: Intersection[] = [];
  let noStrongHook = true;

  if (resolution && raw) {
    resolution.author.homepageUrls = await fetchIdentityAnchors(raw, { fetchFn }).catch(() => []);
    const mineResult = await minePerson({ search: deps.search, fetcher: deps.fetcher, llm: deps.llm }, resolution, raw);
    personId = persistPerson(deps.db, resolution, raw, mineResult);
    factCount = mineResult.facts.length;
    if (email) {
      upsertPerson(deps.db, {
        name: target.name,
        openalexId: resolution.author.id,
        email: email.email,
        emailConfidence: email.confidence,
        emailSource: email.source,
      });
    }
    try {
      const r = await computeIntersections(deps.db, { llm: deps.llm }, personId);
      hooks = r.ranked;
      noStrongHook = r.noStrongHook;
    } catch (e) {
      if (e instanceof SelfOntologyMissingError) notes.push('no self ontology seeded; skipped intersections');
      else throw e;
    }
  } else if (email) {
    personId = upsertPerson(deps.db, {
      name: target.name,
      email: email.email,
      emailConfidence: email.confidence,
      emailSource: email.source,
    });
    notes.push('persisted contact only (identity unconfirmed, no ontology)');
  }

  return { arxivId: paper.arxivId, target: target.name, resolved: !!resolution, email, personId, factCount, hooks, noStrongHook, notes };
}
