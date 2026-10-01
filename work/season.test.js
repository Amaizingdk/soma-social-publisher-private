'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSeason, themeForSeason } = require('../outputs/content-planner/lib/season');

const automatic = { mode: 'auto', winterStarts: '11-01' };

test('automatic season stays autumn through 31 October and turns winter on 1 November', () => {
  assert.equal(resolveSeason('2026-10-31', automatic), 'autumn');
  assert.equal(resolveSeason('2026-11-01', automatic), 'winter');
  assert.equal(resolveSeason('2027-02-28', automatic), 'winter');
  assert.equal(resolveSeason('2027-03-01', automatic), 'spring');
});

test('manual mode overrides the calendar season', () => {
  assert.equal(resolveSeason('2026-07-01', { ...automatic, mode: 'winter' }), 'winter');
  assert.throws(() => resolveSeason('2026-07-01', { ...automatic, mode: 'monsoon' }), /sæson/i);
});

test('winter theme uses a dark cool shade with a warm accent and invitation', () => {
  const theme = themeForSeason('winter');
  assert.equal(theme.eyebrow, 'KOM IND I VARMEN');
  assert.match(theme.shade, /rgba/);
  assert.match(theme.accent, /^#[0-9a-f]{6}$/i);
  assert.notEqual(theme.shade, themeForSeason('summer').shade);
});
