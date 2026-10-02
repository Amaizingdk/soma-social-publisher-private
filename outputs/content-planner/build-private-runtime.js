const fs = require('node:fs/promises');
const path = require('node:path');
const { contentRevisionFor } = require('./lib/draft-lifecycle');

const FORBIDDEN_PATH = /(^|\/)(?:\.env(?:\.|$)|debug\.log$|PROJECT_STATUS[^/]*|licensed-music(?:\/|$)|screenshots?(?:\/|$)|[^/]*token[^/]*|[^/]*\.(?:mp4|webm))|prototype/i;
const TOKEN_PATTERN = /EA[A-Za-z0-9]{20,}/;
const TEXT_EXTENSIONS = new Set(['', '.cjs', '.gitignore', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml']);
const OPERATIONAL_STATUSES = new Set([
  'draft',
  'needs_review',
  'approved',
  'needs_correction',
  'skipped',
  'published',
  'rejected',
]);

function portable(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function assertRelativePath(relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error(`${label} skal være en relativ sti`);
  }
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} forlader den tilladte mappe`);
  }
  return normalized;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSeparateDestination(projectRoot, destination) {
  const source = path.resolve(projectRoot);
  const target = path.resolve(destination);
  if (source === target || isInside(source, target) || isInside(target, source)) {
    throw new Error('Release-destinationen skal være en separat mappe uden for kildeprojektet');
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, 'outputs', 'content-planner', 'private-runtime-manifest.json');
  const manifest = await readJson(manifestPath);
  if (manifest.version !== 1 || !Array.isArray(manifest.copies)) {
    throw new Error('Ugyldigt private-runtime-manifest');
  }
  return manifest;
}

async function listFilesRecursive(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolske links er ikke tilladt i release: ${fullPath}`);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function validateReleasePath(relativePath) {
  const normalized = portable(assertRelativePath(relativePath, 'Release-sti'));
  if (FORBIDDEN_PATH.test(normalized)) throw new Error(`Forbudt fil i release-allowlist: ${normalized}`);
  return normalized;
}

async function resolveAllowlist(projectRoot, manifest) {
  const resolved = [];
  for (const copy of manifest.copies) {
    const sourceRelative = assertRelativePath(copy.source, 'Kildesti');
    const destinationRelative = assertRelativePath(copy.destination, 'Destinationssti');
    const source = path.join(projectRoot, sourceRelative);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`Symbolske links er ikke tilladt i release: ${copy.source}`);
    if (stat.isDirectory()) {
      for (const file of await listFilesRecursive(source)) {
        const child = path.relative(source, file);
        resolved.push({ source: file, destination: validateReleasePath(path.join(destinationRelative, child)) });
      }
    } else if (stat.isFile()) {
      resolved.push({ source, destination: validateReleasePath(destinationRelative) });
    } else {
      throw new Error(`Kilden er ikke en fil eller mappe: ${copy.source}`);
    }
  }

  if (manifest.testGlob !== 'work/*.test.js' || manifest.testDestination !== 'work') {
    throw new Error('Manifestets testkontrakt er ugyldig');
  }
  const workDir = path.join(projectRoot, 'work');
  for (const entry of await fs.readdir(workDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      resolved.push({
        source: path.join(workDir, entry.name),
        destination: validateReleasePath(path.join('work', entry.name)),
      });
    }
  }

  const unique = new Map();
  for (const item of resolved) {
    if (unique.has(item.destination)) throw new Error(`Dubleret release-sti: ${item.destination}`);
    unique.set(item.destination, item);
  }
  return [...unique.values()].sort((a, b) => a.destination.localeCompare(b.destination));
}

function stripLocalData(value) {
  if (Array.isArray(value)) return value.map(stripLocalData);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'history' || key === 'sourcePath') continue;
    if ((key === 'render' || key === 'renderPath') && child) continue;
    if (typeof child === 'string' && /^[A-Za-z]:\\/.test(child)) continue;
    result[key] = stripLocalData(child);
  }
  return result;
}

