'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildFreshTestPlan } = require('../outputs/content-planner/publish-meta-test');

async function approvedDraft() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-live-test-'));
  const imagePath = path.join(directory, 'approved.jpg');
  await fs.writeFile(imagePath, 'fixture');
  return {
    draftId: 'event-1_day-before_r1',
    eventKey: 'event-1',
    revision: 1,
    status: 'approved',
    approvedAt: '2026-09-30T07:00:00Z',
    scheduledFor: '2026-10-01T11:30:00+02:00',
    warnings: [],
    warningsAcknowledged: false,
    platformCopies: { facebookPage: '8 ledige pladser.', instagram: '8 ledige pladser.', facebookGroup: '8 ledige pladser.' },
    event: { eventKey: 'event-1', date: '2026-10-01', start: '18:30', end: '20:30', name: 'Saunagus', booked: 4, capacity: 12 },
    render: { path: imagePath, width: 1080, height: 1350 },
  };
}

test('live Meta test refuses to build without fresh calendar events', async () => {
  const draft = await approvedDraft();
  await assert.rejects(
    buildFreshTestPlan({ drafts: [draft], liveEvents: null, config: {}, now: new Date('2026-09-30T09:00:00Z') }),
    /frisk kalender/i,
  );
});

test('live Meta test replaces approved availability with the fresh calendar value', async () => {
  const draft = await approvedDraft();
  const plan = await buildFreshTestPlan({
    drafts: [draft],
    liveEvents: [{ eventKey: 'event-1', date: '2026-10-01', start: '18:30', end: '20:30', name: 'Saunagus', booked: 6, capacity: 12, readAt: '2026-09-30T09:00:00Z' }],
    config: { assetHosting: { baseUrl: 'https://example.com' } },
    now: new Date('2026-09-30T09:00:00Z'),
  });
  assert.match(plan.automatic.find((item) => item.platform === 'instagram').caption, /6 ledige pladser/);
});
