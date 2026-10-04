const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  changeDraftImage, chooseInstructor, listSelectableAssets, assetFileFor,
} = require('../outputs/content-planner/lib/change-image');
const { runPipeline } = require('../outputs/content-planner/build-content-plan');

const projectRoot = path.join(__dirname, '..');
const plannerFiles = ['config.json', 'profiles.json', 'event-overrides.json', 'assets.json'];
const NOW = new Date('2026-10-03T12:00:00Z');
const WITH_VARIANTS = '2026-10-06_18-30_saunagus_event-day_r7';
const ORIGINAL_ASSET = 'soma-power-steam';

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-change-image-test-'));
  const planner = path.join(root, 'outputs', 'content-planner');
  await fs.mkdir(planner, { recursive: true });
  for (const file of plannerFiles) {
    await fs.copyFile(path.join(projectRoot, 'outputs', 'content-planner', file), path.join(planner, file));
  }
  await fs.cp(path.join(projectRoot, 'assets'), path.join(root, 'assets'), { recursive: true });
  const drafts = JSON.parse(await fs.readFile(path.join(projectRoot, 'outputs', 'content-planner', 'drafts.json'), 'utf8'));
  return { root, drafts };
}

function jpegSize(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG dimensions not found');
}

test('skifter billedet, nulstiller godkendelsen og renderer alle varianter', async () => {
  const { root, drafts } = await sandbox();
  const original = drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  assert.equal(original.status, 'approved');
  const result = await changeDraftImage({
    repoRoot: root, drafts, draftId: WITH_VARIANTS, contentRevision: original.contentRevision,
    assetId: 'soma-outdoor-sunday', now: NOW,
  });
  assert.equal(result.outcome, 'changed');
  const updated = result.drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  assert.equal(updated.assetId, 'soma-outdoor-sunday');
  assert.equal(updated.manualAssetId, 'soma-outdoor-sunday');
  assert.notEqual(updated.contentRevision, original.contentRevision);
  assert.notEqual(updated.render.sha256, original.render.sha256);
  assert.equal(updated.status, 'draft');
  assert.equal(updated.approvedRevision, null);
  assert.equal(updated.approvedAt, null);
  assert.equal(updated.history.at(-1).type, 'change_image');
  assert.equal(updated.renderPath, original.renderPath);
  for (const option of Object.values(updated.instructorOptions)) assert.equal(option.assetId, 'soma-outdoor-sunday');
  assert.equal(result.files.length, 1 + Object.keys(original.instructorOptions).length);
  for (const file of result.files) {
    assert.deepEqual(jpegSize(await fs.readFile(path.join(root, file))), { width: 1080, height: 1350 });
  }
  // Øvrige kladder er urørte.
  assert.deepEqual(result.drafts.filter((draft) => draft.draftId !== WITH_VARIANTS),
    drafts.filter((draft) => draft.draftId !== WITH_VARIANTS));
});

test('retur til det oprindelige billede giver samme fingerprint og revision som pipelinen', async () => {
  const { root, drafts: all } = await sandbox();
  const plain = '2026-10-08_18-30_saunagus_event-day_r7';
  // Søskendeopslaget fjernes, så testen kan skifte tilbage til det oprindelige (dublerede) billede.
  const drafts = all.filter((draft) => draft.draftId !== '2026-10-08_18-30_saunagus_day-before_r7');
  const original = drafts.find((draft) => draft.draftId === plain);
  const away = await changeDraftImage({
    repoRoot: root, drafts, draftId: plain, contentRevision: original.contentRevision,
    assetId: 'soma-sauna-01', now: NOW,
  });
  const awayDraft = away.drafts.find((draft) => draft.draftId === plain);
  const back = await changeDraftImage({
    repoRoot: root, drafts: away.drafts, draftId: plain, contentRevision: awayDraft.contentRevision,
    assetId: original.assetId, now: NOW,
  });
  const restored = back.drafts.find((draft) => draft.draftId === plain);
  // Pixels afhænger af styresystemets skrifttyper (CI renderer på Linux), så sha sammenlignes ikke.
  assert.equal(restored.contentFingerprint, original.contentFingerprint);
  assert.equal(restored.contentRevision, original.contentRevision);
});

