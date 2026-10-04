const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const ENDPOINT = 'http://127.0.0.1:47831/approve';
const KEY = 'k'.repeat(48);
const PAGE_URL = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;

function draft(id, overrides = {}) {
  return {
    draftId: id,
    kind: 'event_day',
    status: 'draft',
    revision: 1,
    eventKey: `${id}-event`,
    eventFingerprint: `fp-${id}`,
    contentFingerprint: `cf-${id}`,
    contentRevision: id.length.toString(16).padStart(64, 'a'),
    scheduledFor: '2099-01-01T11:30:00+01:00',
    event: { date: '2099-01-01', start: '10:00', end: '12:00', name: 'Saunagus', instructor: 'Søren' },
    warnings: [],
    platformCopies: { instagram: 'Instagram', facebookPage: 'Side', facebookGroup: 'Gruppe' },
    history: [],
    ...overrides,
  };
}

async function open(browser, drafts, { session = true, respond, storage, delayMs = 0 } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  const requests = [];
  await page.route(ENDPOINT, async (route) => {
    const request = route.request();
    requests.push({ headers: request.headers(), body: request.postData() ? JSON.parse(request.postData()) : null });
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'POST',
        },
      });
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const body = respond ? respond(requests[requests.length - 1].body) : { results: [], pushed: true };
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
  await page.addInitScript((value) => {
    window.__SOMA_DRAFTS__ = value.drafts;
    if (value.session) window.__SOMA_SESSION__ = value.session;
    if (value.storage) localStorage.setItem('soma-content-planner-review-v1', JSON.stringify(value.storage));
  }, { drafts, session: session ? { key: KEY, endpoint: ENDPOINT } : null, storage });
  await page.goto(PAGE_URL);
  await page.waitForSelector('.draft');
  return { page, requests: () => requests.filter((item) => item.body) };
}

const approvedFor = (pushed) => (body) => ({
  results: body.items.map((item) => ({ draftId: item.draftId, outcome: 'approved' })),
  pushed,
});

test('approve buttons are disabled without a session', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await open(browser, [draft('one')], { session: false });
    assert.equal(await page.getByRole('button', { name: 'Godkend opslag' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Godkend alle' }).isDisabled(), true);
  } finally { await browser.close(); }
});

test('approve sends the session key and the draft revision', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const one = draft('one');
    const { page, requests } = await open(browser, [one], { respond: approvedFor(true) });
    await page.getByRole('button', { name: 'Godkend opslag' }).click();
    await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'approved');
    const [sent] = requests();
    assert.equal(sent.headers['x-soma-key'], KEY);
    assert.deepEqual(sent.body, { items: [{ draftId: 'one', contentRevision: one.contentRevision }] });
  } finally { await browser.close(); }
});

test('approve marks a draft approved only after pushed:true', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    let pushed = false;
    const { page } = await open(browser, [draft('one')], {
      respond: (body) => ({ ...approvedFor(pushed)(body), ...(pushed ? {} : { error: 'push_failed' }) }),
    });
    await page.getByRole('button', { name: 'Godkend opslag' }).click();
    await page.waitForSelector('.send-status');
    assert.equal((await page.locator('.status').innerText()).toLowerCase(), 'draft');
    assert.match(await page.locator('.send-status').innerText(), /ikke sendt til github/i);
    pushed = true;
    await page.getByRole('button', { name: 'Godkend opslag' }).click();
    await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'approved');
  } finally { await browser.close(); }
});

test('stale_revision leaves the draft unapproved and shows the outcome', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await open(browser, [draft('one')], {
      respond: (body) => ({ results: [{ draftId: body.items[0].draftId, outcome: 'stale_revision' }], pushed: false }),
    });
    await page.getByRole('button', { name: 'Godkend opslag' }).click();
    await page.waitForSelector('.send-status');
    assert.equal((await page.locator('.status').innerText()).toLowerCase(), 'draft');
    assert.match(await page.locator('.send-status').innerText(), /ændret/i);
  } finally { await browser.close(); }
});

