'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const {
  reconcileDrafts,
  transitionDraft,
} = require('../outputs/content-planner/lib/drafts');
const { contentRevisionFor } = require('../outputs/content-planner/lib/draft-lifecycle');

function generated(changes = {}) {
  return {
    draftId: 'event-1_event-day_r1',
    slotKey: 'event-1_event-day',
    eventKey: 'event-1',
    eventFingerprint: 'fingerprint-1',
    contentFingerprint: 'content-1',
    revision: 1,
    status: 'draft',
    scheduledFor: '2026-10-18T07:00:00+02:00',
    warnings: [],
    platformCopies: {
      instagram: 'Instagram original',
      facebookPage: 'Side original',
      facebookGroup: 'Gruppe original',
    },
    history: [],
    ...changes,
  };
}

test('new drafts start draft or needs_review according to warnings', () => {
  const clean = reconcileDrafts([], [generated()], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  const warned = reconcileDrafts([], [generated({ warnings: ['unknown_instructor'] })], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  assert.equal(clean[0].status, 'draft');
  assert.equal(warned[0].status, 'needs_review');
});

test('approve records timestamp and editing returns approved draft to draft', () => {
  const revision = contentRevisionFor(generated());
  const approved = transitionDraft(generated({ contentRevision: revision }), {
    type: 'approve',
    at: '2026-09-29T10:00:00Z',
    approvedBy: 'Amaizingai',
    approvedRevision: revision,
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedAt, '2026-09-29T10:00:00Z');
  assert.equal(approved.approvedBy, 'Amaizingai');
  assert.equal(approved.approvedRevision, revision);
  const edited = transitionDraft(approved, {
    type: 'edit', platform: 'instagram', text: 'Ny Instagramtekst', at: '2026-09-29T10:05:00Z',
  });
  assert.equal(edited.status, 'draft');
  assert.equal(edited.approvedAt, null);
  assert.equal(edited.approvedBy, null);
  assert.equal(edited.approvedRevision, null);
  assert.equal(edited.platformCopies.instagram, 'Ny Instagramtekst');
  assert.equal(edited.platformCopies.facebookPage, 'Side original');
});

test('warnings must be acknowledged before approval', () => {
  const warned = generated({ status: 'needs_review', warnings: ['unknown_instructor'] });
  assert.throws(() => transitionDraft(warned, { type: 'approve' }), /advarsel/i);
  const acknowledged = transitionDraft(warned, { type: 'acknowledge_warnings' });
  assert.equal(transitionDraft(acknowledged, { type: 'approve' }).status, 'approved');
});

test('changed event preserves old draft as obsolete and creates next revision', () => {
  const old = generated({ status: 'approved' });
  const changed = generated({ eventFingerprint: 'fingerprint-2' });
  const result = reconcileDrafts([old], [changed], [{ eventKey: 'event-1', fingerprint: 'fingerprint-2' }]);
  assert.equal(result.find((draft) => draft.draftId === old.draftId).status, 'obsolete');
  const next = result.find((draft) => draft.eventFingerprint === 'fingerprint-2');
  assert.equal(next.revision, 2);
  assert.equal(next.draftId, 'event-1_event-day_r2');
  assert.equal(next.status, 'draft');
});

test('changed scheduled time invalidates prior approval and creates a review revision', () => {
  const old = generated({ status: 'approved', approvedAt: '2026-10-02T12:00:00Z', approvedRevision: 'same-copy' });
  const changed = generated({ scheduledFor: '2026-10-03T10:00:00+02:00' });
  const result = reconcileDrafts([old], [changed], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  const next = result.find((draft) => draft.scheduledFor === changed.scheduledFor);

  assert.equal(result.find((draft) => draft.draftId === old.draftId).status, 'obsolete');
  assert.equal(next.revision, 2);
  assert.equal(next.status, 'draft');
  assert.equal(next.approvedRevision, undefined);
});

test('changed scheduled time never reopens an already published slot', () => {
  const published = generated({ status: 'published' });
  const changed = generated({ scheduledFor: '2026-10-03T10:00:00+02:00' });
  const result = reconcileDrafts([published], [changed], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);

  assert.equal(result.length, 1);
  assert.equal(result[0].draftId, published.draftId);
  assert.equal(result[0].status, 'published');
  assert.equal(result[0].scheduledFor, published.scheduledFor);
});

test('availability-only generated copy keeps approval and refreshes volatile availability', () => {
  const base = generated({ availability: { free: 8, soldOut: false } });
  const revision = contentRevisionFor(base);
  const old = generated({
    status: 'approved', availability: { free: 8, soldOut: false },
    contentRevision: revision, approvedRevision: revision, approvedBy: 'Amaizingai',
  });
  const changed = generated({
    availability: { free: 2, soldOut: false },
    contentFingerprint: 'content-2',
    contentRevision: revision,
    platformCopies: {
      instagram: 'Instagram med 2 ledige pladser',
      facebookPage: 'Side med 2 ledige pladser',
      facebookGroup: 'Gruppe med 2 ledige pladser',
    },
  });
  const result = reconcileDrafts([old], [changed], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'approved');
  assert.equal(result[0].availability.free, 2);
  assert.equal(result[0].platformCopies.instagram, 'Instagram original');
  assert.equal(result[0].approvedRevision, revision);
});

test('changed generated copy creates a new revision for an unapproved draft', () => {
  const old = generated({ status: 'draft' });
  const changed = generated({ contentFingerprint: 'content-2' });
  const result = reconcileDrafts([old], [changed], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  assert.equal(result.find((draft) => draft.draftId === old.draftId).status, 'obsolete');
  const next = result.find((draft) => draft.contentFingerprint === 'content-2');
  assert.equal(next.revision, 2);
  assert.equal(next.status, 'draft');
});

test('removed event marks old unposted draft obsolete', () => {
  const result = reconcileDrafts([generated()], [], []);
  assert.equal(result[0].status, 'obsolete');
});

test('reconciliation is safe when an earlier draft is already obsolete', () => {
  const obsolete = { ...generated(), status: 'obsolete' };
  const result = reconcileDrafts([obsolete], [], []);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'obsolete');
});

test('reconciliation preserves published and skipped history after events leave the calendar', () => {
  const terminal = [
    generated({ draftId: 'published-1', status: 'published' }),
    generated({ draftId: 'skipped-1', status: 'skipped', skipReason: 'expired_event' }),
  ];
  assert.deepEqual(reconcileDrafts(terminal, [], []), terminal);
});

test('approval page edits one platform, blocks local approval, and exports JSON', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript((drafts) => { window.__SOMA_DRAFTS__ = drafts; }, [generated({
      renderPath: '../renders/sample-mellemrum-check.jpg',
      event: { date: '2026-10-18', start: '10:00', end: '12:00', name: 'Saunagus', instructor: 'Millemaja', booked: 1, capacity: 12 },
      availability: { free: 11, label: 'ledige pladser', soldOut: false },
      factsUsed: ['event.date'],
    })]);
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    await page.getByRole('button', { name: 'Facebook-side' }).click();
    const editor = page.locator('textarea[data-platform="facebookPage"]');
    await editor.fill('Redigeret side-tekst');
    await page.getByRole('button', { name: 'Gem ændringer' }).click();
    assert.equal(await page.getByRole('button', { name: 'Godkend alle' }).isDisabled(), true);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Eksportér godkendelser' }).click();
    const download = await downloadPromise;
    const saved = await download.createReadStream();
    let raw = '';
    for await (const chunk of saved) raw += chunk.toString('utf8');
    const [reviewed] = JSON.parse(raw);
    assert.equal(reviewed.platformCopies.facebookPage, 'Redigeret side-tekst');
    assert.equal(reviewed.platformCopies.instagram, 'Instagram original');
    assert.equal(reviewed.status, 'draft');
    assert.equal('localEdit' in reviewed, false);
  } finally {
    await browser.close();
  }
});

test('approval page resolves a portable render path to a real preview image', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = generated({
      renderPath: 'renders/2026-10-04_16-00_saunagus_event-day-7d781a2cd4-soren.jpg',
      event: { date: '2099-10-04', start: '16:00', end: '18:00', name: 'Saunagus', instructor: 'Søren' },
    });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.addInitScript((value) => { window.__SOMA_DRAFTS__ = value; }, [draft]);
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    const image = page.locator('.preview img');
    await image.waitFor({ state: 'attached' });
    await page.waitForFunction((node) => node.complete, await image.elementHandle());
    assert.ok(
      await image.evaluate((node) => node.naturalWidth > 0),
      `Billedet kunne ikke indlæses: ${await image.getAttribute('src')}`,
    );
  } finally {
    await browser.close();
  }
});

