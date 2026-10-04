const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const {
  assetIdFor, cropFor, sizeReport, listLibrary, libraryStatus, prepareImages, registerImage, parseFocus, parseArgs,
} = require('../outputs/content-planner/prepare-post-image');

async function tmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function fakePlanner() {
  const planner = await tmp('soma-prep-planner-');
  const repo = await tmp('soma-prep-repo-');
  await fs.writeFile(path.join(planner, 'assets.json'), JSON.stringify({ version: 1, logoPath: 'assets/l.png', assets: [] }));
  return { planner, repo };
}

async function makeJpeg(browser, file, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.setContent(`<body style="margin:0"><div style="width:${width}px;height:${height}px;background:linear-gradient(90deg,#c33,#36c)"></div></body>`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
  } finally { await page.close(); }
}

test('billed-id kommer fra filnavnet uden accenter, kopi-endelser og tegnsætning', () => {
  assert.equal(assetIdFor('IMG_5595.jpg'), 'soma-img-5595');
  assert.equal(assetIdFor('IMG_5591 - Kopi.jpg'), 'soma-img-5591');
  assert.equal(assetIdFor('Hygge aften i kabinen.png'), 'soma-hygge-aften-i-kabinen');
  assert.equal(assetIdFor('soma-sauna-01.jpg'), 'soma-sauna-01');
  assert.throws(() => assetIdFor('---.jpg'), /billed-id/);
});

test('beskæringsvinduet har det rigtige format og holder sig inde i billedet', () => {
  const portrait = cropFor({ width: 1800, height: 2400 }, 4 / 5);
  assert.equal(portrait.width, 1);
  assert.ok(Math.abs((portrait.width * 1800) / (portrait.height * 2400) - 0.8) < 0.001);
  const landscape = cropFor({ width: 2400, height: 1800 }, 9 / 16, { x: 0, y: 0.5 });
  assert.equal(landscape.x, 0);
  assert.equal(landscape.height, 1);
  const edge = cropFor({ width: 2400, height: 1800 }, 4 / 5, { x: 1, y: 0.5 });
  assert.ok(edge.x + edge.width <= 1.00001);
});

test('størrelseskontrollen stopper for små billeder og advarer om Story', () => {
  assert.deepEqual(sizeReport({ width: 1800, height: 2400 }), { errors: [], warnings: [] });
  assert.equal(sizeReport({ width: 2400, height: 1800 }).warnings.length, 1);
  assert.equal(sizeReport({ width: 1536, height: 1024 }).errors.length, 1);
  assert.equal(sizeReport({ width: 1079, height: 1500 }).errors.length, 1);
});

test('fokus og argumenter valideres', () => {
  assert.deepEqual(parseFocus('0.25,0.75'), { x: 0.25, y: 0.75 });
  assert.deepEqual(parseFocus(undefined), { x: 0.5, y: 0.5 });
  assert.throws(() => parseFocus('2,0'), /mellem 0 og 1/);
  assert.throws(() => parseArgs(['--nonsens']), /Ukendt argument/);
  assert.throws(() => parseArgs(['--library']), /mangler/);
});

test('biblioteket afviser to filer med samme billed-id og ignorerer andre filtyper', async () => {
  const dir = await tmp('soma-lib-');
  await fs.writeFile(path.join(dir, 'IMG_1.jpg'), 'x');
  await fs.writeFile(path.join(dir, 'IMG_1.png'), 'x');
  await assert.rejects(() => listLibrary(dir), /ens for/);
  await fs.rm(path.join(dir, 'IMG_1.png'));
  await fs.writeFile(path.join(dir, 'video.MOV'), 'x');
  assert.deepEqual((await listLibrary(dir)).map((item) => item.assetId), ['soma-img-1']);
});

