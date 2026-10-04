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
  assert.ok(drafts.some((draft) => draft.scheduledFor === '2026-10-18T09:30:00+02:00'));
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

test('planner retains an upcoming event when its preferred publish time has just passed', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-late-content-'));
  const now = new Date('2026-10-17T17:01:00Z');
  await runPipeline({ fixturePath, outputDir, now, runtimeRoot: outputDir });
  const drafts = JSON.parse(await fs.readFile(path.join(outputDir, 'drafts.json'), 'utf8'));
  const late = drafts.find((draft) => (
    draft.event?.date === '2026-10-18'
    && Date.parse(draft.scheduledFor) < now.getTime()
  ));
  assert.ok(late);
  assert.notEqual(late.status, 'obsolete');
  assert.match(late.render.path, /^renders\//);
  assert.equal(path.isAbsolute(late.render.path), false);
  await fs.access(path.join(outputDir, late.render.path));
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

test('two posts about the same event never get the same image, in base or instructor variants', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-unique-'));
  await runPipeline({ fixturePath, outputDir, now: new Date('2026-09-29T10:00:00Z') });
  const drafts = JSON.parse(await fs.readFile(path.join(outputDir, 'drafts.json'), 'utf8'))
    .filter((draft) => draft.status !== 'obsolete' && draft.eventKey);
  const byEvent = new Map();
  for (const draft of drafts) byEvent.set(draft.eventKey, [...(byEvent.get(draft.eventKey) || []), draft]);
  let pairs = 0;
  for (const [, posts] of byEvent) {
    if (posts.length < 2) continue;
    pairs += 1;
    assert.equal(new Set(posts.map((post) => post.assetId)).size, posts.length);
    for (const key of ['soren', 'millemaja']) {
      const variants = posts.map((post) => post.instructorOptions?.[key]?.assetId).filter(Boolean);
      assert.equal(new Set(variants).size, variants.length);
    }
  }
  assert.ok(pairs > 0);
});

test('approved posts keep their image even when two siblings share it', async () => {
  const { fingerprintForContent } = require('../outputs/content-planner/lib/content-fingerprint');
  const { contentRevisionFor } = require('../outputs/content-planner/lib/draft-lifecycle');
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-pinned-'));
  const now = new Date('2026-09-29T10:00:00Z');
  await runPipeline({ fixturePath, outputDir, now });
  const draftsPath = path.join(outputDir, 'drafts.json');
  const drafts = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
  const active = drafts.filter((draft) => draft.status !== 'obsolete');
  const dayBefore = active.find((draft) => draft.slotKey.endsWith('_day-before') && !draft.instructorOptions
    && active.some((other) => other.slotKey === draft.slotKey.replace('_day-before', '_event-day') && !other.instructorOptions));
  assert.ok(dayBefore, 'fixture mangler et par uden gusmester-varianter');
  const eventDay = active.find((draft) => draft.slotKey === dayBefore.slotKey.replace('_day-before', '_event-day'));
  // Ældre, allerede godkendte opslag, der deler billede (før reglen fandtes).
  for (const draft of [dayBefore, eventDay]) {
    draft.assetId = dayBefore.assetId;
    draft.contentFingerprint = fingerprintForContent({
      platformCopies: {
        instagram: draft.platformCopies.instagram,
        facebookPage: draft.platformCopies.facebookPage,
        facebookGroup: draft.platformCopies.facebookGroup,
      },
      assetId: draft.assetId, season: draft.season, warnings: draft.warnings, instructorOptions: undefined,
    });
    draft.contentRevision = contentRevisionFor(draft);
    draft.status = 'approved';
    draft.approvedRevision = draft.contentRevision;
    draft.approvedAt = '2026-09-29T09:00:00Z';
  }
  await fs.writeFile(draftsPath, JSON.stringify(drafts), 'utf8');

  await runPipeline({ fixturePath, outputDir, now });
  const after = JSON.parse(await fs.readFile(draftsPath, 'utf8')).filter((draft) => draft.status !== 'obsolete');
  for (const before of [dayBefore, eventDay]) {
    const kept = after.find((draft) => draft.slotKey === before.slotKey);
    assert.equal(kept.draftId, before.draftId);
    assert.equal(kept.status, 'approved');
    assert.equal(kept.assetId, dayBefore.assetId);
  }
});
