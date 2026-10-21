const test = require('node:test');
const assert = require('node:assert/strict');

const {
  approvalLostDecision,
  liveTestReminderDecision,
  markApprovalLostSent,
  markLiveTestReminderSent,
  markOverdueSent,
  overdueDecision,
  reminderDecision,
  markReminderSent,
} = require('../outputs/content-planner/lib/reminders');

function reviewDraft(overrides = {}) {
  return {
    draftId: 'draft-1',
    status: 'draft',
    contentRevision: 'a'.repeat(64),
    scheduledFor: '2026-10-05T12:00:00Z',
    reminderState: {},
    ...overrides,
  };
}

test('sends exactly one reminder, inside the last 3 hours, once per content revision', () => {
  let draft = reviewDraft();
  assert.equal(reminderDecision(draft, new Date('2026-10-02T12:00:00Z')), null);
  assert.equal(reminderDecision(draft, new Date('2026-10-04T12:00:00Z')), null);
  assert.equal(reminderDecision(draft, new Date('2026-10-05T08:59:00Z')), null);
  const decision = reminderDecision(draft, new Date('2026-10-05T09:01:00Z'));
  assert.equal(decision.kind, 'final');
  assert.deepEqual(decision.mark, ['final']);
  draft = markReminderSent(draft, decision, new Date('2026-10-05T09:01:00Z'));
  assert.equal(draft.reminderState.sentFinalAt, '2026-10-05T09:01:00.000Z');
  assert.equal(reminderDecision(draft, new Date('2026-10-05T11:00:00Z')), null);
});

test('late discovery sends the same single reminder', () => {
  const decision = reminderDecision(reviewDraft({ scheduledFor: '2026-10-03T12:00:00Z' }), new Date('2026-10-03T11:00:00Z'));
  assert.equal(decision.kind, 'final');
});

test('new content revision resets the reminder marker, and older 72h/24h markers do not suppress it', () => {
  const draft = reviewDraft({
    contentRevision: 'b'.repeat(64),
    reminderState: { revision: 'a'.repeat(64), sentFinalAt: '2026-10-05T09:30:00Z', sent72At: '2026-10-01T00:00:00Z' },
  });
  assert.equal(reminderDecision(draft, new Date('2026-10-05T10:00:00Z')).kind, 'final');
  const legacy = reviewDraft({ reminderState: { revision: 'a'.repeat(64), sent72At: 'x', sent24At: 'y' } });
  assert.equal(reminderDecision(legacy, new Date('2026-10-05T10:00:00Z')).kind, 'final');
});

function approvedDraft(overrides = {}) {
  return reviewDraft({
    status: 'approved', revision: 2, approvedRevision: 'a'.repeat(64),
    kind: 'event_day', event: { date: '2026-10-05', start: '16:00', end: '18:00' }, ...overrides,
  });
}

const published = (deliveryType, revision = 2) => ({ draftId: 'draft-1', revision, deliveryType, status: 'published' });

test('overdue alert fires once, 30 minutes after the planned time, until both deliveries are published', () => {
  const draft = approvedDraft();
  const ledger = { entries: [] };
  assert.equal(overdueDecision(draft, ledger, new Date('2026-10-05T12:29:00Z')), null);
  const decision = overdueDecision(draft, ledger, new Date('2026-10-05T12:31:00Z'));
  assert.equal(decision.kind, 'overdue');
  assert.equal(decision.minutesLate, 31);
  const half = { entries: [published('instagram_story')] };
  assert.equal(overdueDecision(draft, half, new Date('2026-10-05T12:31:00Z')).kind, 'overdue');
  const complete = { entries: [published('instagram_story'), published('facebook_page_feed')] };
  assert.equal(overdueDecision(draft, complete, new Date('2026-10-05T12:31:00Z')), null);
  const marked = markOverdueSent(draft, decision, new Date('2026-10-05T12:31:00Z'));
  assert.equal(overdueDecision(marked, ledger, new Date('2026-10-05T13:00:00Z')), null);
});

test('overdue alert ignores unapproved, mismatched, expired and other-revision drafts', () => {
  const late = new Date('2026-10-05T12:45:00Z');
  const ledger = { entries: [] };
  assert.equal(overdueDecision(reviewDraft(), ledger, late), null);
  assert.equal(overdueDecision(approvedDraft({ approvedRevision: 'f'.repeat(64) }), ledger, late), null);
  assert.equal(overdueDecision(approvedDraft(), ledger, new Date('2026-10-05T17:00:00Z')), null);
  assert.equal(overdueDecision(approvedDraft(), { entries: [published('instagram_story', 1), published('facebook_page_feed', 1)] }, late).kind, 'overdue');
});

test('approved, terminal, due, and invalid-time drafts do not create reminders', () => {
  assert.equal(reminderDecision(reviewDraft({ status: 'approved' }), new Date('2026-10-02T12:00:00Z')), null);
  assert.equal(reminderDecision(reviewDraft({ status: 'skipped' }), new Date('2026-10-02T12:00:00Z')), null);
  assert.equal(reminderDecision(reviewDraft(), new Date('2026-10-05T12:00:00Z')), null);
  assert.equal(reminderDecision(reviewDraft({ scheduledFor: 'not-a-date' }), new Date()), null);
});

