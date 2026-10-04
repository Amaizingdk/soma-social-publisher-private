const test = require('node:test');
const assert = require('node:assert/strict');

const { LABEL_COLORS } = require('../outputs/content-planner/lib/github-issues');
const {
  reconcilePublicationState,
  runOperationsSync,
  syncPublicationIssues,
} = require('../outputs/content-planner/lib/operations');

const REPOSITORY = 'Amaizingdk/soma-social-publisher-private';
const REVISION = 'c'.repeat(64);

function reviewDraft(overrides = {}) {
  return {
    draftId: 'draft-1',
    revision: 1,
    kind: 'event_day',
    status: 'draft',
    contentRevision: REVISION,
    scheduledFor: '2026-10-05T12:00:00Z',
    event: { date: '2026-10-05', start: '16:00', end: '18:00', name: 'Saunagus' },
    availability: { label: '7 ledige pladser' },
    platformCopies: { instagram: 'Instagram', facebookPage: 'Facebook' },
    render: { path: 'renders/preview.jpg', width: 1080, height: 1920 },
    reminderState: {},
    history: [],
    ...overrides,
  };
}

function approvedDraft(overrides = {}) {
  return reviewDraft({
    status: 'approved',
    approvedAt: '2026-10-02T12:00:00Z',
    approvedBy: 'Amaizingai',
    approvedRevision: REVISION,
    ...overrides,
  });
}

function ledgerWith(...entries) {
  return { schemaVersion: 1, entries };
}

function fakeClient() {
  const state = { issues: [], comments: new Map(), nextIssue: 1 };
  const client = {
    repository: REPOSITORY,
    state,
    commentsWith(marker) {
      return [...state.comments.values()].flat().filter((comment) => comment.body.includes('<!-- ' + marker + ' -->'));
    },
    async request(method, requestPath, body) {
      if (method === 'GET' && requestPath.startsWith('/labels?')) {
        return Object.entries(LABEL_COLORS).map(([name, color]) => ({ name, color }));
      }
      if (method === 'GET' && requestPath.startsWith('/issues?')) return state.issues;
      const commentsMatch = requestPath.match(/^\/issues\/(\d+)\/comments(?:\?|$)/);
      if (method === 'GET' && commentsMatch) return state.comments.get(Number(commentsMatch[1])) || [];
      if (method === 'POST' && commentsMatch) {
        const number = Number(commentsMatch[1]);
        const created = { id: Date.now(), body: body.body, user: { login: 'github-actions[bot]' } };
        state.comments.set(number, [...(state.comments.get(number) || []), created]);
        return created;
      }
      if (method === 'POST' && requestPath === '/issues') {
        const created = { number: state.nextIssue++, ...body };
        state.issues.push(created);
        return created;
      }
      const issueMatch = requestPath.match(/^\/issues\/(\d+)$/);
      if (method === 'PATCH' && issueMatch) {
        const issue = state.issues.find((item) => item.number === Number(issueMatch[1]));
        Object.assign(issue, body);
        return issue;
      }
      throw new Error('Unexpected request ' + method + ' ' + requestPath);
    },
  };
  return client;
}

test('operations creates no issue until an alert is needed, then one reminder with one mention', async () => {
  const client = fakeClient();
  const run = (drafts, now, ledger = { version: 1, entries: [] }) => runOperationsSync({
    drafts, ledger, client, approverLogin: 'Amaizingai', now: new Date(now),
  });
  // langt ude i fremtiden: ingen issue og ingen mail
  const early = await run([reviewDraft()], '2026-10-02T12:00:00Z');
  assert.equal(client.state.issues.length, 0);
  // godkendte opslag får aldrig issue, før de er forsinkede
  await run([approvedDraft()], '2026-10-05T11:00:00Z');
  assert.equal(client.state.issues.length, 0);
  // under 3 timer før: ét issue og én påmindelse
  const first = await run(early.drafts, '2026-10-05T09:30:00Z');
  const second = await run(first.drafts, '2026-10-05T09:35:00Z');
  assert.equal(client.state.issues.length, 1);
  assert.equal(client.commentsWith('soma-reminder:draft-1:' + REVISION + ':final').length, 1);
  assert.match(client.commentsWith('soma-reminder:draft-1:' + REVISION + ':final')[0].body, /@Amaizingai/);
  assert.equal(second.drafts[0].reminderState.sentFinalAt !== undefined, true);
});

