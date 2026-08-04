// The typo blocker. d17 and d70 are one keystroke apart on a phone, and before
// the three refusals below, `d17 to alice@x.edu` would have overwritten person
// 17's verified address at confidence 1.0, made it permanent (the on-record
// shortcut in orchestrate.ts returns early forever and upsertPerson's
// `email = coalesce(?, email)` cannot displace a non-NULL value), rewritten
// drafts.to_email so loadApprovedSend returns 'ok', and re-presented d17 as a
// normal tapback-approvable draft. One thumbs up then sends a real,
// irreversible cold email to the wrong human.
import { describe, expect, it } from 'vitest';
import { openDb, upsertPerson, getPerson } from '../src/db/db.js';
import { persistDraft, logEvent, loadApprovedSend, decide } from '../src/approval/ledger.js';
import { applyAddressCorrection, addressRequestDeclined, addressWasRequested } from '../src/pipeline/addressCorrection.js';
import type { Draft, DraftInput } from '../src/pipeline/draft.js';

const draftInput: DraftInput = {
  recipient: { name: 'Xiyu Zhang', paperTitle: 'A Paper' },
  hooks: [], intent: 'seeking direction', senderName: 'Aditya Gupta',
};
const groundedDraft: Draft = { subject: 'a subject', body: 'a body', grounded: true, wordCount: 2, notes: [] };

function seed(email: string | null, emailSource: string | null = null, name = 'Xiyu Zhang') {
  const db = openDb(':memory:');
  const personId = upsertPerson(db, { name, openalexId: `A-${name}`, email, emailSource: emailSource ?? undefined });
  const p = persistDraft(db, {
    personId, paperArxivId: '2601.00001', paperTitle: 'A Paper',
    intent: 'seeking direction', draftInput, draft: groundedDraft, contextJson: {},
  });
  return { db, personId, ...p };
}

