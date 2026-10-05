'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  parseDanishDate,
  parseEvent,
  deduplicateAndSort,
  filterUpcoming,
} = require('./content-planner/lib/event-parser');
const {
  CALENDAR_URL,
  readCalendarWeeks,
} = require('./content-planner/lib/calendar-navigation');

const OUTPUT_PATH = path.join(__dirname, 'events.json');

async function extractRawEvents(root) {
  const groups = root.locator('li.events-group');
  const rawEvents = [];

  for (let groupIndex = 0; groupIndex < await groups.count(); groupIndex += 1) {
    const group = groups.nth(groupIndex);
    const dateText = await group.locator(':scope > .cal-top > .bold').innerText();
    const cards = group.locator(':scope > ul > li.class-item');

    for (let cardIndex = 0; cardIndex < await cards.count(); cardIndex += 1) {
      const card = cards.nth(cardIndex);
      rawEvents.push({
        dateText,
        timeText: await card.locator(':scope > a > .bold.mb-1').first().innerText(),
        nameText: await card.locator('.event-name').textContent(),
        occupancyText: await card.locator(':scope > a > .justify-end > .bold.mb-1').innerText(),
      });
    }
  }

  return rawEvents.map((raw) => Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, value.replace(/\s+/g, ' ').trim()]),
  ));
}

// Kalenderen svarer langsomt fra GitHubs servere; hele læsningen prøves derfor op til tre gange.
async function readCalendar(page, now = new Date(), weeksAhead = 4, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const events = await readCalendarWeeks(page, { now, weeksAhead });
      if (events.length === 0) {
        throw new Error('Kalenderen indeholdt ingen kommende events');
      }
      return events;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function writeEventsAtomic(events, outputPath = OUTPUT_PATH) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Nægter at overskrive events.json med et tomt resultat');
  }

  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(events, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const events = await readCalendar(page);
    await writeEventsAtomic(events);
    console.log(`\nFandt ${events.length} kommende Soma-event(s):\n`);
    console.table(events);
    console.log(`Gemt i ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

module.exports = {
  parseDanishDate,
  parseEvent,
  deduplicateAndSort,
  filterUpcoming,
  extractRawEvents,
  readCalendarWeeks,
  readCalendar,
  writeEventsAtomic,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`SOMA Calendar Reader fejlede: ${error.message}`);
    process.exitCode = 1;
  });
}
