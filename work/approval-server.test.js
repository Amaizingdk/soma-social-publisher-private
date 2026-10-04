const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createApprovalServer } = require('../outputs/content-planner/approval-server');

const KEY = 'k'.repeat(48);
const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);
const PLACEHOLDER = '<script id="soma-session" type="application/json">null</script>';
const INDEX = `<!doctype html><html><body>${PLACEHOLDER}<script src="app.js"></script></body></html>`;

async function createRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-approval-server-'));
  const dir = path.join(root, 'outputs', 'content-planner', 'approval');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'index.html'), INDEX);
  await fs.writeFile(path.join(dir, 'app.js'), 'console.log("app");\n');
  await fs.writeFile(path.join(dir, 'styles.css'), 'body{}\n');
  await fs.writeFile(path.join(dir, 'drafts-data.js'), 'window.__SOMA_DRAFTS__ = [];\n');
  await fs.writeFile(path.join(root, 'outputs', 'content-planner', 'drafts.json'), '["hemmelig"]');
  return root;
}

function drafts() {
  return [
    { draftId: 'd1', status: 'draft', contentRevision: REV_A, history: [] },
    { draftId: 'd2', status: 'draft', contentRevision: REV_B, history: [] },
  ];
}

function stubTransaction(calls, overrides = {}) {
  return async ({ apply, message }) => {
    calls.push({ message });
    if (overrides.result) return overrides.result;
    const applied = await apply(drafts());
    return { pushed: true, changed: true, results: applied.results, attempts: 1 };
  };
}

async function startServer(transaction) {
  const repoRoot = await createRoot();
  const server = createApprovalServer({
    repoRoot, sessionKey: KEY, port: 0, approvedBy: 'soren',
    transaction, now: () => new Date('2026-10-03T12:00:00Z'),
  });
  const info = await server.start();
  return { server, info, repoRoot };
}

function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, contentType: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function approveRequest(info, items, { key = KEY, origin = `http://127.0.0.1:${info.port}`, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-soma-key'] = key;
  if (origin) headers.origin = origin;
  return request(info.port, {
    method: 'POST', path: '/approve', headers, body: raw !== undefined ? raw : JSON.stringify({ items }),
  });
}

test('health answers only for the loopback host header', async () => {
  const { server, info } = await startServer(stubTransaction([]));
  try {
    const ok = await request(info.port, { path: '/health' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { ok: true, app: 'soma-approval' });
    const foreign = await request(info.port, { path: '/health', headers: { host: 'evil.example.com' } });
    assert.equal(foreign.status, 403);
  } finally { await server.stop(); }
});

test('index embeds the session key and nothing else changes', async () => {
  const { server, info } = await startServer(stubTransaction([]));
  try {
    const page = await request(info.port, { path: '/' });
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`{"key":"${KEY}"}`));
    assert.equal(page.text.replace(`{"key":"${KEY}"}`, 'null'), INDEX);
  } finally { await server.stop(); }
});

test('serves only whitelisted approval files', async () => {
  const { server, info } = await startServer(stubTransaction([]));
  try {
    for (const file of ['/app.js', '/styles.css', '/drafts-data.js']) {
      assert.equal((await request(info.port, { path: file })).status, 200, file);
    }
    for (const file of ['/drafts.json', '/../drafts.json', '/%2e%2e/drafts.json', '/lib/x.js', '/session.js']) {
      assert.equal((await request(info.port, { path: file })).status, 404, file);
    }
  } finally { await server.stop(); }
});