describe('applyAddressCorrection', () => {
  it('writes people.email and drafts.to_email in one transaction, which is what keeps loadApprovedSend honest', () => {
    const { db, draftId, personId } = seed(null);
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'xiyu.zhang@tongji.edu.cn');
    expect(r.kind).toBe('applied');
    const person = getPerson(db, personId)!;
    expect(person.email).toBe('xiyu.zhang@tongji.edu.cn');
    expect(person.email_source).toBe('user_provided');
    expect(person.email_confidence).toBe(1);
    const to = (db.prepare('SELECT to_email AS t FROM drafts WHERE id = ?').get(draftId) as { t: string }).t;
    expect(to).toBe('xiyu.zhang@tongji.edu.cn');
    // The pair assertion. Either half alone passes for the wrong reason.
    decide(db, draftId, 'send', 'imessage');
    expect(loadApprovedSend(db, draftId).kind).toBe('ok');
    upsertPerson(db, { name: 'Xiyu Zhang', openalexId: 'A-Xiyu Zhang', email: 'someone.else@tongji.edu.cn' });
    expect(loadApprovedSend(db, draftId).kind).toBe('recipient_changed');
  });

  it('REFUSES a correction that would overwrite a machine-verified address', () => {
    const { db, draftId, personId } = seed('verified@tongji.edu.cn', 'homepage');
    // address_requested is logged so this test isolates Refusal 2. Without it,
    // Refusal 3 (no request on record) would ALSO block this correction, and
    // the test would stay green even if Refusal 2 were deleted, which is
    // exactly the "test that cannot fail" failure mode this whole task exists
    // to avoid: Refusal 2 is the typo blocker and the single most important
    // check in this module.
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'alice@x.edu');
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.message).toContain('verified@tongji.edu.cn');
    expect(getPerson(db, personId)!.email).toBe('verified@tongji.edu.cn');
    expect((db.prepare('SELECT to_email AS t FROM drafts WHERE id = ?').get(draftId) as { t: string | null }).t)
      .toBe('verified@tongji.edu.cn');
  });

  it('ALLOWS re-correcting your own typo, because that value is user_provided', () => {
    const { db, draftId, personId } = seed('typo@x.edu', 'user_provided');
    logEvent(db, draftId, 'address_requested', { personId });
    expect(applyAddressCorrection(db, draftId, 'correct@x.edu').kind).toBe('applied');
    expect(getPerson(db, personId)!.email).toBe('correct@x.edu');
  });

  it('REFUSES when no address was requested for this draft and the person already has one', () => {
    const { db, draftId, personId } = seed('earlier@x.edu', 'user_provided');
    const r = applyAddressCorrection(db, draftId, 'alice@x.edu');
    expect(r.kind).toBe('refused');
    expect(getPerson(db, personId)!.email).toBe('earlier@x.edu');
  });

  it('ALLOWS a draft with no request whose person has no address, which is outreach add\'s manual queue', () => {
    const { db, draftId } = seed(null);
    expect(applyAddressCorrection(db, draftId, 'alice@x.edu').kind).toBe('applied');
  });

  it('reports whether the address names the person, advisorily, without gating on it', () => {
    const { db, draftId, personId } = seed(null);
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'ishen@stu.hit.edu.cn');
    // Applied ANYWAY. Gating on nameMatches would be circular (it is the check
    // that just failed) and would block the unusual-but-correct addresses this
    // feature exists to rescue.
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.nameMatched).toBe(false);
  });

  // Reached only by calling this function directly: parseReply splits on
  // /\s+/, so no whitespace-bearing address can ever arrive through it, and a
  // test written through parseReply could not fail.
  it('refuses a header-injection shaped address without writing anything', () => {
    const { db, draftId, personId } = seed(null);
    logEvent(db, draftId, 'address_requested', { personId });
    const r = applyAddressCorrection(db, draftId, 'a@b.edu\r\nBcc: evil@x.com');
    expect(r.kind).toBe('refused');
    expect(getPerson(db, personId)!.email).toBeNull();
  });

  it('refuses a draft that has already been decided or attempted', () => {
    for (const setup of ['skipped', 'attempted'] as const) {
      const { db, draftId, personId } = seed(null);
      logEvent(db, draftId, 'address_requested', { personId });
      if (setup === 'skipped') decide(db, draftId, 'skip', 'imessage');
      else {
        decide(db, draftId, 'send', 'imessage');
        db.prepare("UPDATE drafts SET send_attempted_at = datetime('now') WHERE id = ?").run(draftId);
      }
      expect(applyAddressCorrection(db, draftId, 'alice@x.edu').kind).toBe('refused');
      expect(getPerson(db, personId)!.email).toBeNull();
    }
  });

  it('clears the stale seen_papers reason so outreach stranded stops printing a resolved item', () => {
    const { db, draftId, personId, shortId } = seed(null);
    db.prepare(
      `INSERT INTO seen_papers (arxiv_id, title, discovered_via, status, reason, draft_id)
       VALUES ('2601.00001','A Paper','saved_query','drafted_unsendable',?,?)`,
    ).run(`awaiting address correction (${shortId}): rejected wrong@x.edu`, draftId);
    logEvent(db, draftId, 'address_requested', { personId });
    applyAddressCorrection(db, draftId, 'alice@x.edu');
    const reason = (db.prepare('SELECT reason AS r FROM seen_papers WHERE arxiv_id = ?').get('2601.00001') as { r: string }).r;
    expect(reason).toBe(`address corrected (${shortId})`);
  });
});

describe('the durable decline record', () => {
  it('is keyed on the person, because the re-ask arrives on a different draft', () => {
    const { db, draftId, personId } = seed(null);
    expect(addressRequestDeclined(db, personId)).toBe(false);
    logEvent(db, draftId, 'address_requested', { personId });
    expect(addressWasRequested(db, draftId)).toBe(true);
    logEvent(db, draftId, 'address_request_declined', { personId });
    expect(addressRequestDeclined(db, personId)).toBe(true);
    expect(addressRequestDeclined(db, personId + 999)).toBe(false);
  });
});
