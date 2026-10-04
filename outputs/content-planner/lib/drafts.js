'use strict';

const PLATFORMS = new Set(['instagram', 'facebookPage', 'facebookGroup']);

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function now(action) {
  return action.at || new Date().toISOString();
}

function baseStatus(draft) {
  return Array.isArray(draft.warnings) && draft.warnings.length ? 'needs_review' : 'draft';
}

function withHistory(draft, type, from, to, at) {
  draft.history = [...(draft.history || []), { at, type, from, to }];
  return draft;
}

function clearApproval(draft) {
  draft.approvedAt = null;
  draft.approvedBy = null;
  draft.approvedRevision = null;
  return draft;
}

function transitionDraft(input, action) {
  const draft = copy(input);
  const from = draft.status;
  const at = now(action);

  if (from === 'obsolete') throw new Error('Et forældet opslag kan ikke ændres.');

  if (action.type === 'approve') {
    if (from === 'needs_review' && !draft.warningsAcknowledged) {
      throw new Error('En advarsel skal bekræftes før godkendelse.');
    }
    draft.status = 'approved';
    draft.approvedAt = at;
    draft.approvedBy = action.approvedBy || draft.approvedBy || null;
    draft.approvedRevision = action.approvedRevision || draft.contentRevision || null;
  } else if (action.type === 'acknowledge_warnings') {
    draft.warningsAcknowledged = true;
    draft.status = 'draft';
  } else if (action.type === 'edit') {
    if (!PLATFORMS.has(action.platform)) throw new Error('Ukendt platform.');
    if (typeof action.text !== 'string' || !action.text.trim()) throw new Error('Opslagsteksten må ikke være tom.');
    draft.platformCopies[action.platform] = action.text.trim();
    draft.status = 'draft';
    clearApproval(draft);
  } else if (action.type === 'change_image' || action.type === 'change_instructor') {
    draft.status = baseStatus(draft) === 'needs_review' && !draft.warningsAcknowledged ? 'needs_review' : 'draft';
    clearApproval(draft);
  } else if (action.type === 'reject') {
    draft.status = 'rejected';
    clearApproval(draft);
  } else if (action.type === 'obsolete') {
    draft.status = 'obsolete';
    clearApproval(draft);
  } else {
    throw new Error(`Ukendt handling: ${action.type}`);
  }

  return withHistory(draft, action.type, from, draft.status, at);
}

function reconcileDrafts(previousDrafts, generatedDrafts, currentEvents) {
  const previous = copy(previousDrafts || []);
  const generated = copy(generatedDrafts || []);
  const result = [];
  const handledIds = new Set();

  for (const candidate of generated) {
    const same = previous.find((draft) =>
      draft.slotKey === candidate.slotKey
      && draft.eventFingerprint === candidate.eventFingerprint
      && draft.contentFingerprint === candidate.contentFingerprint
      && draft.scheduledFor === candidate.scheduledFor
      && draft.status !== 'obsolete');

    if (same) {
      const preserved = {
        ...candidate,
        revision: same.revision,
        draftId: same.draftId,
        status: same.status,
        platformCopies: same.platformCopies,
        approvedAt: same.approvedAt || null,
        approvedBy: same.approvedBy || null,
        approvedRevision: same.approvedRevision || null,
        githubIssueNumber: same.githubIssueNumber || null,
        reminderState: same.reminderState || null,
        warningsAcknowledged: same.warningsAcknowledged || false,
        manualInstructor: same.manualInstructor || candidate.manualInstructor || null,
        history: same.history || [],
      };
      result.push(preserved);
      handledIds.add(same.draftId);
      continue;
    }

    const published = previous.find((draft) =>
      draft.slotKey === candidate.slotKey
      && draft.status === 'published');
    if (published) {
      result.push(published);
      handledIds.add(published.draftId);
      continue;
    }

    const locked = previous.find((draft) =>
      draft.slotKey === candidate.slotKey
      && draft.status === 'approved'
      && draft.scheduledFor === candidate.scheduledFor
      && draft.contentRevision
      && draft.contentRevision === candidate.contentRevision);
    if (locked) {
      result.push({
        ...locked,
        eventFingerprint: candidate.eventFingerprint,
        contentFingerprint: candidate.contentFingerprint,
        availability: candidate.availability,
        event: candidate.event,
        events: candidate.events,
      });
      handledIds.add(locked.draftId);
      continue;
    }

    const older = previous.filter((draft) => draft.slotKey === candidate.slotKey);
    const revision = older.length ? Math.max(...older.map((draft) => Number(draft.revision) || 1)) + 1 : (candidate.revision || 1);
    for (const old of older) {
      if (!handledIds.has(old.draftId)) {
        result.push(old.status === 'obsolete' ? old : transitionDraft(old, { type: 'obsolete' }));
        handledIds.add(old.draftId);
      }
    }
    candidate.revision = revision;
    candidate.draftId = `${candidate.slotKey}_r${revision}`;
    candidate.status = baseStatus(candidate);
    candidate.approvedAt = null;
    candidate.warningsAcknowledged = false;
    candidate.history = candidate.history || [];
    result.push(candidate);
  }

  for (const old of previous) {
    if (handledIds.has(old.draftId)) continue;
    result.push(['obsolete', 'published', 'skipped'].includes(old.status)
      ? old
      : transitionDraft(old, { type: 'obsolete' }));
  }

  return result;
}

module.exports = { reconcileDrafts, transitionDraft };
