'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { themeForSeason } = require('./season');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mimeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.svg') return 'image/svg+xml';
  if (extension === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function dataUrl(filePath) {
  return `data:${mimeFor(filePath)};base64,${(await fs.readFile(filePath)).toString('base64')}`;
}

function validateRenderInput(input) {
  if (input.asset?.status !== 'approved' || !input.asset.orientationVerified) {
    throw new Error('Render kræver et godkendt billede med verificeret orientation');
  }
  if (!input.asset.normalizedPath || !input.logoPath) throw new Error('Render mangler billede eller logo');
  if (!input.copy?.imageLines || !input.config?.render) throw new Error('Render mangler copy eller konfiguration');
}

async function buildRenderHtml(input) {
  validateRenderInput(input);
  const theme = themeForSeason(input.season || 'autumn');
  const [imageSource, logoSource] = await Promise.all([
    dataUrl(input.asset.normalizedPath),
    dataUrl(input.logoPath),
  ]);
  const lines = input.copy.imageLines;
  const crop = input.asset.crop45;
  const objectX = Math.round((crop.x + (crop.width / 2)) * 100);
  const objectY = Math.round((crop.y + (crop.height / 2)) * 100);
  const weekly = Boolean(lines.weekly);
  const instructor = lines.instructorName
    ? `<div class="instructor" data-field="instructor" data-fit-check>
         <div class="instructor-label" data-field="instructor-label">${escapeHtml(lines.instructorLabel || 'GUSMESTER')}</div>
         <div class="instructor-name" data-field="instructor-name">${escapeHtml(lines.instructorName)}</div>
       </div>`
    : '';
  const details = weekly
    ? ''
    : `<div class="date" data-field="date" data-fit-check>${escapeHtml(lines.date)}</div>
       <div class="time" data-field="time" data-fit-check>${escapeHtml(lines.time)}</div>
       ${instructor}`;

  return `<!doctype html>
<html lang="da"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:#171514;font-family:Arial,sans-serif}.art{position:relative;width:${input.config.render.width}px;height:${input.config.render.height}px;overflow:hidden;background:#211812;color:#fff}.photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:${objectX}% ${objectY}%;transform:none}.shade{position:absolute;inset:0;background:${theme.shade}}.logo{position:absolute;left:72px;top:64px;width:190px;height:190px;display:flex;align-items:flex-start}.logo img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;transform:none}.eyebrow{position:absolute;right:72px;top:92px;font-size:24px;font-weight:700;letter-spacing:5px;text-transform:uppercase}.content{position:absolute;left:72px;right:72px;bottom:92px}.headline{max-height:250px;overflow:hidden;font-family:Georgia,serif;font-size:86px;line-height:1.02;letter-spacing:-2px;text-transform:uppercase;margin-bottom:18px}.tagline{font-size:22px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:${theme.accent};margin-bottom:34px}.date{font-size:30px;letter-spacing:4px;text-transform:uppercase;margin-bottom:14px}.time{font-family:Georgia,serif;font-size:60px;font-weight:700;margin-bottom:20px}.instructor{max-width:820px;max-height:92px;overflow:hidden}.instructor-label{font-size:18px;font-weight:700;letter-spacing:4px;color:${theme.accent};margin-bottom:5px}.instructor-name{font-size:29px;letter-spacing:1px}
</style></head><body><main class="art" id="render-root">
<img class="photo" src="${imageSource}" alt="" data-transform="none">
<div class="shade"></div>
<div class="logo" data-field="logo"><img src="${logoSource}" alt="SOMA Sauna Gus" data-transform="none"></div>
<div class="eyebrow">${escapeHtml(theme.eyebrow)}</div>
<section class="content">
  <div class="headline" data-field="headline" data-fit-check>${escapeHtml(lines.headline)}</div>
  ${lines.tagline ? `<div class="tagline" data-field="tagline" data-fit-check>${escapeHtml(lines.tagline)}</div>` : ''}
  ${details}
</section>
</main></body></html>`;
}

async function renderDraftImage(browser, input, outputPath) {
  validateRenderInput(input);
  const html = await buildRenderHtml(input);
  const { width, height, quality } = input.config.render;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
    const problems = await page.locator('[data-fit-check]').evaluateAll((nodes) => nodes
      .filter((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 4)
      .map((node) => node.getAttribute('data-field')));
    if (problems.length) throw new Error(`Tekstoverløb: ${problems.join(', ')}`);
    const transformed = await page.locator('[data-transform]').evaluateAll((nodes) => nodes
      .filter((node) => getComputedStyle(node).transform !== 'none')
      .map((node) => node.tagName));
    if (transformed.length) throw new Error(`Uventet rotation eller spejling: ${transformed.join(', ')}`);
    const text = await page.locator('#render-root').innerText();
    if (/\b\d+\s*\/\s*\d+\b/.test(text)) throw new Error('Render indeholder et forældeligt præcist pladstal');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const buffer = await page.locator('#render-root').screenshot({
      path: outputPath,
      type: 'jpeg',
      quality,
    });
    return {
      path: outputPath,
      width,
      height,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  } finally {
    await page.close();
  }
}

module.exports = {
  buildRenderHtml,
  renderDraftImage,
  escapeHtml,
  dataUrl,
};