test('rejects approve without key or with a foreign origin', async () => {
  const calls = [];
  const { server, info } = await startServer(stubTransaction(calls));
  try {
    const items = [{ draftId: 'd1', contentRevision: REV_A }];
    assert.equal((await approveRequest(info, items, { key: '' })).status, 403);
    assert.equal((await approveRequest(info, items, { key: 'x'.repeat(48) })).status, 403);
    assert.equal((await approveRequest(info, items, { origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await approveRequest(info, items, { origin: '' })).status, 403);
    assert.equal(calls.length, 0);
  } finally { await server.stop(); }
});

test('rejects oversized, malformed or empty items with 400 and no transaction call', async () => {
  const calls = [];
  const { server, info } = await startServer(stubTransaction(calls));
  try {
    assert.equal((await approveRequest(info, null, { raw: '{nope' })).status, 400);
    assert.equal((await approveRequest(info, [])).status, 400);
    assert.equal((await approveRequest(info, [{ draftId: 'd1' }])).status, 400);
    assert.equal((await approveRequest(info, [{ draftId: 1, contentRevision: REV_A }])).status, 400);
    const many = Array.from({ length: 101 }, (_, i) => ({ draftId: `d${i}`, contentRevision: REV_A }));
    assert.equal((await approveRequest(info, many)).status, 400);
    assert.equal((await approveRequest(info, null, { raw: JSON.stringify({ items: [], pad: 'x'.repeat(70 * 1024) }) })).status, 400);
    assert.equal(calls.length, 0);
  } finally { await server.stop(); }
});

test('approve returns per-draft outcomes and the pushed flag from the transaction', async () => {
  const calls = [];
  const { server, info } = await startServer(stubTransaction(calls));
  try {
    const res = await approveRequest(info, [
      { draftId: 'd1', contentRevision: REV_A },
      { draftId: 'd2', contentRevision: REV_B },
    ]);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.pushed, true);
    assert.deepEqual(body.results, [
      { draftId: 'd1', outcome: 'approved' },
      { draftId: 'd2', outcome: 'approved' },
    ]);
    assert.match(calls[0].message, /^approve: 2 opslag/);
  } finally { await server.stop(); }
});

test('stale_revision is reported per draft and does not block the others', async () => {
  const { server, info } = await startServer(stubTransaction([]));
  try {
    const res = await approveRequest(info, [
      { draftId: 'd1', contentRevision: 'f'.repeat(64) },
      { draftId: 'd2', contentRevision: REV_B },
    ]);
    const body = JSON.parse(res.text);
    assert.deepEqual(body.results, [
      { draftId: 'd1', outcome: 'stale_revision' },
      { draftId: 'd2', outcome: 'approved' },
    ]);
  } finally { await server.stop(); }
});

test('returns pushed:false and a plain error code when the transaction fails', async () => {
  const failure = { pushed: false, changed: true, attempts: 3, error: 'push_failed' };
  const { server, info } = await startServer(stubTransaction([], { result: failure }));
  try {
    const res = await approveRequest(info, [{ draftId: 'd1', contentRevision: REV_A }]);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.pushed, false);
    assert.equal(body.error, 'push_failed');
    assert.deepEqual(body.results, [{ draftId: 'd1', outcome: 'not_processed' }]);
    assert.ok(!res.text.includes('Users'), 'svaret må ikke indeholde lokale stier');
  } finally { await server.stop(); }
});

test('only POST is allowed on /approve', async () => {
  const { server, info } = await startServer(stubTransaction([]));
  try {
    assert.equal((await request(info.port, { path: '/approve' })).status, 405);
    assert.equal((await request(info.port, { method: 'PUT', path: '/approve' })).status, 405);
  } finally { await server.stop(); }
});

test('serializes concurrent approve requests so transactions never overlap', async () => {
  let active = 0;
  let maxActive = 0;
  const order = [];
  const slowTransaction = async ({ apply }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const applied = apply(drafts());
    order.push(applied.results[0].draftId);
    active -= 1;
    return { pushed: true, changed: true, results: applied.results, attempts: 1 };
  };
  const { server, info } = await startServer(slowTransaction);
  try {
    const [first, second] = await Promise.all([
      approveRequest(info, [{ draftId: 'd1', contentRevision: REV_A }]),
      approveRequest(info, [{ draftId: 'd2', contentRevision: REV_B }]),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(maxActive, 1);
    assert.deepEqual(order.sort(), ['d1', 'd2']);
  } finally { await server.stop(); }
});

test('serves the exact file content with the right content type', async () => {
  const { server, info, repoRoot } = await startServer(stubTransaction([]));
  try {
    const dir = path.join(repoRoot, 'outputs', 'content-planner', 'approval');
    const expected = {
      '/app.js': await fs.readFile(path.join(dir, 'app.js'), 'utf8'),
      '/styles.css': await fs.readFile(path.join(dir, 'styles.css'), 'utf8'),
      '/drafts-data.js': await fs.readFile(path.join(dir, 'drafts-data.js'), 'utf8'),
    };
    const types = { '/app.js': 'javascript', '/styles.css': 'css', '/drafts-data.js': 'javascript' };
    for (const [file, content] of Object.entries(expected)) {
      const res = await request(info.port, { path: file });
      assert.equal(res.text, content, file);
      assert.match(res.contentType, new RegExp(types[file]), file);
    }
  } finally { await server.stop(); }
});

test('serves render images from renders/ and nothing else outside the whitelist', async () => {
  const { server, info, repoRoot } = await startServer(stubTransaction([]));
  try {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
    await fs.mkdir(path.join(repoRoot, 'renders'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'renders', 'a-1.jpg'), bytes);
    await fs.writeFile(path.join(repoRoot, 'renders', 'secret.txt'), 'nej');
    const ok = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: info.port, path: '/renders/a-1.jpg' }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.type, 'image/jpeg');
    assert.deepEqual(ok.body, bytes);
    for (const bad of ['/renders/secret.txt', '/renders/missing.jpg', '/renders/../drafts.json', '/renders/%2e%2e/drafts.json', '/renders/sub/a-1.jpg']) {
      assert.equal((await request(info.port, { path: bad })).status, 404, bad);
    }
  } finally { await server.stop(); }
});

