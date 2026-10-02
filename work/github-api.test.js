const test = require('node:test');
const assert = require('node:assert/strict');

const { createGitHubClient } = require('../outputs/content-planner/lib/github-api');

const REPOSITORY = 'Amaizingdk/soma-social-publisher-private';

test('GitHub client is locked to the SOMA private repository', () => {
  assert.throws(() => createGitHubClient({
    repository: 'Amaizingdk/another-repository',
    token: 'github-secret',
    fetchImpl: async () => undefined,
  }), /matcher ikke SOMA/i);
});

test('client accepts only relative paths below the configured repository', async () => {
  let calls = 0;
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: 'github-secret',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [] };
    },
  });

  for (const invalidPath of ['https://evil.example/issues', '//evil.example/issues', 'issues']) {
    await assert.rejects(client.request('GET', invalidPath), /relativ GitHub-sti/i);
  }
  assert.equal(calls, 0);
});

test('HTTP failures redact both token and response body', async () => {
  const secret = 'github-secret-that-must-not-leak';
  const responseBody = 'private response body that must not leak';
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: secret,
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => responseBody }),
  });

  await assert.rejects(client.request('GET', '/issues'), (error) => {
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(responseBody), false);
    assert.match(error.message, /HTTP 403/);
    return true;
  });
});

test('client sends authenticated JSON only to the exact repository API root', async () => {
  const calls = [];
  const client = createGitHubClient({
    repository: REPOSITORY,
    token: 'github-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 201, json: async () => ({ number: 7 }) };
    },
  });

  const result = await client.request('POST', '/issues', { title: 'SOMA' });
  assert.equal(result.number, 7);
  assert.equal(calls[0].url, 'https://api.github.com/repos/' + REPOSITORY + '/issues');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer github-secret');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.body, JSON.stringify({ title: 'SOMA' }));
});

test('client requires a token before any request can be made', () => {
  assert.throws(() => createGitHubClient({
    repository: REPOSITORY,
    token: '',
    fetchImpl: async () => undefined,
  }), /GITHUB_TOKEN mangler/);
});
