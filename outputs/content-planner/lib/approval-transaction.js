'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { writeJsonAtomic } = require('./io');

const DRAFTS_FILE = 'outputs/content-planner/drafts.json';
const PAYLOAD_FILE = 'outputs/content-planner/approval/drafts-data.js';

function runGit(args, { cwd }) {
  const safeDirectory = String(cwd).replace(/\\/g, '/');
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', `safe.directory=${safeDirectory}`, ...args],
      { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      },
    );
  });
}

async function readDrafts(draftsPath) {
  try {
    const value = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function runApprovalTransaction({
  repoRoot,
  apply,
  message,
  git = runGit,
  maxAttempts = 3,
  writePayload = (outputDir, drafts) => require('../build-content-plan').writeApprovalPayload(outputDir, drafts),
}) {
  const run = (...args) => git(args, { cwd: repoRoot });
  const outputDir = path.join(repoRoot, 'outputs', 'content-planner');
  const draftsPath = path.join(repoRoot, DRAFTS_FILE);

  const fail = (attempt, error, extra = {}) => ({ pushed: false, changed: false, attempts: attempt, error, ...extra });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await run('status', '--porcelain');
    if (status.code !== 0) return fail(attempt, 'fetch_failed');
    if (status.stdout.trim()) return fail(attempt, 'dirty_tree');

    const branch = await run('symbolic-ref', '--short', 'HEAD');
    if (branch.code !== 0 || branch.stdout.trim() !== 'main') return fail(attempt, 'wrong_branch');

    if ((await run('fetch', 'origin', 'main')).code !== 0
      || (await run('merge', '--ff-only', 'origin/main')).code !== 0) {
      return fail(attempt, 'fetch_failed');
    }
    // Lokale, upushede commits må aldrig følge med en godkendelse (og må aldrig kasseres).
    const head = (await run('rev-parse', 'HEAD')).stdout.trim();
    const upstream = (await run('rev-parse', 'origin/main')).stdout.trim();
    if (!head || head !== upstream) return fail(attempt, 'diverged');

    const drafts = await readDrafts(draftsPath);
    if (!drafts) return fail(attempt, 'invalid_drafts');

    const applied = await apply(drafts);
    const extraFiles = applied.files || [];
    const restoreExtra = async () => {
      // Genrenderede billeder rulles tilbage, så træet er rent til næste forsøg.
      if (!extraFiles.length) return;
      for (const file of extraFiles) {
        await run('checkout', '--', file);
        await run('clean', '-f', '--', file);
      }
    };
    if (JSON.stringify(applied.drafts) === JSON.stringify(drafts)) {
      await restoreExtra();
      return { pushed: false, changed: false, results: applied.results, attempts: attempt };
    }

    try {
      await writeJsonAtomic(draftsPath, applied.drafts);
      await writePayload(outputDir, applied.drafts);
    } catch {
      await run('checkout', '--', DRAFTS_FILE, PAYLOAD_FILE);
      await restoreExtra();
      return fail(attempt, 'write_failed', { changed: true, results: applied.results });
    }
    const staged = await run('add', '--', DRAFTS_FILE, PAYLOAD_FILE, ...extraFiles);
    const committed = staged.code === 0 && (await run('commit', '-m', message)).code === 0;
    if (!committed) {
      await run('reset', '--hard', 'origin/main');
      await restoreExtra();
      return fail(attempt, 'commit_failed', { changed: true, results: applied.results });
    }

    const pushedOk = (await run('push', 'origin', 'HEAD:refs/heads/main')).code === 0;
    const remote = pushedOk ? (await run('ls-remote', 'origin', 'refs/heads/main')).stdout.split(/\s/)[0] : '';
    const ourHead = (await run('rev-parse', 'HEAD')).stdout.trim();
    if (pushedOk && remote && remote === ourHead) {
      return { pushed: true, changed: true, results: applied.results, attempts: attempt };
    }
    // Vores egen commit er den eneste lokale; kassér den og prøv igen på friskt origin/main.
    await run('fetch', 'origin', 'main');
    await run('reset', '--hard', 'origin/main');
    await restoreExtra();
    if (attempt === maxAttempts) {
      return { pushed: false, changed: true, results: applied.results, attempts: attempt, error: 'push_failed' };
    }
  }
  return fail(maxAttempts, 'push_failed');
}

module.exports = { runApprovalTransaction, runGit, DRAFTS_FILE, PAYLOAD_FILE };
