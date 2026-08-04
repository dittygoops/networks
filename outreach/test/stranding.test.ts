// Tests for docs/spec-candidate-stranding.md: resuming rows stuck at
// 'discovered', the shared never-email-twice re-check on both the flush and
// the resume path (correction C1), the explicit no-email resolution and its
// exclusion from orphan adoption (correction C2), summary.stranded as a
// per-run delta that excludes normal in-flight `outreach add` orphans
// (correction C3), and a dry run never consuming the attempt budget
// (correction C4).
import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { runLoop } from '../src/pipeline/loop.js';
import { createStubChannel } from '../src/approval/channel.js';
import { decide, persistDraft, priorThreads } from '../src/approval/ledger.js';
import { recordDiscovered, strandedReport } from '../src/discovery/seenLedger.js';
import type { Candidate, DiscoverySource } from '../src/discovery/types.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';
import type { OrchestrateResult } from '../src/pipeline/orchestrate.js';

const GATE = {
  threshold: 0.6,
  borderlineBand: 0.1,
  maxMessagesPerRun: 3,
  maxResumePerRun: 10,
  maxResumeAttempts: 3,
};

const cand = (arxivId: string, title = 'Olfactory Embedding Space Sensors'): Candidate => ({
  arxivId,
  title,
  abstract: title,
  discoveredVia: 'saved_query',
  sourceDetail: 'query: olfactory embedding space',
});

const source = (cs: Candidate[]): DiscoverySource => ({
  name: 'saved_query',
  fetch: async () => ({ candidates: cs, errors: [] }),
});

const groundedDraft: Draft = { subject: 'a subject', body: 'a body', grounded: true, wordCount: 2, notes: [] };
const draftInput: DraftInput = {
  recipient: { name: 'Someone', paperTitle: 'T' },
  hooks: [],
  intent: 'seeking direction',
  senderName: 'Aditya Gupta',
};

function baseDeps(db: ReturnType<typeof openDb>, overrides: Partial<Parameters<typeof runLoop>[0]> = {}) {
  const channel = createStubChannel();
  return {
    deps: {
      db,
      channel,
      config: { queries: ['olfactory embedding space'], authors: [], seeds: [], gate: GATE },
      sources: [source([])],
      terms: ['olfactory embedding space'],
      processPaper: vi.fn(),
      generateDraft: vi.fn().mockResolvedValue(groundedDraft),
      buildDraftInput: () => draftInput,
      sender: { send: vi.fn().mockResolvedValue({ sentId: 'msg-1' }) },
      ...overrides,
    },
    channel,
  };
}

const resolvedResult = (arxivId: string, personId: number): OrchestrateResult => ({
  arxivId,
  target: 'Someone',
  paperTitle: 'A Paper',
  resolved: true,
  email: { email: 'someone@uni.edu', confidence: 0.9, source: 'homepage' } as OrchestrateResult['email'],
  personId,
  factCount: 10,
  hooks: [{ tier: 'A' } as never],
  noStrongHook: false,
  notes: [],
});

function seenRow(db: ReturnType<typeof openDb>, arxivId: string) {
  return db.prepare('SELECT * FROM seen_papers WHERE arxiv_id = ?').get(arxivId) as {
    arxivId: string;
    status: string;
    reason: string | null;
    attempts: number;
    draft_id: number | null;
  };
}

function draftStatus(db: ReturnType<typeof openDb>, draftId: number): string {
  return (db.prepare('SELECT status FROM drafts WHERE id = ?').get(draftId) as { status: string }).status;
}

