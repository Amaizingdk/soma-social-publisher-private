'use strict';

// Gør et foto fra billedbiblioteket post-klart: rigtig orientering, kontrol af størrelse og
// forhåndsvisning i begge formater (Facebook 4:5, Story 9:16). Registrering sker først efter dit visuelle ja.
//
//   node prepare-post-image.js --library "<mappe>" --out "<mappe>" [--only a.jpg,b.png] [--focus 0.5,0.5]
//   node prepare-post-image.js --status --library "<mappe>"
//   node prepare-post-image.js --register <assetId> --from "<out>/<assetId>" --tags sauna,varme \
//        --approved "Søren 2026-10-04" [--focus 0.5,0.5]

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { loadJsonValidated, writeJsonAtomic } = require('./lib/io');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MAX_LONG_EDGE = 2400;
const FEED = { width: 1080, height: 1350, aspect: 4 / 5, label: '4x5' };
const STORY = { width: 1080, height: 1920, aspect: 9 / 16, label: '9x16' };
const PLANNER_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function slug(value) {
  return String(value)
    .normalize('NFKD').replace(/[̀-ͯ]/gu, '')
    .toLowerCase().replace(/ - kopi/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
}

function assetIdFor(fileName) {
  const base = slug(path.basename(fileName, path.extname(fileName)));
  if (!base) throw new Error(`Kan ikke lave et billed-id af filnavnet: ${fileName}`);
  return base.startsWith('soma-') ? base : `soma-${base}`;
}

function parseFocus(value) {
  if (value === undefined || value === null) return { x: 0.5, y: 0.5 };
  const [x, y] = String(value).split(',').map(Number);
  if (![x, y].every((part) => Number.isFinite(part) && part >= 0 && part <= 1)) {
    throw new Error('--focus skal være to tal mellem 0 og 1, fx 0.5,0.4');
  }
  return { x, y };
}

// Beskæringsvindue (andele af billedet) i et givet billedformat omkring et fokuspunkt.
function cropFor({ width, height }, aspect, focus = { x: 0.5, y: 0.5 }) {
  const windowWidth = width / height > aspect ? height * aspect : width;
  const windowHeight = width / height > aspect ? height : width / aspect;
  const fractionWidth = windowWidth / width;
  const fractionHeight = windowHeight / height;
  const clamp = (value, size) => Math.min(Math.max(value - (size / 2), 0), 1 - size);
  const round = (value) => Math.round(value * 10000) / 10000;
  return {
    x: round(clamp(focus.x, fractionWidth)),
    y: round(clamp(focus.y, fractionHeight)),
    width: round(fractionWidth),
    height: round(fractionHeight),
  };
}

// Feed-render dækker 1080×1350 uden at forstørre; Story ønskes 1080×1920 men er kun en advarsel.
function sizeReport({ width, height }) {
  const errors = [];
  const warnings = [];
  if (width < FEED.width || height < FEED.height) {
    errors.push(`for lille til Facebook-opslag: ${width}×${height}, kræver mindst ${FEED.width}×${FEED.height}`);
  }
  if (width < STORY.width || height < STORY.height) {
    warnings.push(`under Story-størrelsen ${STORY.width}×${STORY.height}: forstørres og kan blive blød`);
  }
  return { errors, warnings };
}

async function listLibrary(libraryDir) {
  const entries = await fs.readdir(libraryDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'da'));
  const seen = new Map();
  for (const file of files) {
    const id = assetIdFor(file);
    if (seen.has(id)) throw new Error(`Billed-id ${id} er ens for ${seen.get(id)} og ${file}; omdøb den ene`);
    seen.set(id, file);
  }
  return files.map((file) => ({ file, assetId: assetIdFor(file) }));
}

async function readRegistry(plannerDir = PLANNER_DIR) {
  return loadJsonValidated(path.join(plannerDir, 'assets.json'), (value) => {
    if (!Array.isArray(value?.assets)) throw new Error('assets.json mangler assets-array');
  });
}

