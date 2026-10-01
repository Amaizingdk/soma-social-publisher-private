'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, runCli, runDueContent } = require('../outputs/content-planner/publish-due-content');

function deliveryPlan(items, blocked = []) {
  return { mode: 'dry_run', automatic: items, manual: [], blocked, summary: {} };
}

function storyItem() {
  return {
    deliveryType: 'instagram_story',
    idempotencyKey: 'story-key',
    draftId: 'd1',
    revision: 1,
    eventKey: 'event-1',
    scheduledFor: '2026-09-30T10:00:00Z',
    imagePath: 'old-facebook-render.jpg',
    assetPath: 'approved/d1-r1-story.jpg',
    imageUrl: 'https://old.invalid/story.jpg',
  };
}

test('reads live calendar before rendering, upload, or Meta write', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-due-'));
  const order = [];
  const result = await runDueContent({
    publish: true,
    now: new Date('2026-09-30T12:00:00Z'),
    drafts: [{ draftId: 'd1', status: 'approved', eventKey: 'event-1' }],
    config: { weeksAhead: 4 },
    ledgerPath: path.join(directory, 'ledger.json'),
    liveEventReader: async () => { order.push('calendar'); return [{ eventKey: 'event-1', booked: 6, capacity: 12 }]; },
    planBuilder: async () => deliveryPlan([storyItem()]),
    storyRenderer: async () => { order.push('render'); return { path: 'story.jpg', width: 1080, height: 1920 }; },
    assetUploader: async () => { order.push('upload'); return { publicUrl: 'https://example.com/story.jpg' }; },
    metaAdapter: {
      preflight: async () => { order.push('preflight'); return { status: 'passed' }; },
      publish: async () => { order.push('publish'); return { providerId: 'story-1' }; },
    },
    persistState: async ({ phase }) => { order.push(`persist:${phase}`); },
  });
  assert.deepEqual(order, [
    'calendar',
    'render',
    'upload',
    'preflight',
    'persist:reserved',
    'publish',
    'persist:published',
  ]);
  assert.equal(result.results[0].status, 'published');
});

test('calendar or blocked-plan failures stop before rendering and publishing', async () => {
  let sideEffect = false;
  const common = {
    publish: true,
    drafts: [],
    config: { weeksAhead: 4 },
    storyRenderer: async () => { sideEffect = true; },
    assetUploader: async () => { sideEffect = true; },
    metaAdapter: { preflight: async () => { sideEffect = true; }, publish: async () => { sideEffect = true; } },
  };
  await assert.rejects(
    runDueContent({ ...common, liveEventReader: async () => { throw new Error('calendar unavailable'); } }),
    /calendar unavailable/,
  );
  await assert.rejects(
    runDueContent({
      ...common,
      liveEventReader: async () => [{ eventKey: 'event-1' }],
      planBuilder: async () => deliveryPlan([], [{ reason: 'stale' }]),
    }),
    /blokerede/i,
  );
  assert.equal(sideEffect, false);
});

test('retries one transient all-EVENT_NOT_FOUND calendar snapshot before selecting due content', async () => {
  let calendarReads = 0;
  let planBuilds = 0;
  const result = await runDueContent({
    now: new Date('2026-09-30T12:00:00Z'),
    drafts: [{ draftId: 'd1', status: 'approved', eventKey: 'event-1' }],
    config: { weeksAhead: 4 },
    liveEventReader: async () => {
      calendarReads += 1;
      return [{ eventKey: 'event-1', booked: 6, capacity: 12 }];
    },
    planBuilder: async () => {
      planBuilds += 1;
      return planBuilds === 1
        ? deliveryPlan([], [{ draftId: 'd1', revision: 1, reasons: ['EVENT_NOT_FOUND'] }])
        : deliveryPlan([storyItem()]);
    },
  });
  assert.equal(calendarReads, 2);
  assert.equal(planBuilds, 2);
  assert.deepEqual(result.due.map((item) => item.draftId), ['d1']);
});

