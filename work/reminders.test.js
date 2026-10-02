const test = require('node:test');
const assert = require('node:assert/strict');

const {
  liveTestReminderDecision,
  markLiveTestReminderSent,
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

test('sends 72h and later 24h once per content revision', () => {
  let draft = reviewDraft();
  const first = reminderDecision(draft, new Date('2026-10-02T12:00:00Z'));
  assert.equal(first.kind, '72h');
  draft = markReminderSent(draft, first, new Date('2026-10-02T12:00:00Z'));
  const second = reminderDecision(draft, new Date('2026-10-04T12:00:00Z'));
  assert.equal(second.kind, '24h');
  draft = markReminderSent(draft, second, new Date('2026-10-04T12:00:00Z'));
  assert.equal(reminderDecision(draft, new Date('2026-10-04T13:00:00Z')), null);
});

test('late discovery under 24h sends one urgent reminder and marks both thresholds', () => {
  const decision = reminderDecision(reviewDraft({
    scheduledFor: '2026-10-03T12:00:00Z',
  }), new Date('2026-10-03T06:00:00Z'));
  assert.equal(decision.kind, 'urgent');
  assert.deepEqual(decision.mark, ['72h', '24h']);
  const marked = markReminderSent(reviewDraft(), decision, new Date('2026-10-03T06:00:00Z'));
  assert.equal(marked.reminderState.sent72At, '2026-10-03T06:00:00.000Z');
  assert.equal(marked.reminderState.sent24At, '2026-10-03T06:00:00.000Z');
});

test('new content revision resets prior reminder markers', () => {
  const draft = reviewDraft({
    contentRevision: 'b'.repeat(64),
    reminderState: {
      revision: 'a'.repeat(64),
      sent72At: '2026-10-01T00:00:00Z',
      sent24At: '2026-10-02T00:00:00Z',
    },
  });
  assert.equal(reminderDecision(draft, new Date('2026-10-02T12:00:00Z')).kind, '72h');
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
