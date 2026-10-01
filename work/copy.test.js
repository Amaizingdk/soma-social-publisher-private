'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCopyPackage } = require('../outputs/content-planner/lib/copy');
const { resolveContentSource } = require('../outputs/content-planner/lib/profile-resolver');
const { buildSchedule } = require('../outputs/content-planner/lib/schedule');

const root = path.join(__dirname, '..', 'outputs', 'content-planner');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(root, 'profiles.json'), 'utf8'));
const overrides = JSON.parse(fs.readFileSync(path.join(root, 'event-overrides.json'), 'utf8'));

function event(changes = {}) {
  return {
    eventKey: '2026-10-15_18-30_saunagus',
    date: '2026-10-15', start: '18:30', end: '20:30', name: 'Saunagus',
    instructor: 'Søren', booked: 0, capacity: 12,
    ...changes,
  };
}

function slotFor(input, kind = 'event_day') {
  return buildSchedule([input], config).find((slot) => slot.kind === kind);
}

test('all platform versions retain the same correct date and time', () => {
  const input = event();
  const copy = buildCopyPackage(slotFor(input), [input], resolveContentSource(input, profiles, overrides), config);
  for (const text of [copy.instagram, copy.facebookPage, copy.facebookGroup]) {
    assert.match(text, /15\. oktober 2026/i);
    assert.match(text, /18[.:]30[–-]20[.:]30/);
    assert.doesNotMatch(text, /10[.:]00/);
  }
  assert.match(copy.facebookPage, /https:\/\/somasaunagus\.dk\/kalender\//);
  assert.ok(copy.instagram.length < copy.facebookPage.length);
});

test('MELLEMRUM uses the exact approved credit line and themes', () => {
  const input = event({
    eventKey: '2026-10-18_10-00_saunagus', date: '2026-10-18', start: '10:00', end: '12:00', instructor: 'Millemaja', booked: 1,
  });
  const source = resolveContentSource(input, profiles, overrides);
  const copy = buildCopyPackage(slotFor(input), [input], source, config);
  assert.match(copy.facebookPage, /MELLEMRUM GUS med MilleMaja fra Betterlife by Yndigegn/);
  assert.match(copy.facebookPage, /sanselige og meditative/i);
  assert.ok(copy.factsUsed.includes('override:2026-10-18-mellemrum-10-00'));
});

test('unknown guest copy never inherits Sørens special vocabulary', () => {
  const input = event({ instructor: 'Anna' });
  const source = resolveContentSource(input, profiles, overrides);
  const copy = buildCopyPackage(slotFor(input), [input], source, config);
  const all = JSON.stringify(copy).toLocaleLowerCase('da-DK');
  assert.doesNotMatch(all, /viking|powergus|breathwork|fire runder/);
  assert.match(copy.facebookGroup, /Anna/);
});

test('blank instructor remains neutral and unnamed', () => {
  const input = event({ instructor: null });
  const copy = buildCopyPackage(slotFor(input), [input], resolveContentSource(input, profiles, overrides), config);
  const all = JSON.stringify(copy).toLocaleLowerCase('da-DK');
  assert.doesNotMatch(all, /søren|millemaja|viking|breathwork/);
});

test('Søren stays in review metadata and is not repeated in public copy or artwork', () => {
  const input = event();
  const source = resolveContentSource(input, profiles, overrides);
  const copy = buildCopyPackage(slotFor(input), [input], source, config);
  for (const text of [copy.instagram, copy.facebookPage, copy.facebookGroup]) {
    assert.doesNotMatch(text, /Søren|med Søren|holder Søren/i);
  }
  assert.equal(copy.imageLines.instructorLabel, 'GUSMESTER');
  assert.equal(copy.imageLines.instructorName, 'Søren');

  const weekly = buildSchedule([input], config).find((candidate) => candidate.kind === 'weekly_overview');
  const weeklyCopy = buildCopyPackage(weekly, [input], null, config);
  assert.doesNotMatch(JSON.stringify(weeklyCopy), /Søren|med Søren/i);
});

test('public copy avoids redundant SOMA mentions and uses et saunagus', () => {
  const input = event();
  const copy = buildCopyPackage(slotFor(input), [input], resolveContentSource(input, profiles, overrides), config);
  for (const text of [copy.instagram, copy.facebookPage, copy.facebookGroup]) {
    const withoutUrl = text.replaceAll(config.bookingUrl, '');
    assert.doesNotMatch(withoutUrl, /\bSOMA\b/i);
    assert.doesNotMatch(withoutUrl, /\ben saunagus\b/i);
  }
  assert.match(copy.facebookPage, /\bet saunagus\b/i);

  const weekly = buildSchedule([input], config).find((candidate) => candidate.kind === 'weekly_overview');
  const weeklyCopy = buildCopyPackage(weekly, [input], null, config);
  for (const text of [weeklyCopy.instagram, weeklyCopy.facebookPage, weeklyCopy.facebookGroup]) {
    assert.doesNotMatch(text.replaceAll(config.bookingUrl, ''), /\bSOMA\b/i);
  }
});

test('Søren copy is grounded in calm rather than growing energy', () => {
  const inputs = [
    event({ eventKey: '2026-10-13_18-30_saunagus', date: '2026-10-13' }),
    event({ eventKey: '2026-10-15_18-30_saunagus', date: '2026-10-15' }),
    event({ eventKey: '2026-10-18_16-00_saunagus', date: '2026-10-18', start: '16:00', end: '18:00' }),
  ];
  const platformTexts = [];
  for (const input of inputs) {
    const source = resolveContentSource(input, profiles, overrides);
    for (const kind of ['day_before', 'event_day']) {
      const copy = buildCopyPackage(slotFor(input, kind), [input], source, config);
      platformTexts.push(copy.instagram, copy.facebookPage, copy.facebookGroup);
    }
  }
  const weekly = buildSchedule(inputs, config).find((candidate) => candidate.kind === 'weekly_overview');
  const weeklyCopy = buildCopyPackage(weekly, inputs, null, config);
  platformTexts.push(weeklyCopy.instagram, weeklyCopy.facebookPage, weeklyCopy.facebookGroup);

  const all = platformTexts.join('\n').toLocaleLowerCase('da-DK');
  assert.match(all, /ro|rolig|lande/);
  assert.doesNotMatch(all, /energien vokse|egen energi|energi kan overraske/);
  assert.doesNotMatch(all, /mellemrum/);
});

test('consecutive Thursdays use different calm copy without tempo or energy language', () => {
  const thursdays = ['2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29'];
  const copies = thursdays.map((date) => {
    const input = event({ eventKey: `${date}_18-30_saunagus`, date });
    const source = resolveContentSource(input, profiles, overrides);
    return buildCopyPackage(slotFor(input), [input], source, config).facebookPage;
  });

  assert.equal(new Set(copies).size, copies.length);
  for (const copy of copies) {
    assert.match(copy, /ro|rolig|blid|nærvær|åndedræt|sanser/i);
    assert.doesNotMatch(copy, /energi|tempo|power|viking|beats|kraft/i);
  }
});

test('consecutive Tuesdays vary while keeping power in the music and calm in the body', () => {
  const tuesdays = ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'];
  const copies = tuesdays.map((date) => {
    const input = event({ eventKey: `${date}_18-30_saunagus`, date });
    const source = resolveContentSource(input, profiles, overrides);
    return buildCopyPackage(slotFor(input), [input], source, config).facebookPage;
  });

  assert.equal(new Set(copies).size, copies.length);
  for (const copy of copies) {
    assert.match(copy, /musik|rytme/i);
    assert.match(copy, /ro|rolig|lande|velvære/i);
    assert.doesNotMatch(copy, /energ/i);
  }
});

test('the same event and posting slot always receive the same variation', () => {
  const input = event({ eventKey: '2026-10-22_18-30_saunagus', date: '2026-10-22' });
  const source = resolveContentSource(input, profiles, overrides);
  const first = buildCopyPackage(slotFor(input), [input], source, config);
  const second = buildCopyPackage(slotFor(input), [input], source, config);
  assert.deepEqual(second, first);
});

test('sold-out copy removes booking CTA', () => {
  const input = event({ booked: 12 });
  const copy = buildCopyPackage(slotFor(input), [input], resolveContentSource(input, profiles, overrides), config);
  assert.match(copy.facebookPage, /udsolgt/i);
  assert.doesNotMatch(copy.facebookPage, /book din plads/i);
  assert.doesNotMatch(copy.instagram, /book din plads/i);
});

test('remaining places are explicit in copy but not embedded in image lines', () => {
  const input = event({ booked: 9 });
  const copy = buildCopyPackage(slotFor(input), [input], resolveContentSource(input, profiles, overrides), config);
  assert.match(copy.instagram, /kun 3 pladser tilbage/i);
  assert.doesNotMatch(JSON.stringify(copy.imageLines), /9\s*\/\s*12|3 pladser/i);
});

test('weekly overview lists both events on a double-event date', () => {
  const morning = event({
    eventKey: '2026-10-18_10-00_saunagus', date: '2026-10-18', start: '10:00', end: '12:00', instructor: 'Millemaja',
  });
  const afternoon = event({
    eventKey: '2026-10-18_16-00_saunagus', date: '2026-10-18', start: '16:00', end: '18:00', instructor: 'Søren',
  });
  const slot = buildSchedule([morning, afternoon], config).find((candidate) => candidate.kind === 'weekly_overview');
  const copy = buildCopyPackage(slot, [morning, afternoon], null, config);
  for (const text of [copy.instagram, copy.facebookPage, copy.facebookGroup]) {
    assert.match(text, /10[.:]00[–-]12[.:]00/);
    assert.match(text, /16[.:]00[–-]18[.:]00/);
  }
  assert.equal(copy.imageLines.events, undefined);
});

test('image headlines describe the gus instead of repeating Saunagus', () => {
  const cases = [
    [event({ date: '2026-10-13', instructor: 'Søren' }), 'POWERGUS', /VIKINGEKRAFT/],
    [event({ date: '2026-10-15', instructor: 'Søren' }), 'TORSDAGSGUS', /BREATHWORK/],
    [event({ date: '2026-10-18', instructor: 'Søren' }), 'SØNDAGSGUS', /ALT KAN SKE/],
    [event({ date: '2026-10-20', instructor: 'MilleMaja' }), 'GUS MED MILLEMAJA', /SANSER/],
  ];
  for (const [input, headline, tagline] of cases) {
    const copy = buildCopyPackage(slotFor(input), [input], resolveContentSource(input, profiles, overrides), config);
    assert.equal(copy.imageLines.headline, headline);
    assert.match(copy.imageLines.tagline, tagline);
    assert.equal(copy.imageLines.instructorLabel, 'GUSMESTER');
    assert.ok(copy.imageLines.instructorName);
  }
});
