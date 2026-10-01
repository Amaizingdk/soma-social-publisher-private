'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { loadJsonValidated } = require('./lib/io');
const { buildAssetUpload, uploadAsset } = require('./lib/github-assets');

const DEFAULT_PLAN = path.join(__dirname, 'publish-plan.json');
const DEFAULT_CONFIG = path.join(__dirname, 'config.json');

function parseArgs(argv = []) {
  const result = { publish: false, planPath: DEFAULT_PLAN, configPath: DEFAULT_CONFIG };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') { result.publish = true; continue; }
    if (arg === '--plan' || arg === '--config') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} mangler en sti`);
      if (arg === '--plan') result.planPath = path.resolve(value);
      if (arg === '--config') result.configPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Ukendt argument: ${arg}`);
  }
  return result;
}

function validatePlan(value) {
  if (!value || value.mode !== 'dry_run' || !Array.isArray(value.automatic)) throw new Error('Planen er ikke en gyldig dry-run-plan');
}

function uniqueAssets(plan, config) {
  const baseUrl = config?.assetHosting?.baseUrl;
  const repo = config?.assetHosting?.repository;
  if (!baseUrl || !repo) throw new Error('Asset-hosting mangler repository eller baseUrl');
  const seen = new Set();
  return plan.automatic.filter((item) => {
    if (!item.deliveryType || !item.imagePath || !item.assetPath) {
      throw new Error('Leveringen mangler deliveryType, imagePath eller assetPath');
    }
    const uniqueKey = `${item.deliveryType}|${item.imagePath}`;
    if (seen.has(uniqueKey)) return false;
    seen.add(uniqueKey);
    return true;
  }).map((item) => ({
    ...item,
    repo,
    baseUrl,
  }));
}

async function run(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, stdout = console.log) {
  const args = parseArgs(argv);
  const plan = await loadJsonValidated(args.planPath, validatePlan);
  const config = JSON.parse(await fs.readFile(args.configPath, 'utf8'));
  const assets = uniqueAssets(plan, config);
  if (!args.publish) {
    for (const asset of assets) stdout(`Forberedt uden upload: ${asset.assetPath} ← ${asset.imagePath}`);
    stdout(`I alt: ${assets.length} unikke godkendte billeder`);
    return { mode: 'dry_run', assets };
  }
  if (!env.SOMA_GITHUB_TOKEN) throw new Error('SOMA_GITHUB_TOKEN mangler');
  const uploaded = [];
  for (const asset of assets) {
    const upload = await buildAssetUpload({
      repo: asset.repo,
      baseUrl: asset.baseUrl,
      localPath: asset.imagePath,
      assetPath: asset.assetPath,
      deliveryType: asset.deliveryType,
    });
    uploaded.push(await uploadAsset({ upload, token: env.SOMA_GITHUB_TOKEN, fetchImpl }));
    stdout(`Upload gennemført: ${upload.publicUrl}`);
  }
  return { mode: 'published', uploaded };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Batch-upload stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, uniqueAssets, run };
