'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const config = require('../config.json');
const { escapeHtml, dataUrl } = require('./render');

const MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
];

function availabilityFor(event) {
  const booked = Number(event?.booked);
  const capacity = Number(event?.capacity);
  if (!Number.isFinite(booked) || !Number.isFinite(capacity) || capacity <= 0 || booked < 0 || booked > capacity) {
    throw new Error('Story-render kræver gyldige live belægningsdata');
  }
  const free = capacity - booked;
  return free === 0 ? 'Udsolgt' : `${free} ledige pladser`;
}

function formatDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || !month || !day || !MONTHS[month - 1]) throw new Error('Story-render mangler gyldig dato');
  return `${day}. ${MONTHS[month - 1]} ${year}`;
}

function formatTime(start, end) {
  const display = (value) => String(value || '').replace(':', '.');
  return `${display(start)}–${display(end)}`;
}

function storyEventName(event) {
  const original = String(event?.name || 'Saunagus').trim();
  if (!/^saunagus$/iu.test(original)) return original;
  const [year, month, day] = String(event?.date || '').split('-').map(Number);
  if (!year || !month || !day) return original;
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  if (weekday === 2) return 'Tirsdagsgus';
  if (weekday === 4) return 'Torsdagsgus';
  if (weekday === 0) return 'Søndagsgus';
  return original;
}

function approvedMood(draft) {
  const firstBlock = String(draft?.platformCopies?.instagram || '').split(/\n\s*\n/u)[0].trim();
  return firstBlock.replace(/^(?:I dag|I morgen)\s*:\s*/iu, '').trim();
}

