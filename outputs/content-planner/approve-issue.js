'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { approveIssueComment, parseDraftMarkers } = require('./lib/approvals');
const { createGitHubClient, SOMA_REPOSITORY } = require('./lib/github-api');
const { commentOnce, syncDraftIssue } = require('./lib/github-issues');
const { writeJsonAtomic } = require('./lib/io');

const DEFAULT_DRAFTS_PATH = path.join(__dirname, 'drafts.json');
const DEFAULT_LEDGER_PATH = path.join(__dirname, 'state', 'publish-ledger.json');

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(label + ' kunne ikke læses som JSON', { cause: error });
  }
}

async function readLedger(ledgerPath) {
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    if (!Array.isArray(ledger?.entries)) throw new Error('entries mangler');
    return ledger;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: [] };
    throw new Error('Publiceringsledger kunne ikke læses', { cause: error });
  }
}

function responseText(outcome) {
  const messages = {
    approved: '✅ Kladde godkendt til den aktuelle indholdsrevision.',
    already_approved: 'ℹ️ Kladde var allerede godkendt til den aktuelle indholdsrevision.',
    unauthorized: '❌ Kun den konfigurerede SOMA-godkender kan bruge `GODKEND`.',
    stale_revision: '❌ Kommentaren matcher en ældre indholdsrevision. Gennemgå den opdaterede kladde.',
    terminal: '❌ Kladder, der er afsluttet eller sprunget over, kan ikke godkendes.',
    warnings_not_acknowledged: '❌ Kladde-advarsler skal rettes eller bekræftes før godkendelse.',
    unknown_draft: '❌ Issue-markøren matcher ikke en aktuel kladde.',
  };
  return messages[outcome] || '❌ Godkendelsen blev afvist af sikkerhedskontrollen.';
}

async function runApprovalCli({
  env = process.env,
  draftsPath = DEFAULT_DRAFTS_PATH,
  ledgerPath = DEFAULT_LEDGER_PATH,
  client,
  now = new Date(),
  syncDraftIssueImpl = syncDraftIssue,
  commentOnceImpl = commentOnce,
  writeApprovalPayloadImpl,
} = {}) {
  if (env.GITHUB_REPOSITORY !== SOMA_REPOSITORY) throw new Error('GitHub repository matcher ikke SOMA');
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH mangler');
  if (!env.SOMA_APPROVER_LOGIN) throw new Error('SOMA_APPROVER_LOGIN mangler');

  const payload = await readJson(env.GITHUB_EVENT_PATH, 'GitHub event');
  const drafts = await readJson(draftsPath, 'Kladder');
  if (!Array.isArray(drafts)) throw new Error('Kladder skal være en liste');
  const ledger = await readLedger(ledgerPath);
  const github = client || createGitHubClient({
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
  });
  if (github.repository !== SOMA_REPOSITORY) throw new Error('GitHub-klient matcher ikke SOMA');

  const result = approveIssueComment({
    payload,
    drafts,
    approverLogin: env.SOMA_APPROVER_LOGIN,
    now,
  });
  if (result.outcome === 'ignored_command') return result;

  let current = result.drafts;
  const writeApproval = writeApprovalPayloadImpl
    || require('./build-content-plan').writeApprovalPayload;
  const persistDrafts = async () => {
    await writeJsonAtomic(draftsPath, current);
    await writeApproval(path.dirname(draftsPath), current);
  };
  if (result.outcome === 'approved') await persistDrafts();

  const { draftId } = parseDraftMarkers(payload?.issue?.body || '');
  const draft = current.find((item) => item.draftId === draftId);
  if (draft && ['approved', 'already_approved'].includes(result.outcome)) {
    const synchronized = await syncDraftIssueImpl({
      client: github,
      draft,
      ledger,
      repository: SOMA_REPOSITORY,
    });
    current = current.map((item) => item.draftId === synchronized.draftId ? synchronized : item);
    await persistDrafts();
  }

  const issueNumber = Number(payload?.issue?.number);
  const commentId = Number(payload?.comment?.id);
  if (Number.isInteger(issueNumber) && issueNumber > 0 && Number.isInteger(commentId) && commentId > 0) {
    await commentOnceImpl({
      client: github,
      issueNumber,
      marker: 'soma-approval-response:' + commentId + ':' + result.outcome,
      body: responseText(result.outcome),
    });
  }
  return { ...result, drafts: current };
}

if (require.main === module) {
  runApprovalCli()
    .then((result) => process.stdout.write(JSON.stringify({ outcome: result.outcome }) + '\n'))
    .catch((error) => {
      process.stderr.write('SOMA approval fejlede: ' + error.message + '\n');
      process.exitCode = 1;
    });
}

module.exports = { runApprovalCli };
