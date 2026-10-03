const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildPrivateRuntime } = require('../outputs/content-planner/build-private-runtime');
const sourceRoot = path.resolve(__dirname, '..');

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function createProjectFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-runtime-test-'));
  const projectRoot = path.join(base, 'source');
  const destination = path.join(base, 'release');

  await write(projectRoot, 'outputs/soma-reader.js', 'module.exports = {};\n');
  await write(projectRoot, 'outputs/content-planner/lib/example.js', 'module.exports = {};\n');
  await write(projectRoot, 'outputs/content-planner/publish-due-content.js', 'module.exports = {};\n');
  await write(projectRoot, 'outputs/content-planner/config.json', '{"bookingUrl":"https://somasaunagus.dk/kalender/"}\n');
  await write(projectRoot, 'package.json', '{"name":"fixture","private":true}\n');
  await write(projectRoot, 'package-lock.json', '{"name":"fixture","lockfileVersion":3,"packages":{}}\n');
  await write(projectRoot, 'work/runtime.test.js', "require('node:test')('fixture', () => {});\n");
  await write(projectRoot, 'work/normalized-assets/approved.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await write(projectRoot, 'work/normalized-assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await write(projectRoot, 'work/renders/approved-render.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const render = {
    path: path.join(projectRoot, 'work/renders/approved-render.jpg'),
    width: 1080,
    height: 1350,
    sha256: 'fixture-render-sha',
  };
  const draft = (draftId, status, extra = {}) => ({
    draftId,
    slotKey: draftId,
    revision: 1,
    kind: 'event_day',
    status,
    scheduledFor: '2026-10-04T11:30:00+02:00',
    event: { eventKey: 'event-1', date: '2026-10-04', start: '16:00', end: '18:00', name: 'Saunagus' },
    platformCopies: { instagram: 'Instagram', facebookPage: 'Facebook', facebookGroup: 'Gruppe' },
    assetId: 'approved-image',
    history: [{ type: status }],
    render,
    ...extra,
  });
  await write(projectRoot, 'outputs/content-planner/drafts.json', JSON.stringify([
    draft('approved-1', 'approved', {
      approvedAt: '2026-10-02T09:00:00Z',
      githubIssueNumber: 42,
    }),
    draft('draft-1', 'draft'),
    draft('review-1', 'needs_review'),
    draft('skipped-1', 'skipped', { skipReason: 'missing_approval_at_publish_time' }),
    draft('obsolete-1', 'obsolete'),
  ]));
  await write(projectRoot, 'outputs/content-planner/assets.json', JSON.stringify({
    version: 1,
    logoPath: path.join(projectRoot, 'work/normalized-assets/logo.png'),
    assets: [{
      assetId: 'approved-image',
      status: 'approved',
      sourcePath: 'C:\\Users\\Fixture\\source.jpg',
      normalizedPath: path.join(projectRoot, 'work/normalized-assets/approved.jpg'),
      tags: ['calm'],
    }],
  }));
  await write(projectRoot, 'outputs/content-planner/private-runtime-manifest.json', JSON.stringify({
    version: 1,
    copies: [
      { source: 'outputs/soma-reader.js', destination: 'outputs/soma-reader.js' },
      { source: 'outputs/content-planner/lib', destination: 'outputs/content-planner/lib' },
      { source: 'outputs/content-planner/publish-due-content.js', destination: 'outputs/content-planner/publish-due-content.js' },
      { source: 'outputs/content-planner/config.json', destination: 'outputs/content-planner/config.json' },
      { source: 'package.json', destination: 'package.json' },
      { source: 'package-lock.json', destination: 'package-lock.json' },
    ],
    testGlob: 'work/*.test.js',
    testDestination: 'work',
  }));
  await write(projectRoot, 'outputs/content-planner/prototype.js', 'forbidden\n');
  await write(projectRoot, 'PROJECT_STATUS_2026-10-01.md', 'forbidden\n');
  await write(projectRoot, 'debug.log', 'forbidden\n');
  await write(projectRoot, 'work/licensed-music/song.mp3', 'forbidden\n');

  return { base, projectRoot, destination };
}

test('private runtime includes publisher code but excludes prototypes and notes', async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));

  const result = await buildPrivateRuntime({
    projectRoot: fixture.projectRoot,
    destination: fixture.destination,
    secretValues: [],
  });

  assert(result.files.includes('outputs/content-planner/publish-due-content.js'));
  assert(result.files.includes('package-lock.json'));
  assert(result.files.includes('assets/approved.jpg'));
  assert(result.files.includes('renders/approved-render.jpg'));
  assert.equal(result.files.some((file) => /prototype|licensed-music|PROJECT_STATUS|debug\.log/i.test(file)), false);
});