function experienceLine(event) {
  const name = String(event?.name || '');
  if (/mellemrum/iu.test(name)) return 'Fire sanselige og meditative runder';
  const [year, month, day] = String(event?.date || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  if (weekday === 2) return 'Nordiske toner · varme beats · ro';
  if (weekday === 4) return 'Kort breathwork · fire sanselige runder';
  if (weekday === 0) return 'Varme · dufte · musik · nærvær';
  return '';
}

function validateInput(input) {
  if (input.draft?.status !== 'approved') throw new Error('Story-render kræver et godkendt opslag');
  if (!input.sourceImagePath || !input.logoPath) throw new Error('Story-render mangler billede eller logo');
  if (!input.outputPath && !input.previewOnly) throw new Error('Story-render mangler outputPath');
}

function eventRows(input) {
  if (input.draft.kind !== 'weekly_overview') {
    if (!input.liveEvent) throw new Error('Story-render mangler live event');
    const approved = input.draft.event || {};
    return [{
      ...input.liveEvent,
      name: approved.name || input.liveEvent.name,
      date: approved.date || input.liveEvent.date,
      start: approved.start || input.liveEvent.start,
      end: approved.end || input.liveEvent.end,
      instructor: approved.instructor ?? input.liveEvent.instructor,
    }];
  }
  if (!Array.isArray(input.liveEvents) || input.liveEvents.length === 0) {
    throw new Error('Ugeoversigten mangler live events');
  }
  const approvedByKey = new Map((input.draft.events || []).map((event) => [event.eventKey, event]));
  return input.liveEvents.map((liveEvent) => {
    const approved = approvedByKey.get(liveEvent.eventKey) || {};
    return {
      ...liveEvent,
      name: approved.name || liveEvent.name,
      date: approved.date || liveEvent.date,
      start: approved.start || liveEvent.start,
      end: approved.end || liveEvent.end,
      instructor: approved.instructor ?? liveEvent.instructor,
    };
  });
}

function visibleCopy(input) {
  const events = eventRows(input);
  const event = events[0];
  const soldOut = events.every((event) => availabilityFor(event) === 'Udsolgt');
  const lines = input.draft.kind === 'weekly_overview'
    ? ['Næste uges gus', ...events.flatMap((event) => [
      `${formatDate(event.date)} · ${formatTime(event.start, event.end)}`,
      availabilityFor(event),
    ])]
    : [
      storyEventName(event),
      formatDate(event.date),
      formatTime(event.start, event.end),
      event.instructor ? `Gusmester · ${event.instructor}` : '',
      availabilityFor(event),
    ].filter(Boolean);
  if (!soldOut) lines.push('Book via linket i bio');
  return lines.join('\n');
}

function eventMarkup(event, weekly) {
  const availability = availabilityFor(event);
  if (!weekly) {
    return `<div class="date" data-fit-check>${escapeHtml(formatDate(event.date))}</div>
      <div class="time" data-fit-check>${escapeHtml(formatTime(event.start, event.end))}</div>
      ${event.instructor ? `<div class="instructor" data-fit-check><span>GUSMESTER</span>${escapeHtml(event.instructor)}</div>` : ''}
      <div class="availability ${availability === 'Udsolgt' ? 'sold-out' : ''}" data-role="availability-label" data-fit-check>${escapeHtml(availability)}</div>`;
  }
  return `<article class="event-row">
    <div class="event-date" data-fit-check>${escapeHtml(formatDate(event.date))}</div>
    <div class="event-time" data-fit-check>${escapeHtml(formatTime(event.start, event.end))}</div>
    <div class="event-availability ${availability === 'Udsolgt' ? 'sold-out' : ''}" data-fit-check>${escapeHtml(availability)}</div>
  </article>`;
}

async function buildStoryHtml(input) {
  validateInput({ ...input, previewOnly: true });
  const events = eventRows(input);
  const weekly = input.draft.kind === 'weekly_overview';
  const allSoldOut = events.every((event) => availabilityFor(event) === 'Udsolgt');
  const [imageSource, logoSource] = await Promise.all([
    dataUrl(input.sourceImagePath),
    dataUrl(input.logoPath),
  ]);
  const headline = weekly ? 'NÆSTE UGES GUS' : storyEventName(events[0]).toUpperCase();
  const mood = weekly ? '' : approvedMood(input.draft);
  const experience = weekly ? '' : experienceLine(events[0]);

  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:1080px;height:1920px;background:#171412;font-family:Arial,sans-serif}.story{position:relative;width:1080px;height:1920px;overflow:hidden;color:#fff;background:#1d1713}.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center}.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,8,7,.20) 0%,rgba(10,8,7,.14) 38%,rgba(10,8,7,.82) 68%,rgba(10,8,7,.97) 100%)}.logo{position:absolute;left:76px;top:250px;width:170px;height:170px;object-fit:contain}.eyebrow{position:absolute;right:76px;top:284px;font-size:22px;font-weight:700;letter-spacing:5px;text-transform:uppercase}.content{position:absolute;left:76px;right:76px;bottom:250px}.headline{font-family:Georgia,serif;font-size:72px;line-height:1.02;letter-spacing:-2px;text-transform:uppercase;margin-bottom:18px;max-height:210px;overflow:hidden}.mood{font-family:Georgia,serif;font-size:34px;line-height:1.2;max-width:820px;margin-bottom:12px}.experience{font-size:22px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#f0c98d;margin-bottom:28px}.date{font-size:28px;letter-spacing:4px;text-transform:uppercase;margin-bottom:14px}.time{font-family:Georgia,serif;font-size:61px;font-weight:700;margin-bottom:19px}.instructor{font-size:29px;margin-bottom:26px}.instructor span{display:block;font-size:17px;letter-spacing:4px;color:#e4b16c;margin-bottom:6px}.availability{display:inline-block;background:rgba(29,23,19,.86);color:#fff;border-left:8px solid #e4b16c;border-radius:4px;padding:16px 25px;font-size:29px;font-weight:800;margin-top:7px}.sold-out{border-left-color:#d76a53;color:#fff}.cta{margin-top:34px;border-top:1px solid rgba(255,255,255,.55);padding-top:22px;font-size:21px;font-weight:800;letter-spacing:4px;text-transform:uppercase}.event-row{border-top:1px solid rgba(255,255,255,.38);padding:19px 0 20px;display:grid;grid-template-columns:1fr auto;gap:6px 24px}.event-date{font-size:22px;letter-spacing:2px;text-transform:uppercase}.event-time{font-family:Georgia,serif;font-size:36px;font-weight:700;grid-column:1}.event-availability{font-size:22px;font-weight:800;align-self:end;grid-column:2;grid-row:1 / span 2}.event-availability.sold-out{background:none;color:#ffab97}.weekly .headline{font-size:70px;margin-bottom:24px}
</style></head><body><main id="story-root" class="story ${weekly ? 'weekly' : ''}">
<img class="photo" src="${imageSource}" alt=""><div class="shade"></div><img class="logo" src="${logoSource}" alt="SOMA Sauna Gus"><div class="eyebrow">ET PUSTERUM I VARMEN</div>
<section class="content"><div class="headline" data-fit-check>${escapeHtml(headline)}</div>${mood ? `<div class="mood" data-fit-check>${escapeHtml(mood)}</div>` : ''}${experience ? `<div class="experience" data-fit-check>${escapeHtml(experience)}</div>` : ''}${events.map((event) => eventMarkup(event, weekly)).join('')}${allSoldOut ? '' : '<div class="cta" data-fit-check>BOOK VIA LINKET I BIO</div>'}</section>
</main></body></html>`;
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('Ugyldig JPEG fra Story-render');
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('Kunne ikke verificere Story-billedets dimensioner');
}

async function renderStoryImage(input) {
  validateInput(input);
  const html = await buildStoryHtml(input);
  const renderConfig = config.storyRender;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: renderConfig.width, height: renderConfig.height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const problems = await page.locator('[data-fit-check]').evaluateAll((nodes) => nodes
      .filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 4)
      .map((node) => node.textContent.trim()));
    if (problems.length) throw new Error(`Tekstoverløb i Story: ${problems.join(', ')}`);
    await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
    const buffer = await page.locator('#story-root').screenshot({
      path: input.outputPath,
      type: 'jpeg',
      quality: renderConfig.quality,
    });
    const dimensions = jpegDimensions(buffer);
    if (dimensions.width !== renderConfig.width || dimensions.height !== renderConfig.height) {
      throw new Error(`Forkert Story-format: ${dimensions.width}x${dimensions.height}`);
    }
    const copy = visibleCopy(input);
    return {
      path: input.outputPath,
      width: dimensions.width,
      height: dimensions.height,
      availabilityText: input.draft.kind === 'weekly_overview' ? null : availabilityFor(input.liveEvent),
      copy,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  } finally {
    await browser.close();
  }
}

module.exports = { renderStoryImage, buildStoryHtml, availabilityFor };
