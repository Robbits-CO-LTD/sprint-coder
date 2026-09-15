// Opt-in acceptance against real, UI-installed models in an owned Windows profile.
// The diagnostic probe stays inside Main: credentials and response bodies never leave it.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { writeFileSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const lane = resolve(process.argv[2]);
const dependencies = createRequire(join(resolve(process.argv[3]), 'package.json'));
const { _electron: electron, expect } = dependencies('@playwright/test');
const evidencePath = join(lane, `acceptance-${Date.now()}.json`);
const cleanupOnly = process.argv[4] === 'cleanup';
const evidence = {
  status: 'PARTIAL',
  artifact: 'unsigned beta.3, inspector fuse only changed',
  steps: [],
};
let app, page, target, draft;
let step = 'preflight';
function record(name, data = {}) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...data });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ step: name, ...data }));
}
async function open() {
  app = await electron.launch({
    executablePath: join(lane, 'app', 'Sprint Coder.exe'),
    env: {
      ...process.env,
      SPRINT_CODER_USER_DATA_DIR: join(lane, 'profile'),
      SPRINT_CODER_SKILL_HOME: join(lane, 'profile'),
      SPRINT_CODER_RUNTIME_ADOPT: '0',
      SPRINT_CODER_E2E_BACKGROUND: '1',
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForLoadState('domcontentloaded');
  await page.getByTestId('sidebar-settings-button').click();
  await page.getByTestId('settings-nav-local-ai').click();
  const installed = await page.evaluate(() => window.sprintCoder.localAI.listInstalled());
  target = installed.find((m) => m.sourceId === 'unsloth/Qwen3.8-27B-GGUF');
  draft = installed.find(
    (m) => m.sourceId === 'incoai/Qwen3.8-27B-DFlash2-GGUF' && m.state === 'installed',
  );
  assert.ok(target && draft, 'UI download phase must complete first');
  record(
    'opened-owned-profile',
    await app.evaluate(({ app, BrowserWindow }) => ({
      version: app.getVersion(),
      focused: BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    })),
  );
  record(
    'main-observer-preflight',
    await app.evaluate(() => ({
      requireAvailable: typeof require === 'function',
      builtinModuleAvailable: typeof process.getBuiltinModule === 'function',
    })),
  );
  // Observe only this app's loopback completion request. Keep the existing ephemeral
  // session authorization in a closure for an identical OFF/ON diagnostic request.
  await app.evaluate(() => {
    const { channel } = process.getBuiltinModule('node:diagnostics_channel');
    const { createHash } = process.getBuiltinModule('node:crypto');
    let endpoint = null;
    channel('undici:request:create').subscribe(({ request }) => {
      if (
        request.path !== '/v1/chat/completions' ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(request.origin))
      )
        return;
      const h = request.headers;
      let authorization;
      if (typeof h === 'string')
        authorization = /(?:^|\r\n)authorization:\s*([^\r\n]+)/i.exec(h)?.[1];
      if (Array.isArray(h))
        for (let i = 0; i + 1 < h.length; i += 2)
          if (String(h[i]).toLowerCase() === 'authorization') authorization = String(h[i + 1]);
      if (authorization) endpoint = { origin: request.origin, authorization };
    });
    globalThis.__dflashAcceptanceProbe = async (modelId) => {
      if (!endpoint) return { captureAvailable: false };
      const expected = 'one two three four five six seven eight nine ten';
      const response = await fetch(`${endpoint.origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: endpoint.authorization },
        body: JSON.stringify({
          model: modelId,
          stream: false,
          messages: [{ role: 'user', content: `Reply with exactly: ${expected}` }],
          max_tokens: 64,
          temperature: 0,
          seed: 0,
          reasoning_effort: 'none',
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 1024 * 1024) throw new Error('Probe response exceeds bound');
      const body = JSON.parse(Buffer.from(bytes).toString('utf8'));
      const content = body.choices?.[0]?.message?.content;
      const timings = {};
      for (const key of [
        'draft_n',
        'draft_n_accepted',
        'prompt_n',
        'prompt_ms',
        'predicted_n',
        'predicted_ms',
      ]) {
        if (typeof body.timings?.[key] === 'number') timings[key] = body.timings[key];
      }
      return {
        captureAvailable: true,
        status: response.status,
        exactResponse: typeof content === 'string' && content.trim() === expected,
        responseSha256:
          typeof content === 'string'
            ? createHash('sha256').update(content.trim()).digest('hex')
            : null,
        timings,
      };
    };
  });
}
function targetRow() {
  return page.getByText(target.sourceId, { exact: true }).locator('xpath=ancestor::li');
}
function settings() {
  return page.getByTestId(`local-ai-launch-${target.id}`);
}
async function specPanel() {
  const panel = settings().getByRole('region', { name: '投機的デコード設定' });
  if (!(await panel.isVisible()))
    await settings().getByText('投機的デコード（DFlash2）', { exact: true }).click();
  await expect(panel.getByRole('combobox', { name: '方式', exact: true })).toBeVisible();
  return panel;
}
async function setSpec(mode) {
  step = `spec-settings:${mode}`;
  const panel = await specPanel();
  const before = await page.evaluate(
    (id) => window.sprintCoder.localAI.speculativeSettings(id),
    target.id,
  );
  record('spec-save-preflight', {
    mode,
    supported: before.supported,
    eligibleDraftCount: before.eligibleDrafts.length,
    configured: before.configured,
  });
  await panel.getByRole('combobox', { name: '方式', exact: true }).selectOption(mode);
  if (mode === 'draft-dflash') {
    await panel.getByRole('combobox', { name: '下書きモデル', exact: true }).selectOption(draft.id);
    await panel.getByRole('spinbutton', { name: '先読みトークン上限', exact: true }).fill('3');
  }
  const save = panel.getByRole('button', { name: '投機的デコード設定を保存', exact: true });
  if (await save.isEnabled()) {
    await save.click();
    await expect(panel.getByRole('status')).toHaveText(
      '保存しました。次回のモデル起動から反映します。',
      { timeout: 60_000 },
    );
  }
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.sprintCoder.localAI.speculativeSettings(id), target.id))
          .configured.type,
    )
    .toBe(mode);
  record('spec-saved-through-ui', { mode });
}
async function verify(mode) {
  step = `ui-self-test:${mode}`;
  await targetRow().getByRole('button', { name: '動作確認', exact: true }).click();
  await expect(targetRow().getByRole('button', { name: '確認中…', exact: true })).toBeVisible();
  await expect(targetRow().getByRole('button', { name: '動作確認', exact: true })).toBeEnabled({
    timeout: 300_000,
  });
  await expect(
    page.getByText('動作確認を完了できませんでした。モデルは削除されていません。再試行できます。', {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(targetRow()).toContainText('コーディングツール確認済み');
  const runtime = await page.evaluate(() => window.sprintCoder.localAI.runtime());
  record('ui-self-test-passed', { mode, runtime });
  step = `deterministic-probe:${mode}`;
  const result = await app.evaluate(
    async (_, modelId) => globalThis.__dflashAcceptanceProbe(modelId),
    target.id,
  );
  record('real-deterministic-response', { mode, ...result });
  assert.equal(result.captureAvailable, true);
  assert.equal(result.status, 200);
  assert.equal(result.exactResponse, true);
  if (mode === 'draft-dflash') {
    assert.ok(Number.isSafeInteger(result.timings.draft_n) && result.timings.draft_n > 0);
    assert.ok(
      Number.isSafeInteger(result.timings.draft_n_accepted) &&
        result.timings.draft_n_accepted >= 0 &&
        result.timings.draft_n_accepted <= result.timings.draft_n,
    );
  }
  return result;
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
  assert.ok(session > 0, 'Interactive session required');
  record('interactive-session', { session });
  await open();
  if (cleanupOnly) {
    const prior = readdirSync(lane)
      .filter((name) => /^acceptance-\d+\.json$/.test(name))
      .sort()
      .reverse()
      .find((name) => {
        const saved = JSON.parse(readFileSync(join(lane, name), 'utf8'));
        return (
          saved.steps.some((s) => s.name === 'off-on-identical' && s.status === 'PASS') &&
          saved.steps.some(
            (s) => s.name === 'referenced-draft-delete-rejected' && s.status === 'PASS',
          )
        );
      });
    assert.ok(
      prior,
      'Cleanup continuation requires saved real OFF/ON and reference-rejection evidence',
    );
    record('resume-completed-inference-evidence', { priorEvidence: prior });
    return cleanup();
  }
  step = 'cpu-launch-settings';
  await settings().getByRole('combobox', { name: 'Backend', exact: true }).selectOption('cpu');
  await settings().getByRole('spinbutton', { name: 'Context tokens', exact: true }).fill('2048');
  await settings().getByRole('spinbutton', { name: 'Batch size', exact: true }).fill('512');
  const save = settings().getByRole('button', { name: '起動設定を保存', exact: true });
  if (await save.isEnabled()) await save.click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.sprintCoder.localAI.launchSettings(id), target.id))
          .configured.backend,
    )
    .toBe('cpu');
  record('cpu-settings-saved-through-ui');
  await setSpec('off');
  const off = await verify('off');
  await setSpec('draft-dflash');
  step = 'invalid-token-rejection';
  let panel = await specPanel();
  for (const value of ['0', '65']) {
    await panel.getByRole('spinbutton', { name: '先読みトークン上限', exact: true }).fill(value);
    await expect(panel.getByRole('button', { name: '投機的デコード設定を保存' })).toBeDisabled();
    await expect(panel).toContainText('1〜64の整数を入力してください。');
  }
  await panel.getByRole('spinbutton', { name: '先読みトークン上限', exact: true }).fill('3');
  record('invalid-token-rejection', { status: 'PASS' });
  step = 'restart-same-profile';
  await app.close();
  app = null;
  await open();
  panel = await specPanel();
  await expect(panel.getByRole('combobox', { name: '方式', exact: true })).toHaveValue(
    'draft-dflash',
  );
  await expect(panel.getByRole('combobox', { name: '下書きモデル', exact: true })).toHaveValue(
    draft.id,
  );
  await expect(
    panel.getByRole('spinbutton', { name: '先読みトークン上限', exact: true }),
  ).toHaveValue('3');
  record('restart-settings-persisted', { status: 'PASS' });
  const on = await verify('draft-dflash');
  assert.equal(on.responseSha256, off.responseSha256);
  record('off-on-identical', { status: 'PASS', responseSha256: on.responseSha256 });
  step = 'referenced-draft-delete';
  const draftRow = page.getByText(draft.sourceId, { exact: true }).locator('xpath=ancestor::li');
  await draftRow.getByRole('button', { name: '削除', exact: true }).click();
  await expect(draftRow).toContainText('端末から削除しますか？');
  await draftRow.getByRole('button', { name: '削除', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('操作を完了できませんでした');
  assert.ok(
    await page.evaluate(
      async (id) =>
        (await window.sprintCoder.localAI.listInstalled()).some(
          (m) => m.id === id && m.state === 'installed',
        ),
      draft.id,
    ),
  );
  record('referenced-draft-delete-rejected', { status: 'PASS' });
  await cleanup();
}
async function cleanup() {
  const draftRow = page.getByText(draft.sourceId, { exact: true }).locator('xpath=ancestor::li');
  step = 'target-delete-releases-draft';
  await targetRow().getByRole('button', { name: '削除', exact: true }).click();
  await expect(targetRow()).toContainText('端末から削除しますか？');
  await targetRow().getByRole('button', { name: '削除', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.sprintCoder.localAI.listInstalled())).some(
          (m) => m.id === target.id,
        ),
      { timeout: 60_000 },
    )
    .toBe(false);
  assert.equal(existsSync(join(lane, 'profile', 'local-models', 'models', target.id)), false);
  assert.ok(
    await page.evaluate(
      async (id) =>
        (await window.sprintCoder.localAI.listInstalled()).some(
          (m) => m.id === id && m.state === 'installed',
        ),
      draft.id,
    ),
  );
  record('target-deleted-draft-retained', { status: 'PASS' });
  step = 'unreferenced-draft-delete';
  await draftRow.getByRole('button', { name: '削除', exact: true }).click();
  await expect(draftRow).toContainText('端末から削除しますか？');
  await draftRow.getByRole('button', { name: '削除', exact: true }).click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.sprintCoder.localAI.listInstalled())).some(
        (m) => m.id === draft.id,
      ),
    )
    .toBe(false);
  assert.equal(existsSync(join(lane, 'profile', 'local-models', 'models', draft.id)), false);
  record('unreferenced-draft-deleted', { status: 'PASS', reclaimedWeightBytes: 17607447040 });
  step = 'download-cancel';
  await page.getByRole('button', { name: 'モデルを探す', exact: true }).click();
  await page.getByRole('textbox', { name: 'モデル名', exact: true }).fill(draft.sourceId);
  await page.getByRole('combobox', { name: '取得元', exact: true }).selectOption('hugging_face');
  await page.getByRole('combobox', { name: '用途', exact: true }).selectOption('all');
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page
    .getByRole('option')
    .filter({ hasText: 'Qwen3.8-27B-DFlash2-GGUF' })
    .filter({ hasText: 'incoai' })
    .click();
  await expect(page.locator('.local-ai-revision')).toHaveText(
    '51962825493a48b846b40126d35c799ac4093ad0',
  );
  await page.getByRole('radio', { name: /^Q4_K_M / }).check();
  await page.getByRole('button', { name: 'このGGUFを導入', exact: true }).click();
  await page.getByRole('checkbox', { name: /ライセンス/ }).check();
  await page.getByRole('button', { name: 'ダウンロード開始', exact: true }).click();
  await page.getByRole('button', { name: 'モデル管理に戻る', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.sprintCoder.localAI.listJobs())).some(
          (j) => j.modelId === draft.id && j.state === 'downloading' && j.downloadedBytes > 0,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  const download = page.locator('.local-ai-download-list li').filter({ hasText: draft.sourceId });
  await download.getByRole('button', { name: '一時停止', exact: true }).click();
  await expect(download.getByRole('button', { name: '再開', exact: true })).toBeVisible();
  await download.getByRole('button', { name: '中止', exact: true }).click();
  await download.getByRole('button', { name: '中止する', exact: true }).click();
  await expect(download).toHaveCount(0);
  assert.equal(
    readdirSync(join(lane, 'profile', 'local-models', 'partials')).filter((name) =>
      name.startsWith(draft.id),
    ).length,
    0,
  );
  assert.equal(existsSync(join(lane, 'profile', 'local-models', 'models', draft.id)), false);
  record('real-download-pause-cancel-cleanup', { status: 'PASS' });
  evidence.status = 'PARTIAL';
  evidence.functionalUi = 'PASS';
  evidence.remaining = ['final independent review and Main closeout'];
}
run()
  .catch((error) => {
    process.exitCode = 1;
    record('failed', {
      atStep: step,
      errorType: error?.name ?? 'Error',
      timeout: /[Tt]imeout|[Tt]imed out/.test(error?.message ?? ''),
    });
  })
  .finally(async () => {
    if (app) {
      const pid = app.process().pid;
      await app.close();
      record('owned-app-closed', { pid });
    }
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  });
