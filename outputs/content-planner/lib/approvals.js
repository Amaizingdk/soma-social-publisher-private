'use strict';

const { transitionDraft } = require('./drafts');
const { SOMA_REPOSITORY } = require('./github-api');
const { listAllIssueComments, listAllManagedIssues } = require('./github-issues');

const TERMINAL_STATUSES = new Set(['published', 'skipped', 'rejected', 'obsolete']);

function singleMarker(issueBody, pattern) {
  const matches = [...String(issueBody || '').matchAll(pattern)];
  return matches.length === 1 ? matches[0][1].trim() : null;
}

function parseDraftMarkers(issueBody) {
  const draftId = singleMarker(issueBody, /<!-- soma-draft-id: ([^\r\n<>]+) -->/gu);
  const contentRevision = singleMarker(issueBody, /<!-- soma-content-revision: ([a-f0-9]{64}) -->/gu);
  return { draftId: draftId || null, contentRevision: contentRevision || null };
}

function approveIssueComment({ payload, drafts, approverLogin, now = new Date() }) {
  if (!Array.isArray(drafts)) throw new Error('Kladder skal være en liste');
  if (typeof approverLogin !== 'string' || !approverLogin.trim()) {
    throw new Error('SOMA_APPROVER_LOGIN mangler');
  }
  if (payload?.repository?.full_name !== SOMA_REPOSITORY) {
    return { drafts, outcome: 'wrong_repository' };
  }
  if (payload?.issue?.pull_request) return { drafts, outcome: 'pull_request' };
  if (payload?.comment?.body?.trim() !== 'GODKEND') return { drafts, outcome: 'ignored_command' };
  if (payload?.sender?.login !== approverLogin) return { drafts, outcome: 'unauthorized' };

  const marker = parseDraftMarkers(payload?.issue?.body || '');
  const index = drafts.findIndex((draft) => draft.draftId === marker.draftId);
  if (index < 0) return { drafts, outcome: 'unknown_draft' };
  const draft = drafts[index];
  if (marker.contentRevision !== draft.contentRevision) return { drafts, outcome: 'stale_revision' };
  if (TERMINAL_STATUSES.has(draft.status)) return { drafts, outcome: 'terminal' };
  if (draft.status === 'approved' && draft.approvedRevision === draft.contentRevision) {
    return { drafts, outcome: 'already_approved' };
  }
  if (draft.status === 'needs_review' && !draft.warningsAcknowledged) {
    return { drafts, outcome: 'warnings_not_acknowledged' };
  }

  const approvalTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(approvalTime.getTime())) throw new Error('Godkendelsestidspunkt er ugyldigt');
  const updated = transitionDraft(draft, {
    type: 'approve',
    at: approvalTime.toISOString(),
    approvedBy: payload.sender.login,
    approvedRevision: draft.contentRevision,
  });
  return {
    drafts: drafts.map((item, position) => position === index ? updated : item),
    outcome: 'approved',
  };
}

async function recoverApprovalsFromIssues({ drafts, client, approverLogin, now = new Date() }) {
  let current = drafts;
  const issues = await listAllManagedIssues(client, { state: 'open' });
  for (const issue of issues) {
    const comments = await listAllIssueComments(client, issue.number);
    for (const comment of comments.filter((item) => item.body?.trim() === 'GODKEND')) {
      const result = approveIssueComment({
        payload: {
          repository: { full_name: client.repository },
          issue: { number: issue.number, body: issue.body },
          comment: { id: comment.id, body: comment.body },
          sender: { login: comment.user?.login },
        },
        drafts: current,
        approverLogin,
        now,
      });
      current = result.drafts;
      if (result.outcome === 'approved' || result.outcome === 'already_approved') break;
    }
  }
  return current;
}

module.exports = {
  approveIssueComment,
  parseDraftMarkers,
  recoverApprovalsFromIssues,
};
