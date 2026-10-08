'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { readLedger, findEntry } = require('./lib/publish-ledger');
const { idempotencyKey } = require('./lib/publish-plan');

const DELIVERY_TYPES = ['instagram_story', 'facebook_page_feed'];
const SETTLED_STATUSES = new Set(['published', 'manual_review_required']);

function isSettled(ledger, draft, deliveryType) {
  const entry = findEntry(ledger, idempotencyKey(draft, deliveryType));
  return Boolean(entry && SETTLED_STATUSES.has(entry.status));
}

// Billig forhåndstjek: er et godkendt opslag forfaldent og endnu ikke udgivet?
// Kun hvis ja, behøver udgiveren installere Chromium og køre.
function findDueDrafts(drafts, ledger, now = new Date()) {
  if (!Array.isArray(drafts)) throw new TypeError('Kladder skal være en liste');
  return drafts
    .filter((draft) => draft && draft.status === 'approved')
    .filter((draft) => {
      const scheduled = Date.parse(draft.scheduledFor);
      return !Number.isFinite(scheduled) || scheduled <= now.getTime();
    })
    .filter((draft) => DELIVERY_TYPES.some((type) => !isSettled(ledger, draft, type)))
    .map((draft) => draft.draftId);
}

async function writeOutput(env, due, count) {
  const line = `due=${due}\ncount=${count}\n`;
  if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, line, 'utf8');
}

async function main({ env = process.env, now = new Date(), root = path.resolve(__dirname, '../..') } = {}) {
  // Et bevidst valgt opslag (kontrolleret test) springer altid forhåndstjekket over.
  if ((env.SOMA_DRAFT_ID || '').trim() !== '') {
    await writeOutput(env, 'true', 1);
    console.log('Forhåndstjek: opslag valgt manuelt, udgiveren kører.');
    return true;
  }
  try {
    const drafts = JSON.parse(await fs.readFile(path.join(root, 'outputs/content-planner/drafts.json'), 'utf8'));
    const ledger = await readLedger(path.join(root, 'state/publish-ledger.json'));
    const due = findDueDrafts(drafts, ledger, now);
    await writeOutput(env, due.length > 0 ? 'true' : 'false', due.length);
    console.log(`Forhåndstjek: ${due.length} forfaldne opslag mangler udgivelse.`);
    return due.length > 0;
  } catch (error) {
    // Ved tvivl kører udgiveren, så et opslag aldrig udebliver på grund af selve tjekket.
    await writeOutput(env, 'true', 0);
    console.log(`Forhåndstjek kunne ikke afgøres (${error.message}); udgiveren kører.`);
    return true;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { findDueDrafts, main };
