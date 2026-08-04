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
import { resolveAuthor, minePersonFree, minePersonWeb, detectIdentityCollision, extractPaperFacts } from './research.js';
import {
  extractContactDetailed,
  type PageFetcher, type SearchClient, type SelectedEmail, type EmailSource,
  type RejectedCandidate, type ContactResult,
} from './contacts.js';
import { persistPerson } from './persist.js';
import { computeIntersections, type Intersection } from './intersect.js';
import { getFacts, saveFacts, upsertPerson, getPerson, clearIntersections, type DB } from '../db/db.js';
import type { LLMClient } from '../llm/client.js';
import { extractPdfText } from './pdf.js';
import type { ArxivPaper } from './arxiv.js';

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
  paperTitle: string;
  profileSummary?: string;
  resolved: boolean;
  email: SelectedEmail | null;
  personId: number | null;
  factCount: number;
  hooks: Intersection[];
  noStrongHook: boolean;
  notes: string[];
  // Set (with a human-readable reason) when the mined profile looks like an
  // OpenAlex identity collision (several real people merged under one author
  // id). The loop must never draft from a flagged person; see loop.ts.
  identityCollisionReason?: string;
  // Candidates rejected for naming a different person. OPTIONAL: two test
  // files build an OrchestrateResult literal behind an explicit type
  // annotation, so a required field breaks typecheck outside this file. Read
  // it as `(result.rejectedEmails ?? [])` everywhere.
  rejectedEmails?: RejectedCandidate[];
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

// Let the discovered paper itself contribute facts about its author (see
// research.ts extractPaperFacts), so a genuinely on-topic paper can still
// seed a hook when the mined profile is too coarse (e.g. bare OpenAlex
// concepts) to match. Persist BEFORE computeIntersections so the existing
// engine picks these up with no change to its core logic. Never let a
// paper-derived fact (always tier B) overwrite an existing (facet, key,
// value) row: saveFacts upserts on that triple, so a paper fact that
// happened to collide with an already-persisted tier-A profile fact would
// silently downgrade it. Filter those out first. Returns the count of newly
// saved facts.
async function addPaperFacts(
  deps: OrchestrateDeps,
  personId: number,
  paper: ArxivPaper,
  authorName: string,
): Promise<number> {
  try {
    const paperFacts = await extractPaperFacts(deps.llm, {
      arxivId: paper.arxivId,
      title: paper.title,
      abstract: paper.abstract,
      authorName,
    });
    if (paperFacts.length > 0) {
      const existingKeys = new Set(
        getFacts(deps.db, personId).map((f) => `${f.facet}|${f.key}|${f.value.trim().toLowerCase()}`),
      );
      const newPaperFacts = paperFacts.filter(
        (f) => !existingKeys.has(`${f.facet}|${f.key}|${f.value.trim().toLowerCase()}`),
      );
      if (newPaperFacts.length > 0) {
        saveFacts(deps.db, personId, newPaperFacts);
        return newPaperFacts.length;
      }
    }
  } catch {
    // Paper-fact extraction is best-effort; a failure here must not block
    // intersections from running on the profile facts already persisted.
  }
  return 0;
}

export interface ProcessPaperOptions {
  // `outreach add` is one deliberate human invocation, not a 184-paper batch,
  // so its contact lookup is worth the credits even when the author does not
  // resolve or does not hook. The loop never sets this.
  alwaysExtractContact?: boolean;
}

