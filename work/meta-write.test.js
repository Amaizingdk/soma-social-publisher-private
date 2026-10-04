'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMetaWriteAdapter } = require('../outputs/content-planner/lib/meta-write');

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

function storyAdapter({ statuses = ['FINISHED'], calls = [], bioLinkValidator = async () => ({ status: 'passed' }), maxStatusChecks = 3 } = {}) {
  let statusIndex = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') {
      if (url.includes('/628094223731455?fields=access_token')) {
        return response({ id: '628094223731455', access_token: 'page-access-token' });
      }
      const statusCode = statuses[Math.min(statusIndex, statuses.length - 1)];
      statusIndex += 1;
      return response({ status_code: statusCode });
    }
    if (url.endsWith('/media')) return response({ id: 'container-1' });
    if (url.includes('/media_publish')) return response({ id: 'ig-story-1' });
    if (url.endsWith('/photos')) return response({ id: 'fb-post-1' });
    throw new Error(`Unexpected URL: ${url}`);
  };
  return createMetaWriteAdapter({
    token: 'secret-token',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl,
    bioLinkValidator,
    waitImpl: async () => {},
    maxStatusChecks,
  });
}

test('Instagram delivery creates a Story container and never a Feed container', async () => {
  const calls = [];
  const adapter = storyAdapter({ calls });
  const result = await adapter.publish({
    deliveryType: 'instagram_story',
    imageUrl: 'https://example.com/story.jpg',
    idempotencyKey: 'story-key',
  });
  const body = String(calls[0].options.body);
  assert.equal(result.providerId, 'ig-story-1');
  assert.match(body, /media_type=STORIES/);
  assert.match(body, /image_url=https%3A%2F%2Fexample.com%2Fstory.jpg/);
  assert.doesNotMatch(body, /caption=/);
  assert.doesNotMatch(body, /share_to_feed/);
  assert.equal(calls.at(-1).url, 'https://graph.facebook.com/v26.0/17841475009702608/media_publish');
});

test('waits for an IN_PROGRESS Story container to become FINISHED', async () => {
  const calls = [];
  const adapter = storyAdapter({ statuses: ['IN_PROGRESS', 'FINISHED'], calls });
  await adapter.publish({ deliveryType: 'instagram_story', imageUrl: 'https://example.com/story.jpg' });
  assert.equal(calls.filter((call) => call.options.method === 'GET').length, 2);
  assert.equal(calls.filter((call) => call.url.includes('/media_publish')).length, 1);
});

test('does not publish a Story container in ERROR state', async () => {
  const calls = [];
  const adapter = storyAdapter({ statuses: ['ERROR'], calls });
  await assert.rejects(
    adapter.publish({ deliveryType: 'instagram_story', imageUrl: 'https://example.com/story.jpg' }),
    /ERROR/,
  );
  assert.equal(calls.some((call) => call.url.includes('/media_publish')), false);
});

test('times out without publishing when a Story container never finishes', async () => {
  const calls = [];
  const adapter = storyAdapter({ statuses: ['IN_PROGRESS'], calls, maxStatusChecks: 2 });
  await assert.rejects(
    adapter.publish({ deliveryType: 'instagram_story', imageUrl: 'https://example.com/story.jpg' }),
    /timeout/i,
  );
  assert.equal(calls.filter((call) => call.options.method === 'GET').length, 2);
  assert.equal(calls.some((call) => call.url.includes('/media_publish')), false);
});

test('Facebook Page feed resolves a Page token before using the Page photo endpoint', async () => {
  const calls = [];
  const adapter = storyAdapter({ calls });
  const result = await adapter.publish({
    deliveryType: 'facebook_page_feed',
    imageUrl: 'https://example.com/facebook.jpg',
    caption: 'Godkendt tekst · 6 ledige pladser',
  });
  assert.equal(result.providerId, 'fb-post-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v26.0/628094223731455?fields=access_token');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[1].url, 'https://graph.facebook.com/v26.0/628094223731455/photos');
  assert.match(String(calls[1].options.body), /caption=Godkendt\+tekst/);
  assert.match(String(calls[1].options.body), /access_token=page-access-token/);
  assert.doesNotMatch(String(calls[1].options.body), /secret-token/);
});

for (const deliveryType of ['instagram_feed', 'facebook_private_profile', 'facebook_private_story', 'facebook_group']) {
  test(`refuses forbidden destination ${deliveryType} before network access`, async () => {
    let called = false;
    const adapter = createMetaWriteAdapter({
      token: 'secret',
      instagramUserId: 'ig',
      pageId: 'page',
      fetchImpl: async () => { called = true; return response({}); },
    });
    await assert.rejects(
      adapter.publish({ deliveryType, imageUrl: 'https://example.com/a.jpg', caption: 'Test' }),
      /ikke tilladt/,
    );
    assert.equal(called, false);
  });
}

test('Meta adapter refuses missing token before network access', async () => {
  let called = false;
  const adapter = createMetaWriteAdapter({ token: '', instagramUserId: 'ig', fetchImpl: async () => { called = true; } });
  await assert.rejects(adapter.publish({ deliveryType: 'instagram_story', imageUrl: 'https://example.com/a.jpg' }), /Meta-token mangler/);
  assert.equal(called, false);
});

test('Instagram Story is blocked before Meta write when bio-link validation fails', async () => {
  let writeCalled = false;
  const adapter = createMetaWriteAdapter({
    token: 'secret',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl: async () => { writeCalled = true; return response({ id: 'unexpected' }); },
    preflightValidator: async () => { throw new Error('Instagram bio-link matcher ikke bookinglinket'); },
  });
  await assert.rejects(
    adapter.preflight({ deliveryType: 'instagram_story', imageUrl: 'https://example.com/story.jpg' }),
    /bio-link/i,
  );
  assert.equal(writeCalled, false);
});