test('persistent EVENT_NOT_FOUND failures stop after exactly one retry', async () => {
  let calendarReads = 0;
  await assert.rejects(runDueContent({
    drafts: [{ draftId: 'd1', status: 'approved', eventKey: 'event-1' }],
    config: { weeksAhead: 4 },
    liveEventReader: async () => {
      calendarReads += 1;
      return [{ eventKey: 'event-2', booked: 4, capacity: 12 }];
    },
    planBuilder: async () => deliveryPlan([], [
      { draftId: 'd1', revision: 1, reasons: ['EVENT_NOT_FOUND'] },
    ]),
  }), /blokerede 1 godkendte kladder/i);
  assert.equal(calendarReads, 2);
});

test('calendar validation failures other than EVENT_NOT_FOUND are not retried', async () => {
  let calendarReads = 0;
  await assert.rejects(runDueContent({
    drafts: [{ draftId: 'd1', status: 'approved', eventKey: 'event-1' }],
    config: { weeksAhead: 4 },
    liveEventReader: async () => {
      calendarReads += 1;
      return [{ eventKey: 'event-1', booked: 6, capacity: 12 }];
    },
    planBuilder: async () => deliveryPlan([], [
      { draftId: 'd1', revision: 1, reasons: ['STALE_CALENDAR'] },
    ]),
  }), /blokerede 1 godkendte kladder/i);
  assert.equal(calendarReads, 1);
});

test('a retry skips the published Story and blocks the ambiguous Facebook delivery', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-due-'));
  const ledgerPath = path.join(directory, 'ledger.json');
  const facebook = {
    ...storyItem(),
    deliveryType: 'facebook_page_feed',
    idempotencyKey: 'facebook-key',
    assetPath: 'approved/d1-r1-facebook.jpg',
    caption: '6 ledige pladser',
  };
  const calls = [];
  const options = {
    publish: true,
    now: new Date('2026-09-30T12:00:00Z'),
    drafts: [{ draftId: 'd1', status: 'approved', eventKey: 'event-1' }],
    config: { weeksAhead: 4 },
    ledgerPath,
    liveEventReader: async () => [{ eventKey: 'event-1', booked: 6, capacity: 12 }],
    planBuilder: async () => deliveryPlan([storyItem(), facebook]),
    storyRenderer: async () => ({ path: 'story.jpg' }),
    assetUploader: async ({ item }) => ({ publicUrl: `https://example.com/${item.deliveryType}.jpg` }),
    metaAdapter: {
      preflight: async () => ({ status: 'passed' }),
      publish: async (item) => {
        calls.push(item.deliveryType);
        if (item.deliveryType === 'facebook_page_feed') throw new Error('temporary Facebook error');
        return { providerId: 'story-1' };
      },
    },
  };
  const first = await runDueContent(options);
  const second = await runDueContent(options);
  assert.deepEqual(first.results.map((item) => item.status), ['published', 'manual_review_required']);
  assert.deepEqual(second.results.map((item) => item.status), ['already_published', 'manual_review_required']);
  assert.deepEqual(calls, ['instagram_story', 'facebook_page_feed']);
});

test('default mode is a dry run and performs no render, upload, or Meta write', async () => {
  const effects = [];
  const result = await runDueContent({
    drafts: [],
    config: { weeksAhead: 4 },
    liveEventReader: async () => [{ eventKey: 'event-1' }],
    planBuilder: async () => deliveryPlan([storyItem()]),
    storyRenderer: async () => { effects.push('render'); },
    assetUploader: async () => { effects.push('upload'); },
    metaAdapter: { preflight: async () => { effects.push('preflight'); }, publish: async () => { effects.push('meta'); } },
  });
  assert.equal(result.mode, 'dry_run');
  assert.deepEqual(effects, []);
});

