// Opt-in, real HF downloads. Run only in the assigned Windows interactive lane.
// No model rows, responses, or downloads are mocked or seeded by this runner.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const lane = resolve(process.argv[2]);
const dependencies = createRequire(join(resolve(process.argv[3]), 'package.json'));
const { _electron: electron, expect } = dependencies('@playwright/test');
const { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } =
  dependencies('@electron/fuses');
const executable = join(lane, 'app', 'Sprint Coder.exe');
const profile = join(lane, 'profile');
const report = { acceptance: 'PARTIAL', signedAcceptance: 'NOT_RUN', steps: [] };
const evidencePath = join(lane, `download-evidence-${Date.now()}.json`);
const models = [
  {
    sourceId: 'incoai/Qwen3.8-27B-DFlash2-GGUF',
    quantization: 'Q4_K_M',
    revision: '51962825493a48b846b40126d35c799ac4093ad0',
    size: 1143006816,
    sha256: '1a25c56858e1ebe93f2718ac1d49d1151f9323325c1bbfd6209370f4db131ebd',
  },
  {
    sourceId: 'unsloth/Qwen3.8-27B-GGUF',
    quantization: 'Q4_K_M',
    revision: '4ca720788d1e01f1bff70c033e0d0028fd02e502',
    size: 16464440224,
    sha256: '322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482',
  },
];
let app;
let step = 'preflight';
function record(name, data = {}) {
  report.steps.push({ name, at: new Date().toISOString(), ...data });
  writeFileSync(evidencePath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ step: name, ...data }));
}
async function run() {
  assert.equal(process.platform, 'win32');
  const session = Number(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).SessionId`],
      { encoding: 'utf8' },
    ).trim(),
  );
  assert.ok(session > 0, 'Interactive desktop session required');
  mkdirSync(profile, { recursive: true });
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const beforeHash = hash(executable);
  const fuses = await getCurrentFuseWire(executable);
  if (fuses[FuseV1Options.EnableNodeCliInspectArguments] === 48) {
    await flipFuses(executable, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableNodeCliInspectArguments]: true,
    });
  }
  const afterFuses = await getCurrentFuseWire(executable);
  record('disposable-inspector-copy', {
    beforeSha256: beforeHash,
    afterSha256: hash(executable),
    asarSha256: hash(join(lane, 'app', 'resources', 'app.asar')),
    beforeFuses: fuses,
    afterFuses,
  });
  record('preflight', { session, artifact: 'v0.7.0-beta.3 unsigned disposable inspector copy' });
  app = await electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      SPRINT_CODER_USER_DATA_DIR: profile,
      SPRINT_CODER_SKILL_HOME: profile,
      SPRINT_CODER_RUNTIME_ADOPT: '0',
      SPRINT_CODER_E2E_BACKGROUND: '1',
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForLoadState('domcontentloaded');
  if (await page.getByTestId('setup-wizard').count()) {
    await page.evaluate(() => localStorage.setItem('sprint-coder:setup-complete-v1', '1'));
    await page.reload();
  }
  await page.getByTestId('sidebar-settings-button').click();
  await page.getByTestId('settings-nav-local-ai').click();
  record(
    'settings-visible',
    await app.evaluate(({ app, BrowserWindow }) => ({
      version: app.getVersion(),
      windowCount: BrowserWindow.getAllWindows().length,
      focused: BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    })),
  );
  for (const model of models) {
    step = `catalog:${model.sourceId}`;
    const existing = await page.evaluate(
      async (id) =>
        (await window.sprintCoder.localAI.listInstalled()).find(
          (m) => m.sourceId === id && m.state === 'installed',
        ),
      model.sourceId,
    );
    if (existing) {
      assert.equal(existing.immutableRevision, model.revision);
      assert.equal(existing.totalBytes, model.size);
      record('existing-owned-model', { sourceId: model.sourceId, modelId: existing.id });
      continue;
    }
    await page.getByRole('button', { name: 'モデルを探す', exact: true }).click();
    step = 'search-input';
    await page.getByRole('textbox', { name: 'モデル名', exact: true }).fill(model.sourceId);
    await page.getByRole('combobox', { name: '取得元', exact: true }).selectOption('hugging_face');
    await page.getByRole('combobox', { name: '用途', exact: true }).selectOption('all');
    await page.getByRole('button', { name: '検索', exact: true }).click();
    step = 'search-result-selection';
    record('search-submitted', { sourceId: model.sourceId });
    await page
      .getByRole('option')
      .filter({ hasText: model.sourceId.split('/')[1] })
      .filter({ hasText: model.sourceId.split('/')[0] })
      .first()
      .click();
    step = 'immutable-revision';
    record('catalog-row-selected');
    await expect(page.locator('.local-ai-revision')).toHaveText(model.revision);
    step = 'quantization';
    await page.getByRole('radio', { name: new RegExp(`^${model.quantization} `) }).check();
    step = 'install-confirmation';
    await page.getByRole('button', { name: 'このGGUFを導入', exact: true }).click();
    await page.getByRole('checkbox', { name: /ライセンス/ }).check();
    await page.getByRole('button', { name: 'ダウンロード開始', exact: true }).click();
    await page.getByRole('button', { name: 'モデル管理に戻る', exact: true }).click();
    record('download-started-through-ui', { sourceId: model.sourceId, expectedBytes: model.size });
    step = `download:${model.sourceId}`;
    const deadline = Date.now() + 90 * 60_000;
    let lastBytes = -1;
    while (Date.now() < deadline) {
      const state = await page.evaluate(
        async (sourceId) => ({
          installed: (await window.sprintCoder.localAI.listInstalled()).find(
            (m) => m.sourceId === sourceId && m.state === 'installed',
          ),
          jobs: (await window.sprintCoder.localAI.listJobs())
            .filter((j) => j.sourceId === sourceId)
            .map((j) => ({
              state: j.state,
              downloadedBytes: j.downloadedBytes,
              totalBytes: j.totalBytes,
            })),
        }),
        model.sourceId,
      );
      if (state.installed) {
        assert.equal(state.installed.totalBytes, model.size);
        assert.equal(state.installed.immutableRevision, model.revision);
        assert.equal(
          state.installed.purpose,
          model.sourceId.startsWith('incoai/') ? 'draft-dflash' : 'normal',
        );
        record('installed-via-product-integrity-check', {
          sourceId: model.sourceId,
          modelId: state.installed.id,
          purpose: state.installed.purpose,
          bytes: model.size,
        });
        break;
      }
      assert.ok(
        !state.jobs.some((j) => ['failed', 'canceled', 'interrupted'].includes(j.state)),
        'Download interrupted or rejected',
      );
      const bytes = Math.max(0, ...state.jobs.map((j) => j.downloadedBytes));
      if (bytes !== lastBytes) {
        record('download-progress', { sourceId: model.sourceId, bytes });
        lastBytes = bytes;
      }
      await page.waitForTimeout(10_000);
    }
    const installed = await page.evaluate(
      async (sourceId) =>
        (await window.sprintCoder.localAI.listInstalled()).some(
          (m) => m.sourceId === sourceId && m.state === 'installed',
        ),
      model.sourceId,
    );
    assert.ok(installed, 'Real download deadline exceeded');
  }
  step = 'classification';
  const draftRow = page
    .getByText(models[0].sourceId, { exact: true })
    .locator('xpath=ancestor::li');
  await expect(draftRow).toContainText('下書き専用');
  await expect(draftRow.getByRole('button', { name: '動作確認', exact: true })).toBeDisabled();
  record('draft-only-ui', { status: 'PASS' });
  report.downloadAcceptance = 'PASS';
}
run()
  .catch((error) => {
    process.exitCode = 1;
    record('failed', { atStep: step, errorType: error?.name ?? 'Error' });
  })
  .finally(async () => {
    if (app) {
      const pid = app.process().pid;
      await app.close();
      record('owned-app-closed', { pid });
    }
    writeFileSync(evidencePath, JSON.stringify(report, null, 2));
  });
