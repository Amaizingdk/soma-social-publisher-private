const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS_LABEL,
  commentOnce,
  listAllIssueComments,
  listAllManagedIssues,
  renderIssueBody,
  syncDraftIssue,
} = require('../outputs/content-planner/lib/github-issues');

const REPOSITORY = 'Amaizingdk/soma-social-publisher-private';
const REVISION = 'a'.repeat(64);

function reviewDraft(overrides = {}) {
  return {
    draftId: 'draft-1',
    kind: 'event_day',
    status: 'draft',
    contentRevision: REVISION,
    scheduledFor: '2026-10-05T11:30:00+02:00',
    event: {
      date: '2026-10-05',
      start: '16:00',
      end: '18:00',
      name: 'Saunagus',
    },
    availability: { free: 7, soldOut: false, label: '7 ledige pladser' },
    platformCopies: {
      instagram: 'Rolig varme. Book via link i bio.',
      facebookPage: 'Rolig varme. Book på https://somasaunagus.dk/kalender/.',
    },
    render: { path: 'renders/preview image.jpg', width: 1080, height: 1920 },
    ...overrides,
  };
}

function managedIssue(draftId = 'draft-1', overrides = {}) {
  return {
    number: 7,
    title: 'Old title',
    body: '<!-- soma-draft-id: ' + draftId + ' -->\nOld body',
    labels: [{ name: 'soma-managed' }, { name: 'needs-approval' }],
    ...overrides,
  };
}

function pageFrom(path) {
  return Number(new URL('https://example.test' + path).searchParams.get('page') || 1);
}

function fakeIssueClient({ issues = [], issuePages, comments = [], commentPages, existingLabels = [] } = {}) {
  const state = {
    issues: [...issues],
    created: [],
    updated: [],
    commentsCreated: [],
    labelsCreated: [],
  };
  return {
    repository: REPOSITORY,
    state,
    async request(method, requestPath, body) {
      if (method === 'GET' && requestPath.startsWith('/labels?')) return existingLabels;
      if (method === 'POST' && requestPath === '/labels') {
        state.labelsCreated.push(body);
        return body;
      }
      if (method === 'GET' && requestPath.startsWith('/issues?')) {
        return issuePages ? (issuePages[pageFrom(requestPath) - 1] || []) : state.issues;
      }
      const commentsMatch = requestPath.match(/^\/issues\/(\d+)\/comments(?:\?|$)/);
      if (method === 'GET' && commentsMatch) {
        return commentPages ? (commentPages[pageFrom(requestPath) - 1] || []) : comments;
      }
      if (method === 'POST' && commentsMatch) {
        state.commentsCreated.push({ issueNumber: Number(commentsMatch[1]), ...body });
        return { id: state.commentsCreated.length, ...body };
      }
      const issueMatch = requestPath.match(/^\/issues\/(\d+)$/);
      if (method === 'PATCH' && issueMatch) {
        const updated = { number: Number(issueMatch[1]), ...body };
        state.updated.push(updated);
        return updated;
      }
      if (method === 'POST' && requestPath === '/issues') {
        const created = { number: 100 + state.created.length, ...body };
        state.created.push(created);
        state.issues.push(created);
        return created;
      }
      throw new Error('Unexpected fake request: ' + method + ' ' + requestPath);
    },
  };
}

test('creates one private issue with preview, copy, and stable markers', async () => {
  const client = fakeIssueClient();
  const result = await syncDraftIssue({
    client,
    draft: reviewDraft(),
    ledger: { entries: [] },
    repository: REPOSITORY,
  });

  assert.equal(client.state.created.length, 1);
  assert.equal(result.githubIssueNumber, 100);
  assert.match(client.state.created[0].body, /soma-draft-id: draft-1/);
  assert.match(client.state.created[0].body, new RegExp('soma-content-revision: ' + REVISION));
  assert.match(client.state.created[0].body, /blob\/main\/renders\/preview%20image\.jpg\?raw=1/);
  assert.match(client.state.created[0].body, /Rolig varme/);
  assert.deepEqual(client.state.created[0].labels, ['soma-managed', 'needs-approval']);
});

