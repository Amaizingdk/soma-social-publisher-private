const { SOMA_REPOSITORY } = require('./github-api');

const STATUS_LABEL = Object.freeze({
  draft: 'needs-approval',
  needs_review: 'needs-correction',
  approved: 'approved-scheduled',
  published: 'published',
  skipped: 'skipped',
  needs_correction: 'needs-correction',
  rejected: 'skipped',
  obsolete: 'skipped',
});

const LABEL_COLORS = Object.freeze({
  'soma-managed': '5319e7',
  'needs-approval': 'fbca04',
  'approved-scheduled': '0e8a16',
  published: '1d76db',
  skipped: '6e7781',
  'needs-correction': 'd73a4a',
});

const SOMA_LABELS = new Set(Object.keys(LABEL_COLORS));
const TERMINAL_ISSUE_STATUSES = new Set(['published', 'skipped', 'rejected', 'obsolete']);

function issueTitle(draft) {
  const event = draft.event || draft.events?.[0] || {};
  return '[SOMA] ' + (event.date || 'Uge') + ' · ' + (event.name || draft.kind) + ' · ' + draft.kind;
}

function assertRepository(repository) {
  if (repository !== SOMA_REPOSITORY) throw new Error('GitHub repository matcher ikke SOMA');
}

function assertDraftIdentity(draft) {
  if (!draft?.draftId || /[\r\n]/u.test(draft.draftId)) throw new Error('Kladde-ID mangler eller er ugyldigt');
  if (!/^[a-f0-9]{64}$/u.test(String(draft.contentRevision || ''))) {
    throw new Error('Kladde mangler gyldig content revision');
  }
}

function portablePreviewPath(draft) {
  const value = String(draft.render?.path || draft.renderPath || '').replace(/\\/gu, '/').replace(/^\/+/, '');
  if (!value || /^[A-Za-z]:/u.test(value) || value.split('/').includes('..')) {
    throw new Error('Kladde mangler en portabel preview-sti');
  }
  return value;
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
}

function renderIssueBody(draft, repository, ledger = { entries: [] }) {
  assertRepository(repository);
  assertDraftIdentity(draft);
  const previewPath = portablePreviewPath(draft);
  const previewUrl = 'https://github.com/' + repository + '/blob/main/'
    + previewPath.split('/').map(encodeURIComponent).join('/') + '?raw=1';
  const events = draft.kind === 'weekly_overview' ? (draft.events || []) : [draft.event];
  const eventLines = events.filter(Boolean).map((event) => '- ' + [
    oneLine(event.date),
    oneLine(event.start) + '–' + oneLine(event.end),
    '· ' + oneLine(event.name),
  ].join(' ')).join('\n') || '- Eventdata mangler';
  const deliveryLines = (Array.isArray(ledger?.entries) ? ledger.entries : [])
    .filter((entry) => entry?.draftId === draft.draftId)
    .map((entry) => '- ' + oneLine(entry.deliveryType) + ': ' + oneLine(entry.status)
      + (entry.providerId ? ' · ' + oneLine(entry.providerId) : ''))
    .join('\n') || '- Ikke publiceret';

  return [
    '<!-- soma-draft-id: ' + draft.draftId + ' -->',
    '<!-- soma-content-revision: ' + draft.contentRevision + ' -->',
    '# ' + draft.draftId,
    '',
    '![Preview](' + previewUrl + ')',
    '[Åbn preview i GitHub](' + previewUrl + ')',
    '',
    '**Status:** ' + oneLine(draft.status),
    '**Planlagt:** ' + oneLine(draft.scheduledFor),
    '**Tilgængelighed:** ' + oneLine(draft.availability?.label || 'Ikke oplyst'),
    '',
    '## Event',
    eventLines,
    '',
    '## Instagram Story',
    String(draft.platformCopies?.instagram || ''),
    '',
    '## Facebook-side',
    String(draft.platformCopies?.facebookPage || ''),
    '',
    '## Publiceringsresultat',
    deliveryLines,
  ].join('\n');
}