test('private runtime aborts when a supplied secret is present in copied bytes', async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await write(fixture.projectRoot, 'outputs/content-planner/config.json', '{"token":"secret-fixture-value"}\n');

  await assert.rejects(
    buildPrivateRuntime({
      projectRoot: fixture.projectRoot,
      destination: fixture.destination,
      secretValues: ['secret-fixture-value'],
    }),
    /secret fundet/i,
  );
});

test('private runtime refuses a destination inside the source project', async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));

  await assert.rejects(
    buildPrivateRuntime({
      projectRoot: fixture.projectRoot,
      destination: path.join(fixture.projectRoot, 'nested-repo'),
      secretValues: [],
    }),
    /separat mappe/i,
  );
});

test('generated runtime data keeps operational drafts and portable asset paths', async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));

  await buildPrivateRuntime({
    projectRoot: fixture.projectRoot,
    destination: fixture.destination,
    secretValues: [],
  });
  const drafts = JSON.parse(await fs.readFile(path.join(fixture.destination, 'outputs/content-planner/drafts.json'), 'utf8'));
  const assets = JSON.parse(await fs.readFile(path.join(fixture.destination, 'outputs/content-planner/assets.json'), 'utf8'));

  assert.deepEqual(drafts.map((draft) => draft.status), ['approved', 'draft', 'needs_review', 'skipped']);
  assert.equal(drafts.some((draft) => Object.hasOwn(draft, 'history')), false);
  assert.equal(JSON.stringify(drafts).includes('C:\\Users\\'), false);
  assert.deepEqual(drafts[0].render, {
    path: 'renders/approved-render.jpg',
    width: 1080,
    height: 1350,
    sha256: 'fixture-render-sha',
  });
  await fs.access(path.join(fixture.destination, drafts[0].render.path));
  assert.equal(JSON.stringify(assets).includes('C:\\Users\\'), false);
  assert.equal(assets.logoPath, 'assets/soma-logo-white.png');
  assert.equal(assets.assets.every((asset) => asset.normalizedPath.startsWith('assets/')), true);
  assert.equal(assets.assets.every((asset) => asset.sourcePath === asset.normalizedPath), true);
  assert.equal(assets.assets.some((asset) => /^[A-Za-z]:[\\/]/u.test(asset.sourcePath)), false);
});

test('legacy approved draft receives matching approval revision without losing operations metadata', async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));

  await buildPrivateRuntime({
    projectRoot: fixture.projectRoot,
    destination: fixture.destination,
    secretValues: [],
  });
  const drafts = JSON.parse(await fs.readFile(path.join(fixture.destination, 'outputs/content-planner/drafts.json'), 'utf8'));
  const approved = drafts.find((draft) => draft.draftId === 'approved-1');
  assert.match(approved.contentRevision, /^[a-f0-9]{64}$/);
  assert.equal(approved.approvedRevision, approved.contentRevision);
  assert.equal(approved.approvedBy, 'legacy_local_review');
  assert.equal(approved.githubIssueNumber, 42);
});

test('source runtime allowlist carries the mobile live CLI while recursive roots carry its module and workflow', async () => {
  const manifest = JSON.parse(await fs.readFile(
    path.join(sourceRoot, 'outputs/content-planner/private-runtime-manifest.json'),
    'utf8',
  ));
  assert.equal(manifest.copies.some((entry) => (
    entry.source === 'outputs/content-planner/mobile-live-test.js'
    && entry.destination === 'outputs/content-planner/mobile-live-test.js'
  )), true);
  assert.equal(manifest.copies.some((entry) => (
    entry.source === 'outputs/content-planner/lib'
    && entry.destination === 'outputs/content-planner/lib'
  )), true);
  assert.equal(manifest.copies.some((entry) => (
    entry.source === 'outputs/content-planner/runtime'
    && entry.destination === '.'
  )), true);
});

test('source runtime allowlist carries the approval server and the state persister', async () => {
  const manifest = JSON.parse(await fs.readFile(
    path.join(sourceRoot, 'outputs/content-planner/private-runtime-manifest.json'),
    'utf8',
  ));
  for (const file of ['approval-server.js', 'persist-state.js']) {
    assert.equal(manifest.copies.some((entry) => (
      entry.source === `outputs/content-planner/${file}`
      && entry.destination === `outputs/content-planner/${file}`
    )), true, file);
  }
  const pkg = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['approval-server'], 'node outputs/content-planner/approval-server.js');
});
