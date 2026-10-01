'use strict';

const { parseEvent, filterUpcoming } = require('./event-parser');
const { createEventKey, createEventFingerprint } = require('./event-identity');

const CALENDAR_URL = 'https://somasaunagus.dk/kalender/';
const WEEK_LABEL_SELECTOR = '.calendar__week--nav > .align--center';
const NEXT_WEEK_SELECTOR = '.calendar__week--nav > div:has(> svg.feather-arrow-right)';
const DATE_SELECTOR = 'li.events-group .cal-top > .bold';

function clean(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

async function extractOptionalDetails(card) {
  const instructorField = card.locator('.event-instructor, .small.bold.uppercase').first();
  const descriptionField = card.locator('.event-description').first();
  const explicitInstructor = await instructorField.count()
    ? clean(await instructorField.textContent())
    : null;
  const explicitDescription = await descriptionField.count()
    ? clean(await descriptionField.textContent())
    : null;
  if (explicitInstructor || explicitDescription) {
    return { instructor: explicitInstructor, description: explicitDescription };
  }

  const extraTexts = await card.locator(':scope > a > div:not(.event-name):not(.justify-end)').evaluateAll((nodes) =>
    nodes.map((node) => node.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean),
  );
  const details = extraTexts.filter((text) => !/^\d{2}:\d{2}\s*[-–]\s*\d{2}:\d{2}$/u.test(text));
  const instructorIndex = details.findIndex((text) => /^(gusmester|underviser)\s*:/iu.test(text));
  const instructor = instructorIndex >= 0
    ? clean(details[instructorIndex].replace(/^(gusmester|underviser)\s*:\s*/iu, ''))
    : null;
  const description = clean(details.filter((_, index) => index !== instructorIndex).join(' '));
  return { instructor, description };
}

async function extractWeekEvents(root, now = new Date()) {
  const groups = root.locator('li.events-group');
  const events = [];
  for (let groupIndex = 0; groupIndex < await groups.count(); groupIndex += 1) {
    const group = groups.nth(groupIndex);
    const groupClasses = (await group.getAttribute('class') || '').split(/\s+/u);
    if (groupClasses.includes('before-today')) continue;
    const dateText = await group.locator(':scope > .cal-top > .bold').innerText();
    const cards = group.locator(':scope > ul > li.class-item');
    for (let cardIndex = 0; cardIndex < await cards.count(); cardIndex += 1) {
      const card = cards.nth(cardIndex);
      const raw = {
        dateText,
        timeText: await card.locator(':scope > a > .bold.mb-1').first().innerText(),
        nameText: await card.locator('.event-name').textContent(),
        occupancyText: await card.locator(':scope > a > .justify-end > .bold.mb-1').innerText(),
      };
      const parsed = parseEvent(raw, now);
      const optional = await extractOptionalDetails(card);
      const event = {
        ...parsed,
        instructor: optional.instructor,
        description: optional.description,
        sourceText: clean(await card.innerText()),
        sourceUrl: CALENDAR_URL,
        readAt: now.toISOString(),
      };
      event.eventKey = createEventKey(event);
      event.fingerprint = createEventFingerprint(event);
      events.push(event);
    }
  }
  return events;
}

async function signature(page) {
  return {
    week: clean(await page.locator(WEEK_LABEL_SELECTOR).first().innerText()),
    dates: (await page.locator(DATE_SELECTOR).allInnerTexts()).map(clean),
  };
}

async function waitForWeekChange(page, before, timeoutMs) {
  try {
    await page.waitForFunction(({ weekSelector, previous }) => {
      const week = document.querySelector(weekSelector)?.textContent?.replace(/\s+/g, ' ').trim() || null;
      return Boolean(week && week !== previous.week);
    }, {
      weekSelector: WEEK_LABEL_SELECTOR,
      previous: before,
    }, { timeout: timeoutMs });
  } catch (error) {
    throw new Error(`Kalenderugen skiftede ikke inden for ${timeoutMs} ms`, { cause: error });
  }
}

async function waitForCalendarSettled(page, quietMs, timeoutMs) {
  const settled = await page.evaluate(({ quiet, timeout }) => new Promise((resolve) => {
    let quietTimer;
    let timeoutTimer;
    const finish = (value) => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(timeoutTimer);
      resolve(value);
    };
    const armQuietTimer = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quiet);
    };
    const observer = new MutationObserver(armQuietTimer);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    timeoutTimer = setTimeout(() => finish(false), timeout);
    armQuietTimer();
  }), { quiet: quietMs, timeout: timeoutMs });
  if (!settled) throw new Error(`Kalenderens DOM blev ikke stabil inden for ${timeoutMs} ms`);
}

async function readCalendarWeeks(page, {
  now = new Date(),
  weeksAhead = 4,
  initialTimeoutMs = 30_000,
  settleQuietMs = 750,
  transitionTimeoutMs = 10_000,
} = {}) {
  if (!Number.isInteger(weeksAhead) || weeksAhead < 1 || weeksAhead > 12) {
    throw new Error('weeksAhead skal være et heltal mellem 1 og 12');
  }
  await page.locator(WEEK_LABEL_SELECTOR).first().waitFor({ state: 'visible', timeout: initialTimeoutMs });
  await page.locator(DATE_SELECTOR).first().waitFor({ state: 'attached', timeout: initialTimeoutMs });
  await waitForCalendarSettled(page, settleQuietMs, initialTimeoutMs);
  const collected = [];
  const seenSignatures = new Set();

  for (let index = 0; index < weeksAhead; index += 1) {
    const current = await signature(page);
    const currentKey = JSON.stringify(current);
    if (seenSignatures.has(currentKey)) throw new Error(`Kalenderugen er uændret eller gentaget: ${current.week}`);
    seenSignatures.add(currentKey);
    collected.push(...await extractWeekEvents(page, now));

    if (index < weeksAhead - 1) {
      const next = page.locator(NEXT_WEEK_SELECTOR).first();
      if (await next.count() !== 1) throw new Error('Næste uge-kontrollen blev ikke fundet entydigt');
      await next.click();
      await waitForWeekChange(page, current, transitionTimeoutMs);
      await waitForCalendarSettled(page, settleQuietMs, transitionTimeoutMs);
    }
  }

  const unique = new Map();
  for (const event of filterUpcoming(collected, now)) unique.set(event.eventKey, event);
  return [...unique.values()].sort((left, right) =>
    `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`)
      || left.name.localeCompare(right.name, 'da'));
}

module.exports = {
  CALENDAR_URL,
  WEEK_LABEL_SELECTOR,
  NEXT_WEEK_SELECTOR,
  extractWeekEvents,
  waitForCalendarSettled,
  readCalendarWeeks,
};
