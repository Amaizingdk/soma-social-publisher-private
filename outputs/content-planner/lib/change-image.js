'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { transitionDraft } = require('./drafts');
const { buildCopyPackage } = require('./copy');
const { resolveContentSource, validateProfiles, validateOverrides } = require('./profile-resolver');
const { contentRevisionFor, isExpiredDraft } = require('./draft-lifecycle');
const { fingerprintForContent } = require('./content-fingerprint');
const { renderDraftImage } = require('./render');
const { siblingAssetIds } = require('./assets');
const { loadJsonValidated } = require('./io');

const TERMINAL_STATUSES = new Set(['published', 'skipped', 'rejected', 'obsolete']);
const PLANNER_DIR = path.join('outputs', 'content-planner');

// Registrets stier er relative til repo-roden; absolutte stier gør render uafhængig af arbejdsmappen.
function absoluteRegistry(registry, repoRoot) {
  const abs = (value) => (value ? path.resolve(repoRoot, value) : value);
  return {
    ...registry,
    logoPath: abs(registry.logoPath),
    assets: registry.assets.map((asset) => ({
      ...asset, sourcePath: abs(asset.sourcePath), normalizedPath: abs(asset.normalizedPath),
    })),
  };
}

async function loadPlannerInputs(repoRoot) {
  const dir = path.join(repoRoot, PLANNER_DIR);
  const [config, profiles, overrides, registry] = await Promise.all([
    loadJsonValidated(path.join(dir, 'config.json'), () => {}),
    loadJsonValidated(path.join(dir, 'profiles.json'), validateProfiles),
    loadJsonValidated(path.join(dir, 'event-overrides.json'), validateOverrides),
    loadJsonValidated(path.join(dir, 'assets.json'), () => {}),
  ]);
  return { config, profiles, overrides, registry: absoluteRegistry(registry, repoRoot) };
}

async function usable(asset) {
  if (asset.status !== 'approved' || !asset.orientationVerified) return false;
  return fs.access(asset.normalizedPath).then(() => true, () => false);
}

// Hvilke billeder en kladde må skifte til. Et billede, som et andet opslag om samme event bruger, er aldrig tilladt.
// Galleriet er bevidst ikke årstidsfiltreret: Søren vælger frit. Årstid styrer kun det automatiske valg (selectAsset).
function selectableAssets(draft, registry, drafts = []) {
  const taken = siblingAssetIds(draft, drafts);
  return registry.assets.filter((asset) => asset.status === 'approved' && !taken.has(asset.assetId));
}

async function listSelectableAssets({ repoRoot, draft, drafts = [] }) {
  const { registry } = await loadPlannerInputs(repoRoot);
  const candidates = selectableAssets(draft, registry, drafts);
  const checked = await Promise.all(candidates.map(async (asset) => ((await usable(asset)) ? asset : null)));
  return checked.filter(Boolean).map((asset) => ({ assetId: asset.assetId, tags: asset.tags || [] }));
}

async function assetFileFor({ repoRoot, assetId }) {
  const { registry } = await loadPlannerInputs(repoRoot);
  const asset = registry.assets.find((candidate) => candidate.assetId === assetId);
  return asset && (await usable(asset)) ? asset.normalizedPath : null;
}

function slotOf(draft) {
  const weekly = draft.kind === 'weekly_overview';
  return {
    slotKey: draft.slotKey,
    kind: draft.kind,
    scheduledFor: draft.scheduledFor,
    eventKeys: weekly ? (draft.events || []).map((event) => event.eventKey) : [draft.eventKey],
    availability: draft.availability ?? null,
  };
}

function portablePath(fileName) {
  return path.join('renders', fileName).replace(/\\/g, '/');
}

