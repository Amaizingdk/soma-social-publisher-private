'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateMobileLiveCommand,
  isPublishedDelivery,
  parseMobileLiveCommand,
} = require('../outputs/content-planner/lib/mobile-live-command');

const REPOSITORY = 'Amaizingdk/soma-social-publisher-private';
const DRAFT_ID = '2026-10-04_16-00_saunagus_day-before_r6';
const REVISION = 'b'.repeat(64);

function approvedDraft(overrides = {}) {
  return {
    draftId: DRAFT_ID,
    revision: 6,
    contentRevision: REVISION,
    approvedRevision: REVISION,
    approvedAt: '2026-10-02T12:00:00Z',
    approvedBy: 'Amaizingai',
    status: 'approved',
    scheduledFor: '2026-10-03T19:00:00+02:00',
    githubIssueNumber: 3,
    ...overrides,
};
}

function issueBody(draftId = DRAFT_ID, revision = REVISION) {
  return '<!-- soma-draft-id: ' + draftId + ' -->\n'
    + '<!-- soma-content-revision: ' + revision + ' -->';
}

function payload({
  body = 'PUBLICER STORY',
  actor = 'Amaizingai',
  repository = REPOSITORY,
  number = 3,
  markers = issueBody(),
  pullRequest = false,
} = {}) {
  return {
    action: 'created',
    repository: { full_name: repository },
    issue: {
      number,
      body: markers,
      ...(pullRequest ? { pull_request: {} } : {}),
    },
    comment: { id: 9001, body },
    sender: { login: actor },
  };
}

function evaluate(overrides = {}) {
  return evaluateMobileLiveCommand({
    payload: payload(),
    drafts: [approvedDraft()],
    ledger: { schemaVersion: 1, entries: [] },
    approverLogin: 'Amaizingai',
    automationEnabled: 'false',
    now: new Date('2026-10-03T17:00:00Z'),
    ...overrides,
  });
}

test('parser accepts only the two trimmed exact commands', () => {
  assert.deepEqual(parseMobileLiveCommand('  PUBLICER STORY  '), {
    command: 'PUBLICER STORY',
    deliveryType: 'instagram_story',
  });
  assert.deepEqual(parseMobileLiveCommand('PUBLICER FACEBOOK'), {
    command: 'PUBLICER FACEBOOK',
    deliveryType: 'facebook_page_feed',
  });
  for (const value of [
    'PUBLICER STORY nu',
    'publicer story',
    'PUBLICER STORY\nPUBLICER FACEBOOK',
    'PUBLICER  STORY',
    'PUBLICER ST0RY',
    '',
    null,
  ]) assert.equal(parseMobileLiveCommand(value), null);
});
test('accepts an exact due Story command and emits only normalized fields', () => {
  assert.deepEqual(evaluate(), {
    outcome: 'accepted',
    accepted: true,
    command: 'PUBLICER STORY',
    deliveryType: 'instagram_story',
    draftId: DRAFT_ID,
    revision: 6,
    contentRevision: REVISION,
    issueNumber: 3,
    commentId: 9001,
  });
});

const rejectedCases = [
  ['wrong action', { payload: { ...payload(), action: 'edited' } }, 'wrong_action'],
  ['wrong repository', { payload: payload({ repository: 'other/repo' }) }, 'wrong_repository'],
  ['pull request', { payload: payload({ pullRequest: true }) }, 'pull_request'],
  ['wrong actor', { payload: payload({ actor: 'SomeoneElse' }) }, 'unauthorized'],
  ['automation enabled', { automationEnabled: 'true' }, 'automation_not_safely_disabled'],
  ['automation unset', { automationEnabled: '' }, 'automation_not_safely_disabled'],
  ['unknown draft', { payload: payload({ markers: issueBody('missing') }) }, 'unknown_draft'],
  ['wrong issue', { payload: payload({ number: 4 }) }, 'wrong_issue'],
  ['stale revision', { payload: payload({ markers: issueBody(DRAFT_ID, 'a'.repeat(64)) }) }, 'stale_revision'],
  ['draft status', { drafts: [approvedDraft({ status: 'draft' })] }, 'not_currently_approved'],
  ['changed approval', { drafts: [approvedDraft({ approvedRevision: 'a'.repeat(64) })] }, 'not_currently_approved'],
  ['invalid time', { drafts: [approvedDraft({ scheduledFor: 'invalid' })] }, 'invalid_time'],
  ['too early', { now: new Date('2026-10-03T16:59:59Z') }, 'too_early'],
  ['invalid comment id', { payload: { ...payload(), comment: { id: 'bad', body: 'PUBLICER STORY' } } }, 'invalid_event_identity'],
];

for (const [name, overrides, outcome] of rejectedCases) {
  test('rejects ' + name, () => {
    const result = evaluate(overrides);
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, outcome);
  });
}

test('ignores near matches without revealing authorization state', () => {
  for (const body of ['PUBLICER STORY nu', 'publicer story', 'Hej']) {
    const result = evaluate({ payload: payload({ body, actor: 'SomeoneElse' }) });
    assert.deepEqual(result, { outcome: 'ignored_command', accepted: false });
  }
});

test('published delivery lookup requires exact draft revision, channel, and status', () => {
  const draft = approvedDraft();
  const base = { draftId: DRAFT_ID, revision: 6, deliveryType: 'instagram_story', status: 'published' };
  assert.equal(isPublishedDelivery({ entries: [base] }, draft, 'instagram_story'), true);
  assert.equal(isPublishedDelivery({ entries: [{ ...base, revision: 5 }] }, draft, 'instagram_story'), false);
  assert.equal(isPublishedDelivery({ entries: [{ ...base, deliveryType: 'facebook_page_feed' }] }, draft, 'instagram_story'), false);
  assert.equal(isPublishedDelivery({ entries: [{ ...base, status: 'reserved' }] }, draft, 'instagram_story'), false);
});

test('Facebook requires a published Story for the same draft revision', () => {
  const request = payload({ body: 'PUBLICER FACEBOOK' });
  assert.equal(evaluate({ payload: request }).outcome, 'story_required');
  assert.equal(evaluate({
    payload: request,
    ledger: { entries: [{
      draftId: DRAFT_ID,
      revision: 5,
      deliveryType: 'instagram_story',
      status: 'published',
    }] },
  }).outcome, 'story_required');
  assert.equal(evaluate({
    payload: request,
    ledger: { entries: [{
      draftId: DRAFT_ID,
      revision: 6,
      deliveryType: 'instagram_story',
      status: 'published',
    }] },
  }).outcome, 'accepted');
});

test('a published target delivery is idempotently rejected', () => {
  const result = evaluate({
    ledger: { entries: [{
      draftId: DRAFT_ID,
      revision: 6,
      deliveryType: 'instagram_story',
      status: 'published',
    }] },
  });
  assert.equal(result.outcome, 'already_published');
  assert.equal(result.accepted, false);
});

test('rejects unsafe draft ids before they can become workflow outputs', () => {
  const unsafe = 'draft=value';
  const result = evaluate({
    payload: payload({ markers: issueBody(unsafe) }),
    drafts: [approvedDraft({ draftId: unsafe })],
  });
  assert.equal(result.outcome, 'unsafe_draft_id');
  assert.equal(result.accepted, false);
});
