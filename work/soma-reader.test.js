const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const {
  parseDanishDate,
  parseEvent,
  deduplicateAndSort,
  extractRawEvents,
  filterUpcoming,
} = require('../outputs/soma-reader');

test('parseDanishDate parses an observed Danish date label in the current year', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  assert.equal(parseDanishDate('29. sep', now), '2026-09-29');
});

test('parseDanishDate ignores a leading weekday and accepts a full month name', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  assert.equal(parseDanishDate('Torsdag 1. oktober', now), '2026-10-01');
});

test('parseDanishDate rolls January into the next year when run in December', () => {
  const now = new Date('2026-12-31T12:00:00+01:00');
  assert.equal(parseDanishDate('1. jan', now), '2027-01-01');
});

test('parseDanishDate keeps a nearby earlier day in the current year', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  assert.equal(parseDanishDate('27. sep', now), '2026-09-27');
});

test('parseDanishDate resolves December to the previous year when run in January', () => {
  const now = new Date('2027-01-01T12:00:00+01:00');
  assert.equal(parseDanishDate('31. dec', now), '2026-12-31');
});

test('parseEvent normalizes the separate fields observed in the live widget', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  assert.deepEqual(parseEvent({
    dateText: '29. sep',
    timeText: ' 18:30 - 20:30 ',
    nameText: '  Saunagus  ',
    occupancyText: ' 1/12 ',
  }, now), {
    date: '2026-09-29',
    start: '18:30',
    end: '20:30',
    name: 'Saunagus',
    booked: 1,
    capacity: 12,
  });
});

test('parseEvent accepts an en dash and preserves zero booked', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  const event = parseEvent({
    dateText: '4. okt',
    timeText: '16:00–18:00',
    nameText: 'SAUNAGUS',
    occupancyText: '0/12',
  }, now);
  assert.equal(event.booked, 0);
  assert.equal(event.start, '16:00');
  assert.equal(event.end, '18:00');
});

test('parseEvent rejects malformed occupancy', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  assert.throws(() => parseEvent({
    dateText: '29. sep',
    timeText: '18:30 - 20:30',
    nameText: 'Saunagus',
    occupancyText: 'ledig',
  }, now), /belægning/i);
});

test('parseEvent rejects a missing event name', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  assert.throws(() => parseEvent({
    dateText: '29. sep',
    timeText: '18:30 - 20:30',
    nameText: '   ',
    occupancyText: '1/12',
  }, now), /navn/i);
});

test('deduplicateAndSort removes exact duplicates and sorts chronologically', () => {
  const later = {
    date: '2026-10-04', start: '16:00', end: '18:00', name: 'Saunagus', booked: 0, capacity: 12,
  };
  const earlier = {
    date: '2026-09-29', start: '18:30', end: '20:30', name: 'Saunagus', booked: 1, capacity: 12,
  };
  assert.deepEqual(deduplicateAndSort([later, earlier, { ...earlier }]), [earlier, later]);
});

test('deduplicateAndSort keeps events that differ by time or name', () => {
  const base = {
    date: '2026-09-29', start: '18:30', end: '20:30', name: 'Saunagus', booked: 1, capacity: 12,
  };
  const differentTime = { ...base, start: '20:45', end: '22:45' };
  const differentName = { ...base, name: 'Saunagus Special' };
  assert.equal(deduplicateAndSort([base, differentTime, differentName]).length, 3);
});

test('filterUpcoming removes finished events but keeps future events', () => {
  const now = new Date('2026-09-28T12:00:00+02:00');
  const finished = {
    date: '2026-09-27', start: '16:00', end: '18:00', name: 'Old', booked: 1, capacity: 12,
  };
  const future = {
    date: '2026-09-29', start: '18:30', end: '20:30', name: 'Future', booked: 1, capacity: 12,
  };
  assert.deepEqual(filterUpcoming([finished, future], now), [future]);
});

test('extractRawEvents follows the observed day-group and card structure', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>.ttu { text-transform: uppercase; }</style>
      <ul>
        <li class="events-group yogo-tac">
          <div class="cal-top sticky"><div>Tuesday</div><div class="bold">29. sep</div></div>
          <ul>
            <li class="class-item yogo-tac text-white">
              <a>
                <div class="bold mb-1">18:30 - 20:30</div>
                <div class="ttu bold event-name mb-1">Saunagus</div>
                <div class="justify-end yogo-flex-column flex-grow">
                  <div class="bold mb-1">1/12</div>
                </div>
              </a>
            </li>
          </ul>
        </li>
      </ul>
    `);
    assert.deepEqual(await extractRawEvents(page), [{
      dateText: '29. sep',
      timeText: '18:30 - 20:30',
      nameText: 'Saunagus',
      occupancyText: '1/12',
    }]);
  } finally {
    await browser.close();
  }
});
