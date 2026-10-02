const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  approveIssueComment,
  parseDraftMarkers,
  recoverApprovalsFromIssues,
} = require('../outputs/content-planner/lib/approvals');
const { runApprovalCli } = require('../outputs/content-planner/approve-issue');

const REPOSITORY = 'Amaizingdk/soma-social-publisher-private';
const REVISION = 'b'.repeat(64);

function markers(draftId = 'draft-1', revision = REVISION) {
  return '<!-- soma-draft-id: ' + draftId + ' -->\n'
    + '<!-- soma-content-revision: ' + revision + ' -->';
}

function reviewDraft(overrides = {}) {
  return {
    draftId: 'draft-1',
    kind: 'event_day',
    status: 'draft',
    contentRevision: REVISION,
    scheduledFor: '2026-10-05T11:30:00+02:00',
    event: { date: '2026-10-05', start: '16:00', end: '18:00', name: 'Saunagus' },
    platformCopies: { instagram: 'Instagram', facebookPage: 'Facebook' },
    render: { path: 'renders/preview.jpg', width: 1080, height: 1920 },
    history: [],
    ...overrides,
  };
}

function commentPayload({
  actor = 'Amaizingai',
  body = 'GODKEND',
  repository = REPOSITORY,
  issueBody = markers(),
  issueNumber = 7,
} = {}) {
  return {
    action: 'created',
    repository: { full_name: repository },
    issue: { number: issueNumber, body: issueBody },
    comment: { id: 99, body },
    sender: { login: actor },
  };
}

test('exact GODKEND from Amaizingai approves the current revision', () => {
  const result = approveIssueComment({
    payload: commentPayload({ body: '  GODKEND  ' }),
    drafts: [reviewDraft()],
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-02T12:00:00Z'),
  });

  assert.equal(result.outcome, 'approved');
  assert.equal(result.drafts[0].status, 'approved');
  assert.equal(result.drafts[0].approvedAt, '2026-10-02T12:00:00.000Z');
  assert.equal(result.drafts[0].approvedBy, 'Amaizingai');
  assert.equal(result.drafts[0].approvedRevision, REVISION);
});

test('wrong actor, repository, command, revision, and terminal status never approve', () => {
  const cases = [
    { payload: commentPayload({ actor: 'SomeoneElse' }), expected: 'unauthorized' },
    { payload: commentPayload({ repository: 'other/repo' }), expected: 'wrong_repository' },
    { payload: commentPayload({ body: 'GODKEND tak' }), expected: 'ignored_command' },
    { payload: commentPayload({ issueBody: markers('draft-1', 'a'.repeat(64)) }), expected: 'stale_revision' },
    { payload: commentPayload({ issueBody: markers('missing') }), expected: 'unknown_draft' },
  ];
  for (const item of cases) {
    const result = approveIssueComment({
      payload: item.payload,
      drafts: [reviewDraft()],
      approverLogin: 'Amaizingai',
    });
    assert.equal(result.outcome, item.expected);
    assert.equal(result.drafts[0].status, 'draft');
  }

  for (const status of ['published', 'skipped', 'rejected', 'obsolete']) {
    const result = approveIssueComment({
      payload: commentPayload(),
      drafts: [reviewDraft({ status })],
      approverLogin: 'Amaizingai',
    });
    assert.equal(result.outcome, 'terminal');
    assert.equal(result.drafts[0].status, status);
  }
});

test('unacknowledged warning cannot be approved through GitHub', () => {
  const result = approveIssueComment({
    payload: commentPayload(),
    drafts: [reviewDraft({ status: 'needs_review', warnings: ['Gusmester mangler'] })],
    approverLogin: 'Amaizingai',
  });
  assert.equal(result.outcome, 'warnings_not_acknowledged');
  assert.equal(result.drafts[0].status, 'needs_review');
});

test('repeated approval is idempotent', () => {
  const input = {
    payload: commentPayload(),
    drafts: [reviewDraft()],
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-02T12:00:00Z'),
  };
  const first = approveIssueComment(input);
  const second = approveIssueComment({ ...input, drafts: first.drafts, now: new Date('2026-10-02T12:05:00Z') });
  assert.equal(second.outcome, 'already_approved');
  assert.deepEqual(second.drafts, first.drafts);
});

test('marker parser accepts only complete lowercase revisions', () => {
  assert.deepEqual(parseDraftMarkers(markers()), { draftId: 'draft-1', contentRevision: REVISION });
  assert.deepEqual(parseDraftMarkers('<!-- soma-draft-id: draft-1 -->\n<!-- soma-content-revision: OLD -->'), {
    draftId: 'draft-1', contentRevision: null,
  });
});

test('recovery reads GitHub comments and applies only authorized current approval', async () => {
  const issues = [{ number: 7, body: markers() }];
  const comments = [
    { body: 'GODKEND', user: { login: 'SomeoneElse' } },
    { body: 'GODKEND', user: { login: 'Amaizingai' } },
  ];
  const client = {
    repository: REPOSITORY,
    async request(method, requestPath) {
      if (method === 'GET' && requestPath.startsWith('/issues?')) return issues;
      if (method === 'GET' && requestPath.startsWith('/issues/7/comments?')) return comments;
      throw new Error('Unexpected request');
    },
  };

  const result = await recoverApprovalsFromIssues({
    drafts: [reviewDraft()],
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-02T12:00:00Z'),
  });
  assert.equal(result[0].status, 'approved');
  assert.equal(result[0].approvedBy, 'Amaizingai');
});

test('approval CLI writes atomically, synchronizes the issue, and confirms once', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-approval-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const draftsPath = path.join(root, 'drafts.json');
  const eventPath = path.join(root, 'event.json');
  const ledgerPath = path.join(root, 'ledger.json');
  await fs.writeFile(draftsPath, JSON.stringify([reviewDraft()]));
  await fs.writeFile(eventPath, JSON.stringify(commentPayload()));
  await fs.writeFile(ledgerPath, JSON.stringify({ version: 1, entries: [] }));
  const calls = { sync: 0, comments: 0 };
  const client = { repository: REPOSITORY };

  const result = await runApprovalCli({
    env: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: REPOSITORY,
      SOMA_APPROVER_LOGIN: 'Amaizingai',
    },
    draftsPath,
    ledgerPath,
    client,
    now: new Date('2026-10-02T12:00:00Z'),
    syncDraftIssueImpl: async ({ draft }) => {
      calls.sync += 1;
      return { ...draft, githubIssueNumber: 7 };
    },
    commentOnceImpl: async ({ marker }) => {
      calls.comments += 1;
      assert.equal(marker, 'soma-approval-response:99:approved');
      return { created: true };
    },
    writeApprovalPayloadImpl: async () => {},
  });

  const written = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
  assert.equal(result.outcome, 'approved');
  assert.equal(written[0].status, 'approved');
  assert.equal(written[0].githubIssueNumber, 7);
  assert.equal(calls.sync, 1);
  assert.equal(calls.comments, 1);
});
