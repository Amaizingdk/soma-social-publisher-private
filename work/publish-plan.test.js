'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildDryRunPlan,
  applyDynamicAvailability,
  idempotencyKey,
} = require('../outputs/content-planner/lib/publish-plan');

const GENERATED_AT = new Date('2026-09-30T08:00:00Z');

async function approvedDraft(overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-publish-plan-'));
  const imagePath = path.join(directory, 'approved.jpg');
  await fs.writeFile(imagePath, 'test image fixture');

  const base = {
    draftId: 'approved_r1',
    revision: 1,
    status: 'approved',
    approvedAt: '2026-09-30T07:00:00Z',
    scheduledFor: '2026-10-01T11:30:00+02:00',
    warnings: [],
    warningsAcknowledged: false,
    platformCopies: {
      facebookPage: 'Facebook-side tekst',
      instagram: 'Instagram-tekst',
      facebookGroup: 'Facebook-gruppe tekst',
    },
    render: { path: imagePath, width: 1080, height: 1350 },
  };

  return {
    ...base,
    ...overrides,
    platformCopies: { ...base.platformCopies, ...(overrides.platformCopies || {}) },
    render: { ...base.render, ...(overrides.render || {}) },
  };
}

test('includes only active approved drafts with complete evidence and keeps groups manual', async () => {
  // Mutations caught: loosening status checks or treating the Facebook Group as automatic.
  const valid = await approvedDraft();
  const unapproved = await approvedDraft({ draftId: 'draft_r1', status: 'draft', approvedAt: null });
  const obsolete = await approvedDraft({ draftId: 'obsolete_r1', status: 'obsolete' });

  const plan = await buildDryRunPlan([valid, unapproved, obsolete], { generatedAt: GENERATED_AT });

  assert.deepEqual(plan.automatic.map((item) => item.platform), ['instagram', 'facebookPage']);
  assert.equal(plan.manual.length, 1);
  assert.equal(plan.manual[0].platform, 'facebookGroup');
  assert.equal(plan.manual[0].delivery, 'manual_required');
  assert.equal(plan.summary.approvedDrafts, 1);
  assert.equal(plan.summary.skippedDrafts, 2);
  assert.equal(plan.summary.blockedDrafts, 0);
  assert.equal(plan.metaValidation.status, 'not_requested');
});

test('routes approved calendar content to Instagram Story and Facebook Page Feed only', async () => {
  const draft = await approvedDraft();
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.automatic.map((item) => item.deliveryType), [
    'instagram_story',
    'facebook_page_feed',
  ]);
  assert.equal(plan.automatic.some((item) => item.deliveryType === 'instagram_feed'), false);
  assert.deepEqual(plan.automatic.map((item) => item.renderSpec), [
    { width: 1080, height: 1920 },
    { width: 1080, height: 1350 },
  ]);
  assert.equal(plan.manual[0].deliveryType, 'facebook_group_manual');
});

test('blocks an approved draft without approval evidence', async () => {
  // Mutation caught: ignoring approvedAt evidence.
  const draft = await approvedDraft({ approvedAt: null });
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['MISSING_APPROVED_AT']);
});

test('blocks unacknowledged warnings but permits an explicitly acknowledged warning', async () => {
  // Mutation caught: silently accepting review warnings.
  const blocked = await approvedDraft({ warnings: ['Kontrollér navn'], warningsAcknowledged: false });
  const allowed = await approvedDraft({ draftId: 'approved_r2', revision: 2, warnings: ['Kontrollér navn'], warningsAcknowledged: true });
  const plan = await buildDryRunPlan([blocked, allowed], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['UNACKNOWLEDGED_WARNINGS']);
  assert.equal(plan.summary.approvedDrafts, 1);
});

test('blocks empty required platform copy', async () => {
  // Mutation caught: accepting incomplete automatic copy.
  const draft = await approvedDraft({ platformCopies: { instagram: '   ' } });
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['EMPTY_INSTAGRAM_COPY']);
});

test('blocks a missing render file', async () => {
  // Mutation caught: trusting a path without verifying the image exists.
  const draft = await approvedDraft({ render: { path: path.join(os.tmpdir(), `missing-${Date.now()}.jpg`) } });
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['MISSING_RENDER_FILE']);
});

test('blocks wrong registered dimensions', async () => {
  // Mutation caught: allowing a render that does not match the approved format.
  const draft = await approvedDraft({ render: { width: 1200, height: 1200 } });
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['INVALID_RENDER_DIMENSIONS']);
});