test('operations sends one overdue alert for an approved draft that is not published, and none once published', async () => {
  const client = fakeClient();
  const run = (ledger, now) => runOperationsSync({
    drafts: [approvedDraft()], ledger, client, approverLogin: 'Amaizingai', now: new Date(now),
  });
  const empty = { version: 1, entries: [] };
  await run(empty, '2026-10-05T12:10:00Z');
  assert.equal(client.state.issues.length, 0);
  const late = await run(empty, '2026-10-05T12:40:00Z');
  await run(empty, '2026-10-05T12:50:00Z');
  assert.equal(client.state.issues.length, 1);
  assert.equal(client.commentsWith('soma-overdue:draft-1:' + REVISION).length, 1);
  assert.match(client.commentsWith('soma-overdue:draft-1:' + REVISION)[0].body, /@Amaizingai/);
  assert.equal(late.drafts[0].overdueReminderState.revision, REVISION);

  const doneClient = fakeClient();
  await runOperationsSync({
    drafts: [approvedDraft()],
    ledger: ledgerWith(
      { draftId: 'draft-1', revision: 1, deliveryType: 'instagram_story', status: 'published' },
      { draftId: 'draft-1', revision: 1, deliveryType: 'facebook_page_feed', status: 'published' },
    ),
    client: doneClient, approverLogin: 'Amaizingai', now: new Date('2026-10-05T12:40:00Z'),
  });
  assert.equal(doneClient.state.issues.length, 0);
});

test('operations creates one approved live-test reminder with exact mobile commands', async () => {
  const client = fakeClient();
  const first = await runOperationsSync({
    drafts: [approvedDraft({ scheduledFor: '2026-10-03T17:00:00Z' })],
    ledger: ledgerWith(),
    client,
    approverLogin: 'Amaizingai',
    automationEnabled: 'false',
    now: new Date('2026-10-03T16:30:00Z'),
  });
  await runOperationsSync({
    drafts: first.drafts,
    ledger: ledgerWith(),
    client,
    approverLogin: 'Amaizingai',
    automationEnabled: 'false',
    now: new Date('2026-10-03T16:45:00Z'),
  });
  const marker = 'soma-live-test-reminder:draft-1:' + REVISION + ':30m';
  const comments = client.commentsWith(marker);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /@Amaizingai/);
  assert.match(comments[0].body, /`PUBLICER STORY`/);
  assert.match(comments[0].body, /`PUBLICER FACEBOOK`/);
  assert.match(comments[0].body, /ved eller efter/i);
});

test('operations reminder after Story publication asks only for visual check and Facebook', async () => {
  const client = fakeClient();
  const result = await runOperationsSync({
    drafts: [approvedDraft({ scheduledFor: '2026-10-03T17:00:00Z' })],
    ledger: ledgerWith({
      draftId: 'draft-1',
      revision: 1,
      deliveryType: 'instagram_story',
      status: 'published',
    }),
    client,
    approverLogin: 'Amaizingai',
    automationEnabled: 'false',
    now: new Date('2026-10-03T16:30:00Z'),
  });
  const marker = 'soma-live-test-reminder:draft-1:' + REVISION + ':30m';
  const comments = client.commentsWith(marker);
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /Story er allerede registreret som publiceret/i);
  assert.match(comments[0].body, /kontrollér den visuelt/i);
  assert.match(comments[0].body, /`PUBLICER FACEBOOK`/);
  assert.doesNotMatch(comments[0].body, /`PUBLICER STORY`/);
  assert.equal(result.drafts[0].liveTestReminderState.revision, REVISION);
});

test('missed approval deadline creates one durable skip alert', async () => {
  const client = fakeClient();
  const first = await runOperationsSync({
    drafts: [reviewDraft({ scheduledFor: '2026-10-03T12:00:00Z' })],
    ledger: { version: 1, entries: [] },
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-03T12:00:01Z'),
  });
  await runOperationsSync({
    drafts: first.drafts,
    ledger: { version: 1, entries: [] },
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-03T12:05:00Z'),
  });

  assert.equal(first.drafts[0].status, 'skipped');
  assert.equal(first.drafts[0].skipReason, 'missing_approval_at_publish_time');
  assert.equal(client.commentsWith('soma-skip:draft-1:missing_approval_at_publish_time').length, 1);
});

test('operations recovers a valid approval before applying the deadline', async () => {
  const client = fakeClient();
  const issue = {
    number: 7,
    body: '<!-- soma-draft-id: draft-1 -->\n<!-- soma-content-revision: ' + REVISION + ' -->',
    labels: ['soma-managed', 'needs-approval'],
  };
  client.state.issues.push(issue);
  client.state.comments.set(7, [{ id: 1, body: 'GODKEND', user: { login: 'Amaizingai' } }]);

  const result = await runOperationsSync({
    drafts: [reviewDraft({ scheduledFor: '2026-10-03T12:00:00Z' })],
    ledger: { version: 1, entries: [] },
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-03T12:00:01Z'),
  });

  assert.equal(result.drafts[0].status, 'approved');
  assert.equal(result.drafts[0].approvedBy, 'Amaizingai');
  assert.equal(client.commentsWith('soma-skip:draft-1:missing_approval_at_publish_time').length, 0);
});

