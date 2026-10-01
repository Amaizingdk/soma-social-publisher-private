'use strict';

const { createHash } = require('node:crypto');

function stableChoice(values, key) {
  if (!Array.isArray(values) || values.length === 0) return '';
  const digest = createHash('sha256').update(key).digest();
  return values[digest.readUInt32BE(0) % values.length];
}

function rotatingChoice(values, date, kind) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const [year, month, day] = date.split('-').map(Number);
  const weekIndex = Math.floor(Date.UTC(year, month - 1, day) / 604800000);
  const slotOffset = kind === 'event_day' ? 1 : 0;
  return values[(weekIndex + slotOffset) % values.length];
}

function formatDate(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('da-DK', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatTime(value) {
  return value.replace(':', '.');
}

function eventLine(event) {
  return `${formatDate(event.date)} · ${formatTime(event.start)}–${formatTime(event.end)}`;
}

function presentationFor(event, source = {}) {
  if (source.title) return { headline: source.title, tagline: 'ET MELLEMRUM · BARE TIL DIG' };
  const weekday = new Date(`${event.date}T12:00:00Z`).getUTCDay();
  if (source.profileId === 'soren' && weekday === 2) return { headline: 'POWERGUS', tagline: 'RYTME · VIKINGEKRAFT · VARME BEATS' };
  if (source.profileId === 'soren' && weekday === 4) return { headline: 'TORSDAGSGUS', tagline: 'BREATHWORK · SANSER · BLID VARME' };
  if (source.profileId === 'soren' && weekday === 0) return { headline: 'SØNDAGSGUS', tagline: 'ALT KAN SKE' };
  if (source.profileId === 'millemaja') return { headline: 'GUS MED MILLEMAJA', tagline: 'SANSER · RO · NÆRVÆR' };
  if (weekday === 2) return { headline: 'TIRSDAGSGUS', tagline: 'VARME · DUFTE · NÆRVÆR' };
  if (weekday === 4) return { headline: 'TORSDAGSGUS', tagline: 'VARME · DUFTE · NÆRVÆR' };
  if (weekday === 0) return { headline: 'SØNDAGSGUS', tagline: 'VARME · DUFTE · NÆRVÆR' };
  return { headline: 'GUS I VARMEN', tagline: 'VARME · DUFTE · NÆRVÆR' };
}

function eventDisplayName(event) {
  const weekday = new Date(`${event.date}T12:00:00Z`).getUTCDay();
  if (/mille\s*maja/iu.test(event.instructor || '')) return 'Gus med MilleMaja';
  if (weekday === 2 && /søren/iu.test(event.instructor || '')) return 'Powergus';
  if (weekday === 2) return 'Tirsdagsgus';
  if (weekday === 4) return 'Torsdagsgus';
  if (weekday === 0) return 'Søndagsgus';
  return 'Gus';
}

function availabilityText(slot) {
  return slot.availability?.label || '';
}

function callToAction(slot, config, prefix = 'Book din plads') {
  if (slot.availability?.soldOut) return 'Eventet er udsolgt.';
  return `${prefix}: ${config.bookingUrl}`;
}

function buildWeeklyCopy(slot, events, config) {
  const selected = slot.eventKeys
    .map((key) => events.find((event) => event.eventKey === key))
    .filter(Boolean)
    .sort((left, right) => `${left.date}T${left.start}`.localeCompare(`${right.date}T${right.start}`));
  const lines = selected.map((event) => `${eventLine(event)} · ${eventDisplayName(event)}${event.instructor && !/(mille\s*maja|søren)/iu.test(event.instructor) ? ` med ${event.instructor}` : ''}`);
  const list = lines.map((line) => `• ${line}`).join('\n');
  const headline = 'NÆSTE UGES GUS';
  return {
    headline,
    imageLines: {
      headline,
      weekly: true,
      tagline: 'UGENS VARME PUSTERUM',
    },
    instagram: `Næste uges gus 🔥\n\n${list}\n\nSe tider og book via kalenderen: ${config.bookingUrl}`,
    facebookPage: `Her er næste uges gus. Hver session har sit eget udtryk, men altid med plads til ro, varme, dufte, musik og nærvær.\n\n${list}\n\nFind den oplevelse, der passer dig, og book din plads her: ${config.bookingUrl}`,
    facebookGroup: `Kære alle ❤️\n\nHer er næste uges muligheder for at finde ro i varmen:\n\n${list}\n\nJeg glæder mig til at se jer. Booking: ${config.bookingUrl}`,
    factsUsed: selected.flatMap((event) => [`event:${event.eventKey}.date`, `event:${event.eventKey}.time`]),
  };
}

function buildSingleCopy(slot, event, source, config) {
  if (!source) throw new Error(`Indholdskilde mangler for ${event.eventKey}`);
  const variation = rotatingChoice(source.copyVariants, event.date, slot.kind);
  const hook = variation?.hook || stableChoice(source.hooks, `${slot.slotKey}:hook`);
  const fact = variation?.fact || stableChoice(source.facts, `${slot.slotKey}:fact`);
  const invitation = variation?.invitation || stableChoice(source.invitations, `${slot.slotKey}:invitation`);
  const timing = slot.kind === 'day_before' ? 'I morgen' : 'I dag';
  const isSoren = source.profileId === 'soren';
  const credit = isSoren ? event.name : source.creditLine
    || (source.displayName ? `${event.name} med ${source.displayName}` : event.name);
  const when = eventLine(event);
  const availability = availabilityText(slot);
  const availabilityLine = availability ? `${availability.charAt(0).toUpperCase()}${availability.slice(1)}.` : '';
  const cta = callToAction(slot, config);
  const presentation = presentationFor(event, source);
  const headline = presentation.headline;
  const instructorLabel = source.displayName ? 'GUSMESTER' : null;
  const instructorName = source.displayName || null;
  const instagramTitle = isSoren ? null : credit;
  const opening = source.kind === 'event_override'
    ? `${timing} inviteres du til ${credit}.`
    : source.displayName && !isSoren
    ? `${timing} kan du træde ind i varmen til et saunagus med ${source.displayName}.`
    : `${timing} kan du træde ind i varmen til et saunagus.`;

  const instagram = [
    `${timing}: ${hook}`,
    instagramTitle,
    when,
    availabilityLine,
    cta,
  ].filter(Boolean).join('\n\n');

  const facebookPage = [
    opening,
    hook,
    fact,
    invitation,
    `Dato og tid: ${when}`,
    availabilityLine,
    cta,
  ].filter(Boolean).join('\n\n');

  const facebookGroup = [
    `Kære alle ❤️`,
    opening,
    hook,
    `Tid: ${when}`,
    availabilityLine,
    callToAction(slot, config, 'Du kan booke her'),
  ].filter(Boolean).join('\n\n');

  return {
    headline,
    imageLines: {
      headline,
      tagline: presentation.tagline,
      date: formatDate(event.date),
      time: `${formatTime(event.start)}–${formatTime(event.end)}`,
      instructorLabel,
      instructorName,
    },
    instagram,
    facebookPage,
    facebookGroup,
    factsUsed: [
      'event.date', 'event.start', 'event.end', 'event.name',
      source.sourceId || `profile:${source.profileId}`,
    ],
  };
}

function buildCopyPackage(slot, events, source, config) {
  if (slot.kind === 'weekly_overview') return buildWeeklyCopy(slot, events, config);
  const event = events.find((candidate) => candidate.eventKey === slot.eventKeys[0]);
  if (!event) throw new Error(`Event mangler til slot ${slot.slotKey}`);
  return buildSingleCopy(slot, event, source, config);
}

module.exports = { stableChoice, presentationFor, buildCopyPackage };
