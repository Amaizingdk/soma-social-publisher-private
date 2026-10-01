'use strict';

const DANISH_MONTHS = new Map([
  ['jan', 1], ['januar', 1],
  ['feb', 2], ['februar', 2],
  ['mar', 3], ['marts', 3],
  ['apr', 4], ['april', 4],
  ['maj', 5],
  ['jun', 6], ['juni', 6],
  ['jul', 7], ['juli', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['okt', 10], ['oktober', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12],
]);

function parseDanishDate(label, now = new Date()) {
  const normalized = String(label).toLocaleLowerCase('da-DK').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/\b(\d{1,2})\.?(?:\s+)([a-zæøå]+)\.?\b/u);
  if (!match) throw new Error(`Kunne ikke læse dato: "${label}"`);

  const day = Number(match[1]);
  const month = DANISH_MONTHS.get(match[2]);
  if (!month) throw new Error(`Ukendt dansk måned i dato: "${label}"`);

  const todayNumber = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const candidates = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
    .map((year) => ({ year, value: Date.UTC(year, month - 1, day) }))
    .filter(({ year, value }) => {
      const candidate = new Date(value);
      return candidate.getUTCFullYear() === year
        && candidate.getUTCMonth() === month - 1
        && candidate.getUTCDate() === day;
    })
    .sort((left, right) => {
      const distance = Math.abs(left.value - todayNumber) - Math.abs(right.value - todayNumber);
      return distance || right.value - left.value;
    });

  if (candidates.length === 0) throw new Error(`Ugyldig dato: "${label}"`);
  const { year } = candidates[0];
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseEvent(raw, now = new Date()) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const timeText = clean(raw?.timeText);
  const timeMatch = timeText.match(/^([01]\d|2[0-3]):([0-5]\d)\s*[-–]\s*([01]\d|2[0-3]):([0-5]\d)$/u);
  if (!timeMatch) throw new Error(`Kunne ikke læse tidsinterval: "${timeText}"`);

  const name = clean(raw?.nameText);
  if (!name) throw new Error('Event mangler navn');

  const occupancyText = clean(raw?.occupancyText);
  const occupancyMatch = occupancyText.match(/^(\d+)\s*\/\s*(\d+)$/u);
  if (!occupancyMatch) throw new Error(`Kunne ikke læse belægning: "${occupancyText}"`);

  const booked = Number(occupancyMatch[1]);
  const capacity = Number(occupancyMatch[2]);
  if (capacity < 1 || booked > capacity) throw new Error(`Ugyldig belægning: "${occupancyText}"`);

  return {
    date: parseDanishDate(clean(raw?.dateText), now),
    start: `${timeMatch[1]}:${timeMatch[2]}`,
    end: `${timeMatch[3]}:${timeMatch[4]}`,
    name,
    booked,
    capacity,
  };
}

function deduplicateAndSort(events) {
  const unique = new Map(events.map((event) => [JSON.stringify([
    event.date, event.start, event.end, event.name, event.booked, event.capacity,
  ]), event]));
  return [...unique.values()].sort((left, right) => {
    const chronological = `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`);
    return chronological || left.name.localeCompare(right.name, 'da');
  });
}

function filterUpcoming(events, now = new Date()) {
  return events.filter((event) => {
    const [year, month, day] = event.date.split('-').map(Number);
    const [hour, minute] = event.end.split(':').map(Number);
    return new Date(year, month - 1, day, hour, minute) >= now;
  });
}

module.exports = {
  parseDanishDate,
  parseEvent,
  deduplicateAndSort,
  filterUpcoming,
};
