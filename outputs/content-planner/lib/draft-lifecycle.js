'use strict';

const { createHash } = require('node:crypto');
const { copenhagenTimestamp } = require('./schedule');

const TERMINAL_STATUSES = new Set(['published', 'skipped', 'rejected', 'obsolete']);

function fixedEvent(event = {}) {
  return {
    eventKey: event.eventKey || null,
    date: event.date || null,
    start: event.start || null,
    end: event.end || null,
    name: event.name || null,
    instructor: event.instructor || null,
    description: event.description || null,
    sourceUrl: event.sourceUrl || null,
  };
}

function normalizeCopy(value) {
  return String(value || '')
    .replace(/^\s*(?:\d+\s+)?ledige pladser\.?\s*$/gim, '[AVAILABILITY]')
    .replace(/^\s*Udsolgt\.?\s*$/gim, '[AVAILABILITY]')
    .replace(/^.*\b(?:book(?:e|et|er|ing)?|tilmeld)\b.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentRevisionFor(draft) {
  if (!draft || typeof draft !== 'object') throw new TypeError('Kladde mangler');
  const payload = {
    kind: draft.kind || null,
    scheduledFor: draft.scheduledFor || null,
    event: draft.kind === 'weekly_overview' ? null : fixedEvent(draft.event),
    events: draft.kind === 'weekly_overview' ? (draft.events || []).map(fixedEvent) : null,
    platformCopies: {
      instagram: normalizeCopy(draft.platformCopies?.instagram),
      facebookPage: normalizeCopy(draft.platformCopies?.facebookPage),
    },
    assetId: draft.assetId || null,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function eventEndTimestamp(event) {
  if (!event?.date || !event?.end) return Number.NaN;
  return Date.parse(copenhagenTimestamp(event.date, event.end));
}

function isExpiredDraft(draft, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now skal være en gyldig dato');
  const events = draft?.kind === 'weekly_overview' ? draft.events : [draft?.event];
  if (!Array.isArray(events) || events.length === 0) return false;
  const ends = events.map(eventEndTimestamp);
  return ends.every(Number.isFinite) && ends.every((timestamp) => timestamp <= now.getTime());
}

function runtimeCandidates(drafts, { now = new Date(), draftId = null } = {}) {
  if (!Array.isArray(drafts)) throw new TypeError('Kladder skal være en liste');
  if (draftId !== null) {
    const selected = drafts.find((draft) => draft.draftId === draftId);
    if (!selected) throw new Error(`Den valgte kladde findes ikke: ${draftId}`);
    if (isExpiredDraft(selected, now)) throw new Error(`Den valgte kladde er udløbet: ${draftId}`);
    return [selected];
  }
  return drafts.filter((draft) =>
    draft.status === 'approved'
    && !isExpiredDraft(draft, now)
    && Number.isFinite(Date.parse(draft.scheduledFor))
    && Date.parse(draft.scheduledFor) <= now.getTime());
}

function reconcileLifecycle(drafts, { now = new Date() } = {}) {
  if (!Array.isArray(drafts)) throw new TypeError('Kladder skal være en liste');
  return drafts.map((input) => {
    const draft = JSON.parse(JSON.stringify(input));
    if (TERMINAL_STATUSES.has(draft.status)) return draft;
    if (isExpiredDraft(draft, now)) {
      return {
        ...draft,
        status: 'skipped',
        skipReason: 'expired_event',
        skippedAt: now.toISOString(),
        approvedAt: null,
        approvedBy: null,
        approvedRevision: null,
      };
    }
    if (
      ['draft', 'needs_review'].includes(draft.status)
      && Number.isFinite(Date.parse(draft.scheduledFor))
      && Date.parse(draft.scheduledFor) <= now.getTime()
    ) {
      return {
        ...draft,
        status: 'skipped',
        skipReason: 'missing_approval_at_publish_time',
        skippedAt: now.toISOString(),
      };
    }
    return draft;
  });
}

module.exports = {
  contentRevisionFor,
  isExpiredDraft,
  runtimeCandidates,
  reconcileLifecycle,
};