test('status skelner mellem registreret, afventende og registreret uden for biblioteket', async () => {
  const dir = await tmp('soma-lib-');
  const { planner } = await fakePlanner();
  await fs.writeFile(path.join(planner, 'assets.json'), JSON.stringify({
    assets: [
      { assetId: 'soma-img-1', status: 'approved' },
      { assetId: 'soma-gammel', status: 'approved' },
    ],
  }));
  await fs.writeFile(path.join(dir, 'IMG_1.jpg'), 'x');
  await fs.writeFile(path.join(dir, 'IMG_2.jpg'), 'x');
  const status = await libraryStatus({ libraryDir: dir, plannerDir: planner });
  assert.deepEqual(status.registered.map((item) => item.assetId), ['soma-img-1']);
  assert.deepEqual(status.pending.map((item) => item.assetId), ['soma-img-2']);
  assert.deepEqual(status.registeredOutsideLibrary, ['soma-gammel']);
});

test('forberedelse laver normaliseret billede og begge forhåndsvisninger, og stopper for små billeder', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const lib = await tmp('soma-lib-');
    const out = await tmp('soma-out-');
    await makeJpeg(browser, path.join(lib, 'stort.jpg'), 1200, 1500);
    await makeJpeg(browser, path.join(lib, 'lille.jpg'), 600, 400);
    const results = await prepareImages({ browser, libraryDir: lib, outDir: out });
    const big = results.find((item) => item.assetId === 'soma-stort');
    const small = results.find((item) => item.assetId === 'soma-lille');
    assert.equal(big.ready, true);
    for (const file of ['normaliseret.jpg', 'forhaandsvisning-4x5.jpg', 'forhaandsvisning-9x16.jpg', 'info.json']) {
      await fs.access(path.join(out, 'soma-stort', file));
    }
    assert.equal(small.ready, false);
    await assert.rejects(fs.access(path.join(out, 'soma-lille', 'normaliseret.jpg')));
    assert.ok((await fs.stat(path.join(lib, 'stort.jpg'))).size > 0);
    await assert.rejects(() => prepareImages({ browser, libraryDir: lib, outDir: out, only: ['findes-ikke.jpg'] }), /Findes ikke/);
  } finally { await browser.close(); }
});

test('registrering kræver visuelt ja og tags, kopierer billedet og afviser dubletter', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const lib = await tmp('soma-lib-');
    const out = await tmp('soma-out-');
    const { planner, repo } = await fakePlanner();
    await makeJpeg(browser, path.join(lib, 'stort.jpg'), 1200, 1500);
    await prepareImages({ browser, libraryDir: lib, outDir: out });
    const base = {
      assetId: 'soma-stort', fromDir: path.join(out, 'soma-stort'), tags: ['sauna'],
      approved: 'Søren 2026-10-04', plannerDir: planner, repoRoot: repo,
    };
    await assert.rejects(() => registerImage({ ...base, approved: '' }), /--approved/);
    await assert.rejects(() => registerImage({ ...base, tags: [] }), /--tags/);
    await assert.rejects(() => registerImage({ ...base, assetId: 'soma-andet' }), /hører til/);

    const entry = await registerImage(base);
    assert.equal(entry.status, 'approved');
    assert.equal(entry.orientationVerified, true);
    assert.equal(entry.libraryFile, 'stort.jpg');
    assert.match(entry.approvalNote, /Søren 2026-10-04/);
    await fs.access(path.join(repo, 'assets', 'soma-stort.jpg'));
    const registry = JSON.parse(await fs.readFile(path.join(planner, 'assets.json'), 'utf8'));
    assert.equal(registry.assets.length, 1);
    await assert.rejects(() => registerImage(base), /allerede registreret/);
  } finally { await browser.close(); }
});

test('billeder, der er for små, kan ikke registreres', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const lib = await tmp('soma-lib-');
    const out = await tmp('soma-out-');
    const { planner, repo } = await fakePlanner();
    await makeJpeg(browser, path.join(lib, 'lille.jpg'), 600, 400);
    await prepareImages({ browser, libraryDir: lib, outDir: out });
    await assert.rejects(() => registerImage({
      assetId: 'soma-lille', fromDir: path.join(out, 'soma-lille'), tags: ['x'], approved: 'Søren', plannerDir: planner, repoRoot: repo,
    }), /ikke klart/);
  } finally { await browser.close(); }
});
