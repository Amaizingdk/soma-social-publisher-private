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
const { siblingAssetIds, selectAsset } = require('./assets');
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

// Genopbygger én kladde med et valgt billede (og evt. en valgt gusmester) på samme måde som planlægningen,
// så næste planlægningskørsel giver præcis samme indhold og revision.
async function rebuildDraft({
  ctx, draft, asset, instructorChange = null, actionType, replaceCopies, pinAsset, renderImage, now,
}) {
  const { config, profiles, overrides, registry, browser, tmpDir } = ctx;
  const weekly = draft.kind === 'weekly_overview';
  const withInstructor = (event) => (instructorChange && event.eventKey === instructorChange.eventKey
    ? { ...event, instructor: instructorChange.instructor } : event);
  const event = weekly ? null : withInstructor(draft.event);
  const events = weekly ? draft.events.map(withInstructor) : [event];
  const slot = slotOf(draft);
  const source = weekly ? null : resolveContentSource(event, profiles, overrides);
  const copyPackage = buildCopyPackage(slot, events, source, config);
  const warnings = source?.warnings || [];
  const renderTo = (fileName, copy) => renderDraftImage(browser, {
    asset, logoPath: registry.logoPath, copy, config, season: draft.season,
  }, path.join(tmpDir, fileName));

  const files = [];
  const baseName = path.basename(draft.render?.path || draft.renderPath);
  let base = draft.render;
  if (renderImage) {
    base = { ...(await renderTo(baseName, copyPackage)), path: portablePath(baseName) };
    files.push(baseName);
  }

  let instructorOptions;
  if (draft.instructorOptions) {
    instructorOptions = {};
    for (const [key, option] of Object.entries(draft.instructorOptions)) {
      const variantEvent = { ...event, instructor: option.instructor };
      const variantCopy = buildCopyPackage(slot, [variantEvent], resolveContentSource(variantEvent, profiles, overrides), config);
      const variantName = path.basename(option.render?.path || option.renderPath);
      const variantRender = await renderTo(variantName, variantCopy);
      files.push(variantName);
      instructorOptions[key] = {
        ...option,
        assetId: asset.assetId,
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
  const updated = transitionDraft(
    { ...draft, warnings, warningsAcknowledged: warnings.length ? draft.warningsAcknowledged : false },
    { type: actionType, at: now.toISOString() },
  );
  if (weekly) updated.events = events;
  else updated.event = event;
  if (instructorChange) updated.manualInstructor = instructorChange.instructor;
  if (replaceCopies) updated.platformCopies = platformCopies;
  updated.assetId = asset.assetId;
  if (pinAsset) updated.manualAssetId = asset.assetId;
  updated.render = base;
  updated.renderPath = base?.path || draft.renderPath;
  if (instructorOptions) updated.instructorOptions = instructorOptions;
  updated.contentFingerprint = fingerprintForContent({
    platformCopies, assetId: asset.assetId, season: draft.season, warnings, instructorOptions,
  });
  updated.contentRevision = contentRevisionFor({ ...updated, platformCopies });
  return { updated, files };
}

// Alt eller intet: først når alle render er lykkedes, lægges filerne i repoet.
async function publishFiles({ repoRoot, tmpDir, fileNames }) {
  await fs.mkdir(path.join(repoRoot, 'renders'), { recursive: true });
  const files = [];
  for (const name of fileNames) {
    await fs.copyFile(path.join(tmpDir, name), path.join(repoRoot, portablePath(name)));
    files.push(portablePath(name));
  }
  return files;
}

async function withRenderContext({ repoRoot, launchBrowser }, task) {
  const inputs = await loadPlannerInputs(repoRoot);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-rebuild-'));
  let browser;
  try {
    try {
      browser = await (launchBrowser || (() => require('playwright').chromium.launch({ headless: true })))();
    } catch {
      return { outcome: 'render_unavailable', files: [] };
    }
    return await task({ ...inputs, browser, tmpDir });
  } catch (error) {
    const rejected = /Tekstoverløb|Uventet rotation|forældeligt/u.test(error.message);
    return { outcome: rejected ? 'render_rejected' : 'render_failed', files: [] };
  } finally {
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function blocked(drafts, outcome) {
  return { drafts, outcome, files: [] };
}

async function changeDraftImage({
  repoRoot, drafts, draftId, contentRevision, assetId, now = new Date(), launchBrowser,
}) {
  const index = drafts.findIndex((draft) => draft.draftId === draftId);
  if (index < 0) return blocked(drafts, 'unknown_draft');
  const draft = drafts[index];
  if (contentRevision !== draft.contentRevision) return blocked(drafts, 'stale_revision');
  if (TERMINAL_STATUSES.has(draft.status) || isExpiredDraft(draft, now)) return blocked(drafts, 'terminal');
  if (draft.assetId === assetId) return blocked(drafts, 'unchanged');

  const { registry } = await loadPlannerInputs(repoRoot);
  if (siblingAssetIds(draft, drafts).has(assetId)) return blocked(drafts, 'duplicate_asset');
  const allowed = selectableAssets(draft, registry, drafts).find((asset) => asset.assetId === assetId);
  if (!allowed || !(await usable(allowed))) return blocked(drafts, 'unknown_asset');

  const result = await withRenderContext({ repoRoot, launchBrowser }, async (ctx) => {
    const { updated, files } = await rebuildDraft({
      ctx, draft, asset: allowed, actionType: 'change_image', replaceCopies: false, pinAsset: true,
      renderImage: true, now,
    });
    return { outcome: 'changed', updated, files: await publishFiles({ repoRoot, tmpDir: ctx.tmpDir, fileNames: files }) };
  });
  if (result.outcome !== 'changed') return blocked(drafts, result.outcome);
  return {
    drafts: drafts.map((item, position) => (position === index ? result.updated : item)),
    outcome: 'changed',
    changedIds: [draftId],
    files: result.files,
  };
}

// Gemmer gusmester-valget for et helt event: begge opslag om eventet og ugeoverblik, der nævner det.
async function chooseInstructor({
  repoRoot, drafts, draftId, contentRevision, optionKey, now = new Date(), launchBrowser,
}) {
  const draft = drafts.find((item) => item.draftId === draftId);
  if (!draft) return blocked(drafts, 'unknown_draft');
  if (contentRevision !== draft.contentRevision) return blocked(drafts, 'stale_revision');
  if (TERMINAL_STATUSES.has(draft.status) || isExpiredDraft(draft, now)) return blocked(drafts, 'terminal');
  const option = draft.instructorOptions?.[optionKey];
  if (!option || !draft.eventKey) return blocked(drafts, 'unknown_option');
  if (draft.manualInstructor === option.instructor) return blocked(drafts, 'unchanged');

  const eventKey = draft.eventKey;
  const instructorChange = { eventKey, instructor: option.instructor };
  const targets = drafts.filter((item) => !TERMINAL_STATUSES.has(item.status) && !isExpiredDraft(item, now)
    && (item.eventKey === eventKey
      || (item.kind === 'weekly_overview' && item.events?.some((event) => event.eventKey === eventKey))));

  const { registry } = await loadPlannerInputs(repoRoot);
  const registryAsset = (assetId) => registry.assets.find((asset) => asset.assetId === assetId);

  const result = await withRenderContext({ repoRoot, launchBrowser }, async (ctx) => {
    const rebuilt = new Map();
    const fileNames = [];
    const usedByEvent = new Set();
    for (const target of targets) {
      const weekly = target.kind === 'weekly_overview';
      let assetId = weekly
        ? target.assetId
        : (target.manualAssetId || target.instructorOptions?.[optionKey]?.assetId || target.assetId);
      if (!weekly && usedByEvent.has(assetId)) {
        // Ældre data kan have ens billeder til de to opslag; to opslag om samme event får aldrig samme billede.
        const event = { ...target.event, instructor: option.instructor };
        assetId = selectAsset(slotOf(target), [event], registry, target.season, [...usedByEvent]).assetId;
      }
      const asset = registryAsset(assetId);
      if (!asset || !(await usable(asset))) return { outcome: 'unknown_asset', files: [] };
      if (!weekly) usedByEvent.add(assetId);
      const { updated, files } = await rebuildDraft({
        ctx, draft: target, asset, instructorChange, actionType: 'change_instructor',
        replaceCopies: true, pinAsset: !weekly, renderImage: !weekly, now,
      });
      rebuilt.set(target.draftId, updated);
      fileNames.push(...files);
    }
    return { outcome: 'changed', rebuilt, files: await publishFiles({ repoRoot, tmpDir: ctx.tmpDir, fileNames }) };
  });
  if (result.outcome !== 'changed') return blocked(drafts, result.outcome);
  return {
    drafts: drafts.map((item) => result.rebuilt.get(item.draftId) || item),
    outcome: 'changed',
    changedIds: [...result.rebuilt.keys()],
    files: result.files,
  };
}

module.exports = {
  changeDraftImage, chooseInstructor, listSelectableAssets, selectableAssets, assetFileFor,
};
