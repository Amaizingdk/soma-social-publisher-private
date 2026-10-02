'use strict';

const REVIEW_STATUSES = new Set(['draft', 'needs_review']);
const LIVE_TEST_DELIVERIES = ['instagram_story', 'facebook_page_feed'];

function reminderDecision(draft, now = new Date()) {
  if (!REVIEW_STATUSES.has(draft?.status)) return null;
  const milliseconds = Date.parse(draft.scheduledFor) - now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const hours = milliseconds / 3_600_000;
  const state = draft.reminderState?.revision === draft.contentRevision ? draft.reminderState : {};
  if (hours <= 24 && !state.sent24At) {
    return {
      kind: state.sent72At ? '24h' : 'urgent',
      mark: state.sent72At ? ['24h'] : ['72h', '24h'],
      hoursRemaining: hours,
    };
  }
  if (hours <= 72 && !state.sent72At) {
    return { kind: '72h', mark: ['72h'], hoursRemaining: hours };
  }
  return null;
}

function markReminderSent(draft, decision, now = new Date()) {
  if (!decision?.mark?.length) return draft;
  const at = now.toISOString();
  const previous = draft.reminderState?.revision === draft.contentRevision
    ? draft.reminderState
    : {};
  const reminderState = { ...previous, revision: draft.contentRevision };
  if (decision.mark.includes('72h')) reminderState.sent72At = at;
  if (decision.mark.includes('24h')) reminderState.sent24At = at;
  return { ...draft, reminderState };
}

function liveTestReminderDecision(draft, ledger, { automationEnabled, now = new Date() } = {}) {
  if (automationEnabled !== 'false') return null;
  if (draft?.status !== 'approved' || draft.approvedRevision !== draft.contentRevision) return null;
  const milliseconds = Date.parse(draft.scheduledFor) - now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds > 30 * 60 * 1000) {
    return null;
  }
  if (
    draft.liveTestReminderState?.revision === draft.contentRevision
    && draft.liveTestReminderState?.sentAt
  ) return null;
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const remainingDeliveries = LIVE_TEST_DELIVERIES.filter((deliveryType) => !entries.some((entry) => (
    entry.draftId === draft.draftId
    && entry.revision === draft.revision
    && entry.deliveryType === deliveryType
    && entry.status === 'published'
  )));
  if (remainingDeliveries.length === 0) return null;
  return { kind: 'live_test_30m', remainingDeliveries };
}

function markLiveTestReminderSent(draft, decision, now = new Date()) {
  if (decision?.kind !== 'live_test_30m') return draft;
  return {
    ...draft,
    liveTestReminderState: {
      revision: draft.contentRevision,
      sentAt: now.toISOString(),
    },
  };
}

module.exports = {
  liveTestReminderDecision,
  markLiveTestReminderSent,
  markReminderSent,
  reminderDecision,
};
