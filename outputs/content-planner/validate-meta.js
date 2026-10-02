'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validateMetaPreflight } = require('./lib/meta-readonly');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const CHANNELS = Object.freeze(['instagram_story', 'facebook_page_feed']);

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
  stdout('Meta validate-only bestået for Instagram Story og Facebook-side. Ingen opslag blev publiceret.');
  return result;
}

if (require.main === module) {
  runMetaValidation().catch((error) => {
    console.error(`Meta validate-only stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CHANNELS, runMetaValidation };
