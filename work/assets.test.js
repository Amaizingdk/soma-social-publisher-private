'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateAssetRegistry,
  selectAsset,
} = require('../outputs/content-planner/lib/assets');

function registryWith(tempDir, changes = {}) {
  const sourcePath = path.join(tempDir, 'source.jpg');
  const normalizedPath = path.join(tempDir, 'normalized.jpg');
  const logoPath = path.join(tempDir, 'logo.png');
  fs.writeFileSync(sourcePath, 'source');
  fs.writeFileSync(normalizedPath, 'normalized');
  fs.writeFileSync(logoPath, 'logo');
  return {
    version: 1,
    logoPath,
    assets: [{
      assetId: 'sauna-01', sourcePath, normalizedPath,
      status: 'approved', tags: ['sauna', 'varme'],
      crop45: { x: 0, y: 0, width: 1, height: 1 },
      orientationVerified: true,
      ...changes,
    }],
  };
}

test('valid approved registry passes and selects deterministically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir);
  assert.doesNotThrow(() => validateAssetRegistry(registry));
  const slot = { slotKey: '2026-10-18_event-day' };
  assert.equal(selectAsset(slot, [], registry).assetId, 'sauna-01');
  assert.equal(selectAsset(slot, [], registry).assetId, 'sauna-01');
});

test('selection refuses unapproved assets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir, { status: 'needs_review' });
  assert.throws(() => selectAsset({ slotKey: 'x' }, [], registry), /godkendt billede/i);
});

test('validation rejects crop coordinates outside normalized bounds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir, { crop45: { x: 0.8, y: 0, width: 0.5, height: 1 } });
  assert.throws(() => validateAssetRegistry(registry), /crop/i);
});

test('approved assets require existing source, normalized copy, logo, and verified orientation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir, { orientationVerified: false });
  assert.throws(() => validateAssetRegistry(registry), /orientation/i);
  registry.assets[0].orientationVerified = true;
  fs.rmSync(registry.assets[0].normalizedPath);
  assert.throws(() => validateAssetRegistry(registry), /normalized/i);
  fs.writeFileSync(registry.assets[0].normalizedPath, 'normalized');
  fs.rmSync(registry.logoPath);
  assert.throws(() => validateAssetRegistry(registry), /logo/i);
});

test('asset selection follows the event mood when matching approved tags exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir);
  registry.assets = [
    { ...registry.assets[0], assetId: 'power', tags: ['power'] },
    { ...registry.assets[0], assetId: 'calm', tags: ['calm'] },
    { ...registry.assets[0], assetId: 'sunday', tags: ['sunday'] },
  ];
  const makeEvent = (date, instructor = 'Søren') => ({ eventKey: date, date, instructor });
  assert.equal(selectAsset({ slotKey: 'tue', kind: 'event_day', eventKeys: ['2026-10-13'] }, [makeEvent('2026-10-13')], registry).assetId, 'power');
  assert.equal(selectAsset({ slotKey: 'thu', kind: 'event_day', eventKeys: ['2026-10-15'] }, [makeEvent('2026-10-15')], registry).assetId, 'calm');
  assert.equal(selectAsset({ slotKey: 'sun', kind: 'event_day', eventKeys: ['2026-10-18'] }, [makeEvent('2026-10-18')], registry).assetId, 'sunday');
});

test('winter selection prefers an asset matching both event mood and season', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir);
  registry.assets = [
    { ...registry.assets[0], assetId: 'summer-calm', tags: ['calm', 'summer'] },
    { ...registry.assets[0], assetId: 'winter-calm', tags: ['calm', 'winter'] },
    { ...registry.assets[0], assetId: 'winter-generic', tags: ['winter'] },
  ];
  const event = { eventKey: 'november', date: '2026-11-05', instructor: 'Søren' };
  const slot = { slotKey: 'november-0', kind: 'event_day', eventKeys: ['november'] };
  assert.equal(selectAsset(slot, [event], registry, 'winter').assetId, 'winter-calm');
});

test('selection never returns an excluded asset and fails clearly when nothing else is left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-assets-'));
  const registry = registryWith(dir);
  registry.assets.push({ ...registry.assets[0], assetId: 'sauna-02' });
  const slot = { slotKey: '2026-10-18_event-day' };
  for (const excluded of ['sauna-01', 'sauna-02']) {
    const other = excluded === 'sauna-01' ? 'sauna-02' : 'sauna-01';
    assert.equal(selectAsset(slot, [], registry, null, [excluded]).assetId, other);
  }
  assert.throws(() => selectAsset(slot, [], registry, null, ['sauna-01', 'sauna-02']), /allerede bruges/i);
});

test('siblingAssetIds returns assets of other active slots of the same event, including variants', () => {
  const { siblingAssetIds } = require('../outputs/content-planner/lib/assets');
  const drafts = [
    { draftId: 'a', slotKey: 'e_day-before', eventKey: 'e', status: 'draft', assetId: 'x' },
    { draftId: 'b', slotKey: 'e_event-day', eventKey: 'e', status: 'draft', assetId: 'y', instructorOptions: { soren: { assetId: 'z' } } },
    { draftId: 'c', slotKey: 'e_event-day', eventKey: 'e', status: 'obsolete', assetId: 'old' },
    { draftId: 'd', slotKey: 'f_event-day', eventKey: 'f', status: 'draft', assetId: 'other-event' },
  ];
  assert.deepEqual([...siblingAssetIds(drafts[0], drafts)].sort(), ['y', 'z']);
  assert.deepEqual([...siblingAssetIds(drafts[1], drafts)], ['x']);
  assert.equal(siblingAssetIds({ draftId: 'w', slotKey: 'w', eventKey: null }, drafts).size, 0);
});
