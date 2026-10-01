'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  emptyLedger,
  readLedger,
  writeLedgerAtomic,
  reserve,
  markPublished,
  markManualReviewRequired,
} = require('../outputs/content-planner/lib/publish-ledger');

function item(key = 'key-1') {
  return { idempotencyKey: key, draftId: 'draft-1', revision: 2, platform: 'instagram', deliveryType: 'instagram_story', scheduledFor: '2026-10-01T11:30:00+02:00' };
}

test('missing ledger is treated as an empty ledger', async () => {
  const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'soma-ledger-')), 'publish-ledger.json');
  assert.deepEqual(await readLedger(filePath), emptyLedger());
});

test('reserve is idempotent and does not duplicate an entry', () => {
  const ledger = emptyLedger();
  const first = reserve(ledger, item());
  const second = reserve(ledger, item());
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(ledger.entries.length, 1);
  assert.equal(second.entry.status, 'reserved');
  assert.equal(second.entry.deliveryType, 'instagram_story');
});

test('ledger status can move from reserved to published or manual review', () => {
  const ledger = emptyLedger();
  reserve(ledger, item('published-key'));
  reserve(ledger, item('manual-key'));
  assert.equal(markPublished(ledger, 'published-key', 'meta-123').status, 'published');
  assert.equal(markManualReviewRequired(ledger, 'manual-key', 'safe reason').status, 'manual_review_required');
  assert.equal(ledger.entries[0].providerId, 'meta-123');
  assert.equal(ledger.entries[1].reason, 'safe reason');
});

test('ledger rejects the retired failed status', () => {
  const ledger = emptyLedger();
  reserve(ledger, item());
  ledger.entries[0].status = 'failed';
  assert.throws(() => markPublished(ledger, 'key-1', 'meta-123'), /ugyldig status/);
});

test('ledger writes atomically as newline-terminated JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-ledger-'));
  const filePath = path.join(directory, 'publish-ledger.json');
  const ledger = emptyLedger();
  reserve(ledger, item());
  await writeLedgerAtomic(filePath, ledger);
  const raw = await fs.readFile(filePath, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.deepEqual(await readLedger(filePath), ledger);
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.includes('.tmp-')), []);
});

test('invalid ledger is rejected instead of being overwritten', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-ledger-'));
  const filePath = path.join(directory, 'publish-ledger.json');
  await fs.writeFile(filePath, '{"schemaVersion":99,"entries":[]}\n', 'utf8');
  await assert.rejects(readLedger(filePath), /ukendt format/);
});