test('controlled live test selects one exact Instagram Story when two drafts are due', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-due-'));
  const called = [];
  const secondStory = {
    ...storyItem(),
    idempotencyKey: 'second-story-key',
    draftId: 'd2',
    eventKey: 'event-2',
    assetPath: 'approved/d2-r1-story.jpg',
  };
  const facebook = {
    ...storyItem(),
    deliveryType: 'facebook_page_feed',
    idempotencyKey: 'facebook-key',
    assetPath: 'approved/d1-r1-facebook.jpg',
    caption: '6 ledige pladser',
  };
  await runDueContent({
    publish: true,
    deliveryTypes: ['instagram_story'],
    draftId: 'd1',
    now: new Date('2026-09-30T12:00:00Z'),
    drafts: [
      { draftId: 'd1', status: 'approved', eventKey: 'event-1' },
      { draftId: 'd2', status: 'approved', eventKey: 'event-2' },
    ],
    config: { weeksAhead: 4 },
    ledgerPath: path.join(directory, 'ledger.json'),
    liveEventReader: async () => [
      { eventKey: 'event-1', booked: 6, capacity: 12 },
      { eventKey: 'event-2', booked: 4, capacity: 12 },
    ],
    planBuilder: async () => deliveryPlan([storyItem(), secondStory, facebook]),
    storyRenderer: async () => ({ path: 'story.jpg' }),
    assetUploader: async ({ item }) => ({ publicUrl: `https://example.com/${item.deliveryType}.jpg` }),
    metaAdapter: {
      preflight: async () => ({ status: 'passed' }),
      publish: async (item) => { called.push(`${item.draftId}:${item.deliveryType}`); return { providerId: 'story-1' }; },
    },
  });
  assert.deepEqual(called, ['d1:instagram_story']);
});

test('an exact draft selection validates only the selected draft', async () => {
  let plannedDraftIds;
  const result = await runDueContent({
    draftId: 'd1',
    now: new Date('2026-09-30T12:00:00Z'),
    drafts: [
      { draftId: 'd1', status: 'approved', eventKey: 'event-1' },
      { draftId: 'd2', status: 'approved', eventKey: 'event-2' },
    ],
    config: { weeksAhead: 4 },
    liveEventReader: async () => [{ eventKey: 'event-1', booked: 6, capacity: 12 }],
    planBuilder: async (selectedDrafts) => {
      plannedDraftIds = selectedDrafts.map((draft) => draft.draftId);
      return deliveryPlan(
        [storyItem()],
        selectedDrafts.some((draft) => draft.draftId === 'd2')
          ? [{ draftId: 'd2', revision: 1, reasons: ['EVENT_NOT_FOUND'] }]
          : [],
      );
    },
  });
  assert.deepEqual(plannedDraftIds, ['d1']);
  assert.deepEqual(result.due.map((item) => item.draftId), ['d1']);
});

test('an exact draft selection fails closed when the draft is not due', async () => {
  await assert.rejects(runDueContent({
    draftId: 'missing-draft',
    now: new Date('2026-09-30T12:00:00Z'),
    drafts: [{ draftId: 'd1', status: 'approved', eventKey: 'event-1' }],
    config: { weeksAhead: 4 },
    liveEventReader: async () => [{ eventKey: 'event-1', booked: 6, capacity: 12 }],
    planBuilder: async () => deliveryPlan([storyItem()]),
  }), /valgte kladde.*ikke forfalden/i);
});

test('publish refuses to run unless PUBLISH_ENABLED is exactly true', async () => {
  await assert.rejects(runCli({
    argv: ['--publish'],
    env: {
      PUBLISH_ENABLED: 'false',
      SOMA_META_ACCESS_TOKEN: 'meta-secret',
      SOMA_ASSET_REPO_TOKEN: 'asset-secret',
    },
    stdout: () => {},
    stderr: () => {},
    dependencies: { runDueContent: async () => ({ results: [] }), writeSummary: async () => {} },
  }), /deaktiveret/i);
});

test('publish requires separate Meta and asset secrets and rejects the retired token name', async () => {
  const common = {
    argv: ['--publish'],
    stdout: () => {},
    stderr: () => {},
    dependencies: { runDueContent: async () => ({ results: [] }), writeSummary: async () => {} },
  };
  await assert.rejects(runCli({
    ...common,
    env: { PUBLISH_ENABLED: 'true', SOMA_GITHUB_TOKEN: 'old-secret', SOMA_META_ACCESS_TOKEN: 'meta-secret' },
  }), /SOMA_ASSET_REPO_TOKEN/);
  await assert.rejects(runCli({
    ...common,
    env: { PUBLISH_ENABLED: 'true', SOMA_ASSET_REPO_TOKEN: 'asset-secret' },
  }), /SOMA_META_ACCESS_TOKEN/);
});

