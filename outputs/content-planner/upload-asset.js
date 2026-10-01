'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { buildAssetUpload, uploadAsset } = require('./lib/github-assets');

function parseArgs(argv = []) {
  const result = { publish: false, file: null, assetPath: null, repo: 'Amaizingdk/soma-social-assets', baseUrl: 'https://amaizingdk.github.io/soma-social-assets/' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--publish') { result.publish = true; continue; }
    if (['--file', '--asset-path', '--repo', '--base-url'].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} mangler en værdi`);
      if (arg === '--file') result.file = path.resolve(value);
      if (arg === '--asset-path') result.assetPath = value;
      if (arg === '--repo') result.repo = value;
      if (arg === '--base-url') result.baseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`Ukendt argument: ${arg}`);
  }
  if (!result.file || !result.assetPath) throw new Error('--file og --asset-path er påkrævet');
  return result;
}

async function run(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, stdout = console.log) {
  const args = parseArgs(argv);
  const upload = await buildAssetUpload({
    repo: args.repo,
    baseUrl: args.baseUrl,
    localPath: args.file,
    assetPath: args.assetPath,
  });
  if (!args.publish) {
    stdout(`Forberedt uden upload: ${upload.publicUrl}`);
    return { mode: 'dry_run', publicUrl: upload.publicUrl };
  }
  if (!env.SOMA_GITHUB_TOKEN) throw new Error('SOMA_GITHUB_TOKEN mangler');
  const result = await uploadAsset({ upload, token: env.SOMA_GITHUB_TOKEN, fetchImpl });
  stdout(`Upload gennemført: ${result.publicUrl}`);
  return { mode: 'published', ...result };
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Upload stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, run };
