'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  loadJsonValidated,
  writeJsonAtomic,
} = require('../outputs/content-planner/lib/io');

test('loadJsonValidated parses JSON and applies the validator', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-io-'));
  const file = path.join(dir, 'valid.json');
  await fs.writeFile(file, '{"value":42}\n', 'utf8');
  const value = await loadJsonValidated(file, (data) => {
    if (data.value !== 42) throw new Error('forkert værdi');
  });
  assert.deepEqual(value, { value: 42 });
});

test('loadJsonValidated reports invalid JSON with its path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-io-'));
  const file = path.join(dir, 'broken.json');
  await fs.writeFile(file, '{broken', 'utf8');
  await assert.rejects(loadJsonValidated(file, () => {}), /broken\.json.*JSON/i);
});

test('writeJsonAtomic leaves valid newline-terminated JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-io-'));
  const file = path.join(dir, 'state.json');
  await writeJsonAtomic(file, { status: 'draft' });
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.deepEqual(JSON.parse(raw), { status: 'draft' });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
});
