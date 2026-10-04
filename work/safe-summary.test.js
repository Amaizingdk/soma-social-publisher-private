const test = require('node:test');
const assert = require('node:assert/strict');

const { safeRunSummary } = require('../outputs/content-planner/lib/safe-summary');

test('summary strips tokens and raw response data', () => {
  const token = 'secret-value';
  const summary = safeRunSummary({
    runId: 'run-42',
    results: [{
      draftId: 'draft-1',
      idempotencyKey: 'delivery-1',
      deliveryType: 'instagram_story',
      status: 'manual_review_required',
      reason: `raw response access_token=${token}`,
      rawResponse: { token },
      providerId: 'provider-1',
    }],
  }, [token]);

  assert.equal(JSON.stringify(summary).includes(token), false);
  assert.deepEqual(Object.keys(summary.items[0]), [
    'draftId',
    'idempotencyKey',
    'deliveryType',
    'status',
    'reason',
  ]);
  assert.equal(Object.hasOwn(summary.items[0], 'rawResponse'), false);
  assert.equal(Object.hasOwn(summary.items[0], 'providerId'), false);
});

test('summary handles missing results without leaking token-shaped values', () => {
  const tokenShape = ['EA', 'A', '1234567890123456789012345'].join('');
  const summary = safeRunSummary({
    results: [{ status: 'blocked', reason: tokenShape }],
  });
  assert.equal(summary.runId, 'local');
  assert.equal(JSON.stringify(summary).includes(tokenShape), false);
});

test('summary carries the Facebook Story status but never raw data', () => {
  const summary = safeRunSummary({
    runId: 'r',
    results: [{ draftId: 'd', deliveryType: 'instagram_story', status: 'published', facebookStory: 'published', reason: '', providerId: 'x' }],
  });
  assert.equal(summary.items[0].facebookStory, 'published');
  assert.equal('providerId' in summary.items[0], false);
  const without = safeRunSummary({ runId: 'r', results: [{ draftId: 'd', status: 'published' }] });
  assert.equal('facebookStory' in without.items[0], false);
});