async function preparePortableData(projectRoot) {
  const draftsPath = path.join(projectRoot, 'outputs', 'content-planner', 'drafts.json');
  const assetsPath = path.join(projectRoot, 'outputs', 'content-planner', 'assets.json');
  const draftsSource = await readJson(draftsPath);
  if (!Array.isArray(draftsSource)) throw new Error('drafts.json skal være en liste');
  const copyFiles = [];
  const usedRenderNames = new Map();
  const drafts = [];
  for (const draft of draftsSource.filter((item) => item && OPERATIONAL_STATUSES.has(item.status))) {
    if (!draft.render?.path) throw new Error(`Godkendt kladde mangler render: ${draft.draftId || 'ukendt'}`);
    const fileName = path.basename(draft.render.path);
    const key = fileName.toLowerCase();
    const existingSource = usedRenderNames.get(key);
    if (existingSource && path.resolve(existingSource) !== path.resolve(draft.render.path)) {
      throw new Error(`Render-filnavn er ikke entydigt: ${fileName}`);
    }
    const renderPath = validateReleasePath(path.join('renders', fileName));
    if (!existingSource) {
      usedRenderNames.set(key, draft.render.path);
      copyFiles.push({ source: draft.render.path, destination: renderPath });
    }
    const { path: localRenderPath, ...renderMetadata } = draft.render;
    const contentRevision = contentRevisionFor(draft);
    const portableDraft = {
      ...stripLocalData(draft),
      contentRevision,
      render: { ...stripLocalData(renderMetadata), path: portable(renderPath) },
    };
    if (draft.status === 'approved' && draft.approvedAt && !draft.approvedRevision) {
      portableDraft.approvedRevision = contentRevision;
      portableDraft.approvedBy = 'legacy_local_review';
    }
    drafts.push(portableDraft);
  }

  const assetsSource = await readJson(assetsPath);
  if (!assetsSource || !Array.isArray(assetsSource.assets) || !assetsSource.logoPath) {
    throw new Error('assets.json mangler assets eller logoPath');
  }
  const usedNames = new Set();
  const assets = [];
  for (const asset of assetsSource.assets.filter((item) => item && item.status === 'approved')) {
    if (!asset.normalizedPath) throw new Error(`Godkendt asset mangler normalizedPath: ${asset.assetId || 'ukendt'}`);
    const fileName = path.basename(asset.normalizedPath);
    if (usedNames.has(fileName.toLowerCase())) throw new Error(`Asset-filnavn er ikke entydigt: ${fileName}`);
    usedNames.add(fileName.toLowerCase());
    const portableAssetPath = portable(path.join('assets', fileName));
    copyFiles.push({ source: asset.normalizedPath, destination: validateReleasePath(path.join('assets', fileName)) });
    assets.push({
      ...stripLocalData(asset),
      sourcePath: portableAssetPath,
      normalizedPath: portableAssetPath,
    });
  }
  const logoDestination = 'assets/soma-logo-white.png';
  copyFiles.push({ source: assetsSource.logoPath, destination: logoDestination });

  return {
    copyFiles,
    drafts,
    assets: {
      version: assetsSource.version || 1,
      logoPath: logoDestination,
      assets,
    },
  };
}

async function copyOne({ source, destination }, releaseRoot) {
  const target = path.resolve(releaseRoot, destination);
  if (!isInside(releaseRoot, target)) throw new Error(`Release-sti forlader destinationen: ${destination}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

async function writeJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function scanRelease({ destination, secretValues }) {
  const secrets = secretValues.filter((value) => typeof value === 'string' && value.length > 0);
  for (const file of await listFilesRecursive(destination)) {
    const relative = portable(path.relative(destination, file));
    validateReleasePath(relative);
    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && path.basename(file) !== '.gitignore') continue;
    const content = await fs.readFile(file, 'utf8');
    if (TOKEN_PATTERN.test(content) || secrets.some((secret) => content.includes(secret))) {
      throw new Error(`Secret fundet i releasefil: ${relative}`);
    }
    if (/[A-Za-z]:\\Users\\/i.test(content)) {
      throw new Error(`Lokal brugersti fundet i releasefil: ${relative}`);
    }
  }
}

async function buildPrivateRuntime({ projectRoot, destination, secretValues = [] }) {
  if (!projectRoot || !destination || !Array.isArray(secretValues)) throw new Error('Ugyldige release-parametre');
  assertSeparateDestination(projectRoot, destination);
  const sourceRoot = path.resolve(projectRoot);
  const releaseRoot = path.resolve(destination);
  if (await pathExists(releaseRoot)) {
    const existing = await fs.readdir(releaseRoot);
    if (existing.length > 0) throw new Error('Release-destinationen indeholder allerede filer');
  }
  await fs.mkdir(releaseRoot, { recursive: true });

  const manifest = await readManifest(sourceRoot);
  const files = await resolveAllowlist(sourceRoot, manifest);
  const portableData = await preparePortableData(sourceRoot);
  for (const item of [...files, ...portableData.copyFiles]) await copyOne(item, releaseRoot);
  await writeJson(path.join(releaseRoot, 'outputs', 'content-planner', 'drafts.json'), portableData.drafts);
  await writeJson(path.join(releaseRoot, 'outputs', 'content-planner', 'assets.json'), portableData.assets);
  const approvalDataPath = path.join(releaseRoot, 'outputs', 'content-planner', 'approval', 'drafts-data.js');
  await fs.mkdir(path.dirname(approvalDataPath), { recursive: true });
  await fs.writeFile(approvalDataPath, 'window.__SOMA_DRAFTS__ = window.__SOMA_DRAFTS__ || [];\n', 'utf8');

  const generated = [
    ...files.map((item) => item.destination),
    ...portableData.copyFiles.map((item) => item.destination),
    'outputs/content-planner/drafts.json',
    'outputs/content-planner/assets.json',
    'outputs/content-planner/approval/drafts-data.js',
  ];
  const releaseFiles = [...new Set(generated)].sort();
  await scanRelease({ destination: releaseRoot, secretValues });
  return { files: releaseFiles, destination: releaseRoot };
}

module.exports = {
  assertSeparateDestination,
  buildPrivateRuntime,
  resolveAllowlist,
  scanRelease,
};
