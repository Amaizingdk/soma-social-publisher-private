'use strict';

const {
  emptyLedger,
  readLedger,
  writeLedgerAtomic,
  findEntry,
  reserve,
  markPublished,
  markManualReviewRequired,
} = require('./publish-ledger');

function safeResult(item, status, reason = '', extra = {}) {
  return {
    draftId: item.draftId,
    idempotencyKey: item.idempotencyKey,
    deliveryType: item.deliveryType,
    status,
    reason,
    ...extra,
  };
}

async function persistPhase({ ledgerPath, ledger, entry, phase, persistState }) {
  if (ledgerPath) await writeLedgerAtomic(ledgerPath, ledger);
  await persistState({ ledgerPath, entry: { ...entry }, phase });
}

/**
 * Executes only through an injected adapter. There is intentionally no default
 * network adapter in this project. A real Meta adapter must be added behind a
 * separate, explicit authorization step.
 */
async function executeAutomaticPlan({
  plan,
  ledgerPath,
  adapter,
  allowPublish = false,
  now = new Date(),
  persistState = async () => {},
}) {
  if (!allowPublish) throw new Error('Publicering er låst: allowPublish skal være true');
  if (!plan || plan.mode !== 'dry_run' || !Array.isArray(plan.automatic)) {
    throw new Error('Planen skal være en gyldig dry-run-plan');
  }
  if (!adapter || typeof adapter.publish !== 'function') {
    throw new Error('Der mangler en eksplicit publiceringsadapter');
  }
  if (typeof persistState !== 'function') throw new Error('persistState skal være en funktion');

  const ledger = ledgerPath ? await readLedger(ledgerPath) : emptyLedger();
  const results = [];
  for (const item of plan.automatic) {
    const current = findEntry(ledger, item.idempotencyKey);
    if (current?.status === 'published') {
      results.push(safeResult(item, 'already_published'));
      continue;
    }
    if (current?.status === 'manual_review_required') {
      results.push(safeResult(item, 'manual_review_required', current.reason || 'Kræver manuel kontrol'));
      continue;
    }
    if (current?.status === 'reserved') {
      const entry = markManualReviewRequired(
        ledger,
        item.idempotencyKey,
        'En tidligere kørsel stoppede efter reservation; kontrollér Meta manuelt',
        now,
      );
      await persistPhase({ ledgerPath, ledger, entry, phase: 'manual_review_required', persistState });
      results.push(safeResult(item, 'manual_review_required', entry.reason));
      continue;
    }

    const { entry } = reserve(ledger, item, now);
    await persistPhase({ ledgerPath, ledger, entry, phase: 'reserved', persistState });
    try {
      const response = await adapter.publish(item);
      const publishedEntry = markPublished(ledger, item.idempotencyKey, response?.providerId || null, now);
      await persistPhase({ ledgerPath, ledger, entry: publishedEntry, phase: 'published', persistState });
      results.push(safeResult(item, 'published', '', { providerId: response?.providerId || null }));
    } catch (error) {
      const manualEntry = markManualReviewRequired(
        ledger,
        item.idempotencyKey,
        'Meta-kaldet gav et tvetydigt resultat; kontrollér kanalen manuelt',
        now,
      );
      await persistPhase({ ledgerPath, ledger, entry: manualEntry, phase: 'manual_review_required', persistState });
      results.push(safeResult(item, 'manual_review_required', manualEntry.reason));
    }
  }

  return { results, ledger };
}

module.exports = { executeAutomaticPlan };
