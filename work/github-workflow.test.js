const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const sourceRuntimeRoot = path.resolve(__dirname, '../outputs/content-planner/runtime');
const releaseRoot = path.resolve(__dirname, '..');
const runtimeRoot = fsSync.existsSync(path.join(releaseRoot, '.github/workflows/publish.yml'))
  ? releaseRoot
  : sourceRuntimeRoot;
const publishPath = path.join(runtimeRoot, '.github/workflows/publish.yml');
const ciPath = path.join(runtimeRoot, '.github/workflows/ci.yml');
const ledgerPath = path.join(runtimeRoot, 'state/publish-ledger.json');

test('publish workflow has timezone schedule, manual dispatch, queued concurrency, and explicit permissions', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /cron:\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(yaml, /timezone:\s*Europe\/Copenhagen/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /concurrency:/);
  assert.match(yaml, /group:\s*soma-social-publisher/);
  assert.match(yaml, /cancel-in-progress:\s*false/);
  assert.match(yaml, /queue:\s*max/);
  assert.match(yaml, /permissions:\s*\{\}/);
  assert.match(yaml, /contents:\s*read/);
  assert.match(yaml, /contents:\s*write/);
});

test('schedule is gated by PUBLISH_ENABLED and secrets exist only in the publish step', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /github\.event_name == 'schedule'.*vars\.PUBLISH_ENABLED == 'true'/);
  const dryRunSegment = yaml.slice(yaml.indexOf('dry_run:'), yaml.indexOf('publish:'));
  const publishSegment = yaml.slice(yaml.indexOf('publish:'));
  assert.equal(/secrets\.SOMA_/.test(dryRunSegment), false);
  assert.match(publishSegment, /SOMA_META_ACCESS_TOKEN:\s*\$\{\{ secrets\.SOMA_META_ACCESS_TOKEN \}\}/);
  assert.match(publishSegment, /SOMA_ASSET_REPO_TOKEN:\s*\$\{\{ secrets\.SOMA_ASSET_REPO_TOKEN \}\}/);
  assert.doesNotMatch(yaml, /echo .*SOMA_(META|ASSET)/);
  assert.doesNotMatch(yaml, /^env:/m);
});

test('CI uses locked dependencies, Node 24, Chromium, read-only contents, and no secrets', async () => {
  const yaml = await fs.readFile(ciPath, 'utf8');
  assert.match(yaml, /actions\/checkout@v4/);
  assert.match(yaml, /actions\/setup-node@v4/);
  assert.match(yaml, /node-version:\s*['"]24['"]/);
  assert.match(yaml, /npm ci/);
  assert.match(yaml, /npx playwright install --with-deps chromium/);
  assert.match(yaml, /npm test/);
  assert.match(yaml, /contents:\s*read/);
  assert.equal(yaml.includes('secrets.'), false);
});

test('publisher workflow keeps checkout credentials for ledger pushes and writes only the sanitized summary', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /persist-credentials:\s*true/);
  assert.match(yaml, /state\/run-summary\.json/);
  assert.match(yaml, /GITHUB_STEP_SUMMARY/);
});

test('runtime ledger starts empty with schema version one', async () => {
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.deepEqual(ledger, { schemaVersion: 1, entries: [] });
});