export async function processPaper(
  deps: OrchestrateDeps,
  arxivId: string,
  opts: ProcessPaperOptions = {},
): Promise<OrchestrateResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const notes: string[] = [];

  const paper = await fetchArxivPaper(arxivId, { fetchFn });
  const target = selectTargetAuthor(paper);
  const ctx = buildPaperContext(paper, target);

  let personId: number | null = null;
  let factCount = 0;
  let hooks: Intersection[] = [];
  let noStrongHook = true;
  let profileSummary: string | undefined;
  let identityCollisionReason: string | undefined;
  let email: SelectedEmail | null = null;
  let rejectedEmails: RejectedCandidate[] = [];

  // Contact extraction, factored out so the exits below can reuse it. Returns
  // (rather than assigns to the outer `email` via closure) because TypeScript
  // narrows a `let`-bound variable reassigned only inside a nested closure
  // back to its initial-assignment type at read sites in the outer scope,
  // which would make `if (email)` below report `email` as `never`.
  const runContactExtraction = async (aff: string | undefined): Promise<ContactResult> => {
    // A repeat author already has an address on record; re-paying Tavily to
    // rediscover it is pure waste. Read the ORIGINAL source/confidence back
    // off the person row rather than inventing a new 'on_record' value:
    // EmailSource is a closed union keyed 1:1 by SOURCE_CONFIDENCE's
    // exhaustive Record (contacts.ts), so widening it would force a
    // meaningless confidence entry for a value scoreCandidate never sees, and
    // the address really did come from a homepage or a PDF originally, so
    // reporting that is more truthful anyway. This shortcut re-enters the
    // upsertPerson call below with the same values it read, which is a no-op.
    // `rejected: []` is not a shrug, it is the truth: nothing was looked up,
    // so nothing was rejected.
    if (personId != null) {
      const known = getPerson(deps.db, personId);
      if (known?.email) {
        return {
          selected: { email: known.email, confidence: known.email_confidence ?? 1, source: (known.email_source as EmailSource | null) ?? 'directory' },
          rejected: [],
        };
      }
    }
    const paperText = deps.getPaperText ? await deps.getPaperText(arxivId) : await defaultPaperText(arxivId, fetchFn);
    return extractContactDetailed({ search: deps.search, fetcher: deps.fetcher }, { name: target.name }, paperText, {
      paperContext: ctx,
      currentAffiliation: aff,
      paperAgeMonths: arxivAgeMonths(arxivId),
    });
  };

  // --- Step 2: identity (free). Resolve BEFORE result() is defined below, so
  // the closure never reads `resolution`/`raw` ahead of their declaration. A
  // transport failure (429, DNS, parse) is NOT the same as "this author does
  // not exist": under hook-first gating the unresolved verdict is terminal
  // and nothing ever revisits it (see Task 5), so an outage must surface as a
  // retryable error rather than silently discarding the candidate. Only a
  // well-formed empty/no-match result degrades.
  const fetched = await fetchAuthorCandidates(target.name, { fetchFn });
  const resolution = resolveAuthor(fetched.map((f) => f.candidate), target.name, ctx);
  const raw = resolution ? fetched.find((f) => f.candidate.id === resolution.author.id)?.raw : undefined;
  const currentAff = raw ? currentAffiliation(raw) ?? undefined : undefined;

  const result = (): OrchestrateResult => ({
    arxivId: paper.arxivId,
    target: target.name,
    paperTitle: paper.title,
    profileSummary,
    resolved: !!resolution,
    email,
    personId,
    factCount,
    hooks,
    noStrongHook,
    notes,
    identityCollisionReason,
    rejectedEmails,
  });

  if (!resolution || !raw) {
    notes.push('identity unconfirmed (UNRESOLVED)');
    if (opts.alwaysExtractContact) ({ selected: email, rejected: rejectedEmails } = await runContactExtraction(currentAff));
    return result();
  }

  // --- Step 3: free facts + collision gate ---
  resolution.author.homepageUrls = await fetchIdentityAnchors(raw, { fetchFn }).catch(() => []);
  const free = await minePersonFree({ llm: deps.llm }, resolution, raw);
  personId = persistPerson(deps.db, resolution, raw, free);
  factCount = free.facts.length;
  profileSummary = free.profileSummary;

  // Deliberately runs on the OpenAlex facts ONLY, exactly as before. Feeding
  // it paper facts would change verdicts (arXiv-sourced academic/collaborator
  // rows exist) and is out of scope.
  const collision = detectIdentityCollision(free.facts);
  if (collision.suspected) {
    identityCollisionReason = collision.reason;
    notes.push(collision.reason!);
    // A person flagged on this run must not keep hook rows from an earlier
    // run when they were not flagged: nothing else will clear them, because
    // saveIntersections' DELETE+INSERT no longer runs for them.
    clearIntersections(deps.db, personId);
    if (opts.alwaysExtractContact) ({ selected: email, rejected: rejectedEmails } = await runContactExtraction(currentAff));
    return result();
  }

  // --- Step 4: paper facts + hook gate (still free of Tavily) ---
  factCount += await addPaperFacts(deps, personId, paper, target.name);
  // Deliberately NOT caught. An empty self ontology yields hooks: [], which
  // the hook gate cannot distinguish from a genuinely uninteresting person,
  // so swallowing it would terminate every paper in the run with nothing
  // captured and nothing retryable. Let it reach processCandidate's catch
  // (loop.ts), which records a retryable error.
  ({ ranked: hooks, noStrongHook } = await computeIntersections(deps.db, { llm: deps.llm }, personId));

  if (noStrongHook || hooks.length === 0) {
    if (opts.alwaysExtractContact) ({ selected: email, rejected: rejectedEmails } = await runContactExtraction(currentAff));
    return result(); // zero paid calls on the loop path
  }

  // --- Step 5: paid enrichment, survivors only ---
  const enriched = await minePersonWeb(
    { search: deps.search, fetcher: deps.fetcher, llm: deps.llm },
    resolution,
    raw,
    free.facts,
  );
  persistPerson(deps.db, resolution, raw, enriched);
  factCount = enriched.facts.length;
  profileSummary = enriched.profileSummary;
  // Recompute so a web-mined fact can become the lead hook. Measured case:
  // person 58's top hook (tier A, 0.9, 'olfaction') came from a CSHL page and
  // outranked their best arXiv hook.
  ({ ranked: hooks, noStrongHook } = await computeIntersections(deps.db, { llm: deps.llm }, personId));

  // --- Step 6: contact, survivors only ---
  ({ selected: email, rejected: rejectedEmails } = await runContactExtraction(currentAff));
  if (email) {
    upsertPerson(deps.db, {
      name: target.name,
      openalexId: resolution.author.id,
      email: email.email,
      emailConfidence: email.confidence,
      emailSource: email.source,
    });
  }
  return result();
}
