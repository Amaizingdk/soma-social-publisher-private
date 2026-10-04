'use strict';

function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/EA[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/(access_token|token|authorization)=([^\s&]+)/gi, '$1=[REDACTED]');
}

function safeRunSummary({ runId, results = [] } = {}, secrets = []) {
  if (!Array.isArray(results)) throw new Error('Kørselsresultater skal være en liste');
  return {
    runId: String(runId || 'local'),
    items: results.map((item = {}) => ({
      draftId: item.draftId,
      idempotencyKey: item.idempotencyKey,
      deliveryType: item.deliveryType,
      status: item.status,
      ...(typeof item.facebookStory === 'string' ? { facebookStory: item.facebookStory } : {}),
      reason: redact(item.reason || '', secrets).slice(0, 300),
    })),
  };
}

module.exports = { redact, safeRunSummary };