test('marks a draft published only when both automatic deliveries are published', () => {
  const partial = reconcilePublicationState([approvedDraft()], ledgerWith({
    draftId: 'draft-1', revision: 1, deliveryType: 'instagram_story', status: 'published',
  }), new Date('2026-10-05T12:00:00Z'));
  assert.equal(partial[0].status, 'approved');

  const complete = reconcilePublicationState([approvedDraft()], ledgerWith(
    {
      draftId: 'draft-1', revision: 1, deliveryType: 'instagram_story', status: 'published',
      publishedAt: '2026-10-05T12:01:00Z',
    },
    {
      draftId: 'draft-1', revision: 1, deliveryType: 'facebook_page_feed', status: 'published',
      publishedAt: '2026-10-05T12:02:00Z',
    },
  ), new Date('2026-10-05T12:03:00Z'));
  assert.equal(complete[0].status, 'published');
  assert.equal(complete[0].publishedAt, '2026-10-05T12:02:00.000Z');
});

test('manual review required becomes needs_correction and clears approval', () => {
  const result = reconcilePublicationState([approvedDraft()], ledgerWith({
    draftId: 'draft-1', revision: 1, deliveryType: 'instagram_story', status: 'manual_review_required',
  }));
  assert.equal(result[0].status, 'needs_correction');
  assert.equal(result[0].correctionReason, 'manual_review_required');
  assert.equal(result[0].approvedRevision, null);
});

test('publication reconciliation ignores ledger entries from an older draft revision', () => {
  const result = reconcilePublicationState([approvedDraft({ revision: 2 })], ledgerWith(
    { draftId: 'draft-1', revision: 1, deliveryType: 'instagram_story', status: 'published' },
    { draftId: 'draft-1', revision: 1, deliveryType: 'facebook_page_feed', status: 'published' },
  ));
  assert.equal(result[0].status, 'approved');
});

test('next reconciliation repairs issue after a prior Issue API failure without Meta calls', async () => {
  const client = fakeClient();
  await runOperationsSync({
    drafts: [approvedDraft()],
    ledger: { version: 1, entries: [] },
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-05T12:45:00Z'),
  });
  let failures = 1;
  const originalRequest = client.request.bind(client);
  client.request = async (method, requestPath, body) => {
    if (failures && method === 'PATCH' && /^\/issues\//.test(requestPath)) {
      failures -= 1;
      throw new Error('temporary Issue failure');
    }
    return originalRequest(method, requestPath, body);
  };
  const complete = ledgerWith(
    { draftId: 'draft-1', revision: 1, deliveryType: 'instagram_story', status: 'published' },
    { draftId: 'draft-1', revision: 1, deliveryType: 'facebook_page_feed', status: 'published' },
  );

  await assert.rejects(syncPublicationIssues({ drafts: [approvedDraft()], ledger: complete, client }), /temporary/);
  const repaired = await syncPublicationIssues({ drafts: [approvedDraft()], ledger: complete, client });
  assert.equal(repaired[0].status, 'published');
  assert.ok(client.state.issues[0].labels.includes('published'));
  assert.equal(Object.hasOwn(client.state, 'metaCalls'), false);
});

test('operations creates no new issues for pre-existing terminal history', async () => {
  const client = fakeClient();
  const result = await runOperationsSync({
    drafts: [
      reviewDraft({ draftId: 'obsolete-1', status: 'obsolete' }),
      reviewDraft({ draftId: 'skipped-1', status: 'skipped', skipReason: 'expired_event' }),
    ],
    ledger: { version: 1, entries: [] },
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-02T12:00:00Z'),
  });
  assert.equal(client.state.issues.length, 0);
  assert.equal(result.drafts.every((draft) => !draft.githubIssueNumber), true);
});

test('operations retires an obsolete draft issue instead of showing needs-correction', async () => {
  const client = fakeClient();
  client.state.issues.push({
    number: 7,
    body: '<!-- soma-draft-id: obsolete-1 -->\n<!-- soma-content-revision: ' + REVISION + ' -->',
    labels: ['soma-managed', 'needs-approval'],
    state: 'open',
  });
  await runOperationsSync({
    drafts: [reviewDraft({ draftId: 'obsolete-1', status: 'obsolete', githubIssueNumber: 7 })],
    ledger: { version: 1, entries: [] },
    client,
    approverLogin: 'Amaizingai',
    now: new Date('2026-10-02T12:00:00Z'),
  });
  assert.equal(client.state.issues[0].state, 'closed');
  assert.deepEqual(client.state.issues[0].labels, ['soma-managed', 'skipped']);
});
