'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { uniqueAssets, run } = require('../outputs/content-planner/upload-approved-assets');

test('uploads distinct Story and Facebook assets for one approved draft', () => {
  const plan = { mode: 'dry_run', automatic: [
    { draftId: 'd1', revision: 2, deliveryType: 'instagram_story', imagePath: 'story.jpg', assetPath: 'approved/d1-r2-story.jpg' },
    { draftId: 'd1', revision: 2, deliveryType: 'facebook_page_feed', imagePath: 'facebook.jpg', assetPath: 'approved/d1-r2-facebook.jpg' },
  ] };
  const assets = uniqueAssets(plan, { assetHosting: { repository: 'Amaizingdk/soma-social-assets', baseUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main' } });
  assert.deepEqual(assets.map((item) => item.assetPath), [
    'approved/d1-r2-story.jpg',
    'approved/d1-r2-facebook.jpg',
  ]);
});

test('batch defaults to dry-run without reading a token', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-batch-'));
  const planPath = path.join(directory, 'plan.json');
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(planPath, JSON.stringify({ mode: 'dry_run', automatic: [{ draftId: 'd1', revision: 1, deliveryType: 'instagram_story', imagePath: 'x.jpg', assetPath: 'approved/d1-r1-story.jpg' }] }));
  await fs.writeFile(configPath, JSON.stringify({ assetHosting: { repository: 'Amaizingdk/soma-social-assets', baseUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main' } }));
  const output = [];
  const result = await run(['--plan', planPath, '--config', configPath], {}, async () => { throw new Error('network'); }, (line) => output.push(line));
  assert.equal(result.mode, 'dry_run');
  assert.match(output.at(-1), /1 unikke godkendte billeder/);
});

test('publish mode uploads the prepared JPEG through the injected provider', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-batch-'));
  const imagePath = path.join(directory, 'x.jpg');
  const planPath = path.join(directory, 'plan.json');
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(imagePath, 'fake-jpeg');
  await fs.writeFile(planPath, JSON.stringify({ mode: 'dry_run', automatic: [{ draftId: 'd1', revision: 1, deliveryType: 'instagram_story', imagePath, assetPath: 'approved/d1-r1-story.jpg' }] }));
  await fs.writeFile(configPath, JSON.stringify({ assetHosting: { repository: 'Amaizingdk/soma-social-assets', baseUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main' } }));
  const requests = [];
  const result = await run(['--publish', '--plan', planPath, '--config', configPath], { SOMA_GITHUB_TOKEN: 'local-secret' }, async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'HEAD') {
      return { ok: true, status: 200, headers: { get: () => 'image/jpeg' } };
    }
    if (options.method === 'GET') {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 201, json: async () => ({ content: { sha: 'fake-sha' } }) };
  }, () => {});
  assert.equal(result.mode, 'published');
  assert.equal(result.uploaded[0].providerId, 'fake-sha');
  assert.equal(result.uploaded[0].deliveryType, 'instagram_story');
  assert.equal(requests[1].options.body.includes('local-secret'), false);
  assert.equal(requests[2].options.method, 'HEAD');
});