async function changeDraftImage({
  repoRoot, drafts, draftId, contentRevision, assetId, now = new Date(), launchBrowser,
}) {
  const index = drafts.findIndex((draft) => draft.draftId === draftId);
  if (index < 0) return { drafts, outcome: 'unknown_draft', files: [] };
  const draft = drafts[index];
  if (contentRevision !== draft.contentRevision) return { drafts, outcome: 'stale_revision', files: [] };
  if (TERMINAL_STATUSES.has(draft.status) || isExpiredDraft(draft, now)) {
    return { drafts, outcome: 'terminal', files: [] };
  }
  if (draft.assetId === assetId) return { drafts, outcome: 'unchanged', files: [] };

  const { config, profiles, overrides, registry } = await loadPlannerInputs(repoRoot);
  if (siblingAssetIds(draft, drafts).has(assetId)) return { drafts, outcome: 'duplicate_asset', files: [] };
  const allowed = selectableAssets(draft, registry, drafts).find((asset) => asset.assetId === assetId);
  if (!allowed || !(await usable(allowed))) return { drafts, outcome: 'unknown_asset', files: [] };

  const slot = slotOf(draft);
  const weekly = draft.kind === 'weekly_overview';
  const events = weekly ? draft.events : [draft.event];
  const source = weekly ? null : resolveContentSource(draft.event, profiles, overrides);
  const copyPackage = buildCopyPackage(slot, events, source, config);
  const warnings = source?.warnings || [];

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-change-image-'));
  let browser;
  try {
    try {
      browser = await (launchBrowser || (() => require('playwright').chromium.launch({ headless: true })))();
    } catch {
      return { drafts, outcome: 'render_unavailable', files: [] };
    }
    const renderTo = (fileName, copy) => renderDraftImage(browser, {
      asset: allowed, logoPath: registry.logoPath, copy, config, season: draft.season,
    }, path.join(tmpDir, fileName));

    const baseName = path.basename(draft.render?.path || draft.renderPath);
    const base = await renderTo(baseName, copyPackage);
    const fileNames = [baseName];

    let instructorOptions;
    if (draft.instructorOptions) {
      instructorOptions = {};
      for (const [key, option] of Object.entries(draft.instructorOptions)) {
        const variantEvent = { ...draft.event, instructor: option.instructor };
        const variantSource = resolveContentSource(variantEvent, profiles, overrides);
        const variantCopy = buildCopyPackage(slot, [variantEvent], variantSource, config);
        const variantName = path.basename(option.render?.path || option.renderPath);
        const variantRender = await renderTo(variantName, variantCopy);
        fileNames.push(variantName);
        instructorOptions[key] = {
          ...option,
          assetId,
          render: { ...variantRender, path: portablePath(variantName) },
          renderPath: portablePath(variantName),
        };
      }
    }

    const platformCopies = {
      instagram: copyPackage.instagram,
      facebookPage: copyPackage.facebookPage,
      facebookGroup: copyPackage.facebookGroup,
    };
    const updated = transitionDraft(draft, { type: 'change_image', at: now.toISOString() });
    updated.assetId = assetId;
    updated.manualAssetId = assetId;
    updated.render = { ...base, path: portablePath(baseName) };
    updated.renderPath = portablePath(baseName);
    if (instructorOptions) updated.instructorOptions = instructorOptions;
    updated.contentFingerprint = fingerprintForContent({
      platformCopies, assetId, season: draft.season, warnings, instructorOptions,
    });
    updated.contentRevision = contentRevisionFor({ ...updated, platformCopies });

    // Først når alle render er lykkedes, lægges filerne i repoet (alt eller intet).
    await fs.mkdir(path.join(repoRoot, 'renders'), { recursive: true });
    const files = [];
    for (const name of fileNames) {
      await fs.copyFile(path.join(tmpDir, name), path.join(repoRoot, portablePath(name)));
      files.push(portablePath(name));
    }
    return {
      drafts: drafts.map((item, position) => (position === index ? updated : item)),
      outcome: 'changed',
      files,
    };
  } catch (error) {
    const rejected = /Tekstoverløb|Uventet rotation|forældeligt/u.test(error.message);
    return { drafts, outcome: rejected ? 'render_rejected' : 'render_failed', files: [] };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { changeDraftImage, listSelectableAssets, selectableAssets, assetFileFor };
