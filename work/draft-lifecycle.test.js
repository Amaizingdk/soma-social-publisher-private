'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  contentRevisionFor,
  isExpiredDraft,
  runtimeCandidates,
  reconcileLifecycle,
} = require('../outputs/content-planner/lib/draft-lifecycle');

function event(overrides = {}) {
  return {
    eventKey: '2026-10-04_16-00_saunagus',
    date: '2026-10-04',
    start: '16:00',
    end: '18:00',
    name: 'Saunagus',
    instructor: 'Søren',
    sourceUrl: 'https://somasaunagus.dk/kalender/',
    booked: 4,
    capacity: 12,
    readAt: '2026-10-02T10:00:00Z',
    ...overrides,
  };
}

function copies(free = 8, fixed = 'Land i varmen.') {
  return {
    instagram: `${fixed}\n\n${free} ledige pladser.\n\nBook din plads: https://somasaunagus.dk/kalender/`,
    facebookPage: `${fixed}\n\n${free} ledige pladser.\n\nBook din plads: https://somasaunagus.dk/kalender/`,
  };
}

function draft(overrides = {}) {
  return {
    draftId: '2026-10-04_16-00_saunagus_event-day_r1',
    revision: 1,
    kind: 'event_day',
    status: 'approved',
    scheduledFor: '2026-10-04T11:30:00+02:00',
    event: event(),
    platformCopies: copies(),
    assetId: 'soma-calm-sunlight',
    approvedAt: '2026-10-02T09:00:00Z',
    ...overrides,
  };
}

test('content revision ignores volatile availability but catches fixed publish changes', () => {
  const original = draft();
  const volatile = draft({
    event: event({ booked: 10, readAt: '2026-10-02T11:00:00Z' }),
    platformCopies: copies(2),
  });
  assert.equal(contentRevisionFor(original), contentRevisionFor(volatile));

  for (const changed of [
    draft({ event: event({ start: '17:00' }) }),
    draft({ platformCopies: copies(8, 'Ny fast tekst.') }),
    draft({ scheduledFor: '2026-10-04T12:00:00+02:00' }),
    draft({ assetId: 'soma-outdoor-sunday' }),
  ]) {
    assert.notEqual(contentRevisionFor(original), contentRevisionFor(changed));
  }
});

test('event draft expires only after its Copenhagen event end', () => {
  const value = draft();
  assert.equal(isExpiredDraft(value, new Date('2026-10-04T15:59:59Z')), false);
  assert.equal(isExpiredDraft(value, new Date('2026-10-04T16:00:01Z')), true);
});

test('weekly overview expires only after every referenced event ends', () => {
  const value = draft({
    kind: 'weekly_overview',
    event: null,
    events: [
      event(),
      event({ eventKey: '2026-10-06_18-30_saunagus', date: '2026-10-06', start: '18:30', end: '20:30' }),
    ],
  });
  assert.equal(isExpiredDraft(value, new Date('2026-10-05T10:00:00Z')), false);
  assert.equal(isExpiredDraft(value, new Date('2026-10-06T18:31:00Z')), true);
});

test('automatic runtime selection excludes future, unapproved, and expired drafts', () => {
  const now = new Date('2026-10-03T17:01:00Z');
  const due = draft({ draftId: 'due', scheduledFor: '2026-10-03T19:00:00+02:00' });
  const result = runtimeCandidates([
    draft({ draftId: 'expired', event: event({ date: '2026-10-01' }), scheduledFor: '2026-10-01T11:30:00+02:00' }),
    due,
    draft({ draftId: 'future', scheduledFor: '2026-10-04T11:30:00+02:00' }),
    draft({ draftId: 'unapproved', status: 'draft', scheduledFor: due.scheduledFor }),
  ], { now });
  assert.deepEqual(result.map((item) => item.draftId), ['due']);
});

test('exact expired draft fails closed before runtime work begins', () => {
  const expired = draft({ draftId: 'expired', event: event({ date: '2026-10-01' }) });
  assert.throws(
    () => runtimeCandidates([expired], { now: new Date('2026-10-02T10:00:00Z'), draftId: 'expired' }),
    /udløbet/i,
  );
});

test('lifecycle skips expired approved drafts and missed unapproved deadlines', () => {
  const now = new Date('2026-10-04T16:00:01Z');
  const result = reconcileLifecycle([
    draft({ draftId: 'expired' }),
    draft({ draftId: 'missed', status: 'draft', scheduledFor: '2026-10-04T11:30:00+02:00', event: event({ end: '20:00' }) }),
  ], { now });
  assert.equal(result[0].status, 'skipped');
  assert.equal(result[0].skipReason, 'expired_event');
  assert.equal(result[0].approvedRevision, null);
  assert.equal(result[1].status, 'skipped');
  assert.equal(result[1].skipReason, 'missing_approval_at_publish_time');
});
