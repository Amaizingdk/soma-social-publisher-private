'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadJsonValidated } = require('./lib/io');
const { buildDryRunPlan } = require('./lib/publish-plan');
const { executeAutomaticPlan } = require('./lib/publish-executor');
const { createMetaWriteAdapter } = require('./lib/meta-write');
const { readCalendar } = require('../soma-reader');
const { runDueContent } = require('./publish-due-content');

const DRAFTS_PATH = path.join(__dirname, 'drafts.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const LEDGER_PATH = path.join(__dirname, 'publish-ledger.json');

async function buildFreshTestPlan({ drafts, liveEvents, config, now = new Date() }) {
  if (!Array.isArray(liveEvents) || liveEvents.length === 0) {
    throw new Error('Meta-publicering kræver frisk kalenderdata');
  }
  return buildDryRunPlan(drafts, {
    generatedAt: now,
    now,
    liveEvents,
    assetHosting: config?.assetHosting,
  });
}

async function fetchLiveEvents(now, weeksAhead) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    return await readCalendar(page, now, weeksAhead);
  } finally {
    await browser.close();
  }
}

async function run({
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = console.log,
  now = new Date(),
  liveEventReader = fetchLiveEvents,
} = {}) {
  const result = await runDueContent({
    publish: true,
    deliveryTypes: ['instagram_story'],
    env,
    fetchImpl,
    now,
    liveEventReader,
  });
  stdout(`Instagram Story-teststatus: ${result.results.map((item) => item.status).join(', ')}`);
  return result;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Meta-test stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildFreshTestPlan, fetchLiveEvents, run };
