const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createGitStateStore } = require('../outputs/content-planner/lib/git-state-store');

async function fixture() {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-git-store-'));
  const ledgerPath = 'state/publish-ledger.json';
  await fs.mkdir(path.join(repoDir, 'state'), { recursive: true });
  await fs.writeFile(path.join(repoDir, ledgerPath), '{"schemaVersion":1,"entries":[]}\n');
  return { repoDir, ledgerPath };
}

function entry() {
  return { idempotencyKey: 'draft-1:r2:instagram_story', draftId: 'draft-1', status: 'reserved' };
}

test('state store stages only the configured ledger file', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.repoDir, { recursive: true, force: true }));
  const calls = [];
  const store = createGitStateStore({
    ...data,
    runId: '42',
    runGit: async (args) => {
      calls.push(args);
      return { exitCode: args[0] === 'diff' ? 1 : 0 };
    },
  });
  await store.persist({ phase: 'reserved', entry: entry() });
  assert.deepEqual(calls[0], ['add', '--', 'state/publish-ledger.json']);
  assert.equal(calls.flat().includes('.'), false);
});

test('push must succeed before persist resolves', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.repoDir, { recursive: true, force: true }));
  const calls = [];
  const store = createGitStateStore({
    ...data,
    runId: '42',
    runGit: async (args) => {
      calls.push(args);
      return { exitCode: args[0] === 'diff' ? 1 : 0 };
    },
  });
  await store.persist({ phase: 'reserved', entry: entry() });
  assert.deepEqual(calls.map((call) => call[0]), ['add', 'diff', 'commit', 'push']);
  assert.deepEqual(calls.at(-1), ['push', 'origin', 'HEAD:main']);
});

test('a rejected push aborts persistence and exposes no credentials', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.repoDir, { recursive: true, force: true }));
  const credential = 'credential-secret';
  const store = createGitStateStore({
    ...data,
    runId: '42',
    runGit: async (args) => {
      if (args[0] === 'diff') return { exitCode: 1 };
      if (args[0] === 'push') throw new Error(`rejected ${credential}`);
      return { exitCode: 0 };
    },
  });
  await assert.rejects(store.persist({ phase: 'reserved', entry: entry() }), (error) => {
    assert.equal(error.message.includes(credential), false);
    assert.match(error.message, /Git-persistence/);
    return true;
  });
});

test('state store rejects ledger paths outside the repository', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.repoDir, { recursive: true, force: true }));
  assert.throws(() => createGitStateStore({
    repoDir: data.repoDir,
    ledgerPath: '../outside.json',
    runId: '42',
    runGit: async () => ({ exitCode: 0 }),
  }), /repository/i);
});

test('commit message contains only phase, short key, and run id', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.repoDir, { recursive: true, force: true }));
  const calls = [];
  const store = createGitStateStore({
    ...data,
    runId: 'run 42 unsafe',
    runGit: async (args) => {
      calls.push(args);
      return { exitCode: args[0] === 'diff' ? 1 : 0 };
    },
  });
  await store.persist({ phase: 'published', entry: { ...entry(), caption: 'secret caption' } });
  const commit = calls.find((call) => call[0] === 'commit');
  assert.deepEqual(commit.slice(0, 2), ['commit', '-m']);
  assert.match(commit[2], /^state: published [A-Za-z0-9._-]+ run [A-Za-z0-9._-]+$/);
  assert.equal(commit[2].includes('caption'), false);
});
