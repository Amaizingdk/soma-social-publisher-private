'use strict';

const { copenhagenTimestamp } = require('./schedule');

const REVIEW_STATUSES = new Set(['draft', 'needs_review']);
const LIVE_TEST_DELIVERIES = ['instagram_story', 'facebook_page_feed'];
const REQUIRED_DELIVERIES = ['instagram_story', 'facebook_page_feed'];
// Kun to slags mails er nødvendige: et ikke-godkendt opslag lige før fristen, og et godkendt opslag, der er forsinket.
const FINAL_REMINDER_HOURS = 3;
const OVERDUE_MINUTES = 30;

function reminderDecision(draft, now = new Date()) {
  if (!REVIEW_STATUSES.has(draft?.status)) return null;
  const milliseconds = Date.parse(draft.scheduledFor) - now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const hours = milliseconds / 3_600_000;
  const state = draft.reminderState?.revision === draft.contentRevision ? draft.reminderState : {};
  if (hours <= FINAL_REMINDER_HOURS && !state.sentFinalAt) {
    return { kind: 'final', mark: ['final'], hoursRemaining: hours };
  }
  return null;
}

function eventEndsAt(draft) {
  const events = draft?.kind === 'weekly_overview' ? draft.events : [draft?.event];
  const ends = (events || [])
    .filter((event) => event?.date && event?.end)
    .map((event) => Date.parse(copenhagenTimestamp(event.date, event.end)))
    .filter(Number.isFinite);
  return ends.length ? Math.max(...ends) : Number.NaN;
}

// Et godkendt opslag, der stadig ikke er udgivet 30 minutter efter det planlagte tidspunkt.
function overdueDecision(draft, ledger, now = new Date()) {
  if (draft?.status !== 'approved' || draft.approvedRevision !== draft.contentRevision) return null;
  const late = now.getTime() - Date.parse(draft.scheduledFor);
  if (!Number.isFinite(late) || late < OVERDUE_MINUTES * 60 * 1000) return null;
  const end = eventEndsAt(draft);
  if (Number.isFinite(end) && end <= now.getTime()) return null;
  if (draft.overdueReminderState?.revision === draft.contentRevision) return null;
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  const published = (deliveryType) => entries.some((entry) => entry.draftId === draft.draftId
    && entry.revision === draft.revision && entry.deliveryType === deliveryType && entry.status === 'published');
  if (REQUIRED_DELIVERIES.every(published)) return null;
  return { kind: 'overdue', minutesLate: Math.round(late / 60000) };
}

function markOverdueSent(draft, decision, now = new Date()) {
  if (decision?.kind !== 'overdue') return draft;
  return { ...draft, overdueReminderState: { revision: draft.contentRevision, sentAt: now.toISOString() } };
}

function markReminderSent(draft, decision, now = new Date()) {
  if (!decision?.mark?.length) return draft;
  const at = now.toISOString();
  const previous = draft.reminderState?.revision === draft.contentRevision
    ? draft.reminderState
    : {};
  const reminderState = { ...previous, revision: draft.contentRevision };
  if (decision.mark.includes('final')) reminderState.sentFinalAt = at;
  return { ...draft, reminderState };
}

// Et godkendt opslag er erstattet af en ny, ikke-godkendt version: besked med det samme, én gang pr. kæde af versioner.
function approvalLostDecision(draft, now = new Date()) {
  const lost = draft?.approvalLost;
  if (!lost || lost.notifiedAt || !REVIEW_STATUSES.has(draft.status)) return null;
  const milliseconds = Date.parse(draft.scheduledFor) - now.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const end = eventEndsAt(draft);
  if (Number.isFinite(end) && end <= now.getTime()) return null;
  return { kind: 'approval_lost', fromRevision: lost.fromRevision };
}

function markApprovalLostSent(draft, decision, now = new Date()) {
  if (decision?.kind !== 'approval_lost') return draft;
  return { ...draft, approvalLost: { ...draft.approvalLost, notifiedAt: now.toISOString() } };
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
  approvalLostDecision,
  liveTestReminderDecision,
  markApprovalLostSent,
  markLiveTestReminderSent,
  markOverdueSent,
  markReminderSent,
  overdueDecision,
  reminderDecision,
};
