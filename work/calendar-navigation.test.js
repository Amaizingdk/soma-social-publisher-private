'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const {
  WEEK_LABEL_SELECTOR,
  NEXT_WEEK_SELECTOR,
  extractWeekEvents,
  readCalendarWeeks,
} = require('../outputs/content-planner/lib/calendar-navigation');

const FIXTURES = path.join(__dirname, 'fixtures');

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await run(page);
  } finally {
    await browser.close();
  }
}

test('observed next-week selector identifies the right arrow when both arrows are active', async () => {
  await withPage(async (page) => {
    const html = await fs.readFile(path.join(FIXTURES, 'calendar-week-42-details.html'), 'utf8');
    await page.setContent(html);
    assert.equal(await page.locator(WEEK_LABEL_SELECTOR).innerText(), 'Uge 42');
    assert.equal(await page.locator(NEXT_WEEK_SELECTOR).count(), 1);
    assert.ok(await page.locator(NEXT_WEEK_SELECTOR).locator('svg.feather-arrow-right').count());
  });
});

test('extractWeekEvents reads optional instructor and description without inventing missing values', async () => {
  await withPage(async (page) => {
    const html = await fs.readFile(path.join(FIXTURES, 'calendar-week-42-details.html'), 'utf8');
    await page.setContent(html);
    const events = await extractWeekEvents(page, new Date('2026-09-29T12:00:00+02:00'));
    const mellemrum = events.find((event) => event.start === '10:00');
    const blank = events.find((event) => event.start === '18:30');
    assert.equal(mellemrum.eventKey, '2026-10-18_10-00-mellemrum-gus'.replace('_10-00-', '_10-00_'));
    assert.equal(mellemrum.instructor, 'MilleMaja');
    assert.match(mellemrum.description, /sanselige og meditative/i);
    assert.equal(blank.instructor, null);
    assert.equal(blank.description, null);
  });
});