test('preflight rejects missing delivery permissions before a write request', async () => {
  let writeCalls = 0;
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') writeCalls += 1;
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
  const adapter = createMetaWriteAdapter({
    token: 'secret-value',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl,
  });
  await assert.rejects(adapter.preflight({ deliveryType: 'instagram_story' }), /instagram_content_publish/);
  assert.equal(writeCalls, 0);
});

test('preflight rejects any destination outside Story and Facebook Page', async () => {
  let called = false;
  const adapter = createMetaWriteAdapter({
    token: 'secret',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    fetchImpl: async () => { called = true; return response({}); },
  });
  await assert.rejects(adapter.preflight({ deliveryType: 'instagram_feed' }), /ikke tilladt/);
  await assert.rejects(adapter.preflight({ deliveryType: 'facebook_private_story' }), /ikke tilladt/);
  await assert.rejects(adapter.preflight({ deliveryType: 'facebook_group' }), /ikke tilladt/);
  assert.equal(called, false);
});

test('sanitized Meta failures never include the token', async () => {
  const token = 'secret-value-never-log';
  const adapter = createMetaWriteAdapter({
    token,
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl: async () => { throw new Error(`leak ${token}`); },
  });
  await assert.rejects(adapter.preflight({ deliveryType: 'instagram_story' }), (error) => {
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

test('write boundary exposes only HTTP status and Meta error code', async () => {
  const token = 'secret-value-never-log';
  const adapter = createMetaWriteAdapter({
    token,
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    fetchImpl: async () => response({ error: { message: `raw ${token}`, code: 190 } }, { ok: false, status: 401 }),
  });
  await assert.rejects(
    adapter.publish({ deliveryType: 'facebook_page_feed', imageUrl: 'https://example.com/a.jpg', caption: 'Test' }),
    (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /code 190/);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes('raw'), false);
      return true;
    },
  );
});

function storyAdapterWithFacebookStory({ calls = [], failAt = null, enabled = true } = {}) {
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') {
      if (url.includes('/628094223731455?fields=access_token')) {
        return response({ id: '628094223731455', access_token: 'page-access-token' });
      }
      return response({ status_code: 'FINISHED' });
    }
    if (failAt && url.endsWith(failAt)) return response({ error: { code: 200, message: 'secret-token leaked?' } }, { ok: false, status: 403 });
    if (url.endsWith('/media')) return response({ id: 'container-1' });
    if (url.includes('/media_publish')) return response({ id: 'ig-story-1' });
    if (url.endsWith('/628094223731455/photos')) return response({ id: 'fb-photo-1' });
    if (url.endsWith('/photo_stories')) return response({ success: true, post_id: 'fb-story-1' });
    throw new Error(`Unexpected URL: ${url}`);
  };
  return createMetaWriteAdapter({
    token: 'secret-token',
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: 'https://somasaunagus.dk/kalender/',
    fetchImpl,
    facebookStoryEnabled: enabled,
    waitImpl: async () => {},
  });
}

const STORY_ITEM = { deliveryType: 'instagram_story', imageUrl: 'https://example.com/story.jpg' };

test('Instagram Story is also placed on the Facebook Page as a Story, using the Page token', async () => {
  const calls = [];
  const result = await storyAdapterWithFacebookStory({ calls }).publish(STORY_ITEM);
  assert.equal(result.providerId, 'ig-story-1');
  assert.deepEqual(result.facebookStory, { status: 'published', id: 'fb-story-1' });
  const after = calls.slice(calls.findIndex((call) => call.url.includes('/media_publish')) + 1);
  assert.deepEqual(after.map((call) => call.url.replace('https://graph.facebook.com/v26.0', '')), [
    '/628094223731455?fields=access_token',
    '/628094223731455/photos',
    '/628094223731455/photo_stories',
  ]);
  const photoBody = String(after[1].options.body);
  assert.match(photoBody, /published=false/);
  assert.match(photoBody, /url=https%3A%2F%2Fexample.com%2Fstory.jpg/);
  assert.match(photoBody, /access_token=page-access-token/);
  assert.match(String(after[2].options.body), /photo_id=fb-photo-1/);
  assert.doesNotMatch(String(after[2].options.body), /secret-token/);
});

test('a failing Facebook Story never fails the Instagram Story and leaks no token', async () => {
  for (const failAt of ['/photos', '/photo_stories']) {
    const result = await storyAdapterWithFacebookStory({ failAt }).publish(STORY_ITEM);
    assert.equal(result.providerId, 'ig-story-1');
    assert.equal(result.facebookStory.status, 'failed');
    assert.match(result.facebookStory.reason, /HTTP 403/);
    assert.doesNotMatch(JSON.stringify(result), /secret-token|page-access-token/);
  }
});

test('the Facebook Story is off unless it is enabled, and never touches other deliveries', async () => {
  const calls = [];
  const result = await storyAdapterWithFacebookStory({ calls, enabled: false }).publish(STORY_ITEM);
  assert.equal(result.facebookStory, undefined);
  assert.equal(calls.some((call) => call.url.includes('photo_stories')), false);
  const feedCalls = [];
  const feed = await storyAdapterWithFacebookStory({ calls: feedCalls }).publish({
    deliveryType: 'facebook_page_feed', imageUrl: 'https://example.com/f.jpg', caption: 'Tekst',
  });
  assert.equal(feed.facebookStory, undefined);
  assert.equal(feedCalls.some((call) => call.url.includes('photo_stories')), false);
});
