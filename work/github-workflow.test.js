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
const mobileLivePath = path.join(runtimeRoot, '.github/workflows/mobile-live-test.yml');
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

test('external dispatch needs the PUBLISH_ENABLED switch and a cheap due check before the heavy publisher', async () => {
  const yaml = await fs.readFile(publishPath, 'utf8');
  const start = yaml.indexOf('  check_due:');
  const end = yaml.indexOf('  publish:', start);
  assert.ok(start > -1 && end > start);
  const checkDue = yaml.slice(start, end);
  assert.match(checkDue, /vars\.PUBLISH_ENABLED == 'true'/);
  assert.match(checkDue, /github\.event_name == 'schedule'/);
  assert.match(checkDue, /inputs\.mode == 'publish'/);
  assert.match(checkDue, /contents:\s*read/);
  assert.match(checkDue, /persist-credentials:\s*false/);
  assert.match(checkDue, /node outputs\/content-planner\/check-due\.js/);
  assert.doesNotMatch(checkDue, /secrets\./);
  assert.doesNotMatch(checkDue, /playwright|npm ci/);
  const publishJob = yaml.slice(end);
  assert.match(publishJob, /needs:\s*check_due/);
  assert.match(publishJob, /if:\s*needs\.check_due\.outputs\.due == 'true'/);
});

