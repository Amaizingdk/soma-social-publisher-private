'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatMetaExpiry, runMetaValidation } = require('../outputs/content-planner/validate-meta');

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

test('prints token type and expiry from debug_token without ever printing the token', async () => {
  const token = 'secret-fixture';
  const output = [];
  const base = successfulReadonlyFetch();
  const expires = Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000);
  const fetchImpl = async (url, options) => {
    if (url.includes('/debug_token')) {
      return response({ data: {
        type: 'USER', is_valid: true, expires_at: expires, data_access_expires_at: 0, scopes: ['instagram_basic'],
      } });
    }
    return base(url, options);
  };
  await runMetaValidation({
    env: { SOMA_META_ACCESS_TOKEN: token },
    config: { bookingUrl: 'https://somasaunagus.dk/kalender/' },
    fetchImpl,
    stdout: (line) => output.push(line),
  });
  const text = output.join('\n');
  assert.match(text, /type USER, gyldigt: ja, udløber: 2026-12-01/);
  assert.match(text, /dataadgang udløber: aldrig/);
  assert.match(text, /instagram_basic/);
  assert.equal(text.includes(token), false);
});

test('a failing debug_token never fails the validate-only result', async () => {
  const base = successfulReadonlyFetch();
  const output = [];
  const result = await runMetaValidation({
    env: { SOMA_META_ACCESS_TOKEN: 'secret-fixture' },
    config: { bookingUrl: 'https://somasaunagus.dk/kalender/' },
    fetchImpl: async (url, options) => (url.includes('/debug_token') ? response({}, 400) : base(url, options)),
    stdout: (line) => output.push(line),
  });
  assert.equal(result.status, 'passed');
  assert.match(output.join('\n'), /kunne ikke læses/);
});

test('formatMetaExpiry understands never, unknown and expired', () => {
  const now = new Date('2026-10-05T00:00:00Z');
  assert.equal(formatMetaExpiry(0, now), 'aldrig');
  assert.equal(formatMetaExpiry(undefined, now), 'ukendt');
  assert.match(formatMetaExpiry(Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000), now), /udløbet/);
  assert.match(formatMetaExpiry(Math.floor(Date.parse('2026-11-04T00:00:00Z') / 1000), now), /30 dage tilbage/);
});
