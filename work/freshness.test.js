'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compareDraftToLiveEvent } = require('../outputs/content-planner/lib/freshness');

const NOW = new Date('2026-09-30T10:00:00Z');

function draft(overrides = {}) {
  return {
    eventKey: '2026-10-01_18-30_saunagus',
    event: {
      eventKey: '2026-10-01_18-30_saunagus',
      date: '2026-10-01',
      start: '18:30',
      end: '20:30',
      name: 'Saunagus',
      booked: 4,
      capacity: 12,
    },
    availability: { free: 8 },
    ...overrides,
  };
}

function live(overrides = {}) {
  return {
    eventKey: '2026-10-01_18-30_saunagus',
    date: '2026-10-01',
    start: '18:30',
    end: '20:30',
    name: 'Saunagus',
    booked: 4,
    capacity: 12,
    readAt: '2026-09-30T09:45:00Z',
    ...overrides,
  };
}

test('accepts a matching and recent live event', () => {
  assert.deepEqual(compareDraftToLiveEvent(draft(), [live()], { now: NOW, maxAgeMs: 60 * 60 * 1000 }), {
    status: 'fresh',
    reasons: [],
    availability: { booked: 4, capacity: 12, free: 8, soldOut: false },
  });
});

test('accepts changed booking counts as dynamic availability data', () => {
  const result = compareDraftToLiveEvent(draft(), [live({ booked: 6 })], { now: NOW });
  assert.deepEqual(result, {
    status: 'fresh',
    reasons: [],
    availability: { booked: 6, capacity: 12, free: 6, soldOut: false },
  });
});

test('blocks stale calendar data even when the event facts still match', () => {
  const result = compareDraftToLiveEvent(draft(), [live({ readAt: '2026-09-29T13:08:38Z' })], {
    now: NOW,
    maxAgeMs: 60 * 60 * 1000,
  });
  assert.deepEqual(result, { status: 'blocked', reasons: ['STALE_CALENDAR_DATA'] });
});

test('blocks missing events and schedule changes', () => {
  assert.deepEqual(
    compareDraftToLiveEvent(draft(), [], { now: NOW }),
    { status: 'blocked', reasons: ['EVENT_NOT_FOUND'] },
  );
  assert.deepEqual(
    compareDraftToLiveEvent(draft(), [live({ start: '19:00' })], { now: NOW }),
    { status: 'blocked', reasons: ['SCHEDULE_CHANGED'] },
  );
});

test('validates every weekly event and keeps their live availability separate', () => {
  const weeklyDraft = {
    kind: 'weekly_overview',
    events: [
      { eventKey: 'a', date: '2026-10-06', start: '18:30', end: '20:30', name: 'Saunagus', capacity: 12 },
      { eventKey: 'b', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus', capacity: 12 },
    ],
  };
  const result = compareDraftToLiveEvent(weeklyDraft, [
    { ...weeklyDraft.events[0], booked: 6, readAt: '2026-09-30T09:45:00Z' },
    { ...weeklyDraft.events[1], booked: 12, readAt: '2026-09-30T09:45:00Z' },
  ], { now: NOW });
  assert.deepEqual(result, {
    status: 'fresh',
    reasons: [],
    availabilities: [
      { eventKey: 'a', booked: 6, capacity: 12, free: 6, soldOut: false },
      { eventKey: 'b', booked: 12, capacity: 12, free: 0, soldOut: true },
    ],
  });
});

test('blocks a weekly overview when any individual event is missing', () => {
  const weeklyDraft = {
    kind: 'weekly_overview',
    events: [
      { eventKey: 'a', date: '2026-10-06', start: '18:30', end: '20:30', name: 'Saunagus', capacity: 12 },
      { eventKey: 'b', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus', capacity: 12 },
    ],
  };
  const result = compareDraftToLiveEvent(weeklyDraft, [
    { ...weeklyDraft.events[0], booked: 6, readAt: '2026-09-30T09:45:00Z' },
  ], { now: NOW });
  assert.deepEqual(result, { status: 'blocked', reasons: ['EVENT_NOT_FOUND:b'] });
});