test('ugeoverblik og enkeltopslag uden varianter kan også skifte billede', async () => {
  const { root, drafts } = await sandbox();
  const weekly = drafts.find((draft) => draft.draftId === '2026-10-12_weekly-overview_r9');
  const result = await changeDraftImage({
    repoRoot: root, drafts, draftId: weekly.draftId, contentRevision: weekly.contentRevision,
    assetId: 'soma-sauna-01', now: NOW,
  });
  assert.equal(result.outcome, 'changed');
  assert.equal(result.drafts.find((draft) => draft.draftId === weekly.draftId).assetId, 'soma-sauna-01');
});

test('afviser forældet revision, afsluttede kladder, ukendt billede og uændret valg uden at skrive filer', async () => {
  const { root, drafts } = await sandbox();
  const target = drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  const published = drafts.find((draft) => draft.status === 'published');
  const call = (extra) => changeDraftImage({
    repoRoot: root, drafts, draftId: target.draftId, contentRevision: target.contentRevision,
    assetId: 'soma-calm-sunlight', now: NOW, ...extra,
  });
  assert.equal((await call({ contentRevision: 'f'.repeat(64) })).outcome, 'stale_revision');
  assert.equal((await call({ draftId: 'findes-ikke' })).outcome, 'unknown_draft');
  assert.equal((await call({ draftId: published.draftId, contentRevision: published.contentRevision })).outcome, 'terminal');
  assert.equal((await call({ assetId: 'ikke-registreret' })).outcome, 'unknown_asset');
  assert.equal((await call({ assetId: target.assetId })).outcome, 'unchanged');
  assert.equal((await call({ now: new Date('2027-01-01T00:00:00Z') })).outcome, 'terminal');
  await assert.rejects(fs.access(path.join(root, 'renders')));
});

test('uden Playwright-browser stopper billedskiftet uden at ændre noget', async () => {
  const { root, drafts } = await sandbox();
  const target = drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  const result = await changeDraftImage({
    repoRoot: root, drafts, draftId: target.draftId, contentRevision: target.contentRevision,
    assetId: 'soma-outdoor-sunday', now: NOW, launchBrowser: async () => { throw new Error('mangler'); },
  });
  assert.equal(result.outcome, 'render_unavailable');
  assert.equal(result.drafts, drafts);
});

test('galleriet viser kun godkendte billeder med fil, og billedfil slås op via id', async () => {
  const { root, drafts } = await sandbox();
  const list = await listSelectableAssets({ repoRoot: root, draft: drafts[0] });
  const ids = list.map((item) => item.assetId);
  for (const id of ['soma-calm-sunlight', 'soma-outdoor-sunday', 'soma-power-steam', 'soma-sauna-01', 'soma-winter-night']) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.ok((await assetFileFor({ repoRoot: root, assetId: 'soma-sauna-01' })).endsWith('soma-sauna-01.jpg'));
  assert.equal(await assetFileFor({ repoRoot: root, assetId: '../../etc/passwd' }), null);
});

test('afviser et billede, som søskendeopslaget om samme event allerede bruger, og skjuler det i galleriet', async () => {
  const { root, drafts } = await sandbox();
  const sibling = drafts.find((draft) => draft.draftId === '2026-10-06_18-30_saunagus_day-before_r7');
  const target = drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  assert.equal(sibling.eventKey, target.eventKey);
  const result = await changeDraftImage({
    repoRoot: root, drafts, draftId: target.draftId, contentRevision: target.contentRevision,
    assetId: 'soma-calm-sunlight', now: NOW,
  });
  // søskendets millemaja-variant bruger calm-sunlight
  assert.equal(result.outcome, 'duplicate_asset');
  const list = await listSelectableAssets({ repoRoot: root, draft: target, drafts });
  assert.ok(!list.some((item) => ['soma-power-steam', 'soma-calm-sunlight'].includes(item.assetId)));
  await assert.rejects(fs.access(path.join(root, 'renders')));
});

