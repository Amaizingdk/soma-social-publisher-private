'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requestMetaReadonly,
  sanitizeMetaError,
  validateInstagramBioLink,
  validateMetaConnection,
  validateMetaPreflight,
} = require('../outputs/content-planner/lib/meta-readonly');

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function successfulFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/me?')) return response({ id: '1024', name: 'Søren Madsen' });
    return response({
      id: '628094223731455',
      name: 'SOMA Sauna Gus',
      instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
    });
  };
}

test('uses GET and an Authorization header only against graph.facebook.com v26', async () => {
  const calls = [];
  await requestMetaReadonly({
    method: 'GET',
    path: '/me?fields=id,name',
    token: 'test-secret',
    fetchImpl: successfulFetch(calls),
  });

  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/me?fields=id,name');
  assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer test-secret' });
});

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'get']) {
  test(`rejects ${method} before reading a token or reaching fetch`, async () => {
    let fetched = false;
    const options = {
      method,
      path: '/me',
      fetchImpl: async () => { fetched = true; return response({}); },
    };
    Object.defineProperty(options, 'token', {
      get() { throw new Error('token must not be read'); },
    });

    await assert.rejects(requestMetaReadonly(options), /Kun GET/);
    assert.equal(fetched, false);
  });
}

test('rejects paths that can replace the fixed Meta origin', async () => {
  await assert.rejects(
    requestMetaReadonly({ path: '//example.com/steal', token: 'test-secret', fetchImpl: async () => response({}) }),
    /relativ Meta-sti/,
  );
});

test('rejects a missing token without calling fetch', async () => {
  let fetched = false;
  await assert.rejects(
    requestMetaReadonly({ path: '/me', token: ' ', fetchImpl: async () => { fetched = true; } }),
    /Meta-token mangler/,
  );
  assert.equal(fetched, false);
});

test('sanitizes upstream failures and token-shaped text', async () => {
  const token = 'test-secret';
  const tokenShape = ['EA', 'A', '1234567890123456789012345'].join('');
  await assert.rejects(
    requestMetaReadonly({
      path: '/me',
      token,
      fetchImpl: async () => { throw new Error(`socket failed ${token} ${tokenShape}`); },
    }),
    (error) => {
      assert.match(error.message, /Meta GET fejlede/);
      assert.doesNotMatch(error.message, /test-secret/);
      assert.equal(error.message.includes(tokenShape), false);
      return true;
    },
  );

  const sanitized = sanitizeMetaError(new Error('bad test-secret'), ['test-secret']);
  assert.doesNotMatch(sanitized.message, /test-secret/);
});

test('turns non-2xx responses into safe status-only errors', async () => {
  await assert.rejects(
    requestMetaReadonly({
      path: '/me',
      token: 'test-secret',
      fetchImpl: async () => response({ error: { message: 'raw secret detail' } }, { ok: false, status: 401 }),
    }),
    (error) => error.message === 'Meta GET fejlede (HTTP 401)',
  );
});

test('validates the exact SOMA user, Page, and Instagram identities with two GETs', async () => {
  const calls = [];
  const result = await validateMetaConnection({ token: 'test-secret', fetchImpl: successfulFetch(calls) });

  assert.deepEqual(result, {
    status: 'passed',
    userId: '1024',
    userName: 'Søren Madsen',
    pageId: '628094223731455',
    pageName: 'SOMA Sauna Gus',
    instagramId: '17841475009702608',
    instagramUsername: 'somasaunagus',
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.method === 'GET'));
});

test('preflight requires the channel-specific granted permissions', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/me?fields=id,name')) return response({ id: '1024', name: 'Søren Madsen' });
    if (url.includes('/me/permissions')) {
      return response({ data: [{ permission: 'instagram_basic', status: 'granted' }] });
    }
    return response({
      id: '628094223731455',
      name: 'SOMA Sauna Gus',
      instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
    });
  };

  await assert.rejects(validateMetaPreflight({
    token: 'test-secret',
    deliveryType: 'instagram_story',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl,
  }), /instagram_content_publish/);
});

