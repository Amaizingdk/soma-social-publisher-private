'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');

const { readCalendar } = require('../soma-reader');
const { extractWeekEvents } = require('./lib/calendar-navigation');
const { loadJsonValidated, writeJsonAtomic } = require('./lib/io');
const { validateProfiles, validateOverrides, resolveContentSource } = require('./lib/profile-resolver');
const { buildSchedule } = require('./lib/schedule');
const { buildCopyPackage } = require('./lib/copy');
const { validateAssetRegistry, selectAsset } = require('./lib/assets');
const { renderDraftImage } = require('./lib/render');
const { reconcileDrafts } = require('./lib/drafts');
const { contentRevisionFor, isExpiredDraft } = require('./lib/draft-lifecycle');
const { resolveSeason } = require('./lib/season');
const { fingerprintForContent } = require('./lib/content-fingerprint');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUTPUT = __dirname;
const PLATFORM_KEYS = ['facebookGroup', 'facebookPage', 'instagram'];
const APPROVAL_FILES = ['index.html', 'styles.css', 'app.js'];

function validateConfig(config) {
  if (!config?.bookingUrl?.startsWith('https://somasaunagus.dk/')) throw new Error('Ugyldig bookingUrl i config');
  if (!Number.isInteger(config.weeksAhead) || config.weeksAhead < 1 || config.weeksAhead > 12) throw new Error('Ugyldigt weeksAhead');
  if (!config.render || config.render.width !== 1080 || config.render.height !== 1350) throw new Error('Renderformat skal være 1080×1350');
  resolveSeason('2026-11-01', config.season);
}

function fingerprintForSlot(slot, events) {
  const fingerprints = slot.eventKeys.map((key) => events.find((event) => event.eventKey === key)?.fingerprint || key);
  return createHash('sha256').update(JSON.stringify(fingerprints)).digest('hex');
}

function safeFileName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
}

