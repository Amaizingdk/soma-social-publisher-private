'use strict';

const COPENHAGEN = 'Europe/Copenhagen';

function datePartsInZone(date, timeZone = COPENHAGEN) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
}

function copenhagenTimestamp(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error(`Ugyldig lokal dato/tid: ${date} ${time}`);
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wanted = { year, month, day, hour, minute, second: 0 };
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const candidates = [];

  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const instant = new Date(wallAsUtc - (offsetMinutes * 60_000));
    const parts = datePartsInZone(instant);
    if (Object.entries(wanted).every(([key, value]) => parts[key] === value)) {
      candidates.push(offsetMinutes);
    }
  }
  if (candidates.length !== 1) {
    throw new Error(`Lokal tid er ugyldig eller tvetydig i København: ${date} ${time}`);
  }
  const offset = candidates[0];
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const offsetText = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${date}T${time}:00${offsetText}`;
}

function availabilityFor(event, config) {
  const free = Math.max(0, event.capacity - event.booked);
  if (free === 0) return { free, label: 'udsolgt', soldOut: true };
  const noun = free === 1 ? 'plads' : 'pladser';
  if (free <= config.fewSpotsThreshold) return { free, label: `kun ${free} ${noun} tilbage`, soldOut: false };
  return { free, label: `${free} ledige ${noun}`, soldOut: false };
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return value.toISOString().slice(0, 10);
}

function mondayFor(dateText) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  return addDays(dateText, weekday === 0 ? -6 : 1 - weekday);
}

function weekdayKey(dateText) {
  const weekday = new Date(`${dateText}T12:00:00Z`).getUTCDay();
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][weekday];
}

function buildSchedule(events, config) {
  const uniqueEvents = [...new Map(events.map((event) => [event.eventKey, event])).values()]
    .sort((left, right) => `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`));
  if (uniqueEvents.length === 0) return [];

  const weeks = new Map();
  for (const current of uniqueEvents) {
    const monday = mondayFor(current.date);
    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday).push(current);
  }

  const slots = [];
  for (const [monday, weekEvents] of weeks) {
    const sunday = addDays(monday, -1);
    slots.push({
      slotKey: `${monday}_weekly-overview`,
      kind: 'weekly_overview',
      scheduledFor: copenhagenTimestamp(sunday, config.weeklyOverview.time),
      eventKeys: weekEvents.map((event) => event.eventKey),
      availability: null,
      reason: 'Ugeoverblik for den kommende uges faktiske gus.',
    });
  }

  for (const current of uniqueEvents) {
    const availability = availabilityFor(current, config);
    const configuredTimes = config.fixedPostSchedule?.[weekdayKey(current.date)];
    const fixedTimes = configuredTimes?.eventStart === current.start ? configuredTimes : {};
    const weekday = new Date(`${current.date}T12:00:00Z`).getUTCDay();
    if (weekday !== 1) {
      slots.push({
        slotKey: `${current.eventKey}_day-before`,
        kind: 'day_before',
        scheduledFor: copenhagenTimestamp(addDays(current.date, -1), fixedTimes.dayBeforeTime || config.dayBeforeTime),
        eventKeys: [current.eventKey],
        availability,
        reason: 'Påmindelse dagen før eventet.',
      });
    }

    const postTime = fixedTimes.eventDayTime || (current.start < config.morningCutoff
      ? config.morningPostTime
      : config.dayPostTime);
    slots.push({
      slotKey: `${current.eventKey}_event-day`,
      kind: 'event_day',
      scheduledFor: copenhagenTimestamp(current.date, postTime),
      eventKeys: [current.eventKey],
      availability,
      reason: current.start < config.morningCutoff
        ? 'Formiddagsevent deles tidligt på eventdagen.'
        : `Event deles kl. ${postTime} på eventdagen.`,
    });
  }

  return slots.sort((left, right) =>
    left.scheduledFor.localeCompare(right.scheduledFor) || left.slotKey.localeCompare(right.slotKey));
}

module.exports = {
  availabilityFor,
  copenhagenTimestamp,
  buildSchedule,
};
