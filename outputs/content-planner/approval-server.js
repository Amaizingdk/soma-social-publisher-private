'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { approveDraft } = require('./lib/approvals');
const { runApprovalTransaction } = require('./lib/approval-transaction');

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ITEMS = 100;
const SESSION_PLACEHOLDER = '<script id="soma-session" type="application/json">null</script>';
const RENDER_PATTERN = /^\/renders\/([A-Za-z0-9._-]+\.jpg)$/;
const STATIC_FILES = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/drafts-data.js', ['drafts-data.js', 'text/javascript; charset=utf-8']],
]);

function sameKey(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => (size > MAX_BODY_BYTES
      ? reject(new Error('too_large'))
      : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function parseItems(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  const items = value?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) return null;
  const valid = items.every((item) => typeof item?.draftId === 'string' && item.draftId
    && typeof item?.contentRevision === 'string' && /^[a-f0-9]{64}$/.test(item.contentRevision));
  return valid ? items.map(({ draftId, contentRevision }) => ({ draftId, contentRevision })) : null;
}

function createApprovalServer({
  repoRoot,
  sessionKey = crypto.randomBytes(24).toString('hex'),
  port = Number(process.env.SOMA_APPROVAL_PORT) || 47831,
  approvedBy = process.env.SOMA_APPROVER_LOGIN || 'soma-local-approval',
  transaction = runApprovalTransaction,
  now = () => new Date(),
}) {
  const approvalDir = path.join(repoRoot, 'outputs', 'content-planner', 'approval');
  let boundPort = port;
  let server;
  // Godkendelser kører én ad gangen, så to klik aldrig skriver oven i hinanden.
  let queue = Promise.resolve();
  const runQueued = (task) => {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  };

  async function handleApprove(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
    if (!sameKey(req.headers['x-soma-key'], sessionKey)
      || req.headers.origin !== `http://127.0.0.1:${boundPort}`) {
      return send(res, 403, { error: 'forbidden' });
    }
    let raw;
    try { raw = await readBody(req); } catch { return send(res, 400, { error: 'bad_request' }); }
    const items = parseItems(raw);
    if (!items) return send(res, 400, { error: 'bad_request' });

    const outcome = await runQueued(() => transaction({
      repoRoot,
      message: `approve: ${items.length} opslag via lokal godkendelsesside`,
      apply: (drafts) => {
        let current = drafts;
        const results = [];
        for (const item of items) {
          const result = approveDraft({
            drafts: current, draftId: item.draftId, contentRevision: item.contentRevision,
            approvedBy, now: now(),
          });
          current = result.drafts;
          results.push({ draftId: item.draftId, outcome: result.outcome });
        }
        return { drafts: current, results };
      },
    }));
    const body = {
      results: outcome.results || items.map((item) => ({ draftId: item.draftId, outcome: 'not_processed' })),
      pushed: Boolean(outcome.pushed),
    };
    if (outcome.error) body.error = outcome.error;
    return send(res, 200, body);
  }

  async function handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${boundPort}`) return send(res, 403, { error: 'forbidden' });
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;

    if (urlPath === '/approve') return handleApprove(req, res);
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    if (urlPath === '/health') return send(res, 200, { ok: true, app: 'soma-approval' });
    if (urlPath === '/' || urlPath === '/index.html') {
      const html = await fs.readFile(path.join(approvalDir, 'index.html'), 'utf8');
      return send(res, 200, html.replace(SESSION_PLACEHOLDER,
        () => SESSION_PLACEHOLDER.replace('null', JSON.stringify({ key: sessionKey }))), 'text/html; charset=utf-8');
    }
    const render = RENDER_PATTERN.exec(urlPath);
    if (render) {
      try {
        return send(res, 200, await fs.readFile(path.join(repoRoot, 'renders', render[1])), 'image/jpeg');
      } catch {
        return send(res, 404, { error: 'not_found' });
      }
    }
    const entry = STATIC_FILES.get(urlPath);
    if (!entry) return send(res, 404, { error: 'not_found' });
    return send(res, 200, await fs.readFile(path.join(approvalDir, entry[0])), entry[1]);
  }

  return {
    start() {
      server = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) send(res, 500, { error: 'server_error' });
          else res.end();
        });
      });
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          boundPort = server.address().port;
          resolve({ url: `http://127.0.0.1:${boundPort}/`, port: boundPort, sessionKey });
        });
      });
    },
    stop() {
      return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    },
  };
}

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  createApprovalServer({ repoRoot }).start()
    .then((info) => process.stdout.write(`SOMA godkendelsesside: ${info.url}\n`))
    .catch((error) => {
      process.stderr.write(`SOMA godkendelsesserver kunne ikke starte: ${error.code || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { createApprovalServer };