async function writeTextAtomic(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporaryPath, contents, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function installApprovalUi(outputDir) {
  const destination = path.join(outputDir, 'approval');
  await fs.mkdir(destination, { recursive: true });
  for (const file of APPROVAL_FILES) {
    const source = path.join(DEFAULT_OUTPUT, 'approval', file);
    const target = path.join(destination, file);
    if (path.resolve(source) !== path.resolve(target)) await fs.copyFile(source, target);
  }
}

async function writeApprovalPayload(outputDir, drafts) {
  await installApprovalUi(outputDir);
  const json = JSON.stringify(drafts, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await writeTextAtomic(path.join(outputDir, 'approval', 'drafts-data.js'), `window.__SOMA_DRAFTS__ = window.__SOMA_DRAFTS__ || ${json};\n`);
}

async function readPreviousDrafts(outputDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(outputDir, 'drafts.json'), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function loadInputs() {
  const [config, profiles, overrides, assets] = await Promise.all([
    loadJsonValidated(path.join(__dirname, 'config.json'), validateConfig),
    loadJsonValidated(path.join(__dirname, 'profiles.json'), validateProfiles),
    loadJsonValidated(path.join(__dirname, 'event-overrides.json'), validateOverrides),
    loadJsonValidated(path.join(__dirname, 'assets.json'), validateAssetRegistry),
  ]);
  return { config, profiles, overrides, assets };
}

async function diagnoseLiveFailure(page, error) {
  const diagnostics = path.join(ROOT, 'work', 'diagnostics');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(diagnostics, { recursive: true });
  if (page) {
    await page.screenshot({ path: path.join(diagnostics, `content-plan-${stamp}.png`), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(diagnostics, `content-plan-${stamp}.html`), await page.content().catch(() => ''), 'utf8');
  }
  await writeJsonAtomic(path.join(diagnostics, `content-plan-${stamp}.error.json`), {
    at: new Date().toISOString(), message: error.message, stack: error.stack,
  });
}

async function runPipeline({
  fixturePath = null,
  live = false,
  outputDir = DEFAULT_OUTPUT,
  now = new Date(),
  runtimeRoot = null,
} = {}) {
  if (Boolean(fixturePath) === Boolean(live)) throw new Error('Vælg præcis én datakilde: --fixture eller --live');
  const { config, profiles, overrides, assets } = await loadInputs();
  const browser = await chromium.launch({ headless: true });
  let page;
  const networkRequests = [];
  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('request', (request) => {
      if (/^https?:/i.test(request.url())) networkRequests.push(request.url());
    });
    let events;
    if (fixturePath) {
      await page.setContent(await fs.readFile(path.resolve(fixturePath), 'utf8'), { waitUntil: 'load' });
      events = await extractWeekEvents(page, now);
    } else {
      events = await readCalendar(page, now, config.weeksAhead);
    }
    if (!events.length) throw new Error('Ingen kommende events blev fundet');

    const previousDrafts = await readPreviousDrafts(outputDir);
    const manualInstructors = new Map(previousDrafts
      .filter((draft) => draft.status !== 'obsolete' && draft.eventKey && draft.manualInstructor)
      .map((draft) => [draft.eventKey, draft.manualInstructor]));
    // Fastlåste billeder: manuelt valgte billeder gælder alle varianter; godkendte og publicerede
    // opslag beholder desuden deres basisbillede, så en godkendelse aldrig nulstilles af reglen.
    const approvedAsset = (assetId) => assets.assets.find((asset) =>
      asset.assetId === assetId && asset.status === 'approved');
    const activePrevious = previousDrafts.filter((draft) => draft.slotKey && draft.status !== 'obsolete');
    const manualAssets = new Map(activePrevious
      .filter((draft) => draft.manualAssetId && approvedAsset(draft.manualAssetId))
      .map((draft) => [draft.slotKey, approvedAsset(draft.manualAssetId)]));
    const pinnedAssets = new Map(manualAssets);
    for (const draft of activePrevious) {
      if (['approved', 'published'].includes(draft.status) && !pinnedAssets.has(draft.slotKey)
        && approvedAsset(draft.assetId)) pinnedAssets.set(draft.slotKey, approvedAsset(draft.assetId));
    }
    const effectiveEvents = events.map((event) => manualInstructors.has(event.eventKey)
      ? { ...event, instructor: manualInstructors.get(event.eventKey) }
      : event);
    const originalByKey = new Map(events.map((event) => [event.eventKey, event]));
    const slots = buildSchedule(effectiveEvents, config)
      .filter((slot) => {
        const slotEvents = slot.eventKeys
          .map((key) => effectiveEvents.find((event) => event.eventKey === key))
          .filter(Boolean);
        return !isExpiredDraft({
          kind: slot.kind,
          event: slot.kind === 'weekly_overview' ? null : slotEvents[0],
          events: slot.kind === 'weekly_overview' ? slotEvents : undefined,
        }, now);
      });
    const generated = [];
    const rendersDir = runtimeRoot ? path.join(path.resolve(runtimeRoot), 'renders') : path.join(outputDir, 'renders');
    let renderCount = 0;
    const usedByEvent = new Map();
    const renderFor = async (slot, eventList, copyPackage, season, suffix = '', variantKey = '') => {
      const eventKey = slot.eventKeys.length === 1 && slot.kind !== 'weekly_overview' ? slot.eventKeys[0] : null;
      const siblingKey = `${eventKey}|${variantKey}`;
      const siblings = eventKey ? (usedByEvent.get(siblingKey) || new Map()) : new Map();
      // To opslag om samme event må aldrig få samme billede.
      const excluded = eventKey
        ? [...siblings].filter(([otherSlot]) => otherSlot !== slot.slotKey).map(([, assetId]) => assetId)
        : [];
      for (const other of slots) {
        if (other.slotKey !== slot.slotKey && eventKey && other.eventKeys[0] === eventKey
          && pinnedAssets.has(other.slotKey)) excluded.push(pinnedAssets.get(other.slotKey).assetId);
      }
      const manual = variantKey ? manualAssets.get(slot.slotKey) : pinnedAssets.get(slot.slotKey);
      const asset = manual || selectAsset(slot, eventList, assets, season, excluded);
      if (eventKey) {
        usedByEvent.set(siblingKey, new Map([...siblings, [slot.slotKey, asset.assetId]]));
      }
      const fingerprint = fingerprintForSlot(slot, eventList).slice(0, 10);
      const renderFile = `${safeFileName(slot.slotKey)}-${fingerprint}${suffix}.jpg`;
      const rendered = await renderDraftImage(browser, {
        asset, logoPath: assets.logoPath, copy: copyPackage, config, season,
      }, path.join(rendersDir, renderFile));
      const portableRenderPath = runtimeRoot
        ? path.relative(path.resolve(runtimeRoot), rendered.path).replace(/\\/gu, '/')
        : null;
      if (portableRenderPath && (portableRenderPath.startsWith('../') || path.isAbsolute(portableRenderPath))) {
        throw new Error('Render-stien forlader runtime-repository');
      }
      const render = portableRenderPath ? { ...rendered, path: portableRenderPath } : rendered;
      renderCount += 1;
      return { asset, render, renderPath: portableRenderPath || `../renders/${renderFile}` };
    };
    for (const slot of slots) {
      const event = slot.kind === 'weekly_overview'
        ? null
        : effectiveEvents.find((candidate) => candidate.eventKey === slot.eventKeys[0]);
      const source = event ? resolveContentSource(event, profiles, overrides) : null;
      const copyPackage = buildCopyPackage(slot, effectiveEvents, source, config);
      const seasonDate = event?.date
        || effectiveEvents.find((candidate) => candidate.eventKey === slot.eventKeys[0])?.date;
      const season = resolveSeason(seasonDate, config.season);
      const primary = await renderFor(slot, effectiveEvents, copyPackage, season);
      const warnings = source?.warnings || [];
      const originalEvent = event ? originalByKey.get(event.eventKey) : null;
      let instructorOptions;
      if (event && !originalEvent?.instructor) {
        instructorOptions = {};
        for (const [key, instructor] of [['soren', 'Søren'], ['millemaja', 'MilleMaja']]) {
          const variantEvent = { ...event, instructor };
          const variantEvents = effectiveEvents.map((candidate) =>
            candidate.eventKey === event.eventKey ? variantEvent : candidate);
          const variantSource = resolveContentSource(variantEvent, profiles, overrides);
          const variantCopy = buildCopyPackage(slot, variantEvents, variantSource, config);
          const variantRender = await renderFor(slot, variantEvents, variantCopy, season, `-${key}`, key);
          instructorOptions[key] = {
            instructor,
            warnings: variantSource.warnings,
            platformCopies: {
              instagram: variantCopy.instagram,
              facebookPage: variantCopy.facebookPage,
              facebookGroup: variantCopy.facebookGroup,
            },
            assetId: variantRender.asset.assetId,
            render: variantRender.render,
            renderPath: variantRender.renderPath,
          };
        }
      }
      // Godkendte og publicerede opslag beholder deres tekst, så en ny tekstskabelon kun gælder nye opslag.
      const slotEventFingerprint = fingerprintForSlot(slot, events);
      const frozenCopy = activePrevious.find((draft) => draft.slotKey === slot.slotKey
        && ['approved', 'published'].includes(draft.status)
        && draft.eventFingerprint === slotEventFingerprint
        && draft.scheduledFor === slot.scheduledFor
        && draft.platformCopies);
      const platformCopies = frozenCopy
        ? {
          instagram: frozenCopy.platformCopies.instagram,
          facebookPage: frozenCopy.platformCopies.facebookPage,
          facebookGroup: frozenCopy.platformCopies.facebookGroup,
        }
        : {
          instagram: copyPackage.instagram,
          facebookPage: copyPackage.facebookPage,
          facebookGroup: copyPackage.facebookGroup,
        };
      const candidate = {
        draftId: `${slot.slotKey}_r1`,
        slotKey: slot.slotKey,
        eventKey: event?.eventKey || null,
        eventFingerprint: slotEventFingerprint,
        revision: 1,
        kind: slot.kind,
        status: warnings.length ? 'needs_review' : 'draft',
        scheduledFor: slot.scheduledFor,
        season,
        event: event || null,
        events: slot.kind === 'weekly_overview' ? slot.eventKeys.map((key) => effectiveEvents.find((item) => item.eventKey === key)) : undefined,
        availability: slot.availability,
        warnings,
        platformCopies,
        contentFingerprint: fingerprintForContent({
          platformCopies,
          assetId: primary.asset.assetId,
          season,
          warnings,
          instructorOptions,
        }),
        factsUsed: copyPackage.factsUsed,
        assetId: primary.asset.assetId,
        render: primary.render,
        renderPath: primary.renderPath,
        manualInstructor: event ? manualInstructors.get(event.eventKey) || null : null,
        manualAssetId: manualAssets.get(slot.slotKey)?.assetId || null,
        instructorOptions,
        history: [],
      };
      candidate.contentRevision = contentRevisionFor(candidate);
      generated.push(candidate);
    }

    const drafts = reconcileDrafts(previousDrafts, generated, events);
    await writeJsonAtomic(path.join(outputDir, 'events.json'), events);
    await writeJsonAtomic(path.join(outputDir, 'drafts.json'), drafts);
    await writeApprovalPayload(outputDir, drafts);
    const activeDrafts = drafts.filter((draft) => draft.status !== 'obsolete');
    return {
      events, drafts, networkRequests,
      activeDrafts: activeDrafts.length,
      warnings: activeDrafts.reduce((total, draft) => total + (draft.warnings?.length || 0), 0),
      renders: renderCount,
    };
  } catch (error) {
    if (live) await diagnoseLiveFailure(page, error).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

function validateReviewed(current, reviewed) {
  if (!Array.isArray(reviewed) || reviewed.length !== current.length) throw new Error('Fremmed eller ufuldstændig review-fil');
  const currentById = new Map(current.map((draft) => [draft.draftId, draft]));
  for (const draft of reviewed) {
    const original = currentById.get(draft.draftId);
    if (!original) throw new Error(`Fremmed draft-id: ${draft.draftId}`);
    if (draft.revision !== original.revision || draft.eventFingerprint !== original.eventFingerprint) {
      throw new Error(`Forældet revision eller event-fingerprint: ${draft.draftId}`);
    }
    if (!draft.platformCopies || Object.keys(draft.platformCopies).sort().join('|') !== PLATFORM_KEYS.join('|')) {
      throw new Error(`Ugyldige platformfelter: ${draft.draftId}`);
    }
    if (PLATFORM_KEYS.some((key) => typeof draft.platformCopies[key] !== 'string' || !draft.platformCopies[key].trim())) {
      throw new Error(`Tom eller ugyldig platformtekst: ${draft.draftId}`);
    }
    if (!['draft', 'needs_review', 'approved', 'rejected', 'obsolete'].includes(draft.status)) {
      throw new Error(`Ugyldig status: ${draft.draftId}`);
    }
    if (original.status === 'obsolete' && draft.status !== 'obsolete') throw new Error(`Forældet opslag kan ikke genåbnes: ${draft.draftId}`);
    if (original.status !== 'obsolete' && draft.status === 'obsolete') throw new Error(`Review må ikke selv forælde et opslag: ${draft.draftId}`);
    if (draft.status === 'approved' && draft.warnings?.length && !draft.warningsAcknowledged) {
      throw new Error(`En advarsel er ikke bekræftet: ${draft.draftId}`);
    }
    if (draft.status === 'approved' && !draft.approvedAt) throw new Error(`Godkendelsestidspunkt mangler: ${draft.draftId}`);
    currentById.delete(draft.draftId);
  }
  if (currentById.size) throw new Error('Review-filen mangler aktuelle kladder');
}

async function importReviewed({ reviewedPath, outputDir = DEFAULT_OUTPUT }) {
  const [current, reviewed] = await Promise.all([
    fs.readFile(path.join(outputDir, 'drafts.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.resolve(reviewedPath), 'utf8').then(JSON.parse),
  ]);
  validateReviewed(current, reviewed);
  await writeJsonAtomic(path.join(outputDir, 'drafts.json'), reviewed);
  await writeApprovalPayload(outputDir, reviewed);
  return reviewed;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--live') result.live = true;
    else if (['--fixture', '--output-dir', '--import-reviewed'].includes(value)) {
      if (!argv[index + 1]) throw new Error(`${value} mangler en sti`);
      result[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = argv[++index];
    } else throw new Error(`Ukendt argument: ${value}`);
  }
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outputDir = args.outputDir ? path.resolve(args.outputDir) : DEFAULT_OUTPUT;
  if (args.importReviewed) {
    const drafts = await importReviewed({ reviewedPath: args.importReviewed, outputDir });
    console.log(`Importerede ${drafts.length} kontrollerede kladder. Ingen opslag blev publiceret.`);
    return;
  }
  const result = await runPipeline({
    fixturePath: args.fixture ? path.resolve(args.fixture) : null,
    live: Boolean(args.live), outputDir,
  });
  console.log(`Fandt ${result.events.length} events og byggede ${result.activeDrafts} aktive kladder med ${result.renders} billeder.`);
  console.log(`Advarsler: ${result.warnings}. Godkendelse: ${path.join(outputDir, 'approval', 'index.html')}`);
  console.log('POC – intet er publiceret til Facebook eller Instagram.');
}

module.exports = { parseArgs, runPipeline, importReviewed, validateReviewed, writeApprovalPayload };

if (require.main === module) {
  main().catch((error) => {
    console.error(`SOMA Content Planner fejlede: ${error.message}`);
    process.exitCode = 1;
  });
}
