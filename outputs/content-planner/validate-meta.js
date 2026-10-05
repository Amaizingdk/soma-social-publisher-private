'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { requestMetaReadonly, validateMetaPreflight } = require('./lib/meta-readonly');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CHANNELS = Object.freeze(['instagram_story', 'facebook_page_feed']);

// Meta udtrykker «aldrig udløb» som expires_at = 0. Tidsstempler er sekunder siden 1970.
function formatMetaExpiry(seconds, now = new Date()) {
  if (seconds === 0) return 'aldrig';
  if (!Number.isFinite(seconds)) return 'ukendt';
  const date = new Date(seconds * 1000);
  const days = Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
  return `${date.toISOString().slice(0, 10)} (${days < 0 ? 'udløbet' : `${days} dage tilbage`})`;
}

// Læser kun tokenets egne metadata (type, gyldighed, udløb, rettigheder). Selve tokenet udskrives aldrig.
async function inspectMetaToken({ token, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const body = await requestMetaReadonly({
    token,
    fetchImpl,
    path: `/debug_token?input_token=${encodeURIComponent(token)}`,
  });
  const data = body?.data;
  if (!data || typeof data !== 'object' || typeof data.is_valid !== 'boolean') {
    throw new Error('Ugyldigt svar fra debug_token');
  }
  return {
    type: typeof data.type === 'string' ? data.type : 'ukendt',
    isValid: data.is_valid,
    expiresAt: formatMetaExpiry(data.expires_at, now),
    dataAccessExpiresAt: formatMetaExpiry(data.data_access_expires_at, now),
    scopes: Array.isArray(data.scopes) ? data.scopes.filter((scope) => typeof scope === 'string') : [],
  };
}

async function runMetaValidation({
  env = process.env,
  config,
  fetchImpl = globalThis.fetch,
  stdout = console.log,
} = {}) {
  const token = env.SOMA_META_ACCESS_TOKEN;
  if (typeof token !== 'string' || token.trim() === '') throw new Error('SOMA_META_ACCESS_TOKEN mangler');
  const activeConfig = config || JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const passed = [];
  for (const deliveryType of CHANNELS) {
    await validateMetaPreflight({
      token,
      deliveryType,
      instagramUserId: '17841475009702608',
      pageId: '628094223731455',
      bookingUrl: activeConfig.bookingUrl,
      fetchImpl,
    });
    passed.push(deliveryType);
  }
  const result = { status: 'passed', channels: passed };
  try {
    const info = await inspectMetaToken({ token, fetchImpl });
    stdout(`Meta-token: type ${info.type}, gyldigt: ${info.isValid ? 'ja' : 'NEJ'}, udløber: ${info.expiresAt}, dataadgang udløber: ${info.dataAccessExpiresAt}`);
    stdout(`Meta-token rettigheder: ${info.scopes.join(', ') || 'ingen oplyst'}`);
  } catch {
    stdout('Meta-token udløb kunne ikke læses (debug_token svarede ikke). Validate-only er stadig bestået.');
  }
  stdout('Meta validate-only bestået for Instagram Story og Facebook-side. Ingen opslag blev publiceret.');
  return result;
}

if (require.main === module) {
  runMetaValidation().catch((error) => {
    console.error(`Meta validate-only stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CHANNELS, formatMetaExpiry, inspectMetaToken, runMetaValidation };
