'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { renderStoryImage, buildStoryHtml } = require('../outputs/content-planner/lib/story-render');

const registry = require('../outputs/content-planner/assets.json');

function approvedDraftFixture(changes = {}) {
  return {
    draftId: 'approved_story_r1',
    revision: 1,
    status: 'approved',
    kind: 'event_day',
    season: 'autumn',
    event: {
      eventKey: '2026-10-01_18-30_saunagus',
      date: '2026-10-01',
      start: '18:30',
      end: '20:30',
      name: 'Saunagus',
      instructor: 'Søren',
    },
    platformCopies: {
      instagram: 'I dag: Fra dagens tempo til ro i kroppen.\n\n1. oktober 2026 · 18.30–20.30\n\n6 ledige pladser.\n\nBook via linket i bio',
    },
    ...changes,
  };
}

function storyInput(outputPath, changes = {}) {
  return {
    draft: approvedDraftFixture(),
    liveEvent: {
      eventKey: '2026-10-01_18-30_saunagus',
      date: '2026-10-01',
      start: '18:30',
      end: '20:30',
      name: 'Saunagus',
      instructor: 'Søren',
      booked: 6,
      capacity: 12,
    },
    sourceImagePath: registry.assets[0].normalizedPath,
    logoPath: registry.logoPath,
    outputPath,
    ...changes,
  };
}

test('renders a 1080x1920 story with live availability and bio CTA', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-story-'));
  const result = await renderStoryImage(storyInput(path.join(dir, 'story.jpg')));
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
  assert.equal(result.availabilityText, '6 ledige pladser');
  assert.match(result.copy, /Book via linket i bio/i);
});

test('renders Udsolgt without a booking CTA', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-story-'));
  const result = await renderStoryImage(storyInput(path.join(dir, 'sold-out.jpg'), {
    liveEvent: {
      ...storyInput('unused').liveEvent,
      booked: 12,
      capacity: 12,
    },
  }));
  assert.equal(result.availabilityText, 'Udsolgt');
  assert.doesNotMatch(result.copy, /Book via/i);
});

test('keeps the approved instructor when the live calendar omits it', async () => {
  const input = storyInput('unused');
  input.liveEvent.instructor = null;
  const html = await buildStoryHtml(input);
  assert.match(html, /GUSMESTER/);
  assert.match(html, /Søren/);
});

test('keeps branding and action text inside 250px Story safe zones', async () => {
  const html = await buildStoryHtml(storyInput('unused'));
  assert.match(html, /\.logo\{[^}]*top:250px/);
  assert.match(html, /\.eyebrow\{[^}]*top:284px/);
  assert.match(html, /\.content\{[^}]*bottom:250px/);
});

test('shows availability as a warm label rather than a fake clickable button', async () => {
  const html = await buildStoryHtml(storyInput('unused'));
  assert.match(html, /data-role="availability-label"/);
  assert.match(html, /\.availability\{[^}]*border-left:8px solid #e4b16c/);
  assert.doesNotMatch(html, /border-radius:999px/);
  assert.doesNotMatch(html, /<button/i);
});

test('replaces generic Saunagus with the weekday-specific Story name', async () => {
  const cases = [
    ['2026-10-06', 'TIRSDAGSGUS'],
    ['2026-10-08', 'TORSDAGSGUS'],
    ['2026-10-11', 'SØNDAGSGUS'],
  ];
  for (const [date, expected] of cases) {
    const input = storyInput('unused');
    input.draft.event.date = date;
    input.liveEvent.date = date;
    const html = await buildStoryHtml(input);
    assert.match(html, new RegExp(`>${expected}<`));
    assert.doesNotMatch(html, />SAUNAGUS</);
  }
});

test('keeps a special Story event name instead of replacing it with a weekday name', async () => {
  const input = storyInput('unused');
  input.draft.event.name = 'MELLEMRUM GUS';
  input.liveEvent.name = 'MELLEMRUM GUS';
  const html = await buildStoryHtml(input);
  assert.match(html, />MELLEMRUM GUS</);
  assert.doesNotMatch(html, />TORSDAGSGUS</);
});

test('adds concise approved mood and weekday experience copy without repeating booking data', async () => {
  const html = await buildStoryHtml(storyInput('unused'));
  assert.match(html, /Fra dagens tempo til ro i kroppen/);
  assert.match(html, /Kort breathwork · fire sanselige runder/);
  assert.equal((html.match(/BOOK VIA LINKET I BIO/g) || []).length, 1);
});

test('weekly overview keeps each live event availability separate', async () => {
  const draft = approvedDraftFixture({
    kind: 'weekly_overview',
    event: null,
    events: [
      { eventKey: 'a', date: '2026-10-06', start: '18:30', end: '20:30', name: 'Saunagus' },
      { eventKey: 'b', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus' },
    ],
  });
  const html = await buildStoryHtml({
    ...storyInput('unused'),
    draft,
    liveEvent: undefined,
    liveEvents: [
      { eventKey: 'a', date: '2026-10-06', start: '18:30', end: '20:30', name: 'Saunagus', booked: 6, capacity: 12 },
      { eventKey: 'b', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus', booked: 12, capacity: 12 },
    ],
  });
  assert.match(html, /6 ledige pladser/);
  assert.match(html, /Udsolgt/);
});
