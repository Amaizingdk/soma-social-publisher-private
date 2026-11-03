'use strict';

// En hel uge, der tidligere havde kommende events, men nu er tom midt imellem uger med events,
// ligner en ufuldstændig kalenderlæsning — ikke en aflysning. Så må kladderne ikke gøres forældede.
function mondayOf(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// weeksAhead (valgfri): hvor mange uger læsningen dækker, regnet fra indeværende uge. Uger inden for den
// horisont, der før havde events, men nu er tomme, flagges også når de ligger EFTER den sidste uge i læsningen.
// Det fanger en afkortet læsning (fx siden midt i en genstart), hvor kun de første uger kom med.
function findVanishedWeeks(previousEvents, newEvents, now = new Date(), { weeksAhead = null } = {}) {
  const today = now.toISOString().slice(0, 10);
  const weeksOf = (events) => new Set((events || [])
    .filter((event) => typeof event?.date === 'string' && event.date >= today)
    .map((event) => mondayOf(event.date)));
  const before = weeksOf(previousEvents);
  const after = weeksOf(newEvents);
  const lastWeekAfter = [...after].sort().pop();
  if (!lastWeekAfter) return [];
  const horizon = Number.isInteger(weeksAhead) && weeksAhead > 0
    ? addDays(mondayOf(today), (weeksAhead - 1) * 7)
    : null;
  return [...before]
    .filter((week) => !after.has(week) && (week < lastWeekAfter || (horizon !== null && week <= horizon)))
    .sort();
}

module.exports = { findVanishedWeeks, mondayOf };
