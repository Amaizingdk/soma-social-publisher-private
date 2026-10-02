'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parsePublisherArgs,
  runPublisher,
} = require('../outputs/content-planner/publish-content');

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-publisher-cli-'));
  const imagePath = path.join(directory, 'render.jpg');
  const draftsPath = path.join(directory, 'drafts.json');
  const eventsPath = path.join(directory, 'events.json');
  const outputPath = path.join(directory, 'publish-plan.json');
  await fs.writeFile(imagePath, 'fixture image');
  await fs.writeFile(draftsPath, `${JSON.stringify([{
    draftId: 'approved_r1',
    eventKey: 'event-1',
    revision: 1,
    status: 'approved',
    approvedAt: '2026-09-30T07:00:00Z',
    contentRevision: 'a'.repeat(64),
    approvedRevision: 'a'.repeat(64),
    scheduledFor: '2026-10-01T11:30:00+02:00',
    warnings: [],
    warningsAcknowledged: false,
    platformCopies: {
      facebookPage: 'Facebook-side tekst\n\n8 ledige pladser.',
      instagram: 'Instagram-tekst\n\n8 ledige pladser.',
      facebookGroup: 'Facebook-gruppe tekst',
    },
    event: { eventKey: 'event-1', date: '2026-10-01', start: '18:30', end: '20:30', name: 'Saunagus', booked: 4, capacity: 12 },
    render: { path: imagePath, width: 1080, height: 1350 },
  }], null, 2)}\n`, 'utf8');
  await fs.writeFile(eventsPath, `${JSON.stringify([{
    eventKey: 'event-1', date: '2026-10-01', start: '18:30', end: '20:30', name: 'Saunagus', booked: 6, capacity: 12,
    readAt: new Date().toISOString(),
  }], null, 2)}\n`, 'utf8');
  return { directory, draftsPath, eventsPath, outputPath };
}

function cliArgs(paths, extra = []) {
  return ['--dry-run', ...extra, '--drafts', paths.draftsPath, '--output', paths.outputPath];
}

function metaFetch() {
  return async (url) => {
    if (url.includes('/me?')) {
      return { ok: true, status: 200, json: async () => ({ id: '1024', name: 'Søren Madsen' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: '628094223731455',
        name: 'SOMA Sauna Gus',
        instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
      }),
    };
  };
}

test('requires the explicit dry-run flag', () => {
  assert.throws(() => parsePublisherArgs([]), /--dry-run er påkrævet/);
});

test('rejects unknown flags before reading environment values', async () => {
  const env = new Proxy({}, { get() { throw new Error('environment must not be read'); } });
  await assert.rejects(
    runPublisher({ argv: ['--publish'], env }),
    /Ukendt argument: --publish/,
  );
});

for (const flag of ['--drafts', '--output']) {
  test(`rejects a missing value after ${flag} before reading files`, () => {
    assert.throws(() => parsePublisherArgs(['--dry-run', flag]), new RegExp(`${flag} mangler en sti`));
    assert.throws(() => parsePublisherArgs(['--dry-run', flag, '--validate-meta']), new RegExp(`${flag} mangler en sti`));
  });
}

test('rejects blank input and output paths', () => {
  assert.throws(() => parsePublisherArgs(['--dry-run', '--drafts', '']), /--drafts mangler en sti/);
  assert.throws(() => parsePublisherArgs(['--dry-run', '--output', '   ']), /--output mangler en sti/);
});

test('offline dry-run writes parseable newline-terminated JSON without network access', async () => {
  const paths = await fixture();
  const output = [];
  const plan = await runPublisher({
    argv: cliArgs(paths),
    env: {},
    fetchImpl: async () => { throw new Error('network must not be touched'); },
    stdout: (line) => output.push(line),
  });

  const raw = await fs.readFile(paths.outputPath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(plan.metaValidation.status, 'not_requested');
  assert.match(output[0], /Dry-run gemt/);
  assert.deepEqual((await fs.readdir(paths.directory)).filter((name) => name.includes('.tmp-')), []);
});

test('never serializes the environment token into an offline plan', async () => {
  const paths = await fixture();
  const token = 'test-secret-never-write';
  await runPublisher({ argv: cliArgs(paths), env: { SOMA_META_ACCESS_TOKEN: token }, stdout: () => {} });
  const raw = await fs.readFile(paths.outputPath, 'utf8');
  assert.equal(raw.includes(token), false);
});

test('validate-meta without a token fails before writing a plan', async () => {
  const paths = await fixture();
  await assert.rejects(
    runPublisher({ argv: cliArgs(paths, ['--validate-meta']), env: {}, fetchImpl: metaFetch(), stdout: () => {} }),
    /Meta-token mangler/,
  );
  await assert.rejects(fs.access(paths.outputPath));
});

test('successful fake Meta validation records only safe identity fields', async () => {
  const paths = await fixture();
  const token = 'test-secret';
  const plan = await runPublisher({
    argv: cliArgs(paths, ['--validate-meta']),
    env: { SOMA_META_ACCESS_TOKEN: token },
    fetchImpl: metaFetch(),
    stdout: () => {},
  });

  assert.equal(plan.metaValidation.status, 'passed');
  assert.equal(plan.metaValidation.pageId, '628094223731455');
  assert.equal((await fs.readFile(paths.outputPath, 'utf8')).includes(token), false);
});

test('optional live events input updates dynamic availability without reapproval', async () => {
  const paths = await fixture();
  const plan = await runPublisher({
    argv: cliArgs(paths, ['--events', paths.eventsPath]),
    env: {},
    stdout: () => {},
  });
  assert.equal(plan.summary.approvedDrafts, 1);
  assert.equal(plan.blocked.length, 0);
  assert.match(plan.automatic.find((item) => item.platform === 'instagram').caption, /6 ledige pladser/);
});

test('failed Meta validation does not overwrite an existing valid plan', async () => {
  const paths = await fixture();
  const existing = '{"safe":"existing"}\n';
  await fs.writeFile(paths.outputPath, existing, 'utf8');

  await assert.rejects(
    runPublisher({
      argv: cliArgs(paths, ['--validate-meta']),
      env: { SOMA_META_ACCESS_TOKEN: 'test-secret' },
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      stdout: () => {},
    }),
    /HTTP 401/,
  );
  assert.equal(await fs.readFile(paths.outputPath, 'utf8'), existing);
});

test('refuses to overwrite the source drafts file', async () => {
  const paths = await fixture();
  const before = await fs.readFile(paths.draftsPath, 'utf8');
  await assert.rejects(
    runPublisher({
      argv: ['--dry-run', '--drafts', paths.draftsPath, '--output', paths.draftsPath],
      env: {},
      stdout: () => {},
    }),
    /Output må ikke overskrive kladdefilen/,
  );
  assert.equal(await fs.readFile(paths.draftsPath, 'utf8'), before);
});

test('refuses to overwrite an unrelated existing file', async () => {
  const paths = await fixture();
  const unrelatedPath = path.join(paths.directory, 'config.json');
  const before = '{"important":true}\n';
  await fs.writeFile(unrelatedPath, before, 'utf8');
  await assert.rejects(
    runPublisher({
      argv: ['--dry-run', '--drafts', paths.draftsPath, '--output', unrelatedPath],
      env: {},
      stdout: () => {},
    }),
    /Outputfilen er ikke en eksisterende SOMA dry-run-plan/,
  );
  assert.equal(await fs.readFile(unrelatedPath, 'utf8'), before);
});
