'use strict';

const fs = require('node:fs');
const { createHash } = require('node:crypto');

function validCrop(crop) {
  if (!crop || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(crop[key]))) return false;
  return crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
}

function validateAssetRegistry(registry) {
  if (!registry || !Array.isArray(registry.assets)) throw new Error('Asset registry mangler assets-array');
  if (!registry.logoPath || !fs.existsSync(registry.logoPath)) throw new Error(`Logo mangler: ${registry.logoPath}`);
  const ids = new Set();
  for (const asset of registry.assets) {
    if (!asset.assetId || ids.has(asset.assetId)) throw new Error(`Asset-id mangler eller er dublet: ${asset.assetId}`);
    ids.add(asset.assetId);
    if (!validCrop(asset.crop45)) throw new Error(`Ugyldig crop45 for ${asset.assetId}`);
    if (!asset.sourcePath || !fs.existsSync(asset.sourcePath)) throw new Error(`Source image mangler for ${asset.assetId}`);
    if (asset.status === 'approved') {
      if (!asset.orientationVerified) throw new Error(`Orientation er ikke verificeret for ${asset.assetId}`);
      if (!asset.normalizedPath || !fs.existsSync(asset.normalizedPath)) {
        throw new Error(`Normalized image mangler for ${asset.assetId}`);
      }
    }
  }
}

// Billeder, som andre aktive opslag om samme event bruger (basis og gusmester-varianter).
function siblingAssetIds(draft, drafts) {
  if (!draft?.eventKey || !Array.isArray(drafts)) return new Set();
  const ids = new Set();
  for (const other of drafts) {
    if (other.draftId === draft.draftId || other.slotKey === draft.slotKey) continue;
    if (other.eventKey !== draft.eventKey || other.status === 'obsolete') continue;
    if (other.assetId) ids.add(other.assetId);
    for (const option of Object.values(other.instructorOptions || {})) {
      if (option?.assetId) ids.add(option.assetId);
    }
  }
  return ids;
}

function selectAsset(slot, events, registry, season = null, excludeAssetIds = []) {
  validateAssetRegistry(registry);
  const excluded = new Set(excludeAssetIds);
  const approved = registry.assets.filter((asset) => asset.status === 'approved' && !excluded.has(asset.assetId));
  if (approved.length === 0) throw new Error('Der findes intet godkendt billede til opslaget, som ikke allerede bruges af et andet opslag om samme event');
  const event = events.find((candidate) => candidate.eventKey === slot.eventKeys?.[0]);
  let desiredTag = null;
  if (slot.kind === 'weekly_overview') desiredTag = 'weekly';
  else if (event) {
    const weekday = new Date(`${event.date}T12:00:00Z`).getUTCDay();
    if (/mille\s*maja/iu.test(event.instructor || '')) desiredTag = 'calm';
    else if (weekday === 2) desiredTag = 'power';
    else if (weekday === 4) desiredTag = 'calm';
    else if (weekday === 0) desiredTag = 'sunday';
  }
  const matching = desiredTag
    ? approved.filter((asset) => (asset.tags || []).includes(desiredTag))
    : [];
  const seasonalMatching = season
    ? matching.filter((asset) => (asset.tags || []).includes(season) || (asset.tags || []).includes('all-season'))
    : [];
  const seasonal = season
    ? approved.filter((asset) => (asset.tags || []).includes(season) || (asset.tags || []).includes('all-season'))
    : [];
  const candidates = seasonalMatching.length
    ? seasonalMatching
    : (matching.length ? matching : (seasonal.length ? seasonal : approved));
  const digest = createHash('sha256').update(slot.slotKey).digest();
  return candidates[digest.readUInt32BE(0) % candidates.length];
}

module.exports = { validateAssetRegistry, selectAsset, siblingAssetIds };