test('Facebook preflight requires Page permissions but not Instagram bio lookup', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/me?fields=id,name')) return response({ id: '1024', name: 'Søren Madsen' });
    if (url.includes('/me/permissions')) {
      return response({ data: [
        { permission: 'pages_show_list', status: 'granted' },
        { permission: 'pages_read_engagement', status: 'granted' },
        { permission: 'pages_manage_posts', status: 'granted' },
      ] });
    }
    return response({
      id: '628094223731455',
      name: 'SOMA Sauna Gus',
      instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
    });
  };

  const result = await validateMetaPreflight({
    token: 'test-secret',
    deliveryType: 'facebook_page_feed',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl,
  });
  assert.equal(result.status, 'passed');
  assert.equal(calls.some((url) => url.includes('fields=id,username,website')), false);
});

test('validates SOMA Instagram bio link and confirms the booking page opens', async () => {
  const calls = [];
  const result = await validateInstagramBioLink({
    token: 'test-secret',
    expectedBookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.startsWith('https://graph.facebook.com/')) {
        return response({
          id: '17841475009702608',
          username: 'somasaunagus',
          website: 'https://somasaunagus.dk/kalender',
        });
      }
      return { ok: true, status: 200, url: 'https://somasaunagus.dk/kalender/' };
    },
  });

  assert.deepEqual(result, {
    status: 'passed',
    instagramId: '17841475009702608',
    instagramUsername: 'somasaunagus',
    website: 'https://somasaunagus.dk/kalender',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /fields=id,username,website/);
  assert.equal(calls[1].url, 'https://somasaunagus.dk/kalender/');
});

test('blocks before checking the website when Instagram bio link is missing or wrong', async () => {
  for (const website of ['', 'https://example.com/booking']) {
    let bookingPageCalled = false;
    await assert.rejects(
      validateInstagramBioLink({
        token: 'test-secret',
        expectedBookingUrl: 'https://somasaunagus.dk/kalender/',
        fetchImpl: async (url) => {
          if (url.startsWith('https://graph.facebook.com/')) {
            return response({ id: '17841475009702608', username: 'somasaunagus', website });
          }
          bookingPageCalled = true;
          return { ok: true, status: 200 };
        },
      }),
      /bio-link/i,
    );
    assert.equal(bookingPageCalled, false);
  }
});

test('blocks when the configured booking page cannot be opened', async () => {
  await assert.rejects(
    validateInstagramBioLink({
      token: 'test-secret',
      expectedBookingUrl: 'https://somasaunagus.dk/kalender/',
      fetchImpl: async (url) => url.startsWith('https://graph.facebook.com/')
        ? response({ id: '17841475009702608', username: 'somasaunagus', website: 'https://somasaunagus.dk/kalender/' })
        : { ok: false, status: 503 },
    }),
    /bookingsiden kan ikke åbnes/i,
  );
});

test('rejects a successful response that contains no readable user identity', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/me?')) return response({});
    return response({
      id: '628094223731455',
      name: 'SOMA Sauna Gus',
      instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
    });
  };
  await assert.rejects(
    validateMetaConnection({ token: 'test-secret', fetchImpl }),
    /Meta-identitet matcher ikke SOMA/,
  );
});

for (const mutation of [
  { label: 'Page ID', change: (page) => { page.id = 'wrong'; } },
  { label: 'Page name', change: (page) => { page.name = 'Wrong'; } },
  { label: 'Instagram ID', change: (page) => { page.instagram_business_account.id = 'wrong'; } },
  { label: 'Instagram username', change: (page) => { page.instagram_business_account.username = 'wrong'; } },
]) {
  test(`rejects a wrong ${mutation.label}`, async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/me?')) return response({ id: '1024', name: 'Søren Madsen' });
      const page = {
        id: '628094223731455',
        name: 'SOMA Sauna Gus',
        instagram_business_account: { id: '17841475009702608', username: 'somasaunagus' },
      };
      mutation.change(page);
      return response(page);
    };

    await assert.rejects(
      validateMetaConnection({ token: 'test-secret', fetchImpl }),
      /Meta-identitet matcher ikke SOMA/,
    );
  });
}