test('approve all only sends visible future drafts without needs_review', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const drafts = [
      draft('future'),
      draft('ended-draft', { event: { date: '2000-01-01', start: '10:00', end: '12:00', name: 'Saunagus' } }),
      draft('needs-review', { status: 'needs_review', warnings: ['instructor_missing'] }),
    ];
    const { page, requests } = await open(browser, drafts, { respond: approvedFor(true) });
    await page.getByRole('button', { name: 'Godkend alle' }).click();
    await page.waitForFunction(() => document.querySelector('.draft[data-draft-id="future"] .status')?.textContent === 'approved');
    assert.deepEqual(requests()[0].body.items.map((item) => item.draftId), ['future']);
  } finally { await browser.close(); }
});

test('a locally edited draft cannot be approved', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, requests } = await open(browser, [draft('one')], { respond: approvedFor(true) });
    await page.locator('textarea[data-platform="instagram"]').fill('Min egen tekst');
    await page.getByRole('button', { name: 'Gem ændringer' }).click();
    assert.equal(await page.getByRole('button', { name: 'Godkend opslag' }).isDisabled(), true);
    assert.match(await page.locator('.draft').innerText(), /eksporteres og importeres/i);
    await page.getByRole('button', { name: 'Godkend alle' }).click();
    assert.equal(requests().length, 0);
  } finally { await browser.close(); }
});

test('old localStorage status does not make a draft look approved', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const one = draft('one');
    const { page } = await open(browser, [one], {
      storage: [{ ...one, status: 'approved', approvedAt: '2026-10-01T10:00:00.000Z' }],
    });
    assert.equal((await page.locator('.status').innerText()).toLowerCase(), 'draft');
  } finally { await browser.close(); }
});

test('buttons are disabled while an approval is in flight', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await open(browser, [draft('one'), draft('two')], { respond: approvedFor(true), delayMs: 500 });
    await page.getByRole('button', { name: 'Godkend opslag' }).first().click();
    assert.equal(await page.getByRole('button', { name: 'Godkend alle' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Godkend opslag' }).last().isDisabled(), true);
    await page.waitForFunction(() => document.querySelector('.draft .status')?.textContent === 'approved');
    assert.equal(await page.getByRole('button', { name: 'Godkend alle' }).isDisabled(), false);
  } finally { await browser.close(); }
});

test('stored text is ignored when the draft is not marked as locally edited', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const one = draft('one');
    const { page } = await open(browser, [one], {
      storage: [{ ...one, localEdit: false, platformCopies: { instagram: 'GAMMEL TEKST', facebookPage: 'x', facebookGroup: 'y' } }],
    });
    assert.equal(await page.locator('textarea[data-platform="instagram"]').inputValue(), 'Instagram');
  } finally { await browser.close(); }
});

const ASSETS_URL = 'http://127.0.0.1:47831/assets';
const CHANGE_URL = 'http://127.0.0.1:47831/change-image';

async function routeImageApi(page, { changeResponse }) {
  const changes = [];
  await page.route(/127\.0\.0\.1:47831\/(assets|change-image|asset-image)/, async (route) => {
    const request = route.request();
    const url = request.url();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.startsWith(ASSETS_URL)) {
      return route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...cors },
        body: JSON.stringify({ assets: [{ assetId: 'soma-a', tags: [] }, { assetId: 'soma-b', tags: [] }] }),
      });
    }
    if (url.startsWith(CHANGE_URL)) {
      changes.push({ headers: request.headers(), body: JSON.parse(request.postData()) });
      return route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', ...cors },
        body: JSON.stringify(changeResponse(changes.at(-1).body)),
      });
    }
    return route.fulfill({ status: 200, headers: { 'content-type': 'image/png', ...cors }, body: Buffer.from('iVBORw0KGgo=', 'base64') });
  });
  return changes;
}

