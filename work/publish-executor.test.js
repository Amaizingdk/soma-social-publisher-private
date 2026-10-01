'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { executeAutomaticPlan } = require('../outputs/content-planner/lib/publish-executor');
const { emptyLedger, readLedger, reserve, writeLedgerAtomic } = require('../outputs/content-planner/lib/publish-ledger');

function plan() {
  return {
    mode: 'dry_run',
    automatic: [
      { idempotencyKey: 'instagram-key', draftId: 'd1', revision: 1, platform: 'instagram', deliveryType: 'instagram_story', scheduledFor: '2026-10-01T11:30:00+02:00' },
      { idempotencyKey: 'facebook-key', draftId: 'd1', revision: 1, platform: 'facebookPage', deliveryType: 'facebook_page_feed', scheduledFor: '2026-10-01T11:30:00+02:00' },
    ],
  };
}

test('publishing is locked unless explicitly enabled', async () => {
  await assert.rejects(
    executeAutomaticPlan({ plan: plan(), adapter: { publish: async () => ({}) } }),
    /Publicering er låst/,
  );
});

test('fake adapter records success and makes ambiguous failure manual-only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-executor-'));
  const ledgerPath = path.join(directory, 'publish-ledger.json');
  const calls = [];
  const adapter = {
    publish: async (item) => {
      calls.push(item.idempotencyKey);
      if (item.idempotencyKey === 'facebook-key') throw new Error('simulated provider failure');
      return { providerId: 'fake-instagram-1' };
    },
  };
  const now = new Date('2026-09-30T10:00:00Z');
  const first = await executeAutomaticPlan({ plan: plan(), ledgerPath, adapter, allowPublish: true, now });
  assert.deepEqual(first.results.map((result) => result.status), ['published', 'manual_review_required']);
  assert.deepEqual(calls, ['instagram-key', 'facebook-key']);

  const second = await executeAutomaticPlan({ plan: plan(), ledgerPath, adapter, allowPublish: true, now });
  assert.deepEqual(second.results.map((result) => result.status), ['already_published', 'manual_review_required']);
  assert.deepEqual(calls, ['instagram-key', 'facebook-key']);
  assert.equal((await readLedger(ledgerPath)).entries.length, 2);
});

test('persists reserved before calling Meta and published after it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-executor-'));
  const ledgerPath = path.join(directory, 'publish-ledger.json');
  const order = [];
  await executeAutomaticPlan({
    plan: { mode: 'dry_run', automatic: [plan().automatic[0]] },
    ledgerPath,
    adapter: { publish: async () => { order.push('meta'); return { providerId: 'm1' }; } },
    allowPublish: true,
    persistState: async ({ phase }) => order.push(`persist:${phase}`),
  });
  assert.deepEqual(order, ['persist:reserved', 'meta', 'persist:published']);
});

test('an existing reserved item becomes manual review without another Meta call', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-executor-'));
  const ledgerPath = path.join(directory, 'publish-ledger.json');
  const ledger = emptyLedger();
  reserve(ledger, plan().automatic[0], new Date('2026-09-30T10:00:00Z'));
  await writeLedgerAtomic(ledgerPath, ledger);
  let metaCalls = 0;

  const result = await executeAutomaticPlan({
    plan: { mode: 'dry_run', automatic: [plan().automatic[0]] },
    ledgerPath,
    adapter: { publish: async () => { metaCalls += 1; return { providerId: 'unexpected' }; } },
    allowPublish: true,
    persistState: async () => {},
  });

  assert.equal(metaCalls, 0);
  assert.equal(result.results[0].status, 'manual_review_required');
  assert.equal((await readLedger(ledgerPath)).entries[0].status, 'manual_review_required');
});

test('a persistence failure before Meta aborts without calling Meta', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-executor-'));
  const ledgerPath = path.join(directory, 'publish-ledger.json');
  let metaCalls = 0;

  await assert.rejects(executeAutomaticPlan({
    plan: { mode: 'dry_run', automatic: [plan().automatic[0]] },
    ledgerPath,
    adapter: { publish: async () => { metaCalls += 1; return { providerId: 'unexpected' }; } },
    allowPublish: true,
    persistState: async () => { throw new Error('push failed'); },
  }), /push failed/);
  assert.equal(metaCalls, 0);
});

test('every result contains the safe summary contract', async () => {
  const result = await executeAutomaticPlan({
    plan: { mode: 'dry_run', automatic: [plan().automatic[0]] },
    adapter: { publish: async () => ({ providerId: 'm1' }) },
    allowPublish: true,
  });
  assert.deepEqual(Object.keys(result.results[0]).slice(0, 5), [
    'draftId',
    'idempotencyKey',
    'deliveryType',
    'status',
    'reason',
  ]);
});

test('manual group items are not executed because only automatic plan items are accepted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-executor-'));
  const ledgerPath = path.join(directory, 'publish-ledger.json');
  const calls = [];
  const result = await executeAutomaticPlan({
    plan: { mode: 'dry_run', automatic: [], manual: [{ idempotencyKey: 'group-key', platform: 'facebookGroup' }] },
    ledgerPath,
    adapter: { publish: async (item) => { calls.push(item); return {}; } },
    allowPublish: true,
  });
  assert.deepEqual(result.results, []);
  assert.deepEqual(calls, []);
});
