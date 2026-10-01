'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slugify,
  createEventKey,
  createEventFingerprint,
} = require('../outputs/content-planner/lib/event-identity');

test('slugify normalizes Danish letters, case, spacing, and punctuation', () => {
  assert.equal(slugify('  SØRENs Åndedræt & Æteriske olier  '), 'sorens-andedraet-aeteriske-olier');
});

test('createEventKey is stable across case and spacing', () => {
  assert.equal(
    createEventKey({ date: '2026-10-18', start: '10:00', name: ' MELLEMRUM  GUS ' }),
    '2026-10-18_10-00_mellemrum-gus',
  );
});

test('createEventFingerprint ignores readAt but changes with mutable facts', () => {
  const event = {
    date: '2026-10-18',
    start: '10:00',
    end: '12:00',
    name: 'Mellemrum Gus',
    instructor: 'MilleMaja',
    booked: 3,
    capacity: 12,
    description: 'Sanselig gus',
    readAt: '2026-09-28T12:00:00.000Z',
  };
  assert.equal(
    createEventFingerprint(event),
    createEventFingerprint({ ...event, readAt: '2026-09-29T12:00:00.000Z' }),
  );
  assert.notEqual(
    createEventFingerprint(event),
    createEventFingerprint({ ...event, booked: 4 }),
  );
});

test('createEventKey rejects missing identity fields', () => {
  assert.throws(
    () => createEventKey({ date: '2026-10-18', start: '', name: 'Mellemrum Gus' }),
    /start/i,
  );
});
