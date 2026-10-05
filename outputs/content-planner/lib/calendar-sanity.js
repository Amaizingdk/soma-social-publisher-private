'use strict';

// En hel uge, der tidligere havde kommende events, men nu er tom midt imellem uger med events,
// ligner en ufuldstændig kalenderlæsning — ikke en aflysning. Så må kladderne ikke gøres forældede.
function mondayOf(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function findVanishedWeeks(previousEvents, newEvents, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const weeksOf = (events) => new Set((events || [])
    .filter((event) => typeof event?.date === 'string' && event.date >= today)
    .map((event) => mondayOf(event.date)));
  const before = weeksOf(previousEvents);
  const after = weeksOf(newEvents);
  const lastWeekAfter = [...after].sort().pop();
  if (!lastWeekAfter) return [];
  return [...before].filter((week) => !after.has(week) && week < lastWeekAfter).sort();
}

module.exports = { findVanishedWeeks, mondayOf };