test('every job has a timeout and every Chromium install is cut off early, so a hang cannot block the queue', async () => {
  const files = [publishPath, operationsPath, mobileLivePath, ciPath];
  for (const file of files) {
    const yaml = await fs.readFile(file, 'utf8');
    const jobsSection = yaml.slice(yaml.indexOf('\njobs:\n'));
    const jobs = jobsSection.split(/^  ([\w-]+):\n/m).slice(1);
    assert.ok(jobs.length >= 2, path.basename(file));
    for (let index = 0; index < jobs.length; index += 2) {
      const match = jobs[index + 1].match(/^    timeout-minutes:\s*(\d+)$/m);
      assert.ok(match, `${path.basename(file)}:${jobs[index]} mangler timeout-minutes`);
      assert.ok(Number(match[1]) <= 20, `${path.basename(file)}:${jobs[index]} timeout er for høj`);
    }
    for (const step of yaml.split('      - name: ').filter((part) => part.startsWith('Install Chromium'))) {
      assert.match(step, /timeout-minutes:\s*5\b/, `${path.basename(file)}: Install Chromium mangler timeout`);
    }
  }
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

test('runtime ledger keeps schema version one and valid durable entries', async () => {
  const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  assert.equal(ledger.schemaVersion, 1);
  assert.ok(Array.isArray(ledger.entries));
  for (const entry of ledger.entries) {
    assert.match(entry.idempotencyKey, /^[a-f0-9]{64}$/);
    assert.ok(['reserved', 'published', 'manual_review_required'].includes(entry.status));
  }
});

test('operations workflow has no publishing secrets and handles schedule plus issue comments', async () => {
  const yaml = await fs.readFile(operationsPath, 'utf8');
  assert.match(yaml, /cron:\s*['"]\*\/30 \* \* \* \*['"]/);
  assert.match(yaml, /issue_comment:/);
  assert.match(yaml, /issues:\s*write/);
  assert.match(yaml, /contents:\s*write/);
  assert.doesNotMatch(yaml, /SOMA_(META_ACCESS_TOKEN|ASSET_REPO_TOKEN)/);
  assert.match(yaml, /SOMA_APPROVER_LOGIN:\s*\$\{\{ vars\.SOMA_APPROVER_LOGIN \}\}/);
  assert.match(yaml, /PUBLISH_ENABLED:\s*\$\{\{ vars\.PUBLISH_ENABLED \}\}/);
  assert.match(yaml, /run:\s*node outputs\/content-planner\/persist-state\.js/);
  assert.doesNotMatch(yaml, /git add|git pull --rebase|git push/);
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

test('mobile live workflow gates issue comments before any secret-bearing step', async () => {
  const yaml = await fs.readFile(mobileLivePath, 'utf8');
  assert.match(yaml, /issue_comment:\s*\n\s+types:\s*\[created\]/);
  assert.match(yaml, /permissions:\s*\{\}/);
  assert.match(yaml, /group:\s*soma-state-writer/);
  assert.match(yaml, /node outputs\/content-planner\/mobile-live-test\.js --gate/);
  assert.match(yaml, /needs\.gate\.outputs\.accepted == 'true'/);
  const gate = yaml.slice(yaml.indexOf('  gate:'), yaml.indexOf('  publish:'));
  assert.doesNotMatch(gate, /secrets\./);
  assert.match(gate, /persist-credentials:\s*false/);
  assert.match(gate, /SOMA_AUTOMATION_ENABLED:\s*\$\{\{ vars\.PUBLISH_ENABLED \}\}/);
});

test('publishing workflows configure git identity before persistent reservation', async () => {
  const workflows = [
    {
      name: 'scheduled publisher',
      yaml: await fs.readFile(publishPath, 'utf8'),
      publishStep: '- name: Publish due content',
    },
    {
      name: 'mobile live test',
      yaml: await fs.readFile(mobileLivePath, 'utf8'),
      publishStep: '- name: Publish exact accepted delivery',
    },
  ];

  for (const workflow of workflows) {
    const publishIndex = workflow.yaml.indexOf(workflow.publishStep);
    const nameIndex = workflow.yaml.indexOf('git config user.name "soma-social-publisher[bot]"');
    const emailIndex = workflow.yaml.indexOf('git config user.email "soma-social-publisher[bot]@users.noreply.github.com"');
    assert.ok(publishIndex > -1, `${workflow.name} mangler publish-step`);
    assert.ok(nameIndex > -1 && nameIndex < publishIndex, `${workflow.name} konfigurerer git-navn for sent`);
    assert.ok(emailIndex > -1 && emailIndex < publishIndex, `${workflow.name} konfigurerer git-email for sent`);
  }
});

test('mobile live secrets exist only in the exact publish step', async () => {
  const yaml = await fs.readFile(mobileLivePath, 'utf8');
  const start = yaml.indexOf('- name: Publish exact accepted delivery');
  const end = yaml.indexOf('- name: Reconcile publication state', start);
  assert.ok(start > -1 && end > start);
  const publishStep = yaml.slice(start, end);
  const outside = yaml.slice(0, start) + yaml.slice(end);
  assert.match(publishStep, /SOMA_META_ACCESS_TOKEN:\s*\$\{\{ secrets\.SOMA_META_ACCESS_TOKEN \}\}/);
  assert.match(publishStep, /SOMA_ASSET_REPO_TOKEN:\s*\$\{\{ secrets\.SOMA_ASSET_REPO_TOKEN \}\}/);
  assert.doesNotMatch(outside, /secrets\.SOMA_(META_ACCESS_TOKEN|ASSET_REPO_TOKEN)/);
  assert.match(publishStep, /--delivery-type "\$SOMA_DELIVERY_TYPE"/);
  assert.match(publishStep, /--draft-id "\$SOMA_DRAFT_ID"/);
  assert.doesNotMatch(yaml, /--draft-id[^\n]*github\.event/);
  assert.doesNotMatch(yaml, /^env:/m);
  assert.doesNotMatch(yaml, /delivery_type:\s*all|options:\s*\[[^\]]*all/);
});

test('mobile reconciliation and report always run without publishing secrets', async () => {
  const yaml = await fs.readFile(mobileLivePath, 'utf8');
  const reconcile = yaml.slice(
    yaml.indexOf('- name: Reconcile publication state'),
    yaml.indexOf('- name: Persist reconciled drafts'),
  );
  const report = yaml.slice(
    yaml.indexOf('- name: Report sanitized mobile result'),
    yaml.indexOf('- name: Add sanitized summary'),
  );
  assert.match(reconcile, /if:\s*always\(\)/);
  assert.match(report, /if:\s*always\(\)/);
  assert.match(report, /mobile-live-test\.js --report/);
  assert.doesNotMatch(reconcile + report, /SOMA_META_ACCESS_TOKEN|SOMA_ASSET_REPO_TOKEN/);
});

test('operations, publisher, and mobile live workflow serialize shared state writes', async () => {
  const yamls = await Promise.all([
    fs.readFile(operationsPath, 'utf8'),
    fs.readFile(publishPath, 'utf8'),
    fs.readFile(mobileLivePath, 'utf8'),
  ]);
  for (const yaml of yamls) {
    assert.match(yaml, /group:\s*soma-state-writer/);
    assert.match(yaml, /cancel-in-progress:\s*false/);
  }
});