describe('resume: a stranded discovered row is picked up (CS1)', () => {
  it('resumes and messages a row with no draft yet', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    recordDiscovered(db, cand('2601.10001'));
    const { deps, channel } = baseDeps(db, {
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.10001', pid)),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(deps.processPaper).toHaveBeenCalled();
    expect(summary.resumed).toBe(1);
    expect(channel.sent).toHaveLength(1);
    const row = seenRow(db, '2601.10001');
    expect(row.status).toBe('messaged');
  });
});

describe('resume: existing draft is never re-drafted (CS4.1)', () => {
  it('emits the persisted draft without calling processPaper or generateDraft', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10002',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10002'));
    db.prepare("UPDATE seen_papers SET draft_id = ? WHERE arxiv_id = ?").run(p.draftId, '2601.10002');

    const processPaper = vi.fn();
    const generateDraft = vi.fn().mockResolvedValue(groundedDraft);
    const { deps, channel } = baseDeps(db, { processPaper, generateDraft });
    const summary = await runLoop(deps, { dryRun: false });

    expect(processPaper).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
    expect(summary.resumed).toBe(1);
    const draftCount = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(draftCount.n).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.shortId).toBe(p.shortId);
    const row = seenRow(db, '2601.10002');
    expect(row.status).toBe('messaged');
  });
});

describe('resume: mandatory priorThreads re-check even with its own draft (CS4.2, correction C1)', () => {
  it('refuses to emit and retires its own draft when a prior thread appeared in the interval', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const d1 = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10003',
      paperTitle: 'Paper X',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10003'));
    db.prepare("UPDATE seen_papers SET draft_id = ? WHERE arxiv_id = ?").run(d1.draftId, '2601.10003');

    // Simulate the interval: a second draft for the same person, acquired by
    // outreach add / outreach listen / a different loop run, is now `sent`.
    const d2 = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.09999',
      paperTitle: 'A different paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(d2.draftId);

    const { deps, channel } = baseDeps(db);
    await runLoop(deps, { dryRun: false });

    expect(channel.sent).toHaveLength(0);
    const row = seenRow(db, '2601.10003');
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('prior thread exists');
    expect(row.reason).toContain('own draft');
    expect(draftStatus(db, d1.draftId)).toBe('skipped');
    expect(draftStatus(db, d2.draftId)).toBe('sent');
  });

  it('does emit when excludeDraftId correctly stops the row matching its own draft', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const d1 = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10004',
      paperTitle: 'Paper Y',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10004'));
    db.prepare("UPDATE seen_papers SET draft_id = ? WHERE arxiv_id = ?").run(d1.draftId, '2601.10004');

    const { deps, channel } = baseDeps(db);
    await runLoop(deps, { dryRun: false });

    expect(channel.sent).toHaveLength(1);
    const row = seenRow(db, '2601.10004');
    expect(row.status).toBe('messaged');
  });
});

describe('flush: mandatory priorThreads re-check before emitting a queued draft (correction C1)', () => {
  it('refuses a day-old queued draft when a prior thread appeared in the interval', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const queued = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10005',
      paperTitle: 'Paper Q',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10005'));
    db.prepare("UPDATE seen_papers SET draft_id = ?, status = 'queued_for_message' WHERE arxiv_id = ?").run(
      queued.draftId,
      '2601.10005',
    );

    // Same person acquires a prior thread while the draft sat queued.
    const prior = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.09998',
      paperTitle: 'An earlier paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(prior.draftId);

    const { deps, channel } = baseDeps(db);
    await runLoop(deps, { dryRun: false });

    // Before correction C1 the flush's inline query had no prior-thread check
    // at all, so this queued draft would have been texted for approval.
    expect(channel.sent).toHaveLength(0);
    expect(draftStatus(db, queued.draftId)).toBe('skipped');
    const row = seenRow(db, '2601.10005');
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('prior thread exists');
  });
});

describe('no email on record is resolved explicitly, not a silent continue (correction C2)', () => {
  it('retires the draft and marks the row terminal with a recorded reason', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'No Email Person' }); // no email
    const d = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10006',
      paperTitle: 'Paper NE',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10006'));
    db.prepare("UPDATE seen_papers SET draft_id = ?, status = 'queued_for_message' WHERE arxiv_id = ?").run(
      d.draftId,
      '2601.10006',
    );

    const { deps, channel } = baseDeps(db);
    await runLoop(deps, { dryRun: false });

    expect(channel.sent).toHaveLength(0);
    expect(draftStatus(db, d.draftId)).toBe('skipped');
    const row = seenRow(db, '2601.10006');
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('no email on record');
  });
});

