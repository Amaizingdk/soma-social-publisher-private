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
