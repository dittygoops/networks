import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { runLoop } from '../src/pipeline/loop.js';
import { createStubChannel } from '../src/approval/channel.js';
import { logEvent, persistDraft, priorThreads } from '../src/approval/ledger.js';
import { recordDiscovered } from '../src/discovery/seenLedger.js';
import type { Candidate, DiscoverySource } from '../src/discovery/types.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';
import type { OrchestrateResult } from '../src/pipeline/orchestrate.js';

const GATE = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3, maxResumePerRun: 10, maxResumeAttempts: 3 };

const cand = (arxivId: string, title: string): Candidate => ({
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

const rejectedResult = (arxivId: string, personId: number): OrchestrateResult => ({
  ...resolvedResult(arxivId, personId),
  email: null,
  rejectedEmails: [{ email: 'someoneelse@uni.edu', source: 'homepage', reason: 'identity_mismatch' }],
});

describe('runLoop discovery', () => {
  it('filters a low relevance candidate without drafting it', async () => {
    const db = openDb(':memory:');
    const { deps } = baseDeps(db, { sources: [source([cand('2601.00001', 'Byzantine Consensus Protocols')])] });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.filtered).toBe(1);
    expect(deps.processPaper).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00001') as { status: string };
    expect(row.status).toBe('filtered_low_relevance');
  });

  it('marks a relevant paper unsendable when no email resolves', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const noEmail = { ...resolvedResult('2601.00002', pid), email: null };
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00002', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(noEmail),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.unsendable).toBe(1);
    expect(channel.sent).toHaveLength(0);
    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00002') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('email');
  });

  it('reports the hook failure, not the email failure, when a candidate has neither', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    // After hook-first gating, contact extraction never runs for a hookless
    // candidate, so email is null for a reason that is NOT "we looked and
    // failed". The hook gate must win, or the no-grounded-hook bucket
    // silently becomes unobservable.
    const neither = { ...resolvedResult('2601.00009', pid), email: null, hooks: [], noStrongHook: true };
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00009', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(neither),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.unsendable).toBe(1);
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00009') as { reason: string };
    expect(row.reason).toBe('no grounded hook');
  });

  it('marks a flagged identity collision unsendable and never messages it', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Wenwen Zhang' });
    const collided = {
      ...resolvedResult('2601.00040', pid),
      identityCollisionReason: 'identity collision suspected (176 collaborators, 136 institutions)',
    };
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00040', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(collided),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.unsendable).toBe(1);
    expect(summary.messaged).toBe(0);
    expect(channel.sent).toHaveLength(0);
    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00040') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toContain('identity collision suspected (176 collaborators, 136 institutions)');
  });

  it('messages a sendable draft and records it', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00003', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00003', pid)),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(1);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.to).toBe('someone@uni.edu');
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00003') as { status: string };
    expect(row.status).toBe('messaged');
  });

  it('queues sendable drafts beyond the per-run cap', async () => {
    const db = openDb(':memory:');
    // Two distinct people, not one: this test is about the per-run cap, and
    // the awaiting_approval prior-thread guard would otherwise skip the
    // second candidate for an unrelated reason if it shared a person with
    // the first.
    const pid1 = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const pid2 = upsertPerson(db, { name: 'Someone Else', email: 'someone-else@uni.edu' });
    const cands = ['2601.00010', '2601.00011'].map((id) => cand(id, 'Olfactory Embedding Space Sensors'));
    const { deps, channel } = baseDeps(db, {
      config: { queries: [], authors: [], seeds: [], gate: { ...GATE, maxMessagesPerRun: 1 } },
      sources: [source(cands)],
      processPaper: vi.fn(async (_d: unknown, id: string) => resolvedResult(id, id === '2601.00010' ? pid1 : pid2)),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(1);
    expect(channel.sent).toHaveLength(1);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM seen_papers WHERE status = 'queued_for_message'").get() as {
      n: number;
    };
    expect(queued.n).toBe(1);
  });

  it('dry run messages nothing and sends nothing', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00004', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00004', pid)),
    });
    const summary = await runLoop(deps, { dryRun: true });
    expect(channel.sent).toHaveLength(0);
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(summary.dryRun).toBe(true);
  });

  // D3. The guards that already existed stopped a dry run SENDING during the
  // run. They did not stop it arming the next one: emit wrote
  // queued_for_message, the next real run's flush drained that row and texted
  // the draft, and a "y" there sends a real irreversible email.
  it('dry run leaves no row a later real run would flush and text', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00030', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00030', pid)),
    });
    const summary = await runLoop(deps, { dryRun: true });

    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00030') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('discovered');
    expect(row.reason).toContain('dry run');
    expect(summary.queued).toBe(0);
    expect(summary.wouldMessage).toBe(1);

    const queued = db
      .prepare("SELECT COUNT(*) AS n FROM seen_papers WHERE status = 'queued_for_message'")
      .get() as { n: number };
    expect(queued.n).toBe(0);
  });

  // D3. A dry-run draft is a real drafts row at awaiting_approval, which
  // priorThreads matches, so it permanently blocks that person from every
  // future candidate until a human replies "dX n". The abandonment sweep
  // cannot clear it either, because a dry run does not consume attempts.
  it('dry run creates no draft, so it cannot block a person forever', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00031', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00031', pid)),
    });
    await runLoop(deps, { dryRun: true });

    expect(deps.generateDraft).not.toHaveBeenCalled();
    const drafts = db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number };
    expect(drafts.n).toBe(0);
    expect(priorThreads(db, pid)).toEqual([]);
  });

  // The work is deferred, not lost. 'discovered' is a resting state with
  // exactly one reader, the resume step (docs/spec-candidate-stranding.md CS1),
  // so the next real run drafts and messages it for real.
  it('a real run after a dry run picks the candidate up and messages it', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const paper = cand('2601.00032', 'Olfactory Embedding Space Sensors');
    const processPaper = vi.fn().mockResolvedValue(resolvedResult('2601.00032', pid));

    const dry = baseDeps(db, { sources: [source([paper])], processPaper });
    await runLoop(dry.deps, { dryRun: true });
    expect(dry.channel.sent).toHaveLength(0);

    // The real run's source returns nothing: the candidate must come back
    // through the resume path, not through rediscovery.
    const real = baseDeps(db, { sources: [source([])], processPaper });
    const summary = await runLoop(real.deps, { dryRun: false });

    expect(summary.resumed).toBe(1);
    expect(real.channel.sent).toHaveLength(1);
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00032') as {
      status: string;
    };
    expect(row.status).toBe('messaged');
  });

  // The cap branch in emit also writes queued_for_message, so the dry-run
  // check has to come BEFORE it or a dry run that goes over budget arms a real
  // run by the other door.
  it('dry run over the message cap still queues nothing', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00033',
      paperTitle: 'Capped',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    recordDiscovered(db, cand('2601.00033', 'Capped'));
    db.prepare('UPDATE seen_papers SET draft_id = ? WHERE arxiv_id = ?').run(p.draftId, '2601.00033');

    const { deps, channel } = baseDeps(db, {
      sources: [source([])],
      config: {
        queries: ['olfactory embedding space'],
        authors: [],
        seeds: [],
        gate: { ...GATE, maxMessagesPerRun: 0 },
      },
    });
    const summary = await runLoop(deps, { dryRun: true });

    expect(channel.sent).toHaveLength(0);
    expect(summary.queued).toBe(0);
    const row = db.prepare('SELECT status FROM seen_papers WHERE arxiv_id = ?').get('2601.00033') as {
      status: string;
    };
    expect(row.status).toBe('discovered');
  });

  it('skips a person who already has a thread', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2500.00001',
      paperTitle: 'Earlier',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00005', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00005', pid)),
    });
    await runLoop(deps, { dryRun: false });
    expect(channel.sent).toHaveLength(0);
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00005') as { reason: string };
    expect(row.reason).toContain('prior thread');
  });

  it('drafts and messages only one of two candidates that share a person within one run', async () => {
    // The author-watch source's normal output is two papers by the same
    // author. Without the awaiting_approval guard, both would clear
    // priorThreads (neither is sent/approved yet) and both would be
    // messaged, sending that person two cold emails.
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const cands = ['2601.00030', '2601.00031'].map((id) => cand(id, 'Olfactory Embedding Space Sensors'));
    const { deps, channel } = baseDeps(db, {
      sources: [source(cands)],
      processPaper: vi.fn(async (_d: unknown, id: string) => resolvedResult(id, pid)),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(1);
    expect(summary.unsendable).toBe(1);
    expect(channel.sent).toHaveLength(1);
    const rows = db.prepare('SELECT arxiv_id AS arxivId, status, reason FROM seen_papers ORDER BY arxiv_id').all() as {
      arxivId: string;
      status: string;
      reason: string | null;
    }[];
    const first = rows.find((r) => r.arxivId === '2601.00030');
    const second = rows.find((r) => r.arxivId === '2601.00031');
    expect(first?.status).toBe('messaged');
    expect(second?.status).toBe('drafted_unsendable');
    expect(second?.reason).toContain('prior thread');
  });

  it('drafts, asks for the address, and parks the row with its draft id attached', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00020', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(rejectedResult('2601.00020', pid)),
    });
    await runLoop(deps, { dryRun: false });
    // The message, not a draft message: a draft message begins "dN:" and is
    // tapback-approvable, which would let one thumbs up send the very email
    // that was flagged as going to the wrong person.
    expect(channel.sent).toHaveLength(0);
    const needs = channel.notices.find((n) => n.startsWith('NEEDS ADDRESS'));
    expect(needs).toBeDefined();
    expect(needs).toContain('someoneelse@uni.edu');
    const row = db.prepare('SELECT status, reason, draft_id AS draftId FROM seen_papers WHERE arxiv_id = ?')
      .get('2601.00020') as { status: string; reason: string; draftId: number | null };
    expect(row.status).toBe('drafted_unsendable');
    expect(row.reason).toMatch(/^awaiting address correction \(d\d+\): rejected someoneelse@uni\.edu$/);
    // Load-bearing: without it, a successful correction makes strandedReport's
    // orphanDrafts query raise a permanent false alarm.
    expect(row.draftId).not.toBeNull();
  });

  it('still reports no email resolved when nothing was rejected', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps } = baseDeps(db, {
      sources: [source([cand('2601.00021', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue({ ...resolvedResult('2601.00021', pid), email: null }),
    });
    await runLoop(deps, { dryRun: false });
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00021') as { reason: string };
    expect(row.reason).toBe('no email resolved');
  });

  // The budget-separation regression. GATE.maxMessagesPerRun is 3 in this
  // file, and maxAddressRequestsPerRun defaults to 3, so three approvable
  // drafts AND an address request must all go out in one run.
  it('does not let an address request consume a message slot', async () => {
    const db = openDb(':memory:');
    const ids = ['2601.00030', '2601.00031', '2601.00032'];
    const people = ids.map((_, i) => upsertPerson(db, { name: `Person ${i}`, openalexId: `A${i}` }));
    const needy = upsertPerson(db, { name: 'Needy', openalexId: 'A-needy' });
    const byId: Record<string, OrchestrateResult> = {};
    ids.forEach((a, i) => { byId[a] = resolvedResult(a, people[i]!); });
    byId['2601.00033'] = rejectedResult('2601.00033', needy);
    const { deps, channel } = baseDeps(db, {
      sources: [source([...ids, '2601.00033'].map((a) => cand(a, 'Olfactory Embedding Space Sensors')))],
      processPaper: vi.fn(async (_d: unknown, a: string) => byId[a]!),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(3);              // the cap is fully spent on drafts
    expect(summary.addressRequested).toBe(1);      // and the request still went out
    expect(channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(1);
  });

  it('defers past its own budget without touching queued_for_message', async () => {
    const db = openDb(':memory:');
    const ids = ['2601.00040', '2601.00041', '2601.00042', '2601.00043'];
    const byId: Record<string, OrchestrateResult> = {};
    ids.forEach((a, i) => { byId[a] = rejectedResult(a, upsertPerson(db, { name: `P${i}`, openalexId: `B${i}` })); });
    const { deps, channel } = baseDeps(db, {
      sources: [source(ids.map((a) => cand(a, 'Olfactory Embedding Space Sensors')))],
      processPaper: vi.fn(async (_d: unknown, a: string) => byId[a]!),
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.addressRequested).toBe(3);
    expect(channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(3);
    const deferred = db.prepare(
      `SELECT status, reason FROM seen_papers WHERE reason LIKE 'address correction not yet requested%'`,
    ).all() as { status: string; reason: string }[];
    expect(deferred).toHaveLength(1);
    // queued_for_message is the wrong resting place: runLoop's flush would call
    // resolveSendableDraft, hit the no_email branch, and RETIRE the draft,
    // destroying the very draft the correction waits for.
    expect(deferred[0]!.status).toBe('drafted_unsendable');
  });

  it('drains the deferred backlog on the next run', async () => {
    const db = openDb(':memory:');
    const ids = ['2601.00040', '2601.00041', '2601.00042', '2601.00043'];
    const byId: Record<string, OrchestrateResult> = {};
    ids.forEach((a, i) => { byId[a] = rejectedResult(a, upsertPerson(db, { name: `P${i}`, openalexId: `C${i}` })); });
    const first = baseDeps(db, {
      sources: [source(ids.map((a) => cand(a, 'Olfactory Embedding Space Sensors')))],
      processPaper: vi.fn(async (_d: unknown, a: string) => byId[a]!),
    });
    await runLoop(first.deps, { dryRun: false });
    const second = baseDeps(db, { sources: [source([])] });
    const summary = await runLoop(second.deps, { dryRun: false });
    expect(summary.addressRequested).toBe(1);
    expect(second.channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM seen_papers WHERE reason LIKE 'address correction not yet requested%'`)
      .get()).toEqual({ n: 0 });
  });

  it('never asks again about a person who declined', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00050', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(rejectedResult('2601.00050', pid)),
    });
    // Stand in for an earlier "dN n" on a different draft for the same person.
    logEvent(db, null, 'address_request_declined', { personId: pid });
    await runLoop(deps, { dryRun: false });
    expect(channel.notices.filter((n) => n.startsWith('NEEDS ADDRESS'))).toHaveLength(0);
    const row = db.prepare('SELECT reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00050') as { reason: string };
    expect(row.reason).toBe('address correction declined for this person');
  });

  it('puts the pending backlog in the run summary, because a CLI command is somewhere he has to go', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00060', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(rejectedResult('2601.00060', pid)),
    });
    await runLoop(deps, { dryRun: false });
    const line = channel.notices[channel.notices.length - 1]!;
    expect(line).toContain('address requests 1');
    expect(line).toContain('addresses pending 1');
  });
});

describe('runLoop approvals', () => {
  it('sends the email when the reply approves', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00006',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const { deps, channel } = baseDeps(db);
    channel.queueReply(`${p.shortId} y`);
    const summary = await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).toHaveBeenCalledTimes(1);
    expect(summary.sent).toBe(1);
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('sent');
  });

  it('does not send when the reply skips', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00007',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const { deps, channel } = baseDeps(db);
    channel.queueReply(`${p.shortId} n`);
    await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('skipped');
  });

  // CS3.5 (docs/spec-candidate-stranding.md): a thrown error is retryable, not
  // terminal. This test used to assert 'drafted_unsendable'; the whole point
  // of the stranding fix is that a transient generateDraft blip must not
  // permanently drop the candidate, so it now stays 'discovered' for the next
  // run's resume step to pick up.
  it('leaves a candidate retryable, and keeps the run going, when generateDraft throws', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00020', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00020', pid)),
    });
    const original = deps.generateDraft as ReturnType<typeof vi.fn>;
    original.mockRejectedValueOnce(new Error('llm outage'));
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.retryable).toBe(1);
    expect(summary.unsendable).toBe(0);
    expect(summary.errors.some((e) => e.includes('llm outage'))).toBe(true);
    const row = db.prepare('SELECT status, reason, attempts FROM seen_papers WHERE arxiv_id = ?').get('2601.00020') as {
      status: string;
      reason: string;
      attempts: number;
    };
    expect(row.status).toBe('discovered');
    expect(row.attempts).toBe(1);
    expect(row.reason).toContain('llm outage');
    expect(channel.notices.length).toBeGreaterThan(0);
    expect(channel.notices[channel.notices.length - 1]).toContain('errors:');
  });

  it('still processes a second candidate after an earlier one throws', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const cands = ['2601.00021', '2601.00022'].map((id) => cand(id, 'Olfactory Embedding Space Sensors'));
    const generateDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error('llm outage'))
      .mockResolvedValue(groundedDraft);
    const { deps } = baseDeps(db, {
      sources: [source(cands)],
      processPaper: vi.fn(async (_d: unknown, id: string) => resolvedResult(id, pid)),
      generateDraft,
    });
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.retryable).toBe(1);
    expect(summary.messaged).toBe(1);
    const rows = db.prepare('SELECT arxiv_id AS arxivId, status FROM seen_papers ORDER BY arxiv_id').all() as {
      arxivId: string;
      status: string;
    }[];
    expect(rows.find((r) => r.arxivId === '2601.00021')?.status).toBe('discovered');
    expect(rows.find((r) => r.arxivId === '2601.00022')?.status).toBe('messaged');
  });

  it('queues a draft for retry when sendDraftMessage rejects while messaging a fresh candidate', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const { deps, channel } = baseDeps(db, {
      sources: [source([cand('2601.00023', 'Olfactory Embedding Space Sensors')])],
      processPaper: vi.fn().mockResolvedValue(resolvedResult('2601.00023', pid)),
    });
    channel.sendDraftMessage = vi.fn().mockRejectedValueOnce(new Error('imessage down'));
    const summary = await runLoop(deps, { dryRun: false });
    expect(summary.messaged).toBe(0);
    expect(summary.queued).toBe(1);
    const row = db.prepare('SELECT status, reason FROM seen_papers WHERE arxiv_id = ?').get('2601.00023') as {
      status: string;
      reason: string;
    };
    expect(row.status).toBe('queued_for_message');
    expect(row.reason).toContain('imessage down');
  });

  // Was "retries an approved-but-unsent draft on the next run". That behavior
  // was defect D1: an approved draft whose send outcome is unknown must never
  // be re-sent automatically, because a send that timed out after Gmail
  // accepted it is indistinguishable from one Gmail never received.
  // docs/superpowers/plans/2026-07-29-send-path-safety.md.
  it('never auto-sends an approved-but-unsent draft, and reports it once', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00024',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'approved' WHERE id = ?").run(p.draftId);
    const { deps, channel } = baseDeps(db);

    const first = await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(first.sent).toBe(0);
    expect(first.stalled).toBe(1);
    expect(channel.notices.join(' ')).toContain(p.shortId);

    // The second run must not text the same stall again.
    const noticesAfterFirst = channel.notices.length;
    const second = await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(second.stalled).toBe(0);
    // Only the end-of-run summary line was added.
    expect(channel.notices.length).toBe(noticesAfterFirst + 1);

    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('approved');
  });

  it('does not retry an approved-but-unsent draft under dry run', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00025',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    db.prepare("UPDATE drafts SET status = 'approved' WHERE id = ?").run(p.draftId);
    const { deps } = baseDeps(db);
    await runLoop(deps, { dryRun: true });
    expect(deps.sender.send).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('approved');
  });

  it('answers an edit reply with a not-supported notice and does not send', async () => {
    const db = openDb(':memory:');
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const p = persistDraft(db, {
      personId: pid,
      paperArxivId: '2601.00008',
      paperTitle: 'A Paper',
      intent: 'seeking direction',
      draftInput,
      draft: groundedDraft,
      contextJson: {},
    });
    const { deps, channel } = baseDeps(db);
    channel.queueReply(`${p.shortId} make it shorter`);
    await runLoop(deps, { dryRun: false });
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(channel.notices.join(' ')).toContain('not yet supported');
  });
});
