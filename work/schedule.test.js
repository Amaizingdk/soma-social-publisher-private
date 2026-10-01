'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  availabilityFor,
  copenhagenTimestamp,
  buildSchedule,
} = require('../outputs/content-planner/lib/schedule');

const config = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'outputs', 'content-planner', 'config.json'),
  'utf8',
));

function event(overrides = {}) {
  return {
    eventKey: '2026-10-15_18-30_saunagus',
    date: '2026-10-15',
    start: '18:30',
    end: '20:30',
    name: 'Saunagus',
    instructor: 'Søren',
    booked: 0,
    capacity: 12,
    ...overrides,
  };
}

test('copenhagenTimestamp uses summer and winter offsets', () => {
  assert.equal(copenhagenTimestamp('2026-10-18', '07:00'), '2026-10-18T07:00:00+02:00');
  assert.equal(copenhagenTimestamp('2026-11-01', '07:00'), '2026-11-01T07:00:00+01:00');
});

test('availability labels use the configured few-spots threshold', () => {
  assert.deepEqual(availabilityFor(event({ booked: 3 }), config), {
    free: 9, label: '9 ledige pladser', soldOut: false,
  });
  assert.deepEqual(availabilityFor(event({ booked: 9 }), config), {
    free: 3, label: 'kun 3 pladser tilbage', soldOut: false,
  });
  assert.deepEqual(availabilityFor(event({ booked: 11 }), config), {
    free: 1, label: 'kun 1 plads tilbage', soldOut: false,
  });
  assert.deepEqual(availabilityFor(event({ booked: 12 }), config), {
    free: 0, label: 'udsolgt', soldOut: true,
  });
});

test('event before noon posts at 07:00 and afternoon event posts at 11:30', () => {
  const morning = event({
    eventKey: '2026-10-18_10-00_saunagus', date: '2026-10-18', start: '10:00', end: '12:00', instructor: 'Millemaja',
  });
  const afternoon = event({
    eventKey: '2026-10-18_16-00_saunagus', date: '2026-10-18', start: '16:00', end: '18:00',
  });
  const slots = buildSchedule([morning, afternoon], config).filter((slot) => slot.kind === 'event_day');
  assert.deepEqual(slots.map((slot) => slot.scheduledFor), [
    '2026-10-18T07:00:00+02:00',
    '2026-10-18T11:30:00+02:00',
  ]);
  assert.deepEqual(slots.map((slot) => slot.eventKeys), [[morning.eventKey], [afternoon.eventKey]]);
});

test('day-before posts are 19:00 and Monday collision is replaced by Sunday overview', () => {
  const monday = event({
    eventKey: '2026-10-19_18-30_saunagus', date: '2026-10-19', start: '18:30', end: '20:30',
  });
  const thursday = event({
    eventKey: '2026-10-22_18-30_saunagus', date: '2026-10-22', start: '18:30', end: '20:30',
  });
  const slots = buildSchedule([monday, thursday], config);
  const weekly = slots.find((slot) => slot.kind === 'weekly_overview');
  assert.equal(weekly.scheduledFor, '2026-10-18T19:30:00+02:00');
  assert.deepEqual(weekly.eventKeys, [monday.eventKey, thursday.eventKey]);
  assert.equal(slots.some((slot) => slot.slotKey === `${monday.eventKey}_day-before`), false);
  assert.equal(
    slots.find((slot) => slot.slotKey === `${thursday.eventKey}_day-before`).scheduledFor,
    '2026-10-21T19:00:00+02:00',
  );
});

test('an empty event list creates no weekly overview', () => {
  assert.deepEqual(buildSchedule([], config), []);
});

test('duplicate event keys never create duplicate slots', () => {
  const original = event();
  const slots = buildSchedule([original, { ...original }], config);
  assert.equal(new Set(slots.map((slot) => slot.slotKey)).size, slots.length);
});