test('approved current revision gets one live-test reminder inside 30 minutes', () => {
  const input = reviewDraft({
    status: 'approved',
    approvedRevision: 'a'.repeat(64),
    scheduledFor: '2026-10-03T17:00:00Z',
  });
  const decision = liveTestReminderDecision(input, { entries: [] }, {
    automationEnabled: 'false',
    now: new Date('2026-10-03T16:30:00Z'),
  });
  assert.deepEqual(decision, {
    kind: 'live_test_30m',
    remainingDeliveries: ['instagram_story', 'facebook_page_feed'],
  });
  const marked = markLiveTestReminderSent(input, decision, new Date('2026-10-03T16:30:00Z'));
  assert.equal(liveTestReminderDecision(marked, { entries: [] }, {
    automationEnabled: 'false',
    now: new Date('2026-10-03T16:45:00Z'),
  }), null);
});

test('live-test reminder fails closed for automation, approval, and time boundaries', () => {
  const base = reviewDraft({
    status: 'approved',
    approvedRevision: 'a'.repeat(64),
    scheduledFor: '2026-10-03T17:00:00Z',
  });
  const decide = (draft, automationEnabled, now) => liveTestReminderDecision(
    draft,
    { entries: [] },
    { automationEnabled, now },
  );
  assert.equal(decide(base, 'true', new Date('2026-10-03T16:30:00Z')), null);
  assert.equal(decide(base, '', new Date('2026-10-03T16:30:00Z')), null);
  assert.equal(decide({ ...base, status: 'draft' }, 'false', new Date('2026-10-03T16:30:00Z')), null);
  assert.equal(decide({ ...base, approvedRevision: 'b'.repeat(64) }, 'false', new Date('2026-10-03T16:30:00Z')), null);
  assert.equal(decide(base, 'false', new Date('2026-10-03T16:29:59Z')), null);
  assert.equal(decide(base, 'false', new Date('2026-10-03T17:00:00Z')), null);
  assert.equal(decide({ ...base, scheduledFor: 'invalid' }, 'false', new Date('2026-10-03T16:30:00Z')), null);
});

test('live-test reminder tracks remaining deliveries for the exact draft revision', () => {
  const input = reviewDraft({
    revision: 2,
    status: 'approved',
    approvedRevision: 'a'.repeat(64),
    scheduledFor: '2026-10-03T17:00:00Z',
  });
  const entry = (revision, deliveryType) => ({
    draftId: input.draftId,
    revision,
    deliveryType,
    status: 'published',
  });
  const options = { automationEnabled: 'false', now: new Date('2026-10-03T16:30:00Z') };
  assert.deepEqual(liveTestReminderDecision(input, {
    entries: [entry(1, 'instagram_story'), entry(2, 'instagram_story')],
  }, options).remainingDeliveries, ['facebook_page_feed']);
  assert.equal(liveTestReminderDecision(input, {
    entries: [entry(2, 'instagram_story'), entry(2, 'facebook_page_feed')],
  }, options), null);
});

test('an old revision reminder marker does not suppress the current revision', () => {
  const input = reviewDraft({
    status: 'approved',
    approvedRevision: 'a'.repeat(64),
    scheduledFor: '2026-10-03T17:00:00Z',
    liveTestReminderState: { revision: 'b'.repeat(64), sentAt: '2026-10-02T12:00:00Z' },
  });
  assert.equal(liveTestReminderDecision(input, { entries: [] }, {
    automationEnabled: 'false',
    now: new Date('2026-10-03T16:30:00Z'),
  }).kind, 'live_test_30m');
});

const LOST = { fromDraftId: 'draft-0', fromRevision: 1, at: '2026-10-05T08:00:00.000Z', notifiedAt: null };

test('lost approval gives one immediate decision, only for a future unapproved draft', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const draft = reviewDraft({ approvalLost: LOST });
  const decision = approvalLostDecision(draft, now);
  assert.deepEqual(decision, { kind: 'approval_lost', fromRevision: 1 });

  const sent = markApprovalLostSent(draft, decision, now);
  assert.equal(sent.approvalLost.notifiedAt, now.toISOString());
  assert.equal(approvalLostDecision(sent, now), null);
  assert.equal(approvalLostDecision(reviewDraft(), now), null);
  assert.equal(approvalLostDecision(reviewDraft({ approvalLost: LOST, status: 'approved' }), now), null);
  assert.equal(approvalLostDecision(reviewDraft({ approvalLost: LOST }), new Date('2026-10-05T12:00:01Z')), null);
});

test('lost approval stays silent after the event has ended', () => {
  const draft = reviewDraft({
    approvalLost: LOST,
    scheduledFor: '2026-10-05T12:00:00Z',
    event: { date: '2026-10-05', start: '10:00', end: '11:00' },
  });
  assert.equal(approvalLostDecision(draft, new Date('2026-10-05T10:00:00Z')), null);
});