test('CLI accepts only dry-run or publish and the two automatic delivery types', () => {
  assert.deepEqual(parseArgs([]), { publish: false, deliveryTypes: null, draftId: null });
  assert.deepEqual(parseArgs(['--dry-run']), { publish: false, deliveryTypes: null, draftId: null });
  assert.deepEqual(parseArgs(['--publish', '--delivery-type', 'instagram_story']), {
    publish: true,
    deliveryTypes: ['instagram_story'],
    draftId: null,
  });
  assert.throws(() => parseArgs(['--dry-run', '--publish']), /gensidigt udelukkende/i);
  assert.throws(() => parseArgs(['--delivery-type', 'instagram_feed']), /leveringstype/i);
});

test('CLI accepts one exact draft id and forwards it to the runtime', async () => {
  assert.deepEqual(parseArgs(['--dry-run', '--draft-id', 'd1']), {
    publish: false,
    deliveryTypes: null,
    draftId: 'd1',
  });
  assert.throws(() => parseArgs(['--draft-id']), /draft-id.*værdi/i);
  assert.throws(() => parseArgs(['--draft-id', 'd1', '--draft-id', 'd2']), /draft-id.*én gang/i);

  let captured;
  await runCli({
    argv: ['--dry-run', '--draft-id', 'd1'],
    env: {},
    stdout: () => {},
    stderr: () => {},
    dependencies: {
      runDueContent: async (options) => {
        captured = options;
        return { mode: 'dry_run', due: [], results: [] };
      },
      writeSummary: async () => {},
    },
  });
  assert.equal(captured.draftId, 'd1');
});

test('CLI writes only a sanitized summary and prints no secrets', async () => {
  const output = [];
  let written;
  const token = 'meta-secret-value';
  const result = await runCli({
    argv: ['--publish', '--delivery-type', 'facebook_page_feed'],
    env: {
      PUBLISH_ENABLED: 'true',
      SOMA_META_ACCESS_TOKEN: token,
      SOMA_ASSET_REPO_TOKEN: 'asset-secret-value',
      GITHUB_RUN_ID: '42',
    },
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    dependencies: {
      runDueContent: async (options) => {
        assert.deepEqual(options.deliveryTypes, ['facebook_page_feed']);
        return { results: [{
          draftId: 'd1',
          idempotencyKey: 'k1',
          deliveryType: 'facebook_page_feed',
          status: 'manual_review_required',
          reason: `unsafe ${token}`,
          rawResponse: token,
        }] };
      },
      writeSummary: async (summary) => { written = summary; },
    },
  });
  assert.equal(result.results[0].status, 'manual_review_required');
  assert.equal(JSON.stringify(written).includes(token), false);
  assert.equal(output.join('\n').includes(token), false);
});

test('GitHub publish mode injects the durable Git state store and repository ledger', async () => {
  let captured;
  const persist = async () => {};
  const repoDir = path.join(os.tmpdir(), 'soma-private-runtime');
  await runCli({
    argv: ['--publish'],
    env: {
      PUBLISH_ENABLED: 'true',
      SOMA_META_ACCESS_TOKEN: 'meta-secret',
      SOMA_ASSET_REPO_TOKEN: 'asset-secret',
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_ID: '42',
    },
    stdout: () => {},
    stderr: () => {},
    dependencies: {
      createGitStateStore: (options) => {
        assert.equal(options.ledgerPath, 'state/publish-ledger.json');
        assert.equal(options.runId, '42');
        return { persist };
      },
      runDueContent: async (options) => { captured = options; return { results: [] }; },
      writeSummary: async () => {},
      repoDir,
    },
  });
  assert.equal(captured.persistState, persist);
  assert.equal(captured.ledgerPath, path.join(repoDir, 'state', 'publish-ledger.json'));
});
