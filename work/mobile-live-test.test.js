'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  appendGitHubOutput,
  parseArgs,
  runGateCli,
  runReportCli,
} = require('../outputs/content-planner/mobile-live-test');

const REPOSITORY = 'Amaizingdk/soma-social-publisher-private';
const DRAFT_ID = '2026-10-04_16-00_saunagus_day-before_r6';
const CONTENT_REVISION = 'c'.repeat(64);

function draft(overrides = {}) {
  return {
    draftId: DRAFT_ID,
    revision: 6,
    contentRevision: CONTENT_REVISION,
    approvedRevision: CONTENT_REVISION,
    approvedAt: '2026-10-02T12:00:00Z',
    approvedBy: 'Amaizingai',
    status: 'approved',
    scheduledFor: '2026-10-03T19:00:00+02:00',
    githubIssueNumber: 3,
    ...overrides,
};
}

function eventPayload(body = 'PUBLICER STORY', actor = 'Amaizingai') {
  return {
    action: 'created',
    repository: { full_name: REPOSITORY },
    issue: {
      number: 3,
      body: '<!-- soma-draft-id: ' + DRAFT_ID + ' -->\n'
        + '<!-- soma-content-revision: ' + CONTENT_REVISION + ' -->',
    },
    comment: { id: 9001, body },
    sender: { login: actor },
  };
}

async function fixture(t, { event = eventPayload(), drafts = [draft()], entries = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-mobile-live-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, 'event.json');
  const draftsPath = path.join(root, 'drafts.json');
  const ledgerPath = path.join(root, 'publish-ledger.json');
  const outputPath = path.join(root, 'github-output.txt');
  await fs.writeFile(eventPath, JSON.stringify(event), 'utf8');
  await fs.writeFile(draftsPath, JSON.stringify(drafts), 'utf8');
  await fs.writeFile(ledgerPath, JSON.stringify({ schemaVersion: 1, entries }), 'utf8');
  return { root, eventPath, draftsPath, ledgerPath, outputPath };
}

function gateEnv(paths, overrides = {}) {
  return {
    GITHUB_EVENT_PATH: paths.eventPath,
    GITHUB_OUTPUT: paths.outputPath,
    GITHUB_REPOSITORY: REPOSITORY,
    SOMA_APPROVER_LOGIN: 'Amaizingai',
    SOMA_AUTOMATION_ENABLED: 'false',
    ...overrides,
  };
}

function reportEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: REPOSITORY,
    SOMA_DRAFT_ID: DRAFT_ID,
    SOMA_DELIVERY_TYPE: 'instagram_story',
    SOMA_ISSUE_NUMBER: '3',
    SOMA_COMMENT_ID: '9001',
    SOMA_PUBLISH_OUTCOME: 'success',
    ...overrides,
  };
}

test('CLI accepts exactly one gate or report mode', () => {
  assert.deepEqual(parseArgs(['--gate']), { mode: 'gate' });
  assert.deepEqual(parseArgs(['--report']), { mode: 'report' });
  for (const argv of [[], ['--gate', '--report'], ['--publish']]) {
    assert.throws(() => parseArgs(argv), /præcis --gate eller --report/i);
  }
});
test('GitHub output writer rejects unsafe names and multiline values', async (t) => {
  const paths = await fixture(t);
  await assert.rejects(appendGitHubOutput(paths.outputPath, 'bad-name', 'x'), /navn/i);
  await assert.rejects(appendGitHubOutput(paths.outputPath, 'draft_id', 'x\ny'), /én linje/i);
  await appendGitHubOutput(paths.outputPath, 'accepted', 'true');
  assert.equal(await fs.readFile(paths.outputPath, 'utf8'), 'accepted=true\n');
});

test('gate emits only normalized accepted outputs', async (t) => {
  const paths = await fixture(t);
  const written = [];
  const result = await runGateCli({
    env: gateEnv(paths),
    draftsPath: paths.draftsPath,
    ledgerPath: paths.ledgerPath,
    now: new Date('2026-10-03T17:00:00Z'),
    client: { repository: REPOSITORY },
    appendOutputImpl: async (filePath, name, value) => written.push([filePath, name, value]),
    commentOnceImpl: async () => { throw new Error('accepted gate must not comment'); },
  });
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(Object.fromEntries(written.map(([, name, value]) => [name, value])), {
    accepted: 'true',
    draft_id: DRAFT_ID,
    delivery_type: 'instagram_story',
    issue_number: '3',
    comment_id: '9001',
  });
  assert.equal(written.every(([filePath]) => filePath === paths.outputPath), true);
});

test('irrelevant and unauthorized comments stay silent and cannot emit selectors', async (t) => {
  for (const [index, event] of [
    eventPayload('Det ser godt ud'),
    eventPayload('PUBLICER STORY', 'SomeoneElse'),
  ].entries()) {
    const paths = await fixture(t, { event });
    const outputs = [];
    const comments = [];
    const result = await runGateCli({
      env: gateEnv(paths),
      draftsPath: paths.draftsPath,
      ledgerPath: paths.ledgerPath,
      client: { repository: REPOSITORY },
      appendOutputImpl: async (filePath, name, value) => outputs.push([name, value]),
      commentOnceImpl: async (input) => comments.push(input),
    });
    assert.equal(result.accepted, false, 'case ' + index);
    assert.deepEqual(outputs, [['accepted', 'false']]);
    assert.deepEqual(comments, []);
  }
});