test('approval page shows only drafts with at least one event that has not ended', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const drafts = [
      generated({
        draftId: 'ended-event',
        event: { date: '2000-01-01', start: '10:00', end: '12:00', name: 'Afsluttet gus' },
      }),
      generated({
        draftId: 'future-event',
        event: { date: '2099-01-01', start: '10:00', end: '12:00', name: 'Fremtidigt gus' },
      }),
      generated({
        draftId: 'ended-weekly', kind: 'weekly_overview', event: null,
        events: [
          { date: '2000-01-01', start: '10:00', end: '12:00', name: 'Afsluttet gus' },
        ],
      }),
      generated({
        draftId: 'mixed-weekly', kind: 'weekly_overview', event: null,
        events: [
          { date: '2000-01-01', start: '10:00', end: '12:00', name: 'Afsluttet gus' },
          { date: '2099-01-01', start: '10:00', end: '12:00', name: 'Fremtidigt gus' },
        ],
      }),
    ];
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    const endpoint = 'http://127.0.0.1:47831/approve';
    await page.route(endpoint, async (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const { items } = JSON.parse(route.request().postData());
      return route.fulfill({
        status: 200,
        headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ results: items.map((item) => ({ draftId: item.draftId, outcome: 'approved' })), pushed: true }),
      });
    });
    await page.addInitScript((value) => {
      window.__SOMA_DRAFTS__ = value.drafts;
      window.__SOMA_SESSION__ = { key: 'k'.repeat(48), endpoint: value.endpoint };
    }, { drafts: drafts.map((draft) => ({ ...draft, contentRevision: 'a'.repeat(64) })), endpoint });
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);

    assert.deepEqual(
      await page.locator('.draft').evaluateAll((cards) => cards.map((card) => card.dataset.draftId)),
      ['future-event', 'mixed-weekly'],
    );

    await page.getByRole('button', { name: 'Godkend alle' }).click();
    await page.waitForFunction(() => document.querySelector('.draft[data-draft-id="mixed-weekly"] .status')?.textContent === 'approved');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Eksportér godkendelser' }).click();
    const stream = await (await downloadPromise).createReadStream();
    let raw = '';
    for await (const chunk of stream) raw += chunk.toString('utf8');
    const reviewed = JSON.parse(raw);
    assert.equal(reviewed.find((draft) => draft.draftId === 'ended-event').status, 'draft');
    assert.equal(reviewed.find((draft) => draft.draftId === 'future-event').status, 'approved');
    assert.equal(reviewed.find((draft) => draft.draftId === 'mixed-weekly').status, 'approved');
  } finally {
    await browser.close();
  }
});

