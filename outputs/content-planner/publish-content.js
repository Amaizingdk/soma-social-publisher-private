'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { loadJsonValidated, writeJsonAtomic } = require('./lib/io');
const { buildDryRunPlan } = require('./lib/publish-plan');
const { validateMetaConnection } = require('./lib/meta-readonly');

const DEFAULT_DRAFTS_PATH = path.join(__dirname, 'drafts.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_OUTPUT_PATH = path.join(__dirname, 'publish-plan.json');

function parsePublisherArgs(argv = []) {
  const parsed = {
    dryRun: false,
    validateMeta: false,
    draftsPath: DEFAULT_DRAFTS_PATH,
    configPath: DEFAULT_CONFIG_PATH,
    eventsPath: null,
    outputPath: DEFAULT_OUTPUT_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (parsed.dryRun) throw new Error('Argumentet --dry-run er angivet flere gange');
      parsed.dryRun = true;
      continue;
    }
    if (argument === '--validate-meta') {
      if (parsed.validateMeta) throw new Error('Argumentet --validate-meta er angivet flere gange');
      parsed.validateMeta = true;
      continue;
    }
    if (argument === '--drafts' || argument === '--events' || argument === '--output' || argument === '--config') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${argument} mangler en sti`);
      }
      const key = argument === '--drafts' ? 'draftsPath' : argument === '--events' ? 'eventsPath' : argument === '--config' ? 'configPath' : 'outputPath';
      parsed[key] = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Ukendt argument: ${argument}`);
  }

  if (!parsed.dryRun) throw new Error('--dry-run er påkrævet');
  return parsed;
}

function validateDraftArray(value) {
  if (!Array.isArray(value)) throw new Error('Kladdefilen skal indeholde en liste');
}

function safeSummary(plan, outputPath) {
  return [
    `Dry-run gemt: ${outputPath}`,
    `godkendte kladder: ${plan.summary.approvedDrafts}`,
    `blokerede kladder: ${plan.summary.blockedDrafts}`,
    `automatiske forhåndsvisninger: ${plan.summary.automaticPosts}`,
    `manuelle opslag: ${plan.summary.manualPosts}`,
  ].join(' · ');
}

async function assertSafeOutputTarget(outputPath, draftsPath) {
  if (path.resolve(outputPath) === path.resolve(draftsPath)) {
    throw new Error('Output må ikke overskrive kladdefilen');
  }

  let raw;
  try {
    raw = await fs.readFile(outputPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw new Error('Outputfilen kan ikke kontrolleres sikkert');
  }

  let existing;
  try {
    existing = JSON.parse(raw);
  } catch {
    throw new Error('Outputfilen er ikke en eksisterende SOMA dry-run-plan');
  }
  if (existing?.schemaVersion !== 1 || existing?.mode !== 'dry_run') {
    throw new Error('Outputfilen er ikke en eksisterende SOMA dry-run-plan');
  }
}

async function runPublisher({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = console.log,
} = {}) {
  const args = parsePublisherArgs(argv);
  const drafts = await loadJsonValidated(args.draftsPath, validateDraftArray);
  const liveEvents = args.eventsPath ? await loadJsonValidated(args.eventsPath, validateDraftArray) : null;
  const config = JSON.parse(await fs.readFile(args.configPath, 'utf8'));
  const plan = await buildDryRunPlan(drafts, { liveEvents, assetHosting: config.assetHosting });

  if (args.validateMeta) {
    plan.metaValidation = await validateMetaConnection({
      token: env.SOMA_META_ACCESS_TOKEN,
      fetchImpl,
    });
  }

  await assertSafeOutputTarget(args.outputPath, args.draftsPath);
  await writeJsonAtomic(args.outputPath, plan);
  stdout(safeSummary(plan, args.outputPath));
  return plan;
}

if (require.main === module) {
  runPublisher().catch((error) => {
    console.error(`Publisher stoppede sikkert: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parsePublisherArgs, runPublisher, safeSummary };
