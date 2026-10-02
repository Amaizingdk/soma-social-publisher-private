'use strict';

const REVIEW_STATUSES = new Set(['draft', 'needs_review']);

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

module.exports = { markReminderSent, reminderDecision };
