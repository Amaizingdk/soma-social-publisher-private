'use strict';

const { createHash } = require('node:crypto');

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`Event mangler ${field}`);
  return text;
}

function slugify(value) {
  return requiredText(value, 'name')
    .toLocaleLowerCase('da-DK')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createEventKey({ date, start, name }) {
  const normalizedDate = requiredText(date, 'date');
  const normalizedStart = requiredText(start, 'start');
  return `${normalizedDate}_${normalizedStart.replace(':', '-')}_${slugify(name)}`;
}

function createEventFingerprint(event) {
  const canonical = JSON.stringify({
    date: event.date,
    start: event.start,
    end: event.end,
    name: event.name,
    instructor: event.instructor ?? null,
    booked: event.booked,
    capacity: event.capacity,
    description: event.description ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

module.exports = {
  slugify,
  createEventKey,
  createEventFingerprint,
};