test('gusmester-valg gemmes for hele eventet (begge opslag og ugeoverblik) og nulstiller godkendelsen', async () => {
  const { root, drafts } = await sandbox();
  const target = drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  const result = await chooseInstructor({
    repoRoot: root, drafts, draftId: target.draftId, contentRevision: target.contentRevision, optionKey: 'millemaja', now: NOW,
  });
  assert.equal(result.outcome, 'changed');
  const byId = (id) => result.drafts.find((draft) => draft.draftId === id);
  for (const id of [WITH_VARIANTS, '2026-10-06_18-30_saunagus_day-before_r7']) {
    const draft = byId(id);
    assert.equal(draft.manualInstructor, 'MilleMaja');
    assert.equal(draft.event.instructor, 'MilleMaja');
    assert.equal(draft.status, 'draft');
    assert.equal(draft.approvedRevision, null);
    assert.match(draft.platformCopies.instagram, /MilleMaja/);
    assert.notEqual(draft.contentRevision, drafts.find((item) => item.draftId === id).contentRevision);
    assert.equal(draft.manualAssetId, draft.assetId);
  }
  // de to opslag om samme event får aldrig samme billede, selv når ældre data havde ens billeder
  assert.notEqual(byId(WITH_VARIANTS).assetId, byId('2026-10-06_18-30_saunagus_day-before_r7').assetId);
  const weekly = byId('2026-10-05_weekly-overview_r6');
  assert.ok(weekly.events.some((event) => event.eventKey === target.eventKey && event.instructor === 'MilleMaja'));
  assert.match(weekly.platformCopies.instagram, /MilleMaja/);
  // ugeoverblikkets rolige formulering bevares efter et gusmester-valg
  assert.match(weekly.platformCopies.facebookPage, /plads til ro/i);
  assert.doesNotMatch(JSON.stringify(weekly.platformCopies), /egen energi|energien vokse/i);
  assert.deepEqual(result.changedIds.sort(), [WITH_VARIANTS, '2026-10-05_weekly-overview_r6', '2026-10-06_18-30_saunagus_day-before_r7'].sort());
  // andre events er urørte
  assert.deepEqual(byId('2026-10-08_18-30_saunagus_event-day_r7'), drafts.find((item) => item.draftId === '2026-10-08_18-30_saunagus_event-day_r7'));
  for (const file of result.files) await fs.access(path.join(root, file));
});

test('gusmester-valg afvises ved ukendt valg, forældet revision og samme gusmester', async () => {
  const { root, drafts } = await sandbox();
  const target = drafts.find((draft) => draft.draftId === WITH_VARIANTS);
  const call = (extra) => chooseInstructor({
    repoRoot: root, drafts, draftId: target.draftId, contentRevision: target.contentRevision, optionKey: 'soren', now: NOW, ...extra,
  });
  assert.equal((await call({ optionKey: 'ukendt' })).outcome, 'unknown_option');
  assert.equal((await call({ contentRevision: 'f'.repeat(64) })).outcome, 'stale_revision');
  assert.equal((await call({})).outcome, 'unchanged');
  assert.equal((await call({ draftId: 'findes-ikke' })).outcome, 'unknown_draft');
  assert.equal((await call({ launchBrowser: async () => { throw new Error('x'); }, optionKey: 'millemaja' })).outcome, 'render_unavailable');
  await assert.rejects(fs.access(path.join(root, 'renders')));
});

test('efter et gusmester-valg giver næste planlægningskørsel samme opslag, revision og billede', async () => {
  const { root } = await sandbox();
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soma-instr-'));
  const fixturePath = path.join(__dirname, 'fixtures', 'calendar-week-42-details.html');
  const pipelineNow = new Date('2026-09-29T10:00:00Z');
  await runPipeline({ fixturePath, outputDir, now: pipelineNow });
  const draftsPath = path.join(outputDir, 'drafts.json');
  const drafts = JSON.parse(await fs.readFile(draftsPath, 'utf8'));
  const target = drafts.find((draft) => draft.status !== 'obsolete' && draft.instructorOptions && draft.slotKey.endsWith('_day-before'));
  assert.ok(target, 'fixture mangler et opslag uden gusmester');
  const result = await chooseInstructor({
    repoRoot: root, drafts, draftId: target.draftId, contentRevision: target.contentRevision,
    optionKey: 'soren', now: pipelineNow,
  });
  assert.equal(result.outcome, 'changed');
  await fs.writeFile(draftsPath, JSON.stringify(result.drafts), 'utf8');

  await runPipeline({ fixturePath, outputDir, now: pipelineNow });
  const after = JSON.parse(await fs.readFile(draftsPath, 'utf8')).filter((draft) => draft.status !== 'obsolete');
  for (const id of result.changedIds) {
    const expected = result.drafts.find((draft) => draft.draftId === id);
    const actual = after.find((draft) => draft.slotKey === expected.slotKey);
    assert.equal(actual.draftId, expected.draftId, `ny revision af ${id}`);
    assert.equal(actual.contentRevision, expected.contentRevision, id);
    assert.equal(actual.contentFingerprint, expected.contentFingerprint, id);
    assert.equal(actual.assetId, expected.assetId, id);
    assert.equal(actual.manualInstructor, expected.manualInstructor, id);
    assert.equal(actual.status, expected.status, id);
  }
});
