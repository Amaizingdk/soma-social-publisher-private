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
const operationsPath = path.join(runtimeRoot, '.github/workflows/operations.yml');
const ciPath = path.join(runtimeRoot, '.github/workflows/ci.yml');
const ledgerPath = path.join(runtimeRoot, 'state/publish-ledger.json');

test('publish workflow has timezone schedule, manual dispatch, queued concurrency, and explicit permissions', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /cron:\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(yaml, /timezone:\s*Europe\/Copenhagen/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /concurrency:/);
  assert.match(yaml, /group:\s*soma-state-writer/);
  assert.match(yaml, /cancel-in-progress:\s*false/);
  assert.match(yaml, /queue:\s*max/);
  assert.match(yaml, /permissions:\s*\{\}/);
  assert.match(yaml, /contents:\s*read/);
  assert.match(yaml, /contents:\s*write/);
});

test('schedule is gated by PUBLISH_ENABLED and secrets exist only in the publish step', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /github\.event_name == 'schedule'.*vars\.PUBLISH_ENABLED == 'true'/);
  const dryRunSegment = yaml.slice(yaml.indexOf('dry_run:'), yaml.indexOf('validate_meta:'));
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

test('manual workflow forwards an exact draft id through shell-safe arguments', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /draft_id:/);
  assert.match(yaml, /SOMA_DRAFT_ID:\s*\$\{\{ inputs\.draft_id \}\}/);
  assert.equal((yaml.match(/--draft-id "\$SOMA_DRAFT_ID"/g) || []).length, 2);
  assert.doesNotMatch(yaml, /--draft-id[^\n]*\$\{\{ inputs\.draft_id \}\}/);
});

test('validate-meta job is read-only and receives no asset secret', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  assert.match(yaml, /options:\s*\[dry_run, validate_meta, publish\]/);
  const start = yaml.indexOf('  validate_meta:');
  const end = yaml.indexOf('  publish:', start);
  assert.ok(start > -1 && end > start);
  const segment = yaml.slice(start, end);
  assert.match(segment, /contents:\s*read/);
  assert.match(segment, /SOMA_META_ACCESS_TOKEN:\s*\$\{\{ secrets\.SOMA_META_ACCESS_TOKEN \}\}/);
  assert.match(segment, /node outputs\/content-planner\/validate-meta\.js/);
  assert.doesNotMatch(segment, /SOMA_ASSET_REPO_TOKEN/);
  assert.doesNotMatch(segment, /contents:\s*write/);
});

test('runtime ledger starts empty with schema version one', async () => {
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.deepEqual(ledger, { schemaVersion: 1, entries: [] });
});

test('operations workflow has no publishing secrets and handles schedule plus issue comments', async () => {
  const yaml = await fs.readFile(operationsPath, 'utf8');
  assert.match(yaml, /cron:\s*['"]\*\/30 \* \* \* \*['"]/);
  assert.match(yaml, /issue_comment:/);
  assert.match(yaml, /issues:\s*write/);
  assert.match(yaml, /contents:\s*write/);
  assert.doesNotMatch(yaml, /SOMA_(META_ACCESS_TOKEN|ASSET_REPO_TOKEN)/);
  assert.match(yaml, /SOMA_APPROVER_LOGIN:\s*\$\{\{ vars\.SOMA_APPROVER_LOGIN \}\}/);
  const gitAdd = yaml.match(/git add[^\n]+/g) || [];
  assert.equal(gitAdd.length, 1);
  assert.match(gitAdd[0], /outputs\/content-planner\/drafts\.json/);
  assert.match(gitAdd[0], /outputs\/content-planner\/events\.json/);
  assert.match(gitAdd[0], /outputs\/content-planner\/approval\/drafts-data\.js/);
  assert.match(gitAdd[0], /renders/);
  assert.doesNotMatch(gitAdd[0], /\s\.|--all|-A/);
});

test('all state writers share concurrency and publish secrets remain step scoped', async () => {
  const [operations, publish] = await Promise.all([
    fs.readFile(operationsPath, 'utf8'),
    fs.readFile(publishPath, 'utf8'),
  ]);
  assert.match(operations, /group:\s*soma-state-writer/);
  assert.match(publish, /group:\s*soma-state-writer/);
  assert.doesNotMatch(operations, /^env:/m);
  assert.doesNotMatch(publish, /^env:/m);
  const publishStep = publish.slice(publish.indexOf('- name: Publish due content'), publish.indexOf('- name: Reconcile publication state'));
  const reconcileStep = publish.slice(publish.indexOf('- name: Reconcile publication state'));
  assert.match(publishStep, /SOMA_META_ACCESS_TOKEN/);
  assert.match(publishStep, /SOMA_ASSET_REPO_TOKEN/);
  assert.doesNotMatch(reconcileStep, /SOMA_META_ACCESS_TOKEN|SOMA_ASSET_REPO_TOKEN/);
  assert.match(reconcileStep, /sync-operations\.js --publication-only/);
});