async function libraryStatus({ libraryDir, plannerDir = PLANNER_DIR }) {
  const registry = await readRegistry(plannerDir);
  const registered = new Map(registry.assets.map((asset) => [asset.assetId, asset]));
  const library = await listLibrary(libraryDir);
  const inLibrary = new Set(library.map((item) => item.assetId));
  return {
    registered: library.filter((item) => registered.get(item.assetId)?.status === 'approved'),
    pending: library.filter((item) => !registered.has(item.assetId)),
    registeredOutsideLibrary: registry.assets
      .filter((asset) => asset.status === 'approved' && !inLibrary.has(asset.assetId))
      .map((asset) => asset.assetId),
  };
}

const NORMALIZE_SCRIPT = async ({ dataUrl, maxEdge }) => {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  // Chromium anvender EXIF-orienteringen, når billedet tegnes; resultatet har ingen orienteringstag.
  const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  return {
    width, height, original: { width: bitmap.width, height: bitmap.height },
    jpeg: canvas.toDataURL('image/jpeg', 0.92).split(',')[1],
  };
};

function mimeFor(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function normalizeImage(browser, file) {
  const bytes = await fs.readFile(file);
  const page = await browser.newPage();
  try {
    const result = await page.evaluate(NORMALIZE_SCRIPT, {
      dataUrl: `data:${mimeFor(file)};base64,${bytes.toString('base64')}`,
      maxEdge: MAX_LONG_EDGE,
    });
    return {
      width: result.width, height: result.height, original: result.original,
      buffer: Buffer.from(result.jpeg, 'base64'),
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    await page.close();
  }
}

async function renderPreview(browser, buffer, format, crop, outputPath) {
  const objectX = Math.round((crop.x + (crop.width / 2)) * 100);
  const objectY = Math.round((crop.y + (crop.height / 2)) * 100);
  const page = await browser.newPage({ viewport: { width: format.width, height: format.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(`<!doctype html><body style="margin:0;background:#111"><img id="p" style="display:block;width:${format.width}px;height:${format.height}px;object-fit:cover;object-position:${objectX}% ${objectY}%" src="data:image/jpeg;base64,${buffer.toString('base64')}"></body>`);
    await page.waitForFunction(() => document.getElementById('p').complete);
    await page.locator('#p').screenshot({ path: outputPath, type: 'jpeg', quality: 90 });
  } finally {
    await page.close();
  }
}

async function prepareImages({ browser, libraryDir, outDir, only = null, focus = { x: 0.5, y: 0.5 } }) {
  const library = await listLibrary(libraryDir);
  const selected = only ? library.filter((item) => only.includes(item.file)) : library;
  if (only) {
    const missing = only.filter((file) => !library.some((item) => item.file === file));
    if (missing.length) throw new Error(`Findes ikke i biblioteket: ${missing.join(', ')}`);
  }
  const results = [];
  for (const { file, assetId } of selected) {
    const normalized = await normalizeImage(browser, path.join(libraryDir, file));
    const report = sizeReport(normalized);
    const target = path.join(outDir, assetId);
    await fs.mkdir(target, { recursive: true });
    const crop45 = cropFor(normalized, FEED.aspect, focus);
    const crop916 = cropFor(normalized, STORY.aspect, focus);
    const info = {
      assetId, libraryFile: file, focus,
      width: normalized.width, height: normalized.height, original: normalized.original,
      sourceSha256: normalized.sourceSha256,
      crop45, crop916, errors: report.errors, warnings: report.warnings,
      ready: report.errors.length === 0,
    };
    if (info.ready) {
      await fs.writeFile(path.join(target, 'normaliseret.jpg'), normalized.buffer);
      await renderPreview(browser, normalized.buffer, FEED, crop45, path.join(target, `forhaandsvisning-${FEED.label}.jpg`));
      await renderPreview(browser, normalized.buffer, STORY, crop916, path.join(target, `forhaandsvisning-${STORY.label}.jpg`));
    }
    await writeJsonAtomic(path.join(target, 'info.json'), info);
    results.push(info);
  }
  return results;
}

// Registrering kræver, at billedet er forberedt og visuelt godkendt (orientering og beskæring).
async function registerImage({
  assetId, fromDir, tags, approved, focus = null, plannerDir = PLANNER_DIR, repoRoot = REPO_ROOT,
}) {
  if (!approved || !String(approved).trim()) throw new Error('--approved mangler: hvem har godkendt orientering og beskæring visuelt?');
  if (!Array.isArray(tags) || tags.length === 0) throw new Error('--tags mangler (fx sauna,varme,autumn)');
  const info = JSON.parse(await fs.readFile(path.join(fromDir, 'info.json'), 'utf8'));
  if (info.assetId !== assetId) throw new Error(`info.json hører til ${info.assetId}, ikke ${assetId}`);
  if (!info.ready) throw new Error(`Billedet er ikke klart: ${info.errors.join('; ')}`);
  const normalizedFile = path.join(fromDir, 'normaliseret.jpg');
  const buffer = await fs.readFile(normalizedFile);
  const crop45 = focus ? cropFor(info, FEED.aspect, focus) : info.crop45;

  const registryPath = path.join(plannerDir, 'assets.json');
  const registry = await readRegistry(plannerDir);
  if (registry.assets.some((asset) => asset.assetId === assetId)) throw new Error(`${assetId} er allerede registreret`);
  const relative = `assets/${assetId}.jpg`;
  await fs.mkdir(path.join(repoRoot, 'assets'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, relative), buffer);
  const entry = {
    assetId,
    status: 'approved',
    tags,
    crop45,
    orientationVerified: true,
    approvalNote: `Orientering og beskæring visuelt godkendt: ${approved}. Original i billedbiblioteket: ${info.libraryFile}.`,
    libraryFile: info.libraryFile,
    sourcePath: relative,
    normalizedPath: relative,
  };
  await writeJsonAtomic(registryPath, { ...registry, assets: [...registry.assets, entry] });
  return entry;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--status') { args.status = true; continue; }
    if (!['--library', '--out', '--only', '--focus', '--register', '--from', '--tags', '--approved'].includes(flag)) {
      throw new Error(`Ukendt argument: ${flag}`);
    }
    if (!argv[index + 1]) throw new Error(`${flag} mangler en værdi`);
    args[flag.slice(2)] = argv[++index];
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const focus = args.focus === undefined ? undefined : parseFocus(args.focus);
  if (args.register) {
    if (!args.from) throw new Error('--from mangler (mappen med forberedt billede)');
    const entry = await registerImage({
      assetId: args.register, fromDir: path.resolve(args.from),
      tags: String(args.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean),
      approved: args.approved, focus: focus || null,
    });
    console.log(`Registreret: ${entry.assetId}. Husk at synkronisere assets/ og assets.json til runtime (kræver ja pr. push).`);
    return;
  }
  if (!args.library) throw new Error('--library mangler (billedbibliotekets mappe)');
  const libraryDir = path.resolve(args.library);
  if (args.status) {
    const status = await libraryStatus({ libraryDir });
    console.log(`Registreret og klar: ${status.registered.map((item) => item.assetId).join(', ') || '–'}`);
    console.log(`Mangler forberedelse: ${status.pending.map((item) => item.file).join(', ') || '–'}`);
    console.log(`Registreret men ikke i biblioteket: ${status.registeredOutsideLibrary.join(', ') || '–'}`);
    return;
  }
  if (!args.out) throw new Error('--out mangler (hvor forhåndsvisninger skrives)');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const results = await prepareImages({
      browser, libraryDir, outDir: path.resolve(args.out),
      only: args.only ? args.only.split(',') : null, focus: focus || { x: 0.5, y: 0.5 },
    });
    for (const info of results) {
      const state = info.ready ? 'klar' : 'STOPPET';
      console.log(`${state}  ${info.assetId}  ${info.width}×${info.height}  ${[...info.errors, ...info.warnings].join('; ')}`);
    }
    console.log('Intet er registreret. Kontrollér forhåndsvisningerne og registrér efter dit visuelle ja.');
  } finally {
    await browser.close();
  }
}

module.exports = {
  assetIdFor, cropFor, sizeReport, listLibrary, libraryStatus, prepareImages, registerImage, parseFocus, parseArgs,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`prepare-post-image fejlede: ${error.message}`);
    process.exitCode = 1;
  });
}
