'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  evaluateMobileLiveCommand,
  SAFE_DRAFT_ID,
} = require('./lib/mobile-live-command');
const { createGitHubClient, SOMA_REPOSITORY } = require('./lib/github-api');
const { commentOnce } = require('./lib/github-issues');

const DEFAULT_DRAFTS_PATH = path.join(__dirname, 'drafts.json');
const DEFAULT_LEDGER_PATH = path.resolve(process.cwd(), 'state', 'publish-ledger.json');
const DELIVERY_TYPES = new Set(['instagram_story', 'facebook_page_feed']);
const SILENT_OUTCOMES = new Set([
  'ignored_command',
  'unauthorized',
  'wrong_action',
  'wrong_repository',
  'pull_request',
]);

const RESPONSES = Object.freeze({
  automation_not_safely_disabled: '❌ Mobiltesten er lukket, fordi automatisk drift ikke er sikkert deaktiveret.',
  unknown_draft: '❌ Issue matcher ikke en aktuel SOMA-kladde.',
  wrong_issue: '❌ Kommandoen står ikke på kladdens aktive Issue.',
  stale_revision: '❌ Issue viser ikke længere den aktuelt godkendte revision.',
  not_currently_approved: '❌ Kladden er ikke godkendt i sin aktuelle revision.',
  invalid_time: '❌ Kladdens publiceringstidspunkt er ugyldigt.',
  invalid_event_identity: '❌ GitHub-eventet mangler en sikker Issue-identitet.',
  too_early: '⏳ Det er for tidligt. Vent til det planlagte publiceringstidspunkt.',
  already_published: 'ℹ️ Denne levering er allerede registreret som publiceret. Intet blev gentaget.',
  story_required: '❌ Publicér og kontrollér Instagram Story før Facebook-opslaget.',
  unsafe_draft_id: '❌ Kladdens ID kan ikke bruges sikkert til mobiltesten.',
});

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || !['--gate', '--report'].includes(argv[0])) {
    throw new Error('Brug præcis --gate eller --report');
  }
  return { mode: argv[0].slice(2) };
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(label + ' kunne ikke læses som JSON', { cause: error });
  }
}

async function appendGitHubOutput(filePath, name, value) {
  if (!/^[a-z_]+$/u.test(String(name || ''))) throw new Error('GitHub output-navn er ugyldigt');
  const text = String(value);
  if (/\r|\n/u.test(text)) throw new Error('GitHub output-værdi må kun være én linje');
  await fs.appendFile(filePath, name + '=' + text + '\n', 'utf8');
}

function githubClient(env, suppliedClient) {
  const client = suppliedClient || createGitHubClient({
    repository: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
  });
  if (client?.repository !== SOMA_REPOSITORY) throw new Error('GitHub-klient matcher ikke SOMA');
  return client;
}

function responseText(decision) {
  const text = RESPONSES[decision.outcome] || '❌ Mobilkommandoen blev afvist af sikkerhedskontrollen.';
  if (decision.outcome !== 'too_early' || typeof decision.scheduledFor !== 'string') return text;
  return text + ' Planlagt: ' + decision.scheduledFor.replace(/[\r\n]/gu, ' ').slice(0, 80) + '.';
}

async function runGateCli({
  env = process.env,
  draftsPath = DEFAULT_DRAFTS_PATH,
  ledgerPath = DEFAULT_LEDGER_PATH,
  client,
  now = new Date(),
  appendOutputImpl = appendGitHubOutput,
  commentOnceImpl = commentOnce,
} = {}) {
  if (env.GITHUB_REPOSITORY !== SOMA_REPOSITORY) throw new Error('GitHub repository matcher ikke SOMA');
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH mangler');
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT mangler');
  if (!env.SOMA_APPROVER_LOGIN) throw new Error('SOMA_APPROVER_LOGIN mangler');
  if (env.SOMA_AUTOMATION_ENABLED === undefined) throw new Error('SOMA_AUTOMATION_ENABLED mangler');

  const [payload, drafts, ledger] = await Promise.all([
    readJson(env.GITHUB_EVENT_PATH, 'GitHub event'),
    readJson(draftsPath, 'Kladder'),
    readJson(ledgerPath, 'Publiceringsledger'),
  ]);
  const result = evaluateMobileLiveCommand({
    payload,
    drafts,
    ledger,
    approverLogin: env.SOMA_APPROVER_LOGIN,
    automationEnabled: env.SOMA_AUTOMATION_ENABLED,
    now,
  });

  await appendOutputImpl(env.GITHUB_OUTPUT, 'accepted', result.accepted ? 'true' : 'false');
  if (result.accepted) {
    for (const [name, value] of [
      ['draft_id', result.draftId],
      ['delivery_type', result.deliveryType],
      ['issue_number', result.issueNumber],
      ['comment_id', result.commentId],
    ]) await appendOutputImpl(env.GITHUB_OUTPUT, name, String(value));
    return result;
  }

  if (SILENT_OUTCOMES.has(result.outcome)) return result;
  const issueNumber = Number(payload?.issue?.number);
  const commentId = Number(payload?.comment?.id);
  if (Number.isInteger(issueNumber) && issueNumber > 0 && Number.isInteger(commentId) && commentId > 0) {
    await commentOnceImpl({
      client: githubClient(env, client),
      issueNumber,
      marker: 'soma-mobile-live-response:' + commentId + ':' + result.outcome,
      body: responseText(result),
    });
  }
  return result;
}

