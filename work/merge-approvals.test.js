const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeApprovals } = require('../outputs/content-planner/lib/merge-approvals');

const REV = 'a'.repeat(64);
const OLD = 'b'.repeat(64);

function draft(overrides = {}) {
  return {
    draftId: 'd1', status: 'draft', contentRevision: REV,
    approvedAt: null, approvedBy: null, approvedRevision: null, ...overrides,
  };
}
function approved(overrides = {}) {
  return draft({
    status: 'approved', approvedAt: '2026-10-03T10:00:00.000Z', approvedBy: 'soren', approvedRevision: REV, ...overrides,
  });
}

test('keeps an approval from remote when the revision matches', () => {
  const [merged] = mergeApprovals([draft()], [approved()]);
  assert.equal(merged.status, 'approved');
  assert.equal(merged.approvedAt, '2026-10-03T10:00:00.000Z');
  assert.equal(merged.approvedBy, 'soren');
  assert.equal(merged.approvedRevision, REV);
});

test('does not reuse an approval for an older revision', () => {
  const [merged] = mergeApprovals([draft()], [approved({ contentRevision: OLD, approvedRevision: OLD })]);
  assert.equal(merged.status, 'draft');
  assert.equal(merged.approvedAt, null);
});

test('does not reuse an approval whose approvedRevision differs from its own contentRevision', () => {
  const [merged] = mergeApprovals([draft()], [approved({ approvedRevision: OLD })]);
  assert.equal(merged.status, 'draft');
});

test('never overrides a published draft', () => {
  const [merged] = mergeApprovals([draft({ status: 'published' })], [approved()]);
  assert.equal(merged.status, 'published');
});

test('keeps generated drafts without a remote match and preserves order', () => {
  const result = mergeApprovals([draft({ draftId: 'x' }), draft({ draftId: 'y' })], [approved({ draftId: 'y' })]);
  assert.deepEqual(result.map((item) => [item.draftId, item.status]), [['x', 'draft'], ['y', 'approved']]);
});

test('does not mutate inputs', () => {
  const generated = [draft()];
  const remote = [approved()];
  const snapshot = JSON.stringify([generated, remote]);
  mergeApprovals(generated, remote);
  assert.equal(JSON.stringify([generated, remote]), snapshot);
});

test('a remote published draft wins over a generated approved copy', () => {
  const remotePublished = draft({ status: 'published', publishedAt: '2026-10-03T09:00:00.000Z' });
  const [merged] = mergeApprovals([approved()], [remotePublished]);
  assert.equal(merged.status, 'published');
  assert.equal(merged.publishedAt, '2026-10-03T09:00:00.000Z');
});

test('a remote obsolete draft never replaces a generated one', () => {
  const [merged] = mergeApprovals([draft()], [draft({ status: 'obsolete' })]);
  assert.equal(merged.status, 'draft');
});
