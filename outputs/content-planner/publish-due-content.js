'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const { readCalendar } = require('../soma-reader');
const { buildDryRunPlan } = require('./lib/publish-plan');
const { renderStoryImage } = require('./lib/story-render');
const { buildAssetUpload, uploadAsset } = require('./lib/github-assets');
const { createMetaWriteAdapter } = require('./lib/meta-write');
const { executeAutomaticPlan } = require('./lib/publish-executor');
const { readLedger, findEntry } = require('./lib/publish-ledger');
const { safeRunSummary } = require('./lib/safe-summary');
const { createGitStateStore } = require('./lib/git-state-store');

const DRAFTS_PATH = path.join(__dirname, 'drafts.json');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const ASSETS_PATH = path.join(__dirname, 'assets.json');
const LEDGER_PATH = path.join(__dirname, 'publish-ledger.json');

function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new Error('CLI-argumenter skal være en liste');
  const result = { publish: false, deliveryTypes: null, draftId: null };
  let mode = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--publish' || argument === '--dry-run') {
      const nextMode = argument === '--publish' ? 'publish' : 'dry-run';
      if (mode !== null) throw new Error('--dry-run og --publish er gensidigt udelukkende');
      mode = nextMode;
      result.publish = nextMode === 'publish';
    } else if (argument === '--delivery-type') {
      const deliveryType = argv[index + 1];
      if (!['instagram_story', 'facebook_page_feed'].includes(deliveryType)) {
        throw new Error('Ugyldig leveringstype');
      }
      if (result.deliveryTypes !== null) throw new Error('--delivery-type må kun angives én gang');
      result.deliveryTypes = [deliveryType];
      index += 1;
    } else if (argument === '--draft-id') {
      const draftId = argv[index + 1];
      if (typeof draftId !== 'string' || draftId.trim() === '' || draftId.startsWith('--')) {
        throw new Error('--draft-id kræver en værdi');
      }
      if (result.draftId !== null) throw new Error('--draft-id må kun angives én gang');
      result.draftId = draftId;
      index += 1;
    } else {
      throw new Error(`Ukendt eller gentaget argument: ${argument}`);
    }
  }
  return result;
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

function dueItems(plan, now) {
  return plan.automatic.filter((item) => Date.parse(item.scheduledFor) <= now.getTime());
}

function hasOnlyEventNotFoundFailures(blocked) {
  return Array.isArray(blocked)
    && blocked.length > 0
    && blocked.every((item) => Array.isArray(item.reasons)
      && item.reasons.length > 0
      && item.reasons.every((reason) => reason === 'EVENT_NOT_FOUND'));
}

function liveInputsForDraft(draft, liveEvents) {
  if (draft.kind === 'weekly_overview') {
    const keys = new Set((draft.events || []).map((event) => event.eventKey));
    return { liveEvents: liveEvents.filter((event) => keys.has(event.eventKey)) };
  }
  return { liveEvent: liveEvents.find((event) => event.eventKey === draft.eventKey) };
}

async function defaultStoryRenderer({ draft, liveEvents, assets, outputPath }) {
  const asset = assets.assets.find((candidate) => candidate.assetId === draft.assetId);
  if (!asset) throw new Error(`Story-billedet ${draft.assetId} mangler`);
  return renderStoryImage({
    draft,
    ...liveInputsForDraft(draft, liveEvents),
    sourceImagePath: asset.normalizedPath,
    logoPath: assets.logoPath,
    outputPath,
  });
}