test('issue body includes every weekly event and sanitized delivery state', () => {
  const draft = reviewDraft({
    kind: 'weekly_overview',
    event: undefined,
    events: [
      { date: '2026-10-05', start: '16:00', end: '18:00', name: 'Saunagus' },
      { date: '2026-10-07', start: '18:30', end: '20:30', name: 'MELLEMRUM' },
    ],
    availability: null,
  });
  const body = renderIssueBody(draft, REPOSITORY, { entries: [
    { draftId: 'draft-1', deliveryType: 'instagram_story', status: 'published', providerId: 'safe-id' },
    { draftId: 'another', deliveryType: 'facebook_page_feed', status: 'failed', providerId: 'ignore-me' },
  ] });

  assert.match(body, /2026-10-05 16:00–18:00 · Saunagus/);
  assert.match(body, /2026-10-07 18:30–20:30 · MELLEMRUM/);
  assert.match(body, /instagram_story: published · safe-id/);
  assert.doesNotMatch(body, /ignore-me/);
});

test('rerun updates the same issue and preserves only non-SOMA labels', async () => {
  const client = fakeIssueClient({
    issues: [managedIssue('draft-1', { labels: [
      { name: 'soma-managed' },
      { name: 'needs-approval' },
      { name: 'keep-me' },
    ] })],
    existingLabels: Object.keys(STATUS_LABEL).map((name) => ({ name })),
  });

  await syncDraftIssue({
    client,
    draft: reviewDraft({ status: 'approved' }),
    ledger: { entries: [] },
    repository: REPOSITORY,
  });

  assert.equal(client.state.created.length, 0);
  assert.equal(client.state.updated.length, 1);
  assert.deepEqual(client.state.updated[0].labels, ['keep-me', 'soma-managed', 'approved-scheduled']);
});

test('finds a managed issue on the second GitHub page', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => managedIssue('unrelated-' + index, { number: index + 1 }));
  const target = managedIssue('draft-1', { number: 501 });
  const client = fakeIssueClient({ issuePages: [firstPage, [target]] });

  await syncDraftIssue({ client, draft: reviewDraft(), ledger: { entries: [] }, repository: REPOSITORY });

  assert.equal(client.state.created.length, 0);
  assert.equal(client.state.updated[0].number, 501);
});

test('managed issue and comment listing paginate past 100 records', async () => {
  const firstIssues = Array.from({ length: 100 }, (_, index) => managedIssue('d-' + index, { number: index + 1 }));
  const firstComments = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'comment' }));
  const client = fakeIssueClient({
    issuePages: [firstIssues, [managedIssue('last', { number: 101 })]],
    commentPages: [firstComments, [{ id: 101, body: 'last' }]],
  });

  assert.equal((await listAllManagedIssues(client, { state: 'all' })).length, 101);
  assert.equal((await listAllIssueComments(client, 7)).length, 101);
});

test('commentOnce detects its durable marker on GitHub', async () => {
  const client = fakeIssueClient({
    comments: [{ body: '<!-- soma-reminder:draft-1:' + REVISION + ':72h -->\nTid til review.' }],
  });
  const result = await commentOnce({
    client,
    issueNumber: 7,
    marker: 'soma-reminder:draft-1:' + REVISION + ':72h',
    body: 'Påmindelse',
  });

  assert.deepEqual(result, { created: false });
  assert.equal(client.state.commentsCreated.length, 0);
});

test('commentOnce creates one marker-prefixed comment when absent', async () => {
  const client = fakeIssueClient();
  const result = await commentOnce({
    client,
    issueNumber: 7,
    marker: 'soma-reminder:draft-1:' + REVISION + ':24h',
    body: 'Påmindelse',
  });

  assert.deepEqual(result, { created: true });
  assert.equal(client.state.commentsCreated.length, 1);
  assert.match(client.state.commentsCreated[0].body, /^<!-- soma-reminder:/);
});

test('unknown draft status fails closed to needs-correction', async () => {
  const client = fakeIssueClient();
  await syncDraftIssue({
    client,
    draft: reviewDraft({ status: 'unexpected' }),
    ledger: { entries: [] },
    repository: REPOSITORY,
  });
  assert.deepEqual(client.state.created[0].labels, ['soma-managed', 'needs-correction']);
});
