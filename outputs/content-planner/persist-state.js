'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { runGit, DRAFTS_FILE } = require('./lib/approval-transaction');
const { mergeApprovals } = require('./lib/merge-approvals');
const { writeJsonAtomic } = require('./lib/io');

// Eneste filer workflowet må committe — aldrig `.` eller `-A`.
const STATE_FILES = [
  'outputs/content-planner/drafts.json',
  'outputs/content-planner/events.json',
  'outputs/content-planner/approval/drafts-data.js',
  'renders',
];

async function exists(root, relative) {
  try {
    await fs.access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

async function persistState({
  repoRoot,
  files = STATE_FILES,
  message = 'chore: sync SOMA operations',
  git = runGit,
  maxAttempts = 3,
  writePayload = (outputDir, drafts) => require('./build-content-plan').writeApprovalPayload(outputDir, drafts),
}) {
  const run = (...args) => git(args, { cwd: repoRoot });
  const outputDir = path.join(repoRoot, 'outputs', 'content-planner');
  const present = [];
  for (const file of files) if (await exists(repoRoot, file)) present.push(file);

  if (present.length && (await run('add', '--', ...present)).code !== 0) {
    return { pushed: false, merged: false, attempts: 0, error: 'add_failed' };
  }
  if ((await run('diff', '--cached', '--quiet')).code === 0) {
    return { pushed: false, merged: false, attempts: 0 };
  }
  if ((await run('commit', '-m', message)).code !== 0) {
    return { pushed: false, merged: false, attempts: 0, error: 'commit_failed' };
  }

  let merged = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if ((await run('pull', '--rebase')).code === 0) {
      if ((await run('push')).code === 0) return { pushed: true, merged, attempts: attempt };
      continue;
    }

    // Konflikt: bevar vores genererede tilstand, men tab aldrig en godkendelse fra origin.
    await run('rebase', '--abort');
    const ours = (await run('rev-parse', 'HEAD')).stdout.trim();
    if ((await run('fetch', 'origin', 'main')).code !== 0) break;
    const remote = await run('show', `origin/main:${DRAFTS_FILE}`);
    let remoteDrafts;
    try { remoteDrafts = JSON.parse(remote.stdout); } catch { break; }
    if (!Array.isArray(remoteDrafts)) break;

    await run('reset', '--hard', 'origin/main');
    for (const file of present) await run('checkout', ours, '--', file);
    const generated = JSON.parse(await fs.readFile(path.join(repoRoot, DRAFTS_FILE), 'utf8'));
    const combined = mergeApprovals(generated, remoteDrafts);
    await writeJsonAtomic(path.join(repoRoot, DRAFTS_FILE), combined);
    await writePayload(outputDir, combined);
    await run('add', '--', ...present);
    if ((await run('commit', '-m', message)).code !== 0) break;
    merged = true;
  }
  return { pushed: false, merged, attempts: maxAttempts, error: 'push_failed' };
}

if (require.main === module) {
  persistState({ repoRoot: path.resolve(__dirname, '..', '..') })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.error) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`SOMA persist fejlede: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { persistState, STATE_FILES };