test('image picker lists library images, confirms, sends the revision and shows the new state', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await open(browser, [draft('one', { status: 'approved', assetId: 'soma-a', renderPath: 'renders/x.jpg', render: { sha256: 'old' } })]);
    const changes = await routeImageApi(page, {
      changeResponse: (body) => ({
        results: [{ draftId: body.draftId, outcome: 'changed', draft: draft('one', {
          status: 'draft', assetId: body.assetId, contentRevision: 'b'.repeat(64), renderPath: 'renders/x.jpg', render: { sha256: 'new' },
        }) }],
        pushed: true,
      }),
    });
    let dialog = '';
    page.on('dialog', (item) => { dialog = item.message(); item.accept(); });
    await page.getByRole('button', { name: 'Skift billede' }).click();
    await page.waitForSelector('.asset-choice');
    assert.equal(await page.locator('.asset-choice').count(), 2);
    assert.equal(await page.locator('.asset-choice.current').count(), 1);
    assert.equal(await page.locator('.asset-choice.current').isDisabled(), true);
    await page.getByRole('button', { name: 'Vælg billedet soma-b' }).click();
    await page.waitForFunction(() => document.querySelector('.status')?.textContent === 'draft');
    assert.match(dialog, /fjerner godkendelsen/);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].headers['x-soma-key'], KEY);
    assert.equal(changes[0].body.assetId, 'soma-b');
    assert.equal(changes[0].body.contentRevision, draft('one').contentRevision);
    assert.equal(await page.getByRole('button', { name: 'Godkend opslag' }).isDisabled(), false);
  } finally { await browser.close(); }
});

test('image picker keeps the draft and shows a message when the change is not pushed', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await open(browser, [draft('one', { assetId: 'soma-a', renderPath: 'renders/x.jpg' })]);
    await routeImageApi(page, {
      changeResponse: (body) => ({ results: [{ draftId: body.draftId, outcome: 'duplicate_asset' }], pushed: false }),
    });
    page.on('dialog', (item) => item.accept());
    await page.getByRole('button', { name: 'Skift billede' }).click();
    await page.waitForSelector('.asset-choice');
    await page.getByRole('button', { name: 'Vælg billedet soma-b' }).click();
    await page.waitForSelector('.send-status');
    assert.match(await page.locator('.send-status').innerText(), /samme event/);
    assert.equal(await page.locator('.status').textContent(), 'draft');
  } finally { await browser.close(); }
});

test('image picker is disabled without a session and for locally edited drafts', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const noSession = await open(browser, [draft('one')], { session: false });
    assert.equal(await noSession.page.getByRole('button', { name: 'Skift billede' }).isDisabled(), true);
    const edited = await open(browser, [draft('two', { localEdit: true })]);
    assert.equal(await edited.page.getByRole('button', { name: 'Skift billede' }).isDisabled(), true);
  } finally { await browser.close(); }
});

test('a draft changes image without a confirm dialog and the preview is reloaded with a new version', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page } = await open(browser, [draft('one', { assetId: 'soma-a', renderPath: 'renders/x.jpg', render: { sha256: 'old' } })]);
    await routeImageApi(page, {
      changeResponse: (body) => ({
        results: [{ draftId: body.draftId, outcome: 'changed', draft: draft('one', {
          status: 'draft', assetId: body.assetId, contentRevision: 'b'.repeat(64), renderPath: 'renders/x.jpg', render: { sha256: 'new' },
        }) }],
        pushed: true,
      }),
    });
    let dialogs = 0;
    page.on('dialog', (item) => { dialogs += 1; item.accept(); });
    assert.match(await page.locator('.preview > img').getAttribute('src'), /\?v=old$/);
    await page.getByRole('button', { name: 'Skift billede' }).click();
    await page.waitForSelector('.asset-choice');
    await page.getByRole('button', { name: 'Vælg billedet soma-b' }).click();
    await page.waitForFunction(() => /\?v=new$/.test(document.querySelector('.preview > img')?.getAttribute('src') || ''));
    assert.equal(dialogs, 0);
  } finally { await browser.close(); }
});
