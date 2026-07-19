import { describe, expect, it } from 'vitest';
import { openDb, upsertPerson } from '../src/db/db.js';
import { formatShortId, parseShortId } from '../src/approval/ids.js';
import { decide, markSent, persistDraft, priorThreads } from '../src/approval/ledger.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Jane Doe', paperTitle: 'A Paper' },
  hooks: [],
  intent: 'seeking direction',
  senderName: 'Aditya Gupta',
};

const groundedDraft: Draft = {
  subject: 'quick question on your rss-gap work',
  body: 'body text',
  grounded: true,
  wordCount: 2,
  notes: [],
};

function setup() {
  const db = openDb(':memory:');
  const personId = upsertPerson(db, { name: 'Jane Doe' });
  return { db, personId };
}

function persist(db: ReturnType<typeof openDb>, personId: number, draft: Draft = groundedDraft) {
  return persistDraft(db, {
    personId,
    paperArxivId: '2501.00001',
    paperTitle: 'A Paper',
    intent: 'seeking direction',
    draftInput,
    draft,
    contextJson: { intent: 'seeking direction' },
  });
}

describe('short ids', () => {
  it('formats and parses round-trip, tolerating D-prefix and bare digits', () => {
    expect(formatShortId(7)).toBe('d7');
    expect(parseShortId('d7')).toBe(7);
    expect(parseShortId('D7')).toBe(7);
    expect(parseShortId(' 7 ')).toBe(7);
    expect(parseShortId('x7')).toBeNull();
    expect(parseShortId('d0')).toBeNull();
    expect(parseShortId('send d7')).toBeNull();
  });
});

describe('ledger', () => {
  it('persists draft + revision 1 and marks grounded drafts sendable', () => {
    const { db, personId } = setup();
    const p = persist(db, personId);
    expect(p.shortId).toBe(`d${p.draftId}`);
    const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(p.draftId) as Record<string, unknown>;
    expect(row.status).toBe('awaiting_approval');
    expect(row.sendable_revision_id).toBe(p.revisionId);
    expect(row.gist).toBe(groundedDraft.subject);
    const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(p.revisionId) as Record<string, unknown>;
    expect(rev.rev_no).toBe(1);
    expect(rev.provenance).toBe('model');
    expect(rev.grounded).toBe(1);
  });

  it('leaves ungrounded drafts unsendable', () => {
    const { db, personId } = setup();
    const p = persist(db, personId, { ...groundedDraft, grounded: false, notes: ['ungrounded'] });
    expect(p.sendable).toBe(false);
    const row = db.prepare('SELECT sendable_revision_id FROM drafts WHERE id = ?').get(p.draftId) as {
      sendable_revision_id: number | null;
    };
    expect(row.sendable_revision_id).toBeNull();
  });

  it('decides exactly once: the second decision reports the first (first-write-wins)', () => {
    const { db, personId } = setup();
    const p = persist(db, personId);
    expect(decide(db, p.draftId, 'send', 'cli')).toEqual({ applied: true });
    const second = decide(db, p.draftId, 'skip', 'cli', 'changed my mind');
    expect(second.applied).toBe(false);
    if (!second.applied) expect(second.existing.action).toBe('send');
    const row = db.prepare('SELECT status, decided_at FROM drafts WHERE id = ?').get(p.draftId) as Record<string, unknown>;
    expect(row.status).toBe('approved');
    expect(row.decided_at).not.toBeNull();
  });

  it('skip is terminal and recorded with its reason', () => {
    const { db, personId } = setup();
    const p = persist(db, personId);
    decide(db, p.draftId, 'skip', 'cli', 'too salesy');
    const row = db.prepare('SELECT status FROM drafts WHERE id = ?').get(p.draftId) as { status: string };
    expect(row.status).toBe('skipped');
    const d = db.prepare('SELECT reason FROM decisions WHERE draft_id = ?').get(p.draftId) as { reason: string };
    expect(d.reason).toBe('too salesy');
  });

  it('never-email-twice guard: sent and approved drafts count, skipped do not', () => {
    const { db, personId } = setup();
    const p1 = persist(db, personId);
    decide(db, p1.draftId, 'send', 'cli');
    markSent(db, p1.draftId, 'msg-1');
    const p2 = persist(db, personId);
    decide(db, p2.draftId, 'skip', 'cli');
    const threads = priorThreads(db, personId);
    expect(threads.map((t) => t.shortId)).toEqual([p1.shortId]);
    expect(threads[0]!.status).toBe('sent');
    const otherPerson = upsertPerson(db, { name: 'Someone Else' });
    expect(priorThreads(db, otherPerson)).toEqual([]);
  });

  it('logs an auditable event trail', () => {
    const { db, personId } = setup();
    const p = persist(db, personId);
    decide(db, p.draftId, 'send', 'cli');
    markSent(db, p.draftId, 'msg-1');
    const types = (db.prepare('SELECT type FROM draft_events WHERE draft_id = ? ORDER BY id').all(p.draftId) as {
      type: string;
    }[]).map((r) => r.type);
    expect(types).toEqual(['draft_created', 'decision', 'sent']);
  });
});