async function runDueContent({
  publish = false,
  deliveryTypes = null,
  draftId = null,
  now = new Date(),
  env = process.env,
  drafts,
  config,
  assets,
  ledgerPath = LEDGER_PATH,
  liveEventReader = fetchLiveEvents,
  planBuilder = buildDryRunPlan,
  storyRenderer = defaultStoryRenderer,
  assetUploader,
  metaAdapter,
  persistState = async () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const activeDrafts = drafts || JSON.parse(await fs.readFile(DRAFTS_PATH, 'utf8'));
  const activeConfig = config || JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  const activeAssets = assets || (publish ? JSON.parse(await fs.readFile(ASSETS_PATH, 'utf8')) : null);
  let liveEvents = await liveEventReader(now, activeConfig.weeksAhead);
  if (!Array.isArray(liveEvents) || liveEvents.length === 0) throw new Error('Livekalenderen returnerede ingen events');

  const buildPlan = (events) => planBuilder(activeDrafts, {
    generatedAt: now,
    now,
    liveEvents: events,
    assetHosting: activeConfig.assetHosting,
  });
  let plan = await buildPlan(liveEvents);
  if (hasOnlyEventNotFoundFailures(plan.blocked)) {
    liveEvents = await liveEventReader(now, activeConfig.weeksAhead);
    if (!Array.isArray(liveEvents) || liveEvents.length === 0) throw new Error('Livekalenderen returnerede ingen events');
    plan = await buildPlan(liveEvents);
  }
  if (plan.blocked?.length) {
    throw new Error(`Frisk kalenderkontrol blokerede ${plan.blocked.length} godkendte kladder`);
  }
  const allowedDeliveryTypes = new Set(['instagram_story', 'facebook_page_feed']);
  if (deliveryTypes !== null && (!Array.isArray(deliveryTypes) || deliveryTypes.some((value) => !allowedDeliveryTypes.has(value)))) {
    throw new Error('Ugyldigt kanalvalg til kontrolleret publicering');
  }
  const due = dueItems(plan, now)
    .filter((item) => deliveryTypes === null || deliveryTypes.includes(item.deliveryType))
    .filter((item) => draftId === null || item.draftId === draftId);
  if (draftId !== null && due.length === 0) {
    throw new Error(`Den valgte kladde er ikke forfalden til det valgte kanalfilter: ${draftId}`);
  }
  if (!publish) return { mode: 'dry_run', plan, due };

  if (!assetUploader && !env.SOMA_ASSET_REPO_TOKEN) throw new Error('SOMA_ASSET_REPO_TOKEN mangler');
  if (!metaAdapter && !env.SOMA_META_ACCESS_TOKEN) throw new Error('SOMA_META_ACCESS_TOKEN mangler');

  const adapter = metaAdapter || createMetaWriteAdapter({
    token: env.SOMA_META_ACCESS_TOKEN,
    instagramUserId: '17841475009702608',
    pageId: '628094223731455',
    bookingUrl: activeConfig.bookingUrl,
    fetchImpl,
  });
  const uploader = assetUploader || (async ({ item, rendered }) => {
    const upload = await buildAssetUpload({
      repo: activeConfig.assetHosting.repository,
      baseUrl: activeConfig.assetHosting.baseUrl,
      localPath: rendered.path,
      assetPath: item.assetPath,
      deliveryType: item.deliveryType,
    });
    return uploadAsset({ upload, token: env.SOMA_ASSET_REPO_TOKEN, fetchImpl });
  });

  if (typeof adapter.preflight !== 'function' || typeof adapter.publish !== 'function') {
    throw new Error('Meta-adapteren skal have både preflight og publish');
  }

  const ledger = await readLedger(ledgerPath);
  const prepared = [];
  const requiresPreflight = [];
  for (const item of due) {
    if (findEntry(ledger, item.idempotencyKey)) {
      prepared.push(item);
      continue;
    }
    const draft = activeDrafts.find((candidate) => candidate.draftId === item.draftId);
    if (!draft) throw new Error(`Kladde mangler: ${item.draftId}`);
    let rendered = { path: item.imagePath, width: 1080, height: 1350 };
    if (item.deliveryType === 'instagram_story') {
      const outputPath = path.join(__dirname, 'renders', `${item.draftId}-r${item.revision}-story.jpg`);
      rendered = await storyRenderer({ item, draft, liveEvents, assets: activeAssets, outputPath });
    }
    const publicAsset = await uploader({ item, rendered });
    const preparedItem = { ...item, imagePath: rendered.path, imageUrl: publicAsset.publicUrl };
    prepared.push(preparedItem);
    requiresPreflight.push(preparedItem);
  }

  for (const item of requiresPreflight) await adapter.preflight(item);

  return executeAutomaticPlan({
    plan: { ...plan, automatic: prepared },
    ledgerPath,
    adapter,
    allowPublish: true,
    now,
    persistState,
  });
}

async function writeSummaryFile(summary, targetPath = path.join(process.cwd(), 'state', 'run-summary.json')) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = console.log,
  stderr = console.error,
  dependencies = {},
} = {}) {
  const args = parseArgs(argv);
  if (args.publish) {
    if (env.PUBLISH_ENABLED !== 'true') throw new Error('Live-publicering er deaktiveret');
    if (!env.SOMA_META_ACCESS_TOKEN) throw new Error('SOMA_META_ACCESS_TOKEN mangler');
    if (!env.SOMA_ASSET_REPO_TOKEN) throw new Error('SOMA_ASSET_REPO_TOKEN mangler');
  }
  const execute = dependencies.runDueContent || runDueContent;
  const runOptions = { ...(dependencies.runOptions || {}) };
  if (args.publish && env.GITHUB_ACTIONS === 'true') {
    const repoDir = path.resolve(dependencies.repoDir || process.cwd());
    const relativeLedger = 'state/publish-ledger.json';
    const factory = dependencies.createGitStateStore || createGitStateStore;
    const stateStore = factory({
      repoDir,
      ledgerPath: relativeLedger,
      runId: env.GITHUB_RUN_ID || 'local',
    });
    runOptions.ledgerPath = path.join(repoDir, ...relativeLedger.split('/'));
    runOptions.persistState = stateStore.persist;
  }
  const result = await execute({
    publish: args.publish,
    deliveryTypes: args.deliveryTypes,
    draftId: args.draftId,
    env,
    ...runOptions,
  });
  const secrets = [env.SOMA_META_ACCESS_TOKEN, env.SOMA_ASSET_REPO_TOKEN].filter(Boolean);
  const summary = safeRunSummary({ runId: env.GITHUB_RUN_ID || 'local', results: result.results || [] }, secrets);
  const writeSummary = dependencies.writeSummary || writeSummaryFile;
  await writeSummary(summary, dependencies.summaryPath);
  if (result.mode === 'dry_run') {
    stdout(`Dry-run: ${result.due.length} levering(er) er klar eller forfalden. Intet er publiceret.`);
  } else {
    stdout(`Kørsel afsluttet: ${summary.items.map((item) => item.status).join(', ')}`);
  }
  return result;
}

if (require.main === module) {
  runCli({ argv: process.argv.slice(2), env: process.env, stdout: console.log, stderr: console.error }).catch((error) => {
    console.error(`Publicering stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, fetchLiveEvents, dueItems, runDueContent, runCli, writeSummaryFile };
