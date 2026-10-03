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

test('fixed generated copy change resets approval through a new revision', () => {
  const old = generated({
    status: 'approved', contentRevision: 'a'.repeat(64), approvedRevision: 'a'.repeat(64),
  });
  const changed = generated({ contentFingerprint: 'content-2', contentRevision: 'b'.repeat(64) });
  const result = reconcileDrafts([old], [changed], [{ eventKey: 'event-1', fingerprint: 'fingerprint-1' }]);
  assert.equal(result.find((draft) => draft.draftId === old.draftId).status, 'obsolete');
  const next = result.find((draft) => draft.contentRevision === 'b'.repeat(64));
  assert.equal(next.revision, 2);
  assert.equal(next.status, 'draft');
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

test('approval page edits one platform, approves all clean drafts, and exports JSON', async () => {
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
    await page.getByRole('button', { name: 'Godkend alle' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Eksportér godkendelser' }).click();
    const download = await downloadPromise;
    const saved = await download.createReadStream();
    let raw = '';
    for await (const chunk of saved) raw += chunk.toString('utf8');
    const [reviewed] = JSON.parse(raw);
    assert.equal(reviewed.platformCopies.facebookPage, 'Redigeret side-tekst');
    assert.equal(reviewed.platformCopies.instagram, 'Instagram original');
    assert.equal(reviewed.status, 'approved');
  } finally {
    await browser.close();
  }
});

test('instructor dropdown applies the choice to every draft for the same event', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const option = {
      instructor: 'Søren',
      warnings: [],
      platformCopies: { instagram: 'Søren IG', facebookPage: 'Søren side', facebookGroup: 'Søren gruppe' },
      renderPath: '../renders/sample-soren.jpg',
    };
    const drafts = ['day-before', 'event-day'].map((kind, index) => generated({
      draftId: `event-1_${kind}_r1`, slotKey: `event-1_${kind}`, kind,
      status: 'needs_review', warnings: ['instructor_missing'],
      event: { eventKey: 'event-1', date: '2026-10-20', start: '18:30', end: '20:30', name: 'Saunagus', instructor: null },
      instructorOptions: { soren: option }, renderPath: '../renders/sample-mellemrum-check.jpg',
      scheduledFor: `2026-10-${19 + index}T11:30:00+02:00`,
    }));
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.addInitScript((value) => { window.__SOMA_DRAFTS__ = value; }, drafts);
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    await page.getByLabel('Vælg gusmester').first().selectOption('soren');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Eksportér godkendelser' }).click();
    const stream = await (await downloadPromise).createReadStream();
    let raw = '';
    for await (const chunk of stream) raw += chunk.toString('utf8');
    const reviewed = JSON.parse(raw);
    assert.ok(reviewed.every((draft) => draft.manualInstructor === 'Søren'));
    assert.ok(reviewed.every((draft) => draft.status === 'draft'));
    assert.ok(reviewed.every((draft) => draft.platformCopies.instagram === 'Søren IG'));
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

test('approval page restores an approved draft after reload', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const draft = generated({
      event: { eventKey: 'event-1', date: '2026-10-06', start: '18:30', end: '20:30', name: 'Saunagus', instructor: 'Søren' },
    });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.addInitScript((value) => { window.__SOMA_DRAFTS__ = value; }, [draft]);
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    await page.getByRole('button', { name: 'Godkend opslag' }).click();
    await page.reload();
    await page.waitForSelector('.draft');
    assert.equal((await page.locator('.status').innerText()).toLowerCase(), 'approved');
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

test('weekly copy refreshed after instructor choice keeps the calm wording', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const option = {
      instructor: 'Søren',
      warnings: [],
      platformCopies: { instagram: 'Rolig IG', facebookPage: 'Rolig side', facebookGroup: 'Rolig gruppe' },
      renderPath: '../renders/sample-soren.jpg',
    };
    const eventDraft = generated({
      status: 'needs_review', warnings: ['instructor_missing'],
      event: { eventKey: 'event-1', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus', instructor: null },
      instructorOptions: { soren: option }, renderPath: '../renders/sample-mellemrum-check.jpg',
    });
    const weekly = generated({
      draftId: 'weekly_r1', slotKey: 'weekly', eventKey: null, kind: 'weekly_overview',
      events: [{ eventKey: 'event-1', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus', instructor: null }],
      platformCopies: { instagram: 'Uge IG', facebookPage: 'Uge side', facebookGroup: 'Uge gruppe' },
    });
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    await page.addInitScript((value) => { window.__SOMA_DRAFTS__ = value; }, [eventDraft, weekly]);
    const fileUrl = `file:///${path.join(__dirname, '..', 'outputs', 'content-planner', 'approval', 'index.html').replace(/\\/g, '/')}`;
    await page.goto(fileUrl);
    await page.getByLabel('Vælg gusmester').selectOption('soren');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Eksportér godkendelser' }).click();
    const stream = await (await downloadPromise).createReadStream();
    let raw = '';
    for await (const chunk of stream) raw += chunk.toString('utf8');
    const reviewed = JSON.parse(raw);
    const refreshed = reviewed.find((draft) => draft.kind === 'weekly_overview').platformCopies;
    assert.match(refreshed.facebookPage, /plads til ro/i);
    assert.doesNotMatch(JSON.stringify(refreshed), /egen energi|energien vokse/i);
  } finally {
    await browser.close();
  }
});