function reportMessage(deliveryType, outcome) {
  if (outcome !== 'published') {
    return '❌ Publiceringen blev ikke sikkert bekræftet. Automatisk drift er fortsat slukket; kontrollér workflowet før et nyt forsøg.';
  }
  if (deliveryType === 'instagram_story') {
    return '✅ Instagram Story er publiceret. Kontrollér den nu visuelt i Instagram-appen. '
      + 'Skriv derefter kun `PUBLICER FACEBOOK` her, hvis Storyen ser korrekt ud.';
  }
  return '✅ Facebook-opslaget er publiceret. Kontrollér det nu visuelt på SOMA Sauna Gus-siden.';
}

async function runReportCli({
  env = process.env,
  draftsPath = DEFAULT_DRAFTS_PATH,
  ledgerPath = DEFAULT_LEDGER_PATH,
  client,
  commentOnceImpl = commentOnce,
} = {}) {
  if (env.GITHUB_REPOSITORY !== SOMA_REPOSITORY) throw new Error('GitHub repository matcher ikke SOMA');
  const draftId = env.SOMA_DRAFT_ID;
  const deliveryType = env.SOMA_DELIVERY_TYPE;
  const issueNumber = Number(env.SOMA_ISSUE_NUMBER);
  const commentId = Number(env.SOMA_COMMENT_ID);
  if (!SAFE_DRAFT_ID.test(String(draftId || ''))) throw new Error('SOMA_DRAFT_ID er ugyldigt');
  if (!DELIVERY_TYPES.has(deliveryType)) throw new Error('SOMA_DELIVERY_TYPE er ugyldig');
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error('SOMA_ISSUE_NUMBER er ugyldigt');
  if (!Number.isInteger(commentId) || commentId < 1) throw new Error('SOMA_COMMENT_ID er ugyldigt');

  const [drafts, ledger] = await Promise.all([
    readJson(draftsPath, 'Kladder'),
    readJson(ledgerPath, 'Publiceringsledger'),
  ]);
  if (!Array.isArray(drafts) || !Array.isArray(ledger?.entries)) {
    throw new Error('SOMA-state er ugyldig');
  }
  const selected = drafts.filter((item) => (
    item.draftId === draftId && Number(item.githubIssueNumber) === issueNumber
  ));
  if (selected.length !== 1) throw new Error('SOMA-kladden matcher ikke Issue');
  const current = selected[0];
  const entry = ledger.entries.find((item) => (
    item.draftId === draftId
    && item.revision === current.revision
    && item.deliveryType === deliveryType
  ));
  let outcome = 'verification_failed';
  if (entry?.status === 'published') outcome = 'published';
  else if (entry?.status === 'manual_review_required') outcome = 'manual_review_required';
  else if (env.SOMA_PUBLISH_OUTCOME !== 'success') outcome = 'publish_failed';

  await commentOnceImpl({
    client: githubClient(env, client),
    issueNumber,
    marker: 'soma-mobile-live-result:' + commentId + ':' + deliveryType,
    body: reportMessage(deliveryType, outcome),
  });
  return { outcome };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const { mode } = parseArgs(argv);
  const result = mode === 'gate' ? await runGateCli({ env }) : await runReportCli({ env });
  process.stdout.write(JSON.stringify({ outcome: result.outcome }) + '\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('SOMA mobile live test fejlede: ' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  appendGitHubOutput,
  parseArgs,
  runGateCli,
  runReportCli,
};
