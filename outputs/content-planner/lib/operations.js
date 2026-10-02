'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { recoverApprovalsFromIssues } = require('./approvals');
const { reconcileLifecycle } = require('./draft-lifecycle');
const { commentOnce, syncDraftIssue } = require('./github-issues');
const { writeJsonAtomic } = require('./io');
const { markReminderSent, reminderDecision } = require('./reminders');

const REQUIRED_DELIVERIES = ['instagram_story', 'facebook_page_feed'];
const ACTIVE_ISSUE_STATUSES = new Set(['draft', 'needs_review', 'approved', 'needs_correction']);
const TERMINAL_ISSUE_STATUSES = new Set(['published', 'skipped', 'rejected', 'obsolete']);

function reminderBody(draft, decision, approverLogin) {
  const deadline = String(draft.scheduledFor || 'ukendt');
  if (decision.kind === 'urgent') {
    return '@' + approverLogin + ' — kladden blev opdaget mindre end 24 timer før publicering. '
      + 'Gennemgå den straks og skriv kun `GODKEND`, hvis den er klar. Deadline: ' + deadline + '.';
  }
  return '@' + approverLogin + ' — der er cirka ' + decision.kind.replace('h', '')
    + ' timer til planlagt publicering. Gennemgå kladden og skriv kun `GODKEND`, hvis den er klar. '
    + 'Deadline: ' + deadline + '.';
}

async function syncIssuesAndReminders({
  drafts,
  ledger,
  client,
  approverLogin,
  now = new Date(),
  createTerminalIds = new Set(),
}) {
  const updated = [];
  for (const input of drafts) {
    let draft = await syncDraftIssue({
      client,
      draft: input,
      ledger,
      repository: client.repository,
      createIfMissing: ACTIVE_ISSUE_STATUSES.has(input.status) || createTerminalIds.has(input.draftId),
    });

    if (
      draft.githubIssueNumber
      && draft.status === 'skipped'
      && draft.skipReason === 'missing_approval_at_publish_time'
    ) {
      await commentOnce({
        client,
        issueNumber: draft.githubIssueNumber,
        marker: 'soma-skip:' + draft.draftId + ':missing_approval_at_publish_time',
        body: '@' + approverLogin + ' — godkendelsesfristen blev overskredet. Kladde er sprunget over og bliver ikke bagud-publiceret.',
      });
    }

    const decision = reminderDecision(draft, now);
    if (decision) {
      const marker = ['soma-reminder', draft.draftId, draft.contentRevision, decision.kind].join(':');
      await commentOnce({
        client,
        issueNumber: draft.githubIssueNumber,
        marker,
        body: reminderBody(draft, decision, approverLogin),
      });
      draft = markReminderSent(draft, decision, now);
    }
    updated.push(draft);
  }
  return updated;
}

function reconcilePublicationState(drafts, ledger, now = new Date()) {
  if (!Array.isArray(drafts)) throw new Error('Kladder skal være en liste');
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  return drafts.map((draft) => {
    if (['skipped', 'rejected', 'obsolete'].includes(draft.status)) return draft;
    const own = entries.filter((entry) => (
      entry.draftId === draft.draftId
      && (entry.revision === undefined || entry.revision === draft.revision)
    ));
    if (own.some((entry) => entry.status === 'manual_review_required')) {
      return {
        ...draft,
        status: 'needs_correction',
        correctionReason: 'manual_review_required',
        approvedAt: null,
        approvedBy: null,
        approvedRevision: null,
      };
    }
    if (REQUIRED_DELIVERIES.every((deliveryType) => (
      own.some((entry) => entry.deliveryType === deliveryType && entry.status === 'published')
    ))) {
      const times = own.map((entry) => Date.parse(entry.publishedAt)).filter(Number.isFinite);
      return {
        ...draft,
        status: 'published',
        publishedAt: times.length ? new Date(Math.max(...times)).toISOString() : now.toISOString(),
      };
    }
    return draft;
  });
}

async function syncPublicationIssues({ drafts, ledger, client, now = new Date() }) {
  const reconciled = reconcilePublicationState(drafts, ledger, now);
  const updated = [];
  for (const draft of reconciled) {
    updated.push(await syncDraftIssue({
      client,
      draft,
      ledger,
      repository: client.repository,
      createIfMissing: ACTIVE_ISSUE_STATUSES.has(draft.status) || draft.status === 'published',
    }));
  }
  return updated;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(label + ' kunne ikke læses som JSON', { cause: error });
  }
}

async function runOperationsSync({
  now = new Date(),
  paths = {},
  client,
  planner,
  drafts: suppliedDrafts,
  ledger: suppliedLedger,
  approverLogin,
  writeApprovalPayloadImpl,
} = {}) {
  if (!client?.repository) throw new Error('GitHub-klient mangler');
  if (typeof approverLogin !== 'string' || !approverLogin.trim()) {
    throw new Error('SOMA_APPROVER_LOGIN mangler');
  }
  const outputDir = paths.outputDir;
  const draftsPath = paths.draftsPath || (outputDir ? path.join(outputDir, 'drafts.json') : null);
  const ledgerPath = paths.ledgerPath || (outputDir ? path.join(outputDir, 'state', 'publish-ledger.json') : null);

  let plannerResult = null;
  if (planner) {
    if (!outputDir) throw new Error('Operations-outputmappe mangler');
    plannerResult = await planner({ live: true, outputDir, now });
  }
  let drafts = suppliedDrafts || plannerResult?.drafts;
  if (!drafts && draftsPath) drafts = await readJson(draftsPath, 'Kladder');
  if (!Array.isArray(drafts)) throw new Error('Kladder skal være en liste');

  let ledger = suppliedLedger;
  if (!ledger && ledgerPath) {
    try {
      ledger = await readJson(ledgerPath, 'Publiceringsledger');
    } catch (error) {
      if (error.cause?.code !== 'ENOENT') throw error;
    }
  }
  ledger ||= { version: 1, entries: [] };
  if (!Array.isArray(ledger.entries)) throw new Error('Publiceringsledger er ugyldig');

  drafts = reconcilePublicationState(drafts, ledger, now);
  drafts = await recoverApprovalsFromIssues({ drafts, client, approverLogin, now });
  const beforeLifecycle = new Map(drafts.map((draft) => [draft.draftId, draft.status]));
  drafts = reconcileLifecycle(drafts, { now });
  const createTerminalIds = new Set(drafts
    .filter((draft) => (
      TERMINAL_ISSUE_STATUSES.has(draft.status)
      && !TERMINAL_ISSUE_STATUSES.has(beforeLifecycle.get(draft.draftId))
    ))
    .map((draft) => draft.draftId));
  drafts = await syncIssuesAndReminders({
    drafts,
    ledger,
    client,
    approverLogin,
    now,
    createTerminalIds,
  });

  if (draftsPath) await writeJsonAtomic(draftsPath, drafts);
  if (outputDir && writeApprovalPayloadImpl) await writeApprovalPayloadImpl(outputDir, drafts);

  return {
    drafts,
    ledger,
    issues: drafts.filter((draft) => draft.githubIssueNumber).length,
    reminders: drafts.filter((draft) => draft.reminderState?.revision === draft.contentRevision).length,
  };
}

module.exports = {
  REQUIRED_DELIVERIES,
  reconcilePublicationState,
  reminderBody,
  runOperationsSync,
  syncPublicationIssues,
  syncIssuesAndReminders,
};
