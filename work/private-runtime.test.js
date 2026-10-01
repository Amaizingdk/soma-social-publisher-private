const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { buildPrivateRuntime } = require('../outputs/content-planner/build-private-runtime');

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
  await write(projectRoot, 'outputs/content-planner/drafts.json', JSON.stringify([
    { draftId: 'approved-1', status: 'approved', history: [{ type: 'approve' }], render: { path: 'C:\\Users\\Fixture\\render.jpg' } },
    { draftId: 'draft-1', status: 'draft', history: [] },
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

test('generated runtime data contains only approved drafts and portable asset paths', async (t) => {
  const fixture = await createProjectFixture();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));

  await buildPrivateRuntime({
    projectRoot: fixture.projectRoot,
    destination: fixture.destination,
    secretValues: [],
  });
  const drafts = JSON.parse(await fs.readFile(path.join(fixture.destination, 'outputs/content-planner/drafts.json'), 'utf8'));
  const assets = JSON.parse(await fs.readFile(path.join(fixture.destination, 'outputs/content-planner/assets.json'), 'utf8'));

  assert.equal(drafts.every((draft) => draft.status === 'approved'), true);
  assert.equal(drafts.some((draft) => Object.hasOwn(draft, 'history')), false);
  assert.equal(JSON.stringify(drafts).includes('C:\\Users\\'), false);
  assert.equal(JSON.stringify(assets).includes('C:\\Users\\'), false);
  assert.equal(assets.logoPath, 'assets/soma-logo-white.png');
  assert.equal(assets.assets.every((asset) => asset.normalizedPath.startsWith('assets/')), true);
  assert.equal(assets.assets.every((asset) => asset.sourcePath === asset.normalizedPath), true);
  assert.equal(assets.assets.some((asset) => /^[A-Za-z]:[\\/]/u.test(asset.sourcePath)), false);
});