describe('orphan adoption excludes outreach add manual-lookup-queue drafts (correction C2)', () => {
  it('does not adopt a no-email orphan, and drafts fresh instead', async () => {
    const db = openDb(':memory:');
    // The `outreach add` no-email draft: a real person, no email, awaiting
    // approval, never linked into seen_papers.
    const noEmailPerson = upsertPerson(db, { name: 'Manual Lookup Person' });
    const manualDraft = persistDraft(db, {
      personId: noEmailPerson,
      paperArxivId: '2601.10007',
      paperTitle: 'Paper MQ',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });

    recordDiscovered(db, cand('2601.10007'));

    const emailPerson = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const processPaper = vi.fn().mockResolvedValue(resolvedResult('2601.10007', emailPerson));
    const { deps, channel } = baseDeps(db, { processPaper });
    const summary = await runLoop(deps, { dryRun: false });

    // Adoption must have been skipped: the loop drafted fresh instead.
    expect(processPaper).toHaveBeenCalled();
    expect(summary.resumed).toBe(1);
    const row = seenRow(db, '2601.10007');
    expect(row.draft_id).not.toBe(manualDraft.draftId);
    expect(row.status).toBe('messaged');
    expect(channel.sent).toHaveLength(1);
    // The manual-lookup draft is untouched: still pending, still unlinked.
    expect(draftStatus(db, manualDraft.draftId)).toBe('awaiting_approval');
    const draftCount = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(draftCount.n).toBe(2);
  });
});

describe('orphan adoption: the unambiguous case (CS6.1)', () => {
  it('adopts a single orphan draft and emits it without re-drafting', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const orphan = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10008',
      paperTitle: 'Paper OA',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10008'));

    const processPaper = vi.fn();
    const { deps, channel } = baseDeps(db, { processPaper });
    const summary = await runLoop(deps, { dryRun: false });

    expect(processPaper).not.toHaveBeenCalled();
    expect(summary.resumed).toBe(1);
    const row = seenRow(db, '2601.10008');
    expect(row.draft_id).toBe(orphan.draftId);
    expect(row.reason).toContain('adopted orphan draft');
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.shortId).toBe(orphan.shortId);
  });
});