test('extractWeekEvents reads the observed small bold uppercase field as instructor', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <ul><li class="events-group">
        <div class="cal-top"><div class="bold">8. okt</div></div>
        <ul><li class="class-item"><a>
          <div class="bold mb-1">18:30 - 20:30</div>
          <div class="event-name">Saunagus</div>
          <div></div><br>
          <div class="small bold uppercase">Søren</div>
          <div class="justify-end"><div class="bold mb-1">0/12</div></div>
        </a></li></ul>
      </li></ul>
    `);
    const [event] = await extractWeekEvents(page, new Date('2026-09-29T12:00:00+02:00'));
    assert.equal(event.instructor, 'Søren');
    assert.equal(event.description, null);
  });
});

test('extractWeekEvents skips past YOGO groups whose occupancy has been removed', async () => {
  await withPage(async (page) => {
    await page.setContent(`
      <ul>
        <li class="events-group before-today">
          <div class="cal-top"><div class="bold">29. sep</div></div>
          <ul><li class="class-item class-has-started"><a>
            <div class="bold mb-1">18:30 - 20:30</div><div class="event-name">Saunagus</div>
            <div class="justify-end"><div class="bold mb-1"></div></div>
          </a></li></ul>
        </li>
        <li class="events-group">
          <div class="cal-top"><div class="bold">1. okt</div></div>
          <ul><li class="class-item"><a>
            <div class="bold mb-1">18:30 - 20:30</div><div class="event-name">Saunagus</div>
            <div class="justify-end"><div class="bold mb-1">6/12</div></div>
          </a></li></ul>
        </li>
      </ul>
    `);
    const events = await extractWeekEvents(page, new Date('2026-09-30T12:00:00+02:00'));
    assert.equal(events.length, 1);
    assert.equal(events[0].date, '2026-10-01');
    assert.equal(events[0].booked, 6);
  });
});

test('readCalendarWeeks waits for delayed changes, merges weeks, and removes duplicate keys', async () => {
  await withPage(async (page) => {
    const week40 = await fs.readFile(path.join(FIXTURES, 'calendar-week-40.html'), 'utf8');
    const week42 = await fs.readFile(path.join(FIXTURES, 'calendar-week-42-details.html'), 'utf8');
    await page.setContent(week40);
    await page.evaluate((nextHtml) => {
      const target = document.querySelector('.calendar__week--nav > div:has(> svg.feather-arrow-right)');
      target.addEventListener('click', () => {
        setTimeout(() => {
          const parsed = new DOMParser().parseFromString(nextHtml, 'text/html');
          document.body.replaceChildren(...parsed.body.childNodes);
        }, 75);
      }, { once: true });
    }, week42);

    const events = await readCalendarWeeks(page, {
      now: new Date('2026-09-29T12:00:00+02:00'),
      weeksAhead: 2,
    });
    assert.ok(events.some((event) => event.eventKey === '2026-10-18_10-00_mellemrum-gus'));
    assert.equal(new Set(events.map((event) => event.eventKey)).size, events.length);
    assert.deepEqual(events.map((event) => event.date), [...events.map((event) => event.date)].sort());
  });
});

test('readCalendarWeeks ignores transient cleared dates until the week label changes', async () => {
  await withPage(async (page) => {
    const week40 = await fs.readFile(path.join(FIXTURES, 'calendar-week-40.html'), 'utf8');
    const week42 = await fs.readFile(path.join(FIXTURES, 'calendar-week-42-details.html'), 'utf8');
    await page.setContent(week40);
    await page.evaluate((nextHtml) => {
      const target = document.querySelector('.calendar__week--nav > div:has(> svg.feather-arrow-right)');
      target.addEventListener('click', () => {
        document.querySelector('.calendar-events').replaceChildren();
        setTimeout(() => {
          const parsed = new DOMParser().parseFromString(nextHtml, 'text/html');
          document.body.replaceChildren(...parsed.body.childNodes);
        }, 200);
      }, { once: true });
    }, week42);

    const events = await readCalendarWeeks(page, {
      now: new Date('2026-09-29T12:00:00+02:00'),
      weeksAhead: 2,
      settleQuietMs: 50,
      transitionTimeoutMs: 1_000,
    });
    assert.ok(events.some((event) => event.eventKey === '2026-10-18_10-00_mellemrum-gus'));
  });
});

test('readCalendarWeeks waits for initial day groups after the week label appears', async () => {
  await withPage(async (page) => {
    const week40 = await fs.readFile(path.join(FIXTURES, 'calendar-week-40.html'), 'utf8');
    await page.setContent(`
      <span class="calendar__week--nav">
        <span class="align--center">Uge 40</span>
        <div><svg class="feather-arrow-right" width="24" height="24"></svg></div>
      </span>
    `);
    await page.evaluate((fullHtml) => {
      setTimeout(() => {
        const parsed = new DOMParser().parseFromString(fullHtml, 'text/html');
        document.body.replaceChildren(...parsed.body.childNodes);
      }, 75);
    }, week40);

    const events = await readCalendarWeeks(page, {
      now: new Date('2026-09-29T09:00:00+02:00'),
      weeksAhead: 1,
      initialTimeoutMs: 1_000,
    });
    assert.equal(events.length, 3);
  });
});

test('readCalendarWeeks waits for event-card mutations after day groups are present', async () => {
  await withPage(async (page) => {
    const week40 = await fs.readFile(path.join(FIXTURES, 'calendar-week-40.html'), 'utf8');
    await page.setContent(`
      <span class="calendar__week--nav">
        <span class="align--center">Uge 40</span>
        <div><svg class="feather-arrow-right" width="24" height="24"></svg></div>
      </span>
      <ul><li class="events-group"><div class="cal-top"><div class="bold">29. sep</div></div><ul></ul></li></ul>
    `);
    await page.evaluate((fullHtml) => {
      setTimeout(() => {
        const parsed = new DOMParser().parseFromString(fullHtml, 'text/html');
        document.body.replaceChildren(...parsed.body.childNodes);
      }, 75);
    }, week40);

    const events = await readCalendarWeeks(page, {
      now: new Date('2026-09-29T09:00:00+02:00'),
      weeksAhead: 1,
      settleQuietMs: 125,
      initialTimeoutMs: 1_000,
    });
    assert.equal(events.length, 3);
  });
});

test('readCalendarWeeks rejects an unchanged week instead of looping', async () => {
  await withPage(async (page) => {
    const html = await fs.readFile(path.join(FIXTURES, 'calendar-week-40.html'), 'utf8');
    await page.setContent(html);
    await assert.rejects(
      readCalendarWeeks(page, {
        now: new Date('2026-09-29T12:00:00+02:00'),
        weeksAhead: 2,
        transitionTimeoutMs: 150,
      }),
      /skiftede ikke|uændret/i,
    );
  });
});

test('readCalendarWeeks rejects horizons beyond twelve weeks', async () => {
  await withPage(async (page) => {
    await page.setContent('<span class="calendar__week--nav"><span class="align--center">Uge 40</span><div><svg class="feather-arrow-right"></svg></div></span>');
    await assert.rejects(
      readCalendarWeeks(page, { now: new Date(), weeksAhead: 13 }),
      /1 og 12/i,
    );
  });
});
