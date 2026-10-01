'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  parseRepo,
  publicAssetUrl,
  buildAssetUpload,
  gitBlobSha,
  uploadAsset,
  verifyPublicAsset,
} = require('../outputs/content-planner/lib/github-assets');

test('validates separate GitHub repository and HTTPS public URL', () => {
  assert.equal(parseRepo('Amaizingdk/soma-social-assets'), 'Amaizingdk/soma-social-assets');
  assert.equal(publicAssetUrl('https://amaizingdk.github.io/soma-social-assets', '2026/post.jpg'), 'https://amaizingdk.github.io/soma-social-assets/2026/post.jpg');
  assert.throws(() => parseRepo('Amaizingdk/amaizing-os/other'), /ejer\/repository/);
  assert.throws(() => publicAssetUrl('http://example.com', 'post.jpg'), /HTTPS/);
});

test('prepares JPEG without network access and never needs a token', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-github-assets-'));
  const localPath = path.join(directory, 'post.jpg');
  await fs.writeFile(localPath, 'fake-jpeg');
  const upload = await buildAssetUpload({
    repo: 'Amaizingdk/soma-social-assets',
    baseUrl: 'https://amaizingdk.github.io/soma-social-assets',
    localPath,
    assetPath: '2026/post.jpg',
    deliveryType: 'instagram_story',
  });
  assert.equal(upload.publicUrl, 'https://amaizingdk.github.io/soma-social-assets/2026/post.jpg');
  assert.equal(upload.contentBase64, Buffer.from('fake-jpeg').toString('base64'));
  assert.equal(upload.deliveryType, 'instagram_story');
  assert.equal(upload.gitBlobSha, 'c6596fe68588cf8583220abb61e7d2ca231badc8');
  assert.equal(gitBlobSha(Buffer.from('fake-jpeg')), 'c6596fe68588cf8583220abb61e7d2ca231badc8');
});

test('upload requires an explicit local token and sends only the image payload', async () => {
  const upload = {
    endpoint: 'https://api.github.com/repos/Amaizingdk/soma-social-assets/contents/post.jpg',
    publicUrl: 'https://amaizingdk.github.io/soma-social-assets/post.jpg',
    contentBase64: 'ZmFrZQ==',
    gitBlobSha: 'fake-blob-sha',
    deliveryType: 'instagram_story',
  };
  await assert.rejects(uploadAsset({ upload, fetchImpl: async () => { throw new Error('network must not be touched'); } }), /GitHub-token mangler/);
  const requests = [];
  const result = await uploadAsset({
    upload,
    token: 'local-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'image/jpeg' } };
      if (options.method === 'GET') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 201, json: async () => ({ content: { sha: 'fake-sha' } }) };
    },
  });
  assert.equal(result.providerId, 'fake-sha');
  assert.equal(result.deliveryType, 'instagram_story');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[1].options.method, 'PUT');
  assert.equal(requests[1].options.body.includes('local-secret'), false);
  assert.equal(requests[1].options.body.includes('ZmFrZQ=='), true);
  assert.equal(requests[2].options.method, 'HEAD');
  assert.equal(result.reused, false);
});

test('reuses an identical existing asset without PUT', async () => {
  const upload = {
    endpoint: 'https://api.github.com/repos/Amaizingdk/soma-social-assets/contents/post.jpg',
    publicUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main/post.jpg',
    contentBase64: 'ZmFrZQ==',
    gitBlobSha: 'same-blob-sha',
    deliveryType: 'instagram_story',
  };
  let putCalls = 0;
  const result = await uploadAsset({
    upload,
    token: 'local-secret',
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ sha: 'same-blob-sha' }) };
      if (options.method === 'PUT') { putCalls += 1; throw new Error('PUT must not run'); }
      if (options.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => 'image/jpeg' } };
      throw new Error(`Unexpected method ${options.method}`);
    },
  });
  assert.equal(result.reused, true);
  assert.equal(result.providerId, 'same-blob-sha');
  assert.equal(putCalls, 0);
});

test('refuses to overwrite different bytes at a deterministic asset path', async () => {
  const upload = {
    endpoint: 'https://api.github.com/repos/Amaizingdk/soma-social-assets/contents/post.jpg',
    publicUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main/post.jpg',
    contentBase64: 'ZmFrZQ==',
    gitBlobSha: 'expected-blob-sha',
    deliveryType: 'instagram_story',
  };
  let putCalls = 0;
  await assert.rejects(uploadAsset({
    upload,
    token: 'local-secret',
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return { ok: true, status: 200, json: async () => ({ sha: 'different-blob-sha' }) };
      if (options.method === 'PUT') putCalls += 1;
      throw new Error(`Unexpected method ${options.method}`);
    },
  }), /sti-kollision/i);
  assert.equal(putCalls, 0);
});

test('public asset verification fails closed for missing, redirected, or HTML content', async () => {
  const cases = [
    { response: { ok: false, status: 404, headers: { get: () => 'text/plain' } }, expected: /HTTP 404/ },
    { error: new Error('redirect loop'), expected: /kunne ikke verificeres/ },
    { response: { ok: true, status: 200, headers: { get: () => 'text\/html' } }, expected: /image\/jpeg/ },
  ];
  for (const item of cases) {
    await assert.rejects(
      verifyPublicAsset({
        publicUrl: 'https://raw.githubusercontent.com/Amaizingdk/soma-social-assets/main/approved/post.jpg',
        fetchImpl: async () => {
          if (item.error) throw item.error;
          return item.response;
        },
      }),
      item.expected,
    );
  }
});
