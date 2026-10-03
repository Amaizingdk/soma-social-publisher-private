const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { persistState, STATE_FILES } = require('../outputs/content-planner/persist-state');
const { runGit } = require('../outputs/content-planner/lib/approval-transaction');

const DRAFTS = 'outputs/content-planner/drafts.json';
const EVENTS = 'outputs/content-planner/events.json';
const PAYLOAD = 'outputs/content-planner/approval/drafts-data.js';
const FILES = [DRAFTS, EVENTS, PAYLOAD];
const REV_A = '1'.repeat(64);
const REV_B = '2'.repeat(64);

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

function seedDrafts() {
  return [
    { draftId: 'a', status: 'draft', contentRevision: REV_A },
    { draftId: 'b', status: 'draft', contentRevision: REV_B },
  ];
}

async function createRepos() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-persist-'));
  const origin = path.join(base, 'origin.git');
  const runner = path.join(base, 'runner');
  const other = path.join(base, 'other');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', origin, runner]);
  git(runner, 'config', 'user.name', 'Runner');
  git(runner, 'config', 'user.email', 'runner@example.com');
  git(runner, 'checkout', '-b', 'main');
  // Én linje, så to samtidige ændringer altid giver en tekstkonflikt.
  await write(runner, DRAFTS, JSON.stringify(seedDrafts()));
  await write(runner, EVENTS, '[]');
  await write(runner, PAYLOAD, `window.__SOMA_DRAFTS__ = ${JSON.stringify(seedDrafts())};\n`);
  await write(runner, 'other.txt', '1\n');
  git(runner, 'add', '-A');
  git(runner, 'commit', '-m', 'seed');
  git(runner, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, other]);
  git(other, 'config', 'user.name', 'Other');
  git(other, 'config', 'user.email', 'other@example.com');
  return { origin, runner, other };
}

async function generateState(runner) {
  const drafts = seedDrafts();
  drafts[0].availability = { free: 7 };
  await write(runner, DRAFTS, JSON.stringify(drafts));
  await write(runner, EVENTS, '[{"eventKey":"e1"}]');
  await writePayload(path.join(runner, 'outputs', 'content-planner'), drafts);
}

async function approveBFromOther(other) {
  const drafts = JSON.parse(await fs.readFile(path.join(other, DRAFTS), 'utf8'));
  drafts[1] = { ...drafts[1], status: 'approved', approvedAt: '2026-10-03T10:00:00.000Z', approvedBy: 'soren', approvedRevision: REV_B };
  await write(other, DRAFTS, JSON.stringify(drafts));
  git(other, 'commit', '-am', 'approve b');
  git(other, 'push', 'origin', 'main');
}

const persist = (options) => persistState({ files: FILES, message: 'chore: sync SOMA operations', writePayload, ...options });

test('allowlist contains only the operational state files', () => {
  assert.deepEqual([...STATE_FILES].sort(), [
    'outputs/content-planner/approval/drafts-data.js',
    'outputs/content-planner/drafts.json',
    'outputs/content-planner/events.json',
    'renders',
  ]);
});

test('pushes plain state without conflict', async () => {
  const { runner, origin } = await createRepos();
  await generateState(runner);
  const result = await persist({ repoRoot: runner });
  assert.equal(result.pushed, true);
  assert.equal(result.merged, false);
  assert.equal(JSON.parse(git(origin, 'show', `main:${EVENTS}`))[0].eventKey, 'e1');
});

test('keeps an approval pushed from another clone while state was generated', async () => {
  const { runner, other, origin } = await createRepos();
  await generateState(runner);
  await approveBFromOther(other);
  const result = await persist({ repoRoot: runner });
  assert.equal(result.pushed, true);
  assert.equal(result.merged, true);
  const final = JSON.parse(git(origin, 'show', `main:${DRAFTS}`));
  assert.equal(final[0].availability.free, 7);
  assert.equal(final[1].status, 'approved');
  assert.equal(final[1].approvedRevision, REV_B);
  assert.match(git(origin, 'show', `main:${PAYLOAD}`), /"approvedRevision":"2{64}"/);
  assert.equal(JSON.parse(git(origin, 'show', `main:${EVENTS}`))[0].eventKey, 'e1');
});

test('retries and succeeds after a second concurrent push', async () => {
  const { runner, other, origin } = await createRepos();
  await generateState(runner);
  let injected = false;
  const racingGit = async (args, options) => {
    if (!injected && args[0] === 'push') {
      injected = true;
      await write(other, 'other.txt', '2\n');
      git(other, 'commit', '-am', 'concurrent');
      git(other, 'push', 'origin', 'main');
    }
    return runGit(args, options);
  };
  const result = await persist({ repoRoot: runner, git: racingGit });
  assert.equal(result.pushed, true);
  assert.equal(git(origin, 'show', 'main:other.txt'), '2');
  assert.equal(JSON.parse(git(origin, 'show', `main:${EVENTS}`))[0].eventKey, 'e1');
});

test('never leaves the clone in a rebase state', async () => {
  const { runner, other } = await createRepos();
  await generateState(runner);
  await approveBFromOther(other);
  await persist({ repoRoot: runner });
  assert.equal(fsSync.existsSync(path.join(runner, '.git', 'rebase-merge')), false);
  assert.equal(fsSync.existsSync(path.join(runner, '.git', 'rebase-apply')), false);
  assert.equal(git(runner, 'status', '--porcelain'), '');
});

test('returns pushed:false when nothing is staged', async () => {
  const { runner, origin } = await createRepos();
  const before = git(origin, 'rev-parse', 'main');
  const result = await persist({ repoRoot: runner });
  assert.deepEqual([result.pushed, result.merged], [false, false]);
  assert.equal(git(origin, 'rev-parse', 'main'), before);
});

test('fails visibly when git add fails instead of reporting nothing to save', async () => {
  const { runner, origin } = await createRepos();
  await generateState(runner);
  const before = git(origin, 'rev-parse', 'main');
  const brokenAdd = async (args, options) => args[0] === 'add'
    ? { code: 128, stdout: '', stderr: 'index.lock' }
    : runGit(args, options);
  const result = await persist({ repoRoot: runner, git: brokenAdd });
  assert.equal(result.error, 'add_failed');
  assert.equal(result.pushed, false);
  assert.equal(git(origin, 'rev-parse', 'main'), before);
});
