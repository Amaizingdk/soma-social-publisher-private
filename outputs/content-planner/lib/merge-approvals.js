'use strict';

const TERMINAL_STATUSES = new Set(['published', 'skipped', 'rejected', 'obsolete']);

function mergeApprovals(generated, remote) {
  const remoteById = new Map((remote || []).map((draft) => [draft.draftId, draft]));
  return (generated || []).map((draft) => {
    const approval = remoteById.get(draft.draftId);
    if (approval && approval.status !== 'obsolete' && TERMINAL_STATUSES.has(approval.status)) return approval;
    if (!approval || approval.status !== 'approved') return draft;
    if (approval.approvedRevision !== approval.contentRevision) return draft;
    if (draft.contentRevision !== approval.contentRevision) return draft;
    if (TERMINAL_STATUSES.has(draft.status)) return draft;
    return {
      ...draft,
      status: 'approved',
      approvedAt: approval.approvedAt,
      approvedBy: approval.approvedBy,
      approvedRevision: approval.approvedRevision,
    };
  });
}

module.exports = { mergeApprovals };
