// cmdReplies is the only layer that can prove "a quiet cycle never connects to
// Spectrum": runReplyCycle (test/replies-cycle.test.ts, Task 9) can only prove
// the cycle never CALLS the channel factory it is handed. Only this file can
// prove cmdReplies never BUILDS one in the first place, because cmdReplies is
// what decides whether runReplyCycle gets a real factory or none at all.
// A second connected Spectrum client competes on the line carrying
// irreversible approvals, which is why this matters more than an ordinary
// "don't do unnecessary work" property.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, upsertPerson, type DB } from '../src/db/db.js';
import { persistDraft } from '../src/approval/ledger.js';
import { recordSentThread } from '../src/pipeline/sentThreads.js';
import { acquireLease } from '../src/pipeline/replyState.js';
import type { ApprovalChannel } from '../src/approval/channel.js';
import { cmdReplies } from '../src/cli.js';
import type { GmailReader, ThreadMessage } from '../src/sender/gmailReader.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const SENDER_EMAIL = 'apgupta3@asu.edu';

const draftInput: DraftInput = {
  recipient: { name: 'Daniel Kepple', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 's', body: 'b', grounded: true, wordCount: 1, notes: [] };

// An ON-DISK database, deliberately, not ':memory:'. cmdReplies opens its own
// handle from `seams.dbPath`; two ':memory:' handles share nothing, so a row
// seeded by the test would be invisible to the handle cmdReplies opens. Same
// reasoning as test/reply-state.test.ts's diskDb().
function diskDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'cli-replies-')), 'test.db');
}

// isGmailShapedId (sentThreads.ts) requires lowercase hex only, so a fixture
// sentId must be pure hex or recordSentThread marks the row 'unresolvable' on
// sight and it is never selected.
const hex = (n: number): string => n.toString(16).padStart(6, '0');

// Seeds a real person + a real sent draft (foreign_keys = ON, so
// sent_threads.draft_id / person_id are REFERENCES and cannot be invented),
// then a watch row via recordSentThread, forced due immediately.
function seedDueWatch(db: DB, sentId: string, threadId: string): { draftId: number; personId: number } {
  const personId = upsertPerson(db, { name: 'Daniel Kepple', openalexId: 'A-dk', email: 'dk@example.edu' });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  recordSentThread(db, p.draftId, personId, sentId, threadId);
  db.prepare("UPDATE sent_threads SET next_poll_at = datetime('now', '-1 hour') WHERE draft_id = ?").run(p.draftId);
  return { draftId: p.draftId, personId };
}

// Seeds a watch row whose thread_id is NULL, the shape `--backfill` targets.
function seedUnresolvedThreadId(db: DB, sentId: string): { draftId: number; personId: number } {
  const personId = upsertPerson(db, { name: 'Daniel Kepple', openalexId: 'A-dk', email: 'dk@example.edu' });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(p.draftId);
  recordSentThread(db, p.draftId, personId, sentId, undefined);
  return { draftId: p.draftId, personId };
}

function stubMessage(id: string, threadId: string, headers: Record<string, string> = {}): ThreadMessage {
  return { id, threadId, internalDate: String(Date.now()), headers };
}

// A reader over threads with no inbound message at all: everything it is
// asked about comes back empty.
function quietReader(): GmailReader {
  return {
    async threadIdForMessage() { return null; },
    async getThreadMetadata() { return []; },
  };
}

// A reader whose one thread carries our own outbound message plus one human
// reply, so a poll of it produces something to report.
function replyReader(sentId: string, threadId: string): GmailReader {
  return {
    async threadIdForMessage() { return null; },
    async getThreadMetadata(t: string) {
      if (t !== threadId) return [];
      return [
        stubMessage(sentId, threadId),
        stubMessage('reply-1', threadId, { from: 'Daniel Kepple <dkepple@example.edu>', date: new Date().toUTCString() }),
      ];
    },
  };
}

const stubChannel: ApprovalChannel = {
  async sendDraftMessage() {},
  async notify() {},
  async captureReplies() { return []; },
  async streamReplies() { return { reason: 'ended' }; },
};

describe('cmdReplies', () => {
  const prevSenderEmail = process.env.SENDER_EMAIL;
  beforeEach(() => { process.env.SENDER_EMAIL = SENDER_EMAIL; });
  afterEach(() => { process.env.SENDER_EMAIL = prevSenderEmail; });

  it('a quiet cycle never builds a channel, so the job never connects to Spectrum', async () => {
    const lazyChannel = vi.fn(async (): Promise<ApprovalChannel> => { throw new Error('a quiet cycle must not connect'); });
    await cmdReplies([], { dbPath: ':memory:', createReader: () => quietReader(), lazyChannel });
    expect(lazyChannel).not.toHaveBeenCalled();
  });

  it('--dry-run never builds a channel either, even when there IS a reply to report', async () => {
    const path = diskDbPath();
    const db = openDb(path);
    seedDueWatch(db, hex(1), 't1');
    const lazyChannel = vi.fn(async (): Promise<ApprovalChannel> => { throw new Error('dry run must not connect'); });
    await cmdReplies(['--dry-run'], { dbPath: path, createReader: () => replyReader(hex(1), 't1'), lazyChannel });
    expect(lazyChannel).not.toHaveBeenCalled();
    // --dry-run reads and prints, writes nothing: no reply row, no notice.
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(0);
  });

  it('builds exactly one channel when there is a reply to report', async () => {
    const path = diskDbPath();
    const db = openDb(path);
    seedDueWatch(db, hex(2), 't2');
    const lazyChannel = vi.fn(async (): Promise<ApprovalChannel> => stubChannel);
    await cmdReplies([], { dbPath: path, createReader: () => replyReader(hex(2), 't2'), lazyChannel });
    expect(lazyChannel).toHaveBeenCalledTimes(1);   // not zero, so the test is not vacuous
    expect((db.prepare('SELECT count(*) AS n FROM replies').get() as { n: number }).n).toBe(1);
  });

  // The lease covers --backfill, which is the single largest quota spend in
  // the feature (one users.messages.get per legacy send with no threadId).
  it('does not spend the backfill quota when it cannot take the lease', async () => {
    const path = diskDbPath();
    const db = openDb(path);
    seedUnresolvedThreadId(db, hex(3));
    acquireLease(db, 999, new Date());   // somebody else holds it
    const threadIdForMessage = vi.fn(async () => 'resolved-thread');
    const backfillReader: GmailReader = { threadIdForMessage, async getThreadMetadata() { return []; } };
    const lazyChannel = vi.fn(async (): Promise<ApprovalChannel> => stubChannel);
    await cmdReplies(['--backfill'], { dbPath: path, createReader: () => backfillReader, lazyChannel });
    expect(threadIdForMessage).not.toHaveBeenCalled();
    expect(lazyChannel).not.toHaveBeenCalled();
  });
});
