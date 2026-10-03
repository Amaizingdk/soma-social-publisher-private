const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runApprovalTransaction, runGit } = require('../outputs/content-planner/lib/approval-transaction');

const DRAFTS = 'outputs/content-planner/drafts.json';
const PAYLOAD = 'outputs/content-planner/approval/drafts-data.js';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function writePayload(outputDir, drafts) {
  await fs.mkdir(path.join(outputDir, 'approval'), { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'approval', 'drafts-data.js'),
    `window.__SOMA_DRAFTS__ = ${JSON.stringify(drafts)};\n`,
  );
}

function seed() {
  return [
    { draftId: 'a', status: 'draft', contentRevision: '1'.repeat(64) },
    { draftId: 'b', status: 'draft', contentRevision: '2'.repeat(64) },
  ];
}

async function createRepos() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-approval-tx-'));
  const origin = path.join(base, 'origin.git');
  const clone = path.join(base, 'clone');
  const other = path.join(base, 'other');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, clone]);
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'checkout', '-b', 'main');
  await write(clone, DRAFTS, JSON.stringify(seed(), null, 2));
  await write(clone, PAYLOAD, 'window.__SOMA_DRAFTS__ = [];\n');
  await write(clone, 'README.txt', 'x\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-m', 'seed');
  git(clone, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, other]);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.com');
  return { base, origin, clone, other };
}

function approve(draftId) {
  return (drafts) => ({
    drafts: drafts.map((draft) => draft.draftId === draftId ? { ...draft, status: 'approved' } : draft),
    results: { draftId },
  });
}

const tx = (options) => runApprovalTransaction({ writePayload, ...options });

test('pushes an approval commit touching only the two allowed files', async () => {
  const { clone, origin } = await createRepos();
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'approve: a' });
  assert.equal(result.pushed, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.results, { draftId: 'a' });
  const files = git(origin, 'show', '--name-only', '--format=', 'main').split('\n').sort();
  assert.deepEqual(files, [DRAFTS, PAYLOAD].sort());
  assert.equal(JSON.parse(git(origin, 'show', `main:${DRAFTS}`))[0].status, 'approved');
});

test('makes no commit when apply changes nothing', async () => {
  const { clone, origin } = await createRepos();
  const before = git(origin, 'rev-parse', 'main');
  const result = await tx({ repoRoot: clone, apply: (drafts) => ({ drafts, results: 'noop' }), message: 'x' });
  assert.deepEqual([result.pushed, result.changed], [false, false]);
  assert.equal(git(origin, 'rev-parse', 'main'), before);
});

test('retries after a concurrent push and keeps both changes', async () => {
  const { clone, origin, other } = await createRepos();
  let injected = false;
  const racingGit = async (args, options) => {
    if (!injected && args[0] === 'push') {
      injected = true;
      const drafts = JSON.parse(await fs.readFile(path.join(other, DRAFTS), 'utf8'));
      drafts[1].status = 'approved';
      await write(other, DRAFTS, JSON.stringify(drafts, null, 2));
      git(other, 'commit', '-am', 'other approves b');
      git(other, 'push', 'origin', 'main');
    }
    return runGit(args, options);
  };
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'approve: a', git: racingGit });
  assert.equal(result.pushed, true);
  assert.equal(result.attempts, 2);
  const final = JSON.parse(git(origin, 'show', `main:${DRAFTS}`));
  assert.deepEqual(final.map((draft) => draft.status), ['approved', 'approved']);
});

test('returns push_failed after maxAttempts and leaves the clone equal to origin', async () => {
  const { clone, origin } = await createRepos();
  const failingGit = async (args, options) => args[0] === 'push'
    ? { code: 1, stdout: '', stderr: 'rejected' }
    : runGit(args, options);
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x', git: failingGit, maxAttempts: 2 });
  assert.equal(result.pushed, false);
  assert.equal(result.error, 'push_failed');
  assert.equal(result.attempts, 2);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  assert.equal(git(clone, 'status', '--porcelain'), '');
});

test('refuses with dirty_tree and does not touch files', async () => {
  const { clone } = await createRepos();
  await write(clone, 'README.txt', 'lokal ændring\n');
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x' });
  assert.equal(result.error, 'dirty_tree');
  assert.equal(result.pushed, false);
  assert.equal(await fs.readFile(path.join(clone, 'README.txt'), 'utf8'), 'lokal ændring\n');
  assert.equal(JSON.parse(await fs.readFile(path.join(clone, DRAFTS), 'utf8'))[0].status, 'draft');
});

test('returns fetch_failed when origin is unreachable', async () => {
  const { clone, origin } = await createRepos();
  await fs.rm(origin, { recursive: true, force: true });
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x' });
  assert.equal(result.error, 'fetch_failed');
  assert.equal(result.pushed, false);
});

test('returns invalid_drafts when drafts.json is not an array', async () => {
  const { clone } = await createRepos();
  await write(clone, DRAFTS, '{"not":"array"}');
  git(clone, 'commit', '-am', 'break');
  git(clone, 'push', 'origin', 'main');
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x' });
  assert.equal(result.error, 'invalid_drafts');
  assert.equal(result.pushed, false);
});

test('refuses with diverged when the clone has an unpushed local commit and keeps it', async () => {
  const { clone, origin } = await createRepos();
  await write(clone, 'README.txt', 'ureviewet lokal commit\n');
  git(clone, 'commit', '-am', 'lokal commit');
  const before = git(origin, 'rev-parse', 'main');
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x' });
  assert.equal(result.error, 'diverged');
  assert.equal(result.pushed, false);
  assert.equal(git(origin, 'rev-parse', 'main'), before);
  assert.equal(git(clone, 'log', '--format=%s', 'origin/main..HEAD'), 'lokal commit');
});

test('refuses with wrong_branch when HEAD is not main', async () => {
  const { clone, origin } = await createRepos();
  git(clone, 'checkout', '-b', 'feature');
  const before = git(origin, 'rev-parse', 'main');
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x' });
  assert.equal(result.error, 'wrong_branch');
  assert.equal(git(origin, 'rev-parse', 'main'), before);
});

test('does not report pushed when the remote does not contain the commit', async () => {
  const { clone, origin } = await createRepos();
  const silentGit = async (args, options) => args[0] === 'push'
    ? { code: 0, stdout: '', stderr: '' }
    : runGit(args, options);
  const before = git(origin, 'rev-parse', 'main');
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x', git: silentGit, maxAttempts: 2 });
  assert.equal(result.pushed, false);
  assert.equal(result.error, 'push_failed');
  assert.equal(git(origin, 'rev-parse', 'main'), before);
  assert.equal(git(clone, 'rev-parse', 'HEAD'), before);
});

test('restores the allowed files and reports write_failed when writing the payload throws', async () => {
  const { clone, origin } = await createRepos();
  const brokenPayload = async () => { throw new Error('EPERM'); };
  const result = await tx({ repoRoot: clone, apply: approve('a'), message: 'x', writePayload: brokenPayload });
  assert.equal(result.error, 'write_failed');
  assert.equal(result.pushed, false);
  assert.equal(git(clone, 'status', '--porcelain'), '');
  const retry = await tx({ repoRoot: clone, apply: approve('a'), message: 'x' });
  assert.equal(retry.pushed, true);
  assert.equal(JSON.parse(git(origin, 'show', `main:${DRAFTS}`))[0].status, 'approved');
});