describe('orphan adoption: the ambiguous case (CS6.2)', () => {
  it('sends nothing, marks ambiguous, and leaves both drafts alone', async () => {
    const db = openDb(':memory:');
    const pid1 = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const pid2 = upsertPerson(db, { name: 'Someone Else', email: 'someone-else@uni.edu' });
    const d1 = persistDraft(db, {
      personId: pid1,
      paperArxivId: '2601.10009',
      paperTitle: 'Paper AMB',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const d2 = persistDraft(db, {
      personId: pid2,
      paperArxivId: '2601.10009',
      paperTitle: 'Paper AMB',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10009'));

    const processPaper = vi.fn();
    const { deps, channel } = baseDeps(db, { processPaper });
    const summary = await runLoop(deps, { dryRun: false });

    expect(processPaper).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
    const row = seenRow(db, '2601.10009');
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('ambiguous orphan drafts');
    expect(draftStatus(db, d1.draftId)).toBe('awaiting_approval');
    expect(draftStatus(db, d2.draftId)).toBe('awaiting_approval');
    expect(summary.stranded).toBeGreaterThanOrEqual(1);
  });
});

describe('exhaustion sweep (CS3.4)', () => {
  it('abandons an exhausted row with no draft, and does not resume it', async () => {
    const db = openDb(':memory:');
    recordDiscovered(db, cand('2601.10010'));
    db.prepare(
      "UPDATE seen_papers SET attempts = 3, reason = 'attempt 3 failed: boom' WHERE arxiv_id = ?",
    ).run('2601.10010');

    const processPaper = vi.fn();
    const { deps } = baseDeps(db, { processPaper });
    const summary = await runLoop(deps, { dryRun: false });

    expect(processPaper).not.toHaveBeenCalled();
    expect(summary.resumed).toBe(0);
    const row = seenRow(db, '2601.10010');
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('abandoned after 3 attempts');
    expect(summary.stranded).toBe(1);
  });

  it('retires the draft first when abandoning an exhausted row that owns one, unblocking the person', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const d = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10011',
      paperTitle: 'Paper EX',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10011'));
    db.prepare("UPDATE seen_papers SET draft_id = ?, attempts = 3 WHERE arxiv_id = ?").run(d.draftId, '2601.10011');

    const { deps } = baseDeps(db);
    const summary = await runLoop(deps, { dryRun: false });

    const row = seenRow(db, '2601.10011');
    expect(row.status).toBe('drafted_unsendable');
    expect(draftStatus(db, d.draftId)).toBe('skipped');
    expect(priorThreads(db, pid)).toHaveLength(0);
    expect(summary.stranded).toBe(1);
  });
});

describe('summary.stranded is a per-run delta, not a lifetime total (correction C3)', () => {
  it('does not recount an already-abandoned row on a later run', async () => {
    const db = openDb(':memory:');
    recordDiscovered(db, cand('2601.10012'));
    db.prepare("UPDATE seen_papers SET attempts = 3 WHERE arxiv_id = ?").run('2601.10012');

    const { deps: deps1 } = baseDeps(db);
    const first = await runLoop(deps1, { dryRun: false });
    expect(first.stranded).toBe(1);

    const { deps: deps2 } = baseDeps(db);
    const second = await runLoop(deps2, { dryRun: false });
    expect(second.stranded).toBe(0);
  });

  it('does not count a normal in-flight outreach add draft as stranded', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    // outreach add persisted this and the loop never discovered the paper at
    // all (no seen_papers row references it, or exists for its arxiv id).
    persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10013',
      paperTitle: 'Paper CLI',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });

    const { deps } = baseDeps(db);
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.stranded).toBe(0);
    const report = strandedReport(db, GATE.maxResumeAttempts);
    expect(report.orphanDrafts).toHaveLength(0);
  });
});

describe('dry run never consumes the attempt budget (correction C4)', () => {
  it('leaves attempts unchanged across repeated dry-run rehearsals', async () => {
    const db = openDb(':memory:');
    recordDiscovered(db, cand('2601.10014'));

    const processPaper = vi.fn().mockRejectedValue(new Error('rehearsal blip'));
    for (let i = 0; i < 3; i++) {
      const { deps } = baseDeps(db, { processPaper });
      await runLoop(deps, { dryRun: true });
      const row = seenRow(db, '2601.10014');
      expect(row.status).toBe('discovered');
      expect(row.attempts).toBe(0);
    }
  });

  it('does not run the exhaustion sweep or call decide under dry run', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const d = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10015',
      paperTitle: 'Paper DR',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10015'));
    db.prepare("UPDATE seen_papers SET draft_id = ?, attempts = 3 WHERE arxiv_id = ?").run(d.draftId, '2601.10015');

    const { deps, channel } = baseDeps(db);
    const summary = await runLoop(deps, { dryRun: true });

    expect(channel.sent).toHaveLength(0);
    expect(deps.sender.send).not.toHaveBeenCalled();
    const decisionCount = db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(decisionCount.n).toBe(0);
    const row = seenRow(db, '2601.10015');
    expect(row.status).toBe('discovered');
    expect(draftStatus(db, d.draftId)).toBe('awaiting_approval');
    expect(summary.stranded).toBeGreaterThanOrEqual(1); // reported, not acted on
  });
});