test('known instructor appears only under the Gusmester field in the review card', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = generated({
      event: { eventKey: 'event-1', date: '2026-10-15', start: '18:30', end: '20:30', name: 'Saunagus', instructor: 'Søren' },
      platformCopies: { instagram: 'Neutral tekst', facebookPage: 'Neutral tekst', facebookGroup: 'Neutral tekst' },
    });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.addInitScript((value) => { window.__SOMA_DRAFTS__ = value; }, [draft]);
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    await page.waitForSelector('.draft');
    assert.doesNotMatch(await page.locator('.meta').innerText(), /Søren/i);
    assert.match(await page.locator('.instructor-picker').innerText(), /Gusmester\s+Søren/i);
  } finally {
    await browser.close();
  }
});

test('approval page never revives an obsolete revision from browser storage', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const obsolete = generated({ draftId: 'weekly_r1', kind: 'weekly_overview', status: 'obsolete' });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.addInitScript((value) => {
      window.__SOMA_DRAFTS__ = [value.draft];
      localStorage.setItem('soma-content-planner-review-v1', JSON.stringify([{
        ...value.draft,
        status: 'draft',
      }]));
    }, { draft: obsolete });
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    assert.equal(await page.locator('.draft').count(), 0);
    assert.match(await page.locator('#drafts').innerText(), /ingen aktuelle kladder/i);
  } finally {
    await browser.close();
  }
});


test('approved draft survives a changed content fingerprint (code change) with same event and time', () => {
  const old = generated({
    status: 'approved', contentRevision: 'rev-a', approvedRevision: 'rev-a', approvedAt: '2026-10-03T11:37:00Z',
  });
  const regenerated = generated({ contentFingerprint: 'content-2', contentRevision: 'rev-b' });
  const result = reconcileDrafts([old], [regenerated], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  const kept = result.filter((draft) => draft.status !== 'obsolete');

  assert.equal(result.length, 1);
  assert.equal(kept[0].draftId, old.draftId);
  assert.equal(kept[0].status, 'approved');
  assert.equal(kept[0].approvedRevision, 'rev-a');
  assert.equal(kept[0].contentRevision, 'rev-a');
  assert.equal(kept[0].platformCopies.instagram, 'Instagram original');
});

test('unapproved draft with a changed content fingerprint still gets a new revision', () => {
  const old = generated({ status: 'draft', contentRevision: 'rev-a' });
  const regenerated = generated({ contentFingerprint: 'content-2', contentRevision: 'rev-b' });
  const result = reconcileDrafts([old], [regenerated], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  assert.equal(result.find((draft) => draft.draftId === old.draftId).status, 'obsolete');
  assert.equal(result.find((draft) => draft.revision === 2).status, 'draft');
});
