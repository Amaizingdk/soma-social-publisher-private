const test = require('node:test');
const assert = require('node:assert/strict');

const { approveDraft } = require('../outputs/content-planner/lib/approvals');

const REVISION = 'c'.repeat(64);

function reviewDraft(overrides = {}) {
  return {
    draftId: 'draft-1',
    kind: 'event_day',
    status: 'draft',
    contentRevision: REVISION,
    scheduledFor: '2026-10-05T11:30:00+02:00',
    event: { date: '2026-10-05', start: '16:00', end: '18:00', name: 'Saunagus' },
    platformCopies: { instagram: 'Instagram', facebookPage: 'Facebook' },
    history: [],
    ...overrides,
  };
}

const NOW = new Date('2026-10-03T12:00:00Z');

test('approves the current revision and sets approvedBy, approvedAt and approvedRevision', () => {
  const result = approveDraft({
    drafts: [reviewDraft()],
    draftId: 'draft-1',
    contentRevision: REVISION,
    approvedBy: 'soren',
    now: NOW,
  });
  assert.equal(result.outcome, 'approved');
  assert.equal(result.drafts[0].status, 'approved');
  assert.equal(result.drafts[0].approvedBy, 'soren');
  assert.equal(result.drafts[0].approvedAt, NOW.toISOString());
  assert.equal(result.drafts[0].approvedRevision, REVISION);
});

test('returns already_approved without changing drafts', () => {
  const drafts = [reviewDraft({ status: 'approved', approvedRevision: REVISION, approvedAt: NOW.toISOString() })];
  const result = approveDraft({ drafts, draftId: 'draft-1', contentRevision: REVISION, approvedBy: 'soren', now: NOW });
  assert.equal(result.outcome, 'already_approved');
  assert.equal(result.drafts, drafts);
});

test('rejects a stale revision', () => {
  const result = approveDraft({
    drafts: [reviewDraft()], draftId: 'draft-1', contentRevision: 'd'.repeat(64), approvedBy: 'soren', now: NOW,
  });
  assert.equal(result.outcome, 'stale_revision');
  assert.equal(result.drafts[0].status, 'draft');
});

test('rejects a published draft as terminal', () => {
  const result = approveDraft({
    drafts: [reviewDraft({ status: 'published' })], draftId: 'draft-1', contentRevision: REVISION, approvedBy: 'soren', now: NOW,
  });
  assert.equal(result.outcome, 'terminal');
});

test('rejects needs_review without acknowledged warnings', () => {
  const result = approveDraft({
    drafts: [reviewDraft({ status: 'needs_review', warningsAcknowledged: false })],
    draftId: 'draft-1', contentRevision: REVISION, approvedBy: 'soren', now: NOW,
  });
  assert.equal(result.outcome, 'warnings_not_acknowledged');
  assert.equal(result.drafts[0].status, 'needs_review');
});

test('returns unknown_draft for a missing draftId', () => {
  const result = approveDraft({
    drafts: [reviewDraft()], draftId: 'nope', contentRevision: REVISION, approvedBy: 'soren', now: NOW,
  });
  assert.equal(result.outcome, 'unknown_draft');
});

test('does not mutate the input array or its drafts', () => {
  const drafts = [reviewDraft()];
  const snapshot = JSON.stringify(drafts);
  approveDraft({ drafts, draftId: 'draft-1', contentRevision: REVISION, approvedBy: 'soren', now: NOW });
  assert.equal(JSON.stringify(drafts), snapshot);
});

test('throws on an invalid approval time', () => {
  assert.throws(() => approveDraft({
    drafts: [reviewDraft()], draftId: 'draft-1', contentRevision: REVISION, approvedBy: 'soren', now: 'not-a-date',
  }), /Godkendelsestidspunkt er ugyldigt/);
});
