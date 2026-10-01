'use strict';

const DEFAULT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function compareDraftToLiveEvent(draft, liveEvents, {
  now = new Date(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!Array.isArray(liveEvents)) throw new TypeError('Live kalenderdata skal være en liste');

  function compareOne(plannedEvent) {
    const eventKey = plannedEvent?.eventKey;
    const liveEvent = liveEvents.find((event) => event?.eventKey === eventKey);
    if (!liveEvent) return { reasons: ['EVENT_NOT_FOUND'], availability: null };

    const reasons = [];
    const readAt = Date.parse(liveEvent.readAt || '');
    if (!Number.isFinite(readAt) || !(now instanceof Date) || Number.isNaN(now.getTime()) || now.getTime() - readAt > maxAgeMs) {
      reasons.push('STALE_CALENDAR_DATA');
    }

    if (
      plannedEvent.date !== liveEvent.date
      || plannedEvent.start !== liveEvent.start
      || plannedEvent.end !== liveEvent.end
      || plannedEvent.name !== liveEvent.name
    ) {
      reasons.push('SCHEDULE_CHANGED');
    }
    if (plannedEvent.capacity !== liveEvent.capacity) reasons.push('CAPACITY_CHANGED');

    if (!Number.isInteger(liveEvent.booked) || !Number.isInteger(liveEvent.capacity) || liveEvent.booked < 0 || liveEvent.capacity < 1) {
      reasons.push('INVALID_AVAILABILITY_DATA');
    }

    const free = Math.max(0, liveEvent.capacity - liveEvent.booked);
    return {
      reasons,
      availability: {
        eventKey,
        booked: liveEvent.booked,
        capacity: liveEvent.capacity,
        free,
        soldOut: free === 0,
      },
    };
  }

  if (draft?.kind === 'weekly_overview' || (Array.isArray(draft?.events) && !draft?.event)) {
    const checks = (draft.events || []).map((plannedEvent) => ({
      eventKey: plannedEvent.eventKey,
      ...compareOne(plannedEvent),
    }));
    const reasons = checks.flatMap((check) => check.reasons.map((reason) => `${reason}:${check.eventKey}`));
    if (reasons.length) return { status: 'blocked', reasons };
    return { status: 'fresh', reasons: [], availabilities: checks.map((check) => check.availability) };
  }

  const plannedEvent = draft?.event || {};
  const check = compareOne({ ...plannedEvent, eventKey: draft?.eventKey || plannedEvent.eventKey });
  if (check.reasons.length) return { status: 'blocked', reasons: check.reasons };
  const { eventKey, ...availability } = check.availability;
  return { status: 'fresh', reasons: [], availability };
}

module.exports = { compareDraftToLiveEvent };
