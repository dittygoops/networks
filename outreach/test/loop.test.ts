import { describe, expect, it, vi } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { runLoop } from '../src/pipeline/loop.js';
import { createStubChannel } from '../src/approval/channel.js';
import { persistDraft } from '../src/approval/ledger.js';
import type { Candidate, DiscoverySource } from '../src/discovery/types.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';
import type { OrchestrateResult } from '../src/pipeline/orchestrate.js';

const GATE = { threshold: 0.6, borderlineBand: 0.1, maxMessagesPerRun: 3 };

const cand = (arxivId: string, title: string): Candidate => ({
  arxivId,
  title,
  abstract: title,
  discoveredVia: 'saved_query',
  sourceDetail: 'query: olfactory embedding space',
});

const source = (cs: Candidate[]): DiscoverySource => ({ name: 'saved_query', fetch: async () => cs });

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
    const pid = upsertPerson(db, { name: 'Someone', email: 'someone@uni.edu' });
    const cands = ['2601.00010', '2601.00011'].map((id) => cand(id, 'Olfactory Embedding Space Sensors'));
    const { deps, channel } = baseDeps(db, {
      config: { queries: [], authors: [], seeds: [], gate: { ...GATE, maxMessagesPerRun: 1 } },
      sources: [source(cands)],
      processPaper: vi.fn(async (_d: unknown, id: string) => resolvedResult(id, pid)),
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
