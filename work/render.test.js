'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const {
  buildRenderHtml,
  renderDraftImage,
} = require('../outputs/content-planner/lib/render');

const projectRoot = path.join(__dirname, '..');
const registry = require('../outputs/content-planner/assets.json');
const config = require('../outputs/content-planner/config.json');

function jpegSize(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('Invalid JPEG marker');
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG dimensions not found');
}

function draftInput(changes = {}) {
  return {
    asset: registry.assets[0],
    logoPath: registry.logoPath,
    copy: {
      headline: 'MELLEMRUM GUS',
      imageLines: {
        headline: 'MELLEMRUM GUS',
        date: '18. oktober 2026',
        time: '10.00–12.00',
        instructorLabel: 'GUSMESTER',
        instructorName: 'MilleMaja',
      },
    },
    slot: { slotKey: '2026-10-18_10-00_saunagus_event-day', kind: 'event_day' },
    event: { eventKey: '2026-10-18_10-00_saunagus', booked: 1, capacity: 12 },
    config,
    ...changes,
  };
}

test('buildRenderHtml contains correct facts and no exact occupancy', async () => {
  const html = await buildRenderHtml(draftInput());
  assert.match(html, /data-field="time"[^>]*>10\.00–12\.00/);
  assert.match(html, /data-field="logo"/);
  assert.match(html, /data-transform="none"/);
  assert.doesNotMatch(html, /1\s*\/\s*12/);
  assert.doesNotMatch(html, /SOMA SAUNA GUS/);
  assert.doesNotMatch(html, /BOOK ONLINE/);
  assert.match(html, /data-field="instructor-label"[^>]*>GUSMESTER/);
  assert.match(html, /data-field="instructor-name"[^>]*>MilleMaja/);
});

test('renderDraftImage creates a deterministic 1080 by 1350 JPEG', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-render-'));
  const first = path.join(dir, 'first.jpg');
  const second = path.join(dir, 'second.jpg');
  const browser = await chromium.launch({ headless: true });
  try {
    const one = await renderDraftImage(browser, draftInput(), first);
    const two = await renderDraftImage(browser, draftInput(), second);
    assert.deepEqual(jpegSize(await fs.readFile(first)), { width: 1080, height: 1350 });
    assert.equal(one.width, 1080);
    assert.equal(one.height, 1350);
    assert.equal(one.sha256, two.sha256);
  } finally {
    await browser.close();
  }
});

test('render rejects an unapproved or missing asset before screenshot', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    await assert.rejects(
      renderDraftImage(browser, draftInput({ asset: { ...registry.assets[0], status: 'needs_review' } }), path.join(projectRoot, 'work', 'bad.jpg')),
      /approved|godkendt/i,
    );
  } finally {
    await browser.close();
  }
});

test('render rejects overflowing approved text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-render-'));
  const input = draftInput();
  input.copy.imageLines.headline = 'ALT FOR LANG '.repeat(80);
  const browser = await chromium.launch({ headless: true });
  try {
    await assert.rejects(
      renderDraftImage(browser, input, path.join(dir, 'overflow.jpg')),
      /overløb/i,
    );
  } finally {
    await browser.close();
  }
});

test('winter render changes the seasonal invitation and visual treatment', async () => {
  const winter = await buildRenderHtml({ ...draftInput(), season: 'winter' });
  const autumn = await buildRenderHtml({ ...draftInput(), season: 'autumn' });
  assert.match(winter, /KOM IND I VARMEN/);
  assert.doesNotMatch(autumn, /KOM IND I VARMEN/);
  assert.notEqual(winter, autumn);
});