async function listAllManagedIssues(client, { state = 'all' } = {}) {
  const result = [];
  for (let page = 1; ; page += 1) {
    const batch = await client.request(
      'GET',
      '/issues?state=' + encodeURIComponent(state) + '&labels=soma-managed&per_page=100&page=' + page,
    );
    if (!Array.isArray(batch)) throw new Error('GitHub returnerede en ugyldig Issue-liste');
    result.push(...batch.filter((item) => !item.pull_request));
    if (batch.length < 100) return result;
  }
}

async function listAllIssueComments(client, issueNumber) {
  if (!Number.isInteger(Number(issueNumber)) || Number(issueNumber) <= 0) {
    throw new Error('GitHub Issue-nummer er ugyldigt');
  }
  const result = [];
  for (let page = 1; ; page += 1) {
    const batch = await client.request(
      'GET', '/issues/' + Number(issueNumber) + '/comments?per_page=100&page=' + page,
    );
    if (!Array.isArray(batch)) throw new Error('GitHub returnerede en ugyldig kommentarliste');
    result.push(...batch);
    if (batch.length < 100) return result;
  }
}

async function ensureLabels(client) {
  const existing = await client.request('GET', '/labels?per_page=100');
  if (!Array.isArray(existing)) throw new Error('GitHub returnerede en ugyldig label-liste');
  const names = new Set(existing.map((label) => String(label.name || '').toLowerCase()));
  for (const [name, color] of Object.entries(LABEL_COLORS)) {
    if (!names.has(name.toLowerCase())) await client.request('POST', '/labels', { name, color });
  }
}

async function commentOnce({ client, issueNumber, marker, body }) {
  const safeMarker = String(marker || '');
  if (!safeMarker || /[\r\n<>]/u.test(safeMarker)) throw new Error('Kommentarmarkør er ugyldig');
  const comments = await listAllIssueComments(client, issueNumber);
  const hiddenMarker = '<!-- ' + safeMarker + ' -->';
  if (comments.some((comment) => String(comment.body || '').includes(hiddenMarker))) {
    return { created: false };
  }
  await client.request('POST', '/issues/' + Number(issueNumber) + '/comments', {
    body: hiddenMarker + '\n' + String(body || ''),
  });
  return { created: true };
}

async function syncDraftIssue({
  client,
  draft,
  ledger = { entries: [] },
  repository = client?.repository,
  createIfMissing = true,
}) {
  assertRepository(repository);
  if (client?.repository !== repository) throw new Error('GitHub-klient og repository matcher ikke');
  assertDraftIdentity(draft);
  await ensureLabels(client);
  const issues = await listAllManagedIssues(client);
  const marker = '<!-- soma-draft-id: ' + draft.draftId + ' -->';
  const existing = issues.find((issue) => (
    Number(issue.number) === Number(draft.githubIssueNumber)
    || String(issue.body || '').includes(marker)
  ));
  if (!existing && !createIfMissing) return draft;
  const statusLabel = STATUS_LABEL[draft.status] || 'needs-correction';
  const preserved = (existing?.labels || [])
    .map((label) => typeof label === 'string' ? label : label.name)
    .filter((label) => label && !SOMA_LABELS.has(String(label).toLowerCase()));
  const payload = {
    title: issueTitle(draft),
    body: renderIssueBody(draft, repository, ledger),
    labels: [...new Set([...preserved, 'soma-managed', statusLabel])],
    state: TERMINAL_ISSUE_STATUSES.has(draft.status) ? 'closed' : 'open',
  };
  if (existing) {
    await client.request('PATCH', '/issues/' + existing.number, payload);
    return { ...draft, githubIssueNumber: existing.number };
  }
  const created = await client.request('POST', '/issues', payload);
  if (!Number.isInteger(Number(created?.number)) || Number(created.number) <= 0) {
    throw new Error('GitHub oprettede ikke et gyldigt Issue');
  }
  return { ...draft, githubIssueNumber: Number(created.number) };
}

module.exports = {
  LABEL_COLORS,
  STATUS_LABEL,
  commentOnce,
  ensureLabels,
  issueTitle,
  listAllIssueComments,
  listAllManagedIssues,
  renderIssueBody,
  syncDraftIssue,
};