test('authorized early command receives one deduplicated safe response', async (t) => {
  const paths = await fixture(t);
  const comments = [];
  const result = await runGateCli({
    env: gateEnv(paths),
    draftsPath: paths.draftsPath,
    ledgerPath: paths.ledgerPath,
    now: new Date('2026-10-03T16:59:59Z'),
    client: { repository: REPOSITORY },
    appendOutputImpl: async () => {},
    commentOnceImpl: async (input) => comments.push(input),
  });
  assert.equal(result.outcome, 'too_early');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].issueNumber, 3);
  assert.equal(comments[0].marker, 'soma-mobile-live-response:9001:too_early');
  assert.match(comments[0].body, /for tidligt/i);
  assert.equal(comments[0].body.includes(DRAFT_ID), false);
});

test('successful report verifies the exact ledger delivery and comments once', async (t) => {
  const paths = await fixture(t, { entries: [{
    idempotencyKey: 'story-key',
    draftId: DRAFT_ID,
    revision: 6,
    deliveryType: 'instagram_story',
    status: 'published',
  }] });
  const comments = [];
  const result = await runReportCli({
    env: reportEnv(),
    draftsPath: paths.draftsPath,
    ledgerPath: paths.ledgerPath,
    client: { repository: REPOSITORY },
    commentOnceImpl: async (input) => comments.push(input),
  });
  assert.equal(result.outcome, 'published');
  assert.equal(comments[0].marker, 'soma-mobile-live-result:9001:instagram_story');
  assert.match(comments[0].body, /Instagram Story er publiceret/);
  assert.match(comments[0].body, /PUBLICER FACEBOOK/);
});

test('successful publish step without matching ledger evidence reports verification failure', async (t) => {
  const paths = await fixture(t);
  const comments = [];
  const result = await runReportCli({
    env: reportEnv(),
    draftsPath: paths.draftsPath,
    ledgerPath: paths.ledgerPath,
    client: { repository: REPOSITORY },
    commentOnceImpl: async (input) => comments.push(input),
  });
  assert.equal(result.outcome, 'verification_failed');
  assert.match(comments[0].body, /ikke sikkert bekræftet/i);
});

test('failed or ambiguous report is generic and never includes environment secrets', async (t) => {
  for (const [publishOutcome, entryStatus] of [
    ['failure', null],
    ['success', 'manual_review_required'],
  ]) {
    const entries = entryStatus ? [{
      idempotencyKey: 'story-key',
      draftId: DRAFT_ID,
      revision: 6,
      deliveryType: 'instagram_story',
      status: entryStatus,
      reason: 'provider said meta-secret-must-not-leak',
    }] : [];
    const paths = await fixture(t, { entries });
    const comments = [];
    const result = await runReportCli({
      env: reportEnv({
        SOMA_PUBLISH_OUTCOME: publishOutcome,
        SOMA_META_ACCESS_TOKEN: 'meta-secret-must-not-leak',
      }),
      draftsPath: paths.draftsPath,
      ledgerPath: paths.ledgerPath,
      client: { repository: REPOSITORY },
      commentOnceImpl: async (input) => comments.push(input),
    });
    assert.equal(result.outcome, entryStatus || 'publish_failed');
    assert.match(comments[0].body, /ikke sikkert bekræftet/i);
    assert.equal(JSON.stringify(comments).includes('meta-secret-must-not-leak'), false);
  }
});

test('Facebook success message never invites another channel command', async (t) => {
  const paths = await fixture(t, { entries: [{
    idempotencyKey: 'facebook-key',
    draftId: DRAFT_ID,
    revision: 6,
    deliveryType: 'facebook_page_feed',
    status: 'published',
  }] });
  const comments = [];
  const result = await runReportCli({
    env: reportEnv({ SOMA_DELIVERY_TYPE: 'facebook_page_feed' }),
    draftsPath: paths.draftsPath,
    ledgerPath: paths.ledgerPath,
    client: { repository: REPOSITORY },
    commentOnceImpl: async (input) => comments.push(input),
  });
  assert.equal(result.outcome, 'published');
  assert.match(comments[0].body, /Facebook-opslaget er publiceret/);
  assert.doesNotMatch(comments[0].body, /PUBLICER STORY|PUBLICER FACEBOOK/);
});

test('report refuses unnormalized selectors before reading state', async () => {
  await assert.rejects(runReportCli({
    env: reportEnv({ SOMA_DRAFT_ID: 'draft=value' }),
    client: { repository: REPOSITORY },
  }), /DRAFT_ID er ugyldigt/);
  await assert.rejects(runReportCli({
    env: reportEnv({ SOMA_DELIVERY_TYPE: 'all' }),
    client: { repository: REPOSITORY },
  }), /DELIVERY_TYPE er ugyldig/);
});
