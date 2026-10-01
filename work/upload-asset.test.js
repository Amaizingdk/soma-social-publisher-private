'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { run, parseArgs } = require('../outputs/content-planner/upload-asset');

test('asset uploader defaults to dry-run', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-upload-'));
  const file = path.join(directory, 'post.jpg');
  await fs.writeFile(file, 'fake');
  const output = [];
  const result = await run(['--file', file, '--asset-path', '2026/post.jpg'], {}, async () => { throw new Error('network'); }, (line) => output.push(line));
  assert.equal(result.mode, 'dry_run');
  assert.match(output[0], /Forberedt uden upload/);
});

test('real upload requires the explicit publish flag and local token', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-upload-'));
  const file = path.join(directory, 'post.jpg');
  await fs.writeFile(file, 'fake');
  await assert.rejects(run(['--publish', '--file', file, '--asset-path', '2026/post.jpg'], {}), /SOMA_GITHUB_TOKEN mangler/);
  assert.throws(() => parseArgs(['--file', file]), /--file og --asset-path/);
});
