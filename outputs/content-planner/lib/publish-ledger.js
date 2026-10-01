'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, entries: [] };
}

function validateLedger(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.entries)) {
    throw new Error('Publiceringsloggen har et ukendt format');
  }
  for (const entry of value.entries) {
    if (!entry || typeof entry.idempotencyKey !== 'string' || entry.idempotencyKey.trim() === '') {
      throw new Error('Publiceringsloggen indeholder en ugyldig post');
    }
    if (typeof entry.status !== 'string' || !['reserved', 'published', 'manual_review_required'].includes(entry.status)) {
      throw new Error('Publiceringsloggen indeholder en ugyldig status');
    }
  }
}

async function readLedger(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    validateLedger(parsed);
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger();
    if (error instanceof SyntaxError) throw new Error('Publiceringsloggen er ikke gyldig JSON');
    throw error;
  }
}

async function writeLedgerAtomic(filePath, ledger) {
  validateLedger(ledger);
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function findEntry(ledger, idempotencyKey) {
  return ledger.entries.find((entry) => entry.idempotencyKey === idempotencyKey) || null;
}

function reserve(ledger, item, reservedAt = new Date()) {
  if (!item || typeof item.idempotencyKey !== 'string' || item.idempotencyKey.trim() === '') {
    throw new Error('Et opslag mangler idempotencyKey');
  }
  const existing = findEntry(ledger, item.idempotencyKey);
  if (existing) return { ledger, entry: existing, created: false };
  const entry = {
    idempotencyKey: item.idempotencyKey,
    draftId: item.draftId,
    revision: item.revision,
    platform: item.platform,
    deliveryType: item.deliveryType,
    scheduledFor: item.scheduledFor,
    status: 'reserved',
    reservedAt: reservedAt.toISOString(),
  };
  ledger.entries.push(entry);
  return { ledger, entry, created: true };
}

function markPublished(ledger, idempotencyKey, providerId, publishedAt = new Date()) {
  validateLedger(ledger);
  const entry = findEntry(ledger, idempotencyKey);
  if (!entry) throw new Error('Kan ikke markere ukendt idempotencyKey som publiceret');
  if (entry.status !== 'reserved') throw new Error(`Ugyldig statusovergang fra ${entry.status} til published`);
  entry.status = 'published';
  entry.providerId = providerId;
  entry.publishedAt = publishedAt.toISOString();
  return entry;
}

function markManualReviewRequired(ledger, idempotencyKey, reason, markedAt = new Date()) {
  validateLedger(ledger);
  const entry = findEntry(ledger, idempotencyKey);
  if (!entry) throw new Error('Kan ikke markere ukendt idempotencyKey til manuel kontrol');
  if (!['reserved', 'manual_review_required'].includes(entry.status)) {
    throw new Error(`Ugyldig statusovergang fra ${entry.status} til manual_review_required`);
  }
  entry.status = 'manual_review_required';
  entry.reason = String(reason || 'Tvetydigt publiceringsresultat').slice(0, 300);
  entry.manualReviewRequiredAt = markedAt.toISOString();
  return entry;
}

module.exports = {
  emptyLedger,
  validateLedger,
  readLedger,
  writeLedgerAtomic,
  findEntry,
  reserve,
  markPublished,
  markManualReviewRequired,
};
