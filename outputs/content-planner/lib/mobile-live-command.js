'use strict';

const { parseDraftMarkers } = require('./approvals');
const { SOMA_REPOSITORY } = require('./github-api');

const COMMANDS = Object.freeze({
  'PUBLICER STORY': 'instagram_story',
  'PUBLICER FACEBOOK': 'facebook_page_feed',
});

const SAFE_DRAFT_ID = /^[A-Za-z0-9._-]{1,200}$/u;

function parseMobileLiveCommand(value) {
  const command = typeof value === 'string' ? value.trim() : '';
  const deliveryType = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  return deliveryType ? { command, deliveryType } : null;
}

function isPublishedDelivery(ledger, draft, deliveryType) {
  return Array.isArray(ledger?.entries) && ledger.entries.some((entry) => (
    entry.draftId === draft.draftId
    && entry.revision === draft.revision
    && entry.deliveryType === deliveryType
    && entry.status === 'published'
  ));
}

function denied(outcome, details = {}) {
  return { outcome, accepted: false, ...details };
}

function evaluateMobileLiveCommand({
  payload,
  drafts,
  ledger,
  approverLogin,
  automationEnabled,
  now = new Date(),
}) {
  if (!Array.isArray(drafts)) throw new Error('Kladder skal være en liste');
  if (!Array.isArray(ledger?.entries)) throw new Error('Publiceringsledger er ugyldig');
  if (typeof approverLogin !== 'string' || !approverLogin.trim()) {
    throw new Error('SOMA_APPROVER_LOGIN mangler');
  }

  const parsed = parseMobileLiveCommand(payload?.comment?.body);
  if (!parsed) return denied('ignored_command');
  if (payload?.action !== 'created') return denied('wrong_action');
  if (payload?.repository?.full_name !== SOMA_REPOSITORY) return denied('wrong_repository');
  if (payload?.issue?.pull_request) return denied('pull_request');
  if (payload?.sender?.login !== approverLogin) return denied('unauthorized');
  if (automationEnabled !== 'false') return denied('automation_not_safely_disabled');

  const markers = parseDraftMarkers(payload?.issue?.body || '');
  const selected = drafts.filter((item) => item.draftId === markers.draftId);
  if (selected.length !== 1) return denied('unknown_draft');
  const draft = selected[0];
  if (!SAFE_DRAFT_ID.test(draft.draftId)) return denied('unsafe_draft_id');

  const issueNumber = Number(payload?.issue?.number);
  const commentId = Number(payload?.comment?.id);
  if (!Number.isInteger(issueNumber) || issueNumber < 1 || !Number.isInteger(commentId) || commentId < 1) {
    return denied('invalid_event_identity');
  }
  if (issueNumber !== Number(draft.githubIssueNumber)) return denied('wrong_issue');
  if (markers.contentRevision !== draft.contentRevision) return denied('stale_revision');
  if (draft.status !== 'approved' || draft.approvedRevision !== draft.contentRevision) {
    return denied('not_currently_approved');
  }

  const dueAt = Date.parse(draft.scheduledFor);
  const checkedAt = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(dueAt) || !Number.isFinite(checkedAt)) return denied('invalid_time');
  if (checkedAt < dueAt) return denied('too_early', { scheduledFor: draft.scheduledFor });
  if (isPublishedDelivery(ledger, draft, parsed.deliveryType)) {
    return denied('already_published', {
      draftId: draft.draftId,
      deliveryType: parsed.deliveryType,
    });
  }
  if (
    parsed.deliveryType === 'facebook_page_feed'
    && !isPublishedDelivery(ledger, draft, 'instagram_story')
  ) return denied('story_required');

  return {
    outcome: 'accepted',
    accepted: true,
    ...parsed,
    draftId: draft.draftId,
    revision: draft.revision,
    contentRevision: draft.contentRevision,
    issueNumber,
    commentId,
  };
}

module.exports = {
  evaluateMobileLiveCommand,
  isPublishedDelivery,
  parseMobileLiveCommand,
  SAFE_DRAFT_ID,
};