test('blocks an invalid scheduled time', async () => {
  // Mutation caught: queuing a draft without a usable schedule.
  const draft = await approvedDraft({ scheduledFor: 'not-a-date' });
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['INVALID_SCHEDULED_FOR']);
});

test('blocks an approved draft without a stable identity', async () => {
  const draft = await approvedDraft({ draftId: '', revision: 0 });
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['MISSING_DRAFT_ID', 'INVALID_REVISION']);
});

test('does not accept a directory as a render file', async () => {
  const draft = await approvedDraft();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-render-directory-'));
  draft.render.path = directory;
  const plan = await buildDryRunPlan([draft], { generatedAt: GENERATED_AT });
  assert.deepEqual(plan.blocked[0].reasons, ['MISSING_RENDER_FILE']);
});

test('updates dynamic availability without requiring a new approval', async () => {
  const draft = await approvedDraft({
    eventKey: 'event-1',
    platformCopies: {
      facebookPage: 'Facebook-side tekst\n\n8 ledige pladser.',
      instagram: 'Instagram-tekst\n\n8 ledige pladser.',
    },
    event: {
      eventKey: 'event-1', date: '2026-10-01', start: '18:30', end: '20:30', name: 'Saunagus', booked: 4, capacity: 12,
    },
    availability: { free: 8 },
  });
  const plan = await buildDryRunPlan([draft], {
    generatedAt: GENERATED_AT,
    liveEvents: [{
      eventKey: 'event-1', date: '2026-10-01', start: '18:30', end: '20:30', name: 'Saunagus', booked: 6, capacity: 12,
      readAt: '2026-09-30T07:30:00Z',
    }],
    now: GENERATED_AT,
    maxCalendarAgeMs: 60 * 60 * 1000,
  });
  assert.equal(plan.summary.approvedDrafts, 1);
  assert.equal(plan.blocked.length, 0);
  assert.match(plan.automatic.find((item) => item.platform === 'instagram').caption, /6 ledige pladser/);
});

test('adds each weekly event live availability to the Facebook caption', async () => {
  const events = [
    { eventKey: 'a', date: '2026-10-06', start: '18:30', end: '20:30', name: 'Saunagus', booked: 0, capacity: 12 },
    { eventKey: 'b', date: '2026-10-08', start: '18:30', end: '20:30', name: 'Saunagus', booked: 0, capacity: 12 },
  ];
  const draft = await approvedDraft({
    kind: 'weekly_overview',
    event: null,
    events,
    platformCopies: {
      facebookPage: 'Næste uge:\n\n• 6. oktober · Saunagus\n• 8. oktober · Saunagus\n\nBook via kalenderen',
      instagram: 'Næste uge:\n\n• 6. oktober · Saunagus\n• 8. oktober · Saunagus',
    },
  });
  const plan = await buildDryRunPlan([draft], {
    generatedAt: GENERATED_AT,
    now: GENERATED_AT,
    liveEvents: [
      { ...events[0], booked: 6, readAt: '2026-09-30T07:30:00Z' },
      { ...events[1], booked: 12, readAt: '2026-09-30T07:30:00Z' },
    ],
    maxCalendarAgeMs: 60 * 60 * 1000,
  });
  const caption = plan.automatic.find((item) => item.deliveryType === 'facebook_page_feed').caption;
  assert.match(caption, /6\. oktober · Saunagus · 6 ledige pladser/);
  assert.match(caption, /8\. oktober · Saunagus · Udsolgt/);
});

test('idempotency keys are stable and change by revision or platform', () => {
  const draft = { draftId: 'approved_r1', revision: 1 };
  const first = idempotencyKey(draft, 'instagram');
  const repeated = idempotencyKey(draft, 'instagram');
  const revised = idempotencyKey({ ...draft, revision: 2 }, 'instagram');
  const otherPlatform = idempotencyKey(draft, 'facebookPage');

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, repeated);
  assert.notEqual(first, revised);
  assert.notEqual(first, otherPlatform);
});

test('approved plan items include the configured public asset URL', async () => {
  const draft = await approvedDraft();
  const plan = await buildDryRunPlan([draft], {
    assetHosting: { baseUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main' },
  });
  assert.equal(plan.automatic[0].imageUrl, 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main/approved/approved_r1-r1-story.jpg');
});

test('renders sold-out availability without leaving a booking call to action', () => {
  const caption = applyDynamicAvailability(
    'Kom med i varmen.\n\n8 ledige pladser.\n\nBook din plads: https://somasaunagus.dk/kalender/',
    { booked: 12, capacity: 12, free: 0, soldOut: true },
  );
  assert.match(caption, /Udsolgt\./);
  assert.doesNotMatch(caption, /ledige pladser|book din plads/i);
});