function changeRequest(info, body, { key = KEY, origin = `http://127.0.0.1:${info.port}`, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-soma-key'] = key;
  if (origin) headers.origin = origin;
  return request(info.port, {
    method: 'POST', path: '/change-image', headers, body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

test('change-image rejects missing key, foreign origin and malformed bodies without touching anything', async () => {
  const calls = [];
  const { server, info } = await startServer(stubTransaction(calls));
  try {
    const ok = { draftId: 'd1', contentRevision: REV_A, assetId: 'soma-sauna-01' };
    assert.equal((await changeRequest(info, ok, { key: '' })).status, 403);
    assert.equal((await changeRequest(info, ok, { origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await changeRequest(info, null, { raw: '{nope' })).status, 400);
    assert.equal((await changeRequest(info, { ...ok, assetId: '../x' })).status, 400);
    assert.equal((await changeRequest(info, { ...ok, assetId: '' })).status, 400);
    assert.equal((await changeRequest(info, { ...ok, contentRevision: 'kort' })).status, 400);
    assert.equal((await request(info.port, { path: '/change-image' })).status, 405);
    assert.equal(calls.length, 0);
  } finally { await server.stop(); }
});

test('change-image returns the updated draft only when the change was pushed', async () => {
  const seen = [];
  const changeImage = async (input) => {
    seen.push(input.assetId);
    return {
      drafts: [{ draftId: 'd1', assetId: input.assetId, status: 'draft', contentRevision: REV_B }],
      outcome: 'changed', files: ['renders/a.jpg'],
    };
  };
  const repoRoot = await createRoot();
  const make = (pushed) => createApprovalServer({
    repoRoot, sessionKey: KEY, port: 0, changeImage,
    transaction: async ({ apply }) => {
      const applied = await apply(drafts());
      return { pushed, changed: true, results: applied.results, attempts: 1 };
    },
  });
  for (const pushed of [true, false]) {
    const server = make(pushed);
    const info = await server.start();
    try {
      const response = await changeRequest(info, { draftId: 'd1', contentRevision: REV_A, assetId: 'soma-sauna-01' });
      const body = JSON.parse(response.text);
      assert.equal(body.pushed, pushed);
      assert.equal(body.results[0].outcome, 'changed');
      assert.equal(Boolean(body.results[0].draft), pushed);
    } finally { await server.stop(); }
  }
  assert.deepEqual(seen, ['soma-sauna-01', 'soma-sauna-01']);
});

test('asset routes only serve registered images and never paths', async () => {
  const { server, info } = await startServer(stubTransaction([]));
  try {
    for (const route of ['/asset-image/unknown', '/asset-image/..%2Fdrafts.json', '/asset-image/', '/assets', '/assets?draftId=findes-ikke']) {
      assert.equal((await request(info.port, { path: route })).status, 404, route);
    }
  } finally { await server.stop(); }
});

function chooseRequest(info, body, { key = KEY, origin = `http://127.0.0.1:${info.port}`, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-soma-key'] = key;
  if (origin) headers.origin = origin;
  return request(info.port, {
    method: 'POST', path: '/choose-instructor', headers, body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

test('choose-instructor rejects missing key, foreign origin and malformed bodies without touching anything', async () => {
  const calls = [];
  const { server, info } = await startServer(stubTransaction(calls));
  try {
    const ok = { draftId: 'd1', contentRevision: REV_A, option: 'soren' };
    assert.equal((await chooseRequest(info, ok, { key: '' })).status, 403);
    assert.equal((await chooseRequest(info, ok, { origin: 'http://evil.example.com' })).status, 403);
    assert.equal((await chooseRequest(info, null, { raw: '{nope' })).status, 400);
    assert.equal((await chooseRequest(info, { ...ok, option: '../x' })).status, 400);
    assert.equal((await chooseRequest(info, { ...ok, option: '' })).status, 400);
    assert.equal((await chooseRequest(info, { ...ok, contentRevision: 'kort' })).status, 400);
    assert.equal((await request(info.port, { path: '/choose-instructor' })).status, 405);
    assert.equal(calls.length, 0);
  } finally { await server.stop(); }
});

test('choose-instructor returns all changed drafts only when the change was pushed', async () => {
  const seen = [];
  const changeInstructor = async (input) => {
    seen.push(input.optionKey);
    return {
      drafts: [{ draftId: 'd1', status: 'draft' }, { draftId: 'd2', status: 'draft' }, { draftId: 'd3', status: 'draft' }],
      outcome: 'changed', changedIds: ['d1', 'd2'], files: ['renders/a.jpg'],
    };
  };
  const repoRoot = await createRoot();
  for (const pushed of [true, false]) {
    const server = createApprovalServer({
      repoRoot, sessionKey: KEY, port: 0, changeInstructor,
      transaction: async ({ apply }) => {
        const applied = await apply(drafts());
        return { pushed, changed: true, results: applied.results, attempts: 1 };
      },
    });
    const info = await server.start();
    try {
      const body = JSON.parse((await chooseRequest(info, { draftId: 'd1', contentRevision: REV_A, option: 'soren' })).text);
      assert.equal(body.pushed, pushed);
      assert.equal(body.results[0].outcome, 'changed');
      if (pushed) assert.deepEqual(body.results[0].drafts.map((draft) => draft.draftId), ['d1', 'd2']);
      else assert.equal(body.results[0].drafts, undefined);
    } finally { await server.stop(); }
  }
  assert.deepEqual(seen, ['soren', 'soren']);
});
