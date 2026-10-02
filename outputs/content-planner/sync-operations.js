'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { runPipeline, writeApprovalPayload } = require('./build-content-plan');
const { createGitHubClient, SOMA_REPOSITORY } = require('./lib/github-api');
const { writeJsonAtomic } = require('./lib/io');
const { readLedger } = require('./lib/publish-ledger');
const { runOperationsSync, syncPublicationIssues } = require('./lib/operations');

async function main(argv = process.argv.slice(2), env = process.env) {
  if (env.GITHUB_REPOSITORY !== SOMA_REPOSITORY) throw new Error('GitHub repository matcher ikke SOMA');
  if (argv.some((value) => value !== '--publication-only')) throw new Error('Ukendt operations-argument');
  const client = createGitHubClient({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN });
  const outputDir = __dirname;
  const draftsPath = path.join(outputDir, 'drafts.json');
  const ledgerPath = path.resolve(process.cwd(), 'state', 'publish-ledger.json');
  if (argv.includes('--publication-only')) {
    const drafts = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
    const ledger = await readLedger(ledgerPath);
    const reconciled = await syncPublicationIssues({ drafts, ledger, client });
    await writeJsonAtomic(draftsPath, reconciled);
    await writeApprovalPayload(outputDir, reconciled);
    process.stdout.write(JSON.stringify({ status: 'reconciled', drafts: reconciled.length }) + '\n');
    return { drafts: reconciled, ledger };
  }
  const result = await runOperationsSync({
    client,
    approverLogin: env.SOMA_APPROVER_LOGIN,
    automationEnabled: env.PUBLISH_ENABLED,
    planner: (options) => runPipeline({ ...options, runtimeRoot: process.cwd() }),
    writeApprovalPayloadImpl: writeApprovalPayload,
    paths: {
      outputDir,
      draftsPath,
      ledgerPath,
    },
  });
  process.stdout.write(JSON.stringify({
    status: 'ok',
    drafts: result.drafts.length,
    issues: result.issues,
    reminders: result.reminders,
  }) + '\n');
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((error) => {
    process.stderr.write('SOMA operations fejlede: ' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { main };