describe('recovering after a crash right after persistDraft (1.4, exercises the adopt-existing-draft path)', () => {
  // Reconstructs exactly the state a real crash leaves: persistDraft and the
  // setStatus(..., 'discovered', ..., draftId) pointer both committed
  // (CS4.3's atomic transaction), but emit() never ran. A fresh run must find
  // the row already has a draft and go straight to CS4.1's emit-existing path
  // rather than calling processPaper/generateDraft again.
  it('adopts the existing draft on the next run and never re-drafts', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const persisted = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.10016',
      paperTitle: 'Paper Crash',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.10016'));
    // Mirrors processCandidate's atomic persistDraft+setStatus exactly.
    db.prepare("UPDATE seen_papers SET status = 'discovered', reason = ?, draft_id = ? WHERE arxiv_id = ?").run(
      'matches gap term: olfactory embedding space',
      persisted.draftId,
      '2601.10016',
    );

    const processPaper = vi.fn(() => {
      throw new Error('must not be called: the row already has a draft');
    });
    const generateDraft = vi.fn(() => {
      throw new Error('must not be called: the row already has a draft');
    });
    const { deps, channel } = baseDeps(db, { processPaper, generateDraft });
    const summary = await runLoop(deps, { dryRun: false });

    expect(processPaper).not.toHaveBeenCalled();
    expect(generateDraft).not.toHaveBeenCalled();
    expect(summary.resumed).toBe(1);
    expect(summary.errors).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.shortId).toBe(persisted.shortId);
    const row = seenRow(db, '2601.10016');
    expect(row.status).toBe('messaged');
    const draftCount = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(draftCount.n).toBe(1);
  });
});

describe('stranded report covers pending address corrections', () => {
  const seedRow = (db: ReturnType<typeof openDb>, arxivId: string, reason: string) =>
    db.prepare(
      `INSERT INTO seen_papers (arxiv_id, title, discovered_via, status, reason)
       VALUES (?, 'A Paper', 'saved_query', 'drafted_unsendable', ?)`,
    ).run(arxivId, reason);

  it('prints both new reasons', () => {
    const db = openDb(':memory:');
    seedRow(db, '2601.00001', 'awaiting address correction (d7): rejected wrong@x.edu');
    seedRow(db, '2601.00002', 'address correction not yet requested (d8): rejected wrong@y.edu');
    // Unchanged: the other 250-odd drafted_unsendable rows stay invisible.
    // Making them visible is a separate spec.
    seedRow(db, '2601.00003', 'no grounded hook');
    const ids = strandedReport(db, 3).terminalStranded.map((r) => r.arxivId).sort();
    expect(ids).toEqual(['2601.00001', '2601.00002']);
  });

  it('drops a corrected row, so a resolved item is not printed forever', () => {
    const db = openDb(':memory:');
    seedRow(db, '2601.00004', 'awaiting address correction (d7): rejected wrong@x.edu');
    db.prepare("UPDATE seen_papers SET reason = 'address corrected (d7)' WHERE arxiv_id = ?").run('2601.00004');
    expect(strandedReport(db, 3).terminalStranded).toEqual([]);
  });
});

describe('resume does not starve fresh discovery (CS7.4)', () => {
  it('resumes only up to max_resume_per_run and still processes fresh candidates', async () => {
    const db = openDb(':memory:');
    for (const id of ['2601.10020', '2601.10021', '2601.10022']) recordDiscovered(db, cand(id));

    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const processPaper = vi.fn(async (_d: unknown, id: string) => resolvedResult(id, pid));
    const { deps } = baseDeps(db, {
      config: { queries: [], authors: [], seeds: [], gate: { ...GATE, maxResumePerRun: 1, maxMessagesPerRun: 10 } },
      sources: [source([cand('2601.10023')])],
      processPaper,
    });
    const summary = await runLoop(deps, { dryRun: false });

    expect(summary.resumed).toBe(1);
    expect(summary.seen).toBe(1);
    const stillDiscovered = db
      .prepare("SELECT COUNT(*) AS n FROM seen_papers WHERE status = 'discovered'")
      .get() as { n: number };
    // One of the three pre-seeded rows was resumed and messaged; the other two
    // stay discovered for the next run; the fresh candidate was processed too.
    expect(stillDiscovered.n).toBe(2);
  });
});
