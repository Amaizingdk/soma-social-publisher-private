'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

function parseRepo(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GitHub-repository skal være på formen ejer/repository');
  }
  return value;
}

function publicAssetUrl(baseUrl, assetPath) {
  const cleanBase = String(baseUrl || '').replace(/\/$/, '');
  if (!/^https:\/\//i.test(cleanBase)) throw new Error('Billedets base-adresse skal bruge HTTPS');
  const cleanPath = String(assetPath || '').replace(/^\/+/, '');
  if (!cleanPath || cleanPath.includes('..')) throw new Error('Ugyldig billedsti');
  return `${cleanBase}/${cleanPath}`;
}

function githubContentsEndpoint(repo, assetPath) {
  const encodedPath = assetPath.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://api.github.com/repos/${parseRepo(repo)}/contents/${encodedPath}`;
}

function gitBlobSha(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Git blob-SHA kræver billedbytes');
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

async function buildAssetUpload({ repo, baseUrl, localPath, assetPath, deliveryType }) {
  const source = path.resolve(localPath);
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('Billedestien er ikke en fil');
  if (!/\.(?:jpe?g)$/i.test(source)) throw new Error('Kun JPEG-billeder må uploades');
  const bytes = await fs.readFile(source);
  return {
    repo: parseRepo(repo),
    assetPath,
    deliveryType,
    localPath: source,
    contentBase64: bytes.toString('base64'),
    gitBlobSha: gitBlobSha(bytes),
    endpoint: githubContentsEndpoint(repo, assetPath),
    publicUrl: publicAssetUrl(baseUrl, assetPath),
  };
}

async function verifyPublicAsset({ publicUrl, fetchImpl = globalThis.fetch }) {
  if (!/^https:\/\//i.test(String(publicUrl || ''))) throw new Error('Offentligt billede skal bruge HTTPS');
  let response;
  try {
    response = await fetchImpl(publicUrl, {
      method: 'HEAD',
      redirect: 'error',
      headers: { Accept: 'image/jpeg' },
    });
  } catch {
    throw new Error('Det offentlige billede kunne ikke verificeres');
  }
  if (!response || response.status !== 200 || response.ok !== true) {
    throw new Error(`Det offentlige billede fejlede med HTTP ${response?.status ?? 'ukendt'}`);
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/jpeg')) {
    throw new Error('Det offentlige billede skal have content-type image/jpeg');
  }
  return { publicUrl, contentType };
}

async function uploadAsset({ upload, token, fetchImpl = globalThis.fetch, commitMessage = 'Add approved SOMA asset' }) {
  if (!token || typeof token !== 'string') throw new Error('GitHub-token mangler');
  if (!upload || !upload.endpoint || !upload.publicUrl || !upload.contentBase64 || !upload.gitBlobSha) {
    throw new Error('Upload-objektet mangler verificerede billeddata');
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const existingResponse = await fetchImpl(upload.endpoint, { method: 'GET', headers });
  let providerId;
  let reused = false;
  if (existingResponse.ok && existingResponse.status === 200) {
    const existing = await existingResponse.json();
    if (!existing?.sha) throw new Error('GitHub returnerede ingen SHA for det eksisterende billede');
    if (existing.sha !== upload.gitBlobSha) throw new Error('Asset-sti-kollision: eksisterende fil har andre bytes');
    providerId = existing.sha;
    reused = true;
  } else if (existingResponse.status === 404) {
    const response = await fetchImpl(upload.endpoint, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMessage, content: upload.contentBase64 }),
    });
    if (!response.ok) throw new Error(`GitHub upload fejlede med HTTP ${response.status}`);
    const payload = await response.json();
    providerId = payload?.content?.sha || null;
  } else {
    throw new Error(`GitHub asset-kontrol fejlede med HTTP ${existingResponse.status}`);
  }
  await verifyPublicAsset({ publicUrl: upload.publicUrl, fetchImpl });
  return {
    deliveryType: upload.deliveryType,
    publicUrl: upload.publicUrl,
    providerId,
    reused,
  };
}

module.exports = {
  parseRepo,
  publicAssetUrl,
  githubContentsEndpoint,
  gitBlobSha,
  buildAssetUpload,
  verifyPublicAsset,
  uploadAsset,
};
