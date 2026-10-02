'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runMetaValidation } = require('../outputs/content-planner/validate-meta');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function successfulReadonlyFetch(calls = [], permissions = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
]) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'https://somasaunagus.dk/kalender/') return { ok: true, status: 200 };
    if (url.includes('/me?fields=id,name')) return response({ id: '1024', name: 'Søren Madsen' });
    if (url.includes('/me/permissions')) {
      return response({ data: permissions.map((permission) => ({ permission, status: 'granted' })) });
    }
    if (url.includes('/17841475009702608?fields=id,username,website')) {
      return response({
        id: '17841475009702608', username: 'somasaunagus', website: 'https://somasaunagus.dk/kalender/',
      });
    }
    return response({
      id: '628094223731455',
      name: 'SOMA Sauna Gus',
      instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
    });
  };
}

test('validates both allowed channels with read-only requests and a safe result', async () => {
  const calls = [];
  const output = [];
  const token = 'secret-fixture';
  const result = await runMetaValidation({
    env: { SOMA_META_ACCESS_TOKEN: token },
    config: { bookingUrl: 'https://somasaunagus.dk/kalender/' },
    fetchImpl: successfulReadonlyFetch(calls),
    stdout: (line) => output.push(line),
  });
  assert.deepEqual(result, { status: 'passed', channels: ['instagram_story', 'facebook_page_feed'] });
  assert.equal(calls.every((call) => (call.options.method || 'GET') === 'GET'), true);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(output.join('\n').includes(token), false);
});

test('validate-only never reads the asset repository token', async () => {
  const env = { SOMA_META_ACCESS_TOKEN: 'secret-fixture' };
  Object.defineProperty(env, 'SOMA_ASSET_REPO_TOKEN', {
    get() { throw new Error('asset token was read'); },
  });
  await runMetaValidation({
    env,
    config: { bookingUrl: 'https://somasaunagus.dk/kalender/' },
    fetchImpl: successfulReadonlyFetch(),
    stdout: () => {},
  });
});

test('validate-only stops when Facebook publishing permission is missing', async () => {
  await assert.rejects(runMetaValidation({
    env: { SOMA_META_ACCESS_TOKEN: 'secret-fixture' },
    config: { bookingUrl: 'https://somasaunagus.dk/kalender/' },
    fetchImpl: successfulReadonlyFetch([], [
      'instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement',
    ]),
    stdout: () => {},
  }), /pages_manage_posts/);
});
