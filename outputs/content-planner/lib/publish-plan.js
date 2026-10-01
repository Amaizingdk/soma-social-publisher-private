'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { compareDraftToLiveEvent } = require('./freshness');

const AUTOMATIC_DELIVERIES = [
  { platform: 'instagram', deliveryType: 'instagram_story', width: 1080, height: 1920, suffix: 'story' },
  { platform: 'facebookPage', deliveryType: 'facebook_page_feed', width: 1080, height: 1350, suffix: 'facebook' },
];

function idempotencyKey(draft, platform) {
  return createHash('sha256')
    .update(`${draft.draftId}|${draft.revision}|${platform}`)
    .digest('hex');
}

function isValidDate(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value));
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function applyDynamicAvailability(caption, availability) {
  if (!availability || typeof caption !== 'string') return caption;
  const availabilityLine = availability.soldOut ? 'Udsolgt.' : `${availability.free} ledige pladser.`;
  let result = caption.replace(/^\s*(?:\d+\s+)?ledige pladser\.?\s*$/gim, availabilityLine);
  if (availability.soldOut) {
    result = result.replace(/^.*\b(?:book(?:e|et|er|ing)?|tilmeld)\b.*$/gim, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

function applyWeeklyDynamicAvailability(caption, availabilities) {
  if (typeof caption !== 'string' || !Array.isArray(availabilities) || availabilities.length === 0) return caption;
  let index = 0;
  let result = caption.replace(/^\s*•\s+.*$/gm, (line) => {
    const availability = availabilities[index];
    index += 1;
    if (!availability) return line;
    const clean = line.replace(/\s+·\s+(?:\d+\s+ledige pladser|Udsolgt)\s*$/i, '');
    const label = availability.soldOut ? 'Udsolgt' : `${availability.free} ledige pladser`;
    return `${clean} · ${label}`;
  });
  if (availabilities.every((availability) => availability.soldOut)) {
    result = result.replace(/^.*\b(?:book(?:e|et|er|ing)?|tilmeld)\b.*$/gim, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

async function approvedDraftProblems(draft, fileExists) {
  const reasons = [];

  if (!hasText(draft.draftId)) reasons.push('MISSING_DRAFT_ID');
  if (!Number.isInteger(draft.revision) || draft.revision < 1) reasons.push('INVALID_REVISION');
  if (!isValidDate(draft.approvedAt)) reasons.push('MISSING_APPROVED_AT');
  if (!isValidDate(draft.scheduledFor)) reasons.push('INVALID_SCHEDULED_FOR');
  if (!hasText(draft.platformCopies?.facebookPage)) reasons.push('EMPTY_FACEBOOK_PAGE_COPY');
  if (!hasText(draft.platformCopies?.instagram)) reasons.push('EMPTY_INSTAGRAM_COPY');
  if (Array.isArray(draft.warnings) && draft.warnings.length > 0 && draft.warningsAcknowledged !== true) {
    reasons.push('UNACKNOWLEDGED_WARNINGS');
  }

  if (draft.render?.width !== 1080 || draft.render?.height !== 1350) {
    reasons.push('INVALID_RENDER_DIMENSIONS');
  }

  if (!hasText(draft.render?.path) || !(await fileExists(draft.render.path))) {
    reasons.push('MISSING_RENDER_FILE');
  }

  return reasons;
}

function planItemWithHosting(draft, delivery, availability, assetHosting, availabilities = null) {
  const assetPath = `approved/${draft.draftId}-r${draft.revision}-${delivery.suffix}.jpg`;
  const baseUrl = typeof assetHosting?.baseUrl === 'string' ? assetHosting.baseUrl.replace(/\/$/, '') : null;
  return {
    draftId: draft.draftId,
    revision: draft.revision,
    platform: delivery.platform,
    deliveryType: delivery.deliveryType,
    renderSpec: { width: delivery.width, height: delivery.height },
    scheduledFor: draft.scheduledFor,
    caption: Array.isArray(availabilities)
      ? applyWeeklyDynamicAvailability(draft.platformCopies?.[delivery.platform] || '', availabilities)
      : applyDynamicAvailability(draft.platformCopies?.[delivery.platform] || '', availability),
    imagePath: draft.render.path,
    imageUrl: baseUrl ? `${baseUrl}/${assetPath}` : null,
    assetPath,
    idempotencyKey: idempotencyKey(draft, delivery.deliveryType),
  };
}

async function buildDryRunPlan(drafts, {
  generatedAt = new Date(),
  fileExists = async (filePath) => fs.stat(filePath).then((stat) => stat.isFile(), () => false),
  liveEvents = null,
  now = generatedAt,
  maxCalendarAgeMs,
  assetHosting = null,
} = {}) {
  if (!Array.isArray(drafts)) throw new TypeError('Kladder skal være en liste');
  if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.getTime())) {
    throw new TypeError('generatedAt skal være et gyldigt tidspunkt');
  }

  const automatic = [];
  const manual = [];
  const blocked = [];
  let skippedDrafts = 0;
  let approvedDrafts = 0;

  for (const draft of drafts) {
    if (!draft || draft.status !== 'approved') {
      skippedDrafts += 1;
      continue;
    }

    const reasons = await approvedDraftProblems(draft, fileExists);
    let availability = null;
    let availabilities = null;
    if (Array.isArray(liveEvents)) {
      const freshness = compareDraftToLiveEvent(draft, liveEvents, { now, maxAgeMs: maxCalendarAgeMs });
      reasons.push(...freshness.reasons);
      availability = freshness.availability;
      availabilities = freshness.availabilities;
    }
    if (reasons.length > 0) {
      blocked.push({ draftId: draft.draftId, revision: draft.revision, reasons });
      continue;
    }

    approvedDrafts += 1;
    for (const delivery of AUTOMATIC_DELIVERIES) automatic.push(planItemWithHosting(draft, delivery, availability, assetHosting, availabilities));
    manual.push({
      ...planItemWithHosting(draft, {
        platform: 'facebookGroup', deliveryType: 'facebook_group_manual', width: 1080, height: 1350, suffix: 'group',
      }, availability, assetHosting, availabilities),
      delivery: 'manual_required',
    });
  }

  return {
    schemaVersion: 1,
    mode: 'dry_run',
    generatedAt: generatedAt.toISOString(),
    metaValidation: { status: 'not_requested' },
    automatic,
    manual,
    blocked,
    summary: {
      totalDrafts: drafts.length,
      approvedDrafts,
      skippedDrafts,
      blockedDrafts: blocked.length,
      automaticPosts: automatic.length,
      manualPosts: manual.length,
    },
  };
}

module.exports = {
  buildDryRunPlan,
  idempotencyKey,
  applyDynamicAvailability,
  applyWeeklyDynamicAvailability,
  planItemWithHosting,
};
