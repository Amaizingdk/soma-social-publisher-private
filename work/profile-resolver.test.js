'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizePersonName,
  validateProfiles,
  validateOverrides,
  resolveContentSource,
} = require('../outputs/content-planner/lib/profile-resolver');

const base = path.join(__dirname, '..', 'outputs', 'content-planner');
const profiles = JSON.parse(fs.readFileSync(path.join(base, 'profiles.json'), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(base, 'event-overrides.json'), 'utf8'));
const baseEvent = {
  eventKey: '2026-10-15_18-30_saunagus', date: '2026-10-15', start: '18:30',
  end: '20:30', name: 'Saunagus', instructor: 'Søren', booked: 0, capacity: 12,
};

test('profile and override configuration validates', () => {
  assert.doesNotThrow(() => validateProfiles(profiles));
  assert.doesNotThrow(() => validateOverrides(overrides));
});

test('normalization is case-insensitive but keeps full-name equality', () => {
  assert.equal(normalizePersonName('  SØREN   Madsen '), 'søren madsen');
  assert.notEqual(normalizePersonName('Mille'), normalizePersonName('MilleMaja'));
});

test('MELLEMRUM override wins for the live generic event title', () => {
  const event = {
    ...baseEvent,
    eventKey: '2026-10-18_10-00_saunagus',
    date: '2026-10-18',
    start: '10:00',
    end: '12:00',
    instructor: 'Millemaja',
  };
  const result = resolveContentSource(event, profiles, overrides);
  assert.equal(result.kind, 'event_override');
  assert.equal(result.creditLine, 'MELLEMRUM GUS med MilleMaja fra Betterlife by Yndigegn');
  assert.equal(result.automaticUseAllowed, true);
});

test('Søren resolves by exact alias and receives the Thursday profile', () => {
  const result = resolveContentSource(baseEvent, profiles, overrides);
  assert.equal(result.profileId, 'soren');
  assert.ok(result.facts.some((fact) => /breathwork/i.test(fact)));
});

test('Mille does not partially match MilleMaja', () => {
  const result = resolveContentSource({ ...baseEvent, instructor: 'Mille' }, profiles, overrides);
  assert.equal(result.profileId, 'neutral');
  assert.deepEqual(result.warnings, ['unknown_instructor']);
  assert.equal(result.automaticUseAllowed, false);
});

test('unknown explicit instructor is neutral and needs review', () => {
  const result = resolveContentSource({ ...baseEvent, instructor: 'Anna' }, profiles, overrides);
  assert.equal(result.profileId, 'neutral');
  assert.equal(result.displayName, 'Anna');
  assert.deepEqual(result.warnings, ['unknown_instructor']);
  assert.equal(result.automaticUseAllowed, false);
});

test('blank instructor stays neutral without a made-up name or journey', () => {
  const result = resolveContentSource({ ...baseEvent, instructor: null }, profiles, overrides);
  assert.equal(result.profileId, 'neutral');
  assert.equal(result.displayName, null);
  assert.deepEqual(result.warnings, ['instructor_missing']);
  assert.ok(result.facts.every((fact) => !/viking|breathwork|fire runder/i.test(fact)));
});

test('duplicate normalized aliases are rejected', () => {
  const invalid = structuredClone(profiles);
  invalid.profiles[1].aliases.push('SØREN');
  assert.throws(() => validateProfiles(invalid), /alias.*dublet/i);
});
