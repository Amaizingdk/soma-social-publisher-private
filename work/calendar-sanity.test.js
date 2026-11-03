'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { findVanishedWeeks, mondayOf } = require('../outputs/content-planner/lib/calendar-sanity');

const ev = (date) => ({ date });
const NOW = new Date('2026-10-05T07:00:00Z');

test('mondayOf finds the Monday of a week', () => {
  assert.equal(mondayOf('2026-10-13'), '2026-10-12');
  assert.equal(mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(mondayOf('2026-10-12'), '2026-10-12');
});

test('a whole week that vanished between weeks with events is flagged', () => {
  const previous = [ev('2026-10-06'), ev('2026-10-13'), ev('2026-10-15'), ev('2026-10-20')];
  const read = [ev('2026-10-06'), ev('2026-10-20')];
  assert.deepEqual(findVanishedWeeks(previous, read, NOW), ['2026-10-12']);
});

test('a complete read, and ordinary single cancellations, are not flagged', () => {
  const previous = [ev('2026-10-06'), ev('2026-10-13'), ev('2026-10-15'), ev('2026-10-20')];
  assert.deepEqual(findVanishedWeeks(previous, previous, NOW), []);
  assert.deepEqual(findVanishedWeeks(previous, [ev('2026-10-06'), ev('2026-10-13'), ev('2026-10-20')], NOW), []);
});

test('weeks past the last week read, past events and an empty history are ignored', () => {
  assert.deepEqual(findVanishedWeeks([ev('2026-10-06'), ev('2026-11-10')], [ev('2026-10-06')], NOW), []);
  assert.deepEqual(findVanishedWeeks([ev('2026-09-29')], [ev('2026-10-20')], NOW), []);
  assert.deepEqual(findVanishedWeeks([], [ev('2026-10-20')], NOW), []);
});

test('a truncated read that only kept the first weeks is flagged when weeksAhead covers the lost weeks', () => {
  // 31. okt. 2026: kun 1. nov. kom med, 3., 5. og 8. nov. forsvandt (uge 2. og 9. nov. ligger efter sidste læste uge).
  const now = new Date('2026-10-31T04:39:00Z');
  const previous = [ev('2026-11-01'), ev('2026-11-03'), ev('2026-11-05'), ev('2026-11-08')];
  const read = [ev('2026-11-01')];
  assert.deepEqual(findVanishedWeeks(previous, read, now), []);
  assert.deepEqual(findVanishedWeeks(previous, read, now, { weeksAhead: 4 }), ['2026-11-02']);
});

test('weeks beyond the weeksAhead horizon are still ignored', () => {
  const now = new Date('2026-10-05T07:00:00Z');
  const previous = [ev('2026-10-06'), ev('2026-11-10')];
  assert.deepEqual(findVanishedWeeks(previous, [ev('2026-10-06')], now, { weeksAhead: 4 }), []);
});
