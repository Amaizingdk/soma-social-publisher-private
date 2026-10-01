'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { runPipeline, importReviewed } = require('../outputs/content-planner/build-content-plan');

const projectRoot = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures', 'calendar-week-42-details.html');

test('fixture pipeline creates reviewable drafts without publishing', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-content-'));
  const result = await runPipeline({ fixturePath, outputDir, now: new Date('2026-09-29T10:00:00Z') });
  const events = JSON.parse(await fs.readFile(path.join(outputDir, 'events.json'), 'utf8'));
  const drafts = JSON.parse(await fs.readFile(path.join(outputDir, 'drafts.json'), 'utf8'));
  const payload = await fs.readFile(path.join(outputDir, 'approval', 'drafts-data.js'), 'utf8');

  assert.equal(result.networkRequests.length, 0);
  assert.ok(events.some((event) => event.date === '2026-10-18' && event.start === '10:00'));
  assert.ok(events.some((event) => event.date === '2026-10-18' && event.start === '16:00'));
  assert.ok(drafts.some((draft) => draft.scheduledFor === '2026-10-18T07:00:00+02:00'));
  assert.ok(drafts.some((draft) => draft.scheduledFor === '2026-10-18T11:30:00+02:00'));
  const mellemrum = drafts.find((draft) => draft.event?.date === '2026-10-18' && draft.event?.start === '10:00');
  assert.match(mellemrum.platformCopies.instagram, /MELLEMRUM GUS med MilleMaja fra Betterlife by Yndigegn/);
  assert.deepEqual(Object.keys(mellemrum.platformCopies).sort(), ['facebookGroup', 'facebookPage', 'instagram']);
  for (const draft of drafts.filter((item) => item.status !== 'obsolete')) {
    assert.equal(draft.render.width, 1080);
    assert.equal(draft.render.height, 1350);
    await fs.access(draft.render.path);
    assert.match(payload, new RegExp(draft.draftId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const serialized = JSON.stringify(drafts).toLowerCase();
  assert.doesNotMatch(serialized, /access[_-]?token|meta[_-]?credential|publishaction|"publish"/);
});

test('review import accepts current revisions and rejects stale fingerprints', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-review-'));
  await runPipeline({ fixturePath, outputDir, now: new Date('2026-09-29T10:00:00Z') });
  const draftsPath = path.join(outputDir, 'drafts.json');
  const current = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
  current[0].status = 'approved';
  current[0].approvedAt = '2026-09-29T12:00:00Z';
  current[0].platformCopies.instagram = 'Godkendt, redigeret tekst';
  const reviewedPath = path.join(outputDir, 'reviewed.json');
  await fs.writeFile(reviewedPath, JSON.stringify(current), 'utf8');

  await importReviewed({ reviewedPath, outputDir });
  const imported = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
  assert.equal(imported[0].platformCopies.instagram, 'Godkendt, redigeret tekst');

  current[0].eventFingerprint = 'stale';
  await fs.writeFile(reviewedPath, JSON.stringify(current), 'utf8');
  await assert.rejects(() => importReviewed({ reviewedPath, outputDir }), /forældet|fremmed/i);
  assert.equal(JSON.parse(await fs.readFile(draftsPath, 'utf8'))[0].eventFingerprint, imported[0].eventFingerprint);
});
