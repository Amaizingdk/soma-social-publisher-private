const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { findDueDrafts, main } = require('../outputs/content-planner/check-due');
const { idempotencyKey } = require('../outputs/content-planner/lib/publish-plan');

const NOW = new Date('2026-10-08T10:05:00Z');

function draft(overrides = {}) {
  return { draftId: 'd-1', revision: 1, status: 'approved', scheduledFor: '2026-10-08T12:00:00+02:00', ...overrides };
}

function ledgerWith(d, statuses) {
  return {
    schemaVersion: 1,
    entries: Object.entries(statuses).map(([deliveryType, status]) => ({
      idempotencyKey: idempotencyKey(d, deliveryType),
      draftId: d.draftId,
      revision: d.revision,
      deliveryType,
      status,
    })),
  };
}

const EMPTY = { schemaVersion: 1, entries: [] };

test('approved draft past its time without ledger entries is due', () => {
  assert.deepEqual(findDueDrafts([draft()], EMPTY, NOW), ['d-1']);
});

test('approved draft before its time is not due', () => {
  assert.deepEqual(findDueDrafts([draft({ scheduledFor: '2026-10-08T12:30:00+02:00' })], EMPTY, NOW), []);
});

test('draft published on both channels is not due', () => {
  const d = draft();
  const ledger = ledgerWith(d, { instagram_story: 'published', facebook_page_feed: 'published' });
  assert.deepEqual(findDueDrafts([d], ledger, NOW), []);
});

test('one channel still missing keeps the draft due', () => {
  const d = draft();
  const ledger = ledgerWith(d, { instagram_story: 'published' });
  assert.deepEqual(findDueDrafts([d], ledger, NOW), ['d-1']);
});

test('a reserved channel keeps the draft due so the publisher can resolve it', () => {
  const d = draft();
  const ledger = ledgerWith(d, { instagram_story: 'published', facebook_page_feed: 'reserved' });
  assert.deepEqual(findDueDrafts([d], ledger, NOW), ['d-1']);
});

test('manual review required does not retrigger the publisher', () => {
  const d = draft();
  const ledger = ledgerWith(d, { instagram_story: 'manual_review_required', facebook_page_feed: 'published' });
  assert.deepEqual(findDueDrafts([d], ledger, NOW), []);
});

test('drafts that are not approved are ignored', () => {
  const drafts = ['draft', 'obsolete', 'published', 'skipped'].map((status) => draft({ status }));
  assert.deepEqual(findDueDrafts(drafts, EMPTY, NOW), []);
});

test('a new revision is due even when an older revision was published', () => {
  const old = draft({ revision: 1 });
  const ledger = ledgerWith(old, { instagram_story: 'published', facebook_page_feed: 'published' });
  assert.deepEqual(findDueDrafts([draft({ revision: 2 })], ledger, NOW), ['d-1']);
});

async function runMain({ drafts, ledger, env = {}, now = NOW }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-due-'));
  await fs.mkdir(path.join(root, 'outputs/content-planner'), { recursive: true });
  await fs.mkdir(path.join(root, 'state'), { recursive: true });
  if (drafts !== undefined) await fs.writeFile(path.join(root, 'outputs/content-planner/drafts.json'), drafts);
  if (ledger !== undefined) await fs.writeFile(path.join(root, 'state/publish-ledger.json'), ledger);
  const output = path.join(root, 'github-output');
  await fs.writeFile(output, '');
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await main({ env: { GITHUB_OUTPUT: output, ...env }, now, root });
    return { result, output: await fs.readFile(output, 'utf8') };
  } finally {
    console.log = originalLog;
  }
}

test('main writes due=false when nothing is waiting', async () => {
  const { result, output } = await runMain({ drafts: JSON.stringify([]), ledger: JSON.stringify(EMPTY) });
  assert.equal(result, false);
  assert.match(output, /^due=false$/m);
});

test('main writes due=true when an approved draft is overdue', async () => {
  const { result, output } = await runMain({ drafts: JSON.stringify([draft()]), ledger: JSON.stringify(EMPTY) });
  assert.equal(result, true);
  assert.match(output, /^due=true$/m);
  assert.match(output, /^count=1$/m);
});

test('main fails open when drafts cannot be read', async () => {
  const { result, output } = await runMain({ ledger: JSON.stringify(EMPTY) });
  assert.equal(result, true);
  assert.match(output, /^due=true$/m);
});

test('an exact draft id always bypasses the pre-check', async () => {
  const { result, output } = await runMain({
    drafts: JSON.stringify([]),
    ledger: JSON.stringify(EMPTY),
    env: { SOMA_DRAFT_ID: 'd-9' },
  });
  assert.equal(result, true);
  assert.match(output, /^due=true$/m);
});
