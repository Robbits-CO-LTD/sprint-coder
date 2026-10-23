import { test, expect } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeApp,
  createUserDataDir,
  firstWindow,
  launchApp,
  removeUserDataDir,
  resolveDevElectronBinary,
  REPO_ROOT,
} from './helpers';

const retiredSelection = {
  connectionId: 'managed-local:runtime',
  requestedProvider: 'sprint-managed-local',
  requestedModel: 'a'.repeat(64),
};
const retirementMessage =
  '内蔵ローカルAI機能は廃止されました。モデルと接続から別のProviderを選択してください。';

function legacyDatabase(userDataDir: string, taskId: string, seed: boolean): unknown {
  const output = execFileSync(
    resolveDevElectronBinary(),
    [
      '-e',
      `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2], { readonly: process.argv[4] !== 'seed' });
      const taskId = process.argv[3];
      const modelId = 'a'.repeat(64);
      if (process.argv[4] === 'seed') {
        const stamp = '2026-10-23T00:00:00.000Z';
        db.prepare("INSERT INTO provider_connections(id, provider_id, runtime_kind, display_name, enabled, secret_reference, verification_status, rate_limit_mode, created_at, updated_at) VALUES ('managed-local:runtime', 'sprint-managed-local', 'openai_compatible', 'Managed Local', 1, NULL, 'not_required', 'bypass', ?, ?)").run(stamp, stamp);
        db.prepare("UPDATE tasks SET connection_id = 'managed-local:runtime', requested_provider = 'sprint-managed-local', requested_model = ? WHERE id = ?").run(modelId, taskId);
        db.prepare("UPDATE turns SET connection_id = 'managed-local:runtime', requested_provider = 'sprint-managed-local', requested_model = ? WHERE task_id = ?").run(modelId, taskId);
        for (const [id, state, jobState] of [[modelId, 'installed', 'installed'], ['b'.repeat(64), 'installing', 'verifying']]) {
          db.prepare("INSERT INTO local_models(id, source, source_id, immutable_revision, quantization, artifact_count, total_bytes, state, created_at, updated_at, purpose, base_model_id) VALUES (?, 'hugging_face', 'fixture/saved', ?, 'Q4_K_M', 1, 32, ?, ?, ?, 'normal', 'fixture/base')").run(id, 'c'.repeat(40), state, stamp, stamp);
          db.prepare("INSERT INTO local_model_artifacts(model_id, ordinal, filename, sha256, byte_length, downloaded_bytes, state, role) VALUES (?, 1, 'fixture.gguf', ?, 32, 32, ?, 'model')").run(id, 'd'.repeat(64), state === 'installed' ? 'installed' : 'downloaded');
          db.prepare("INSERT INTO local_model_download_jobs(id, model_id, state, downloaded_bytes, created_at, updated_at) VALUES (?, ?, ?, 32, ?, ?)").run('job-' + id, id, jobState, stamp, stamp);
        }
        db.prepare("INSERT INTO local_model_verifications(model_id, level, verified_at, binding_json) VALUES (?, 'loaded', ?, '{}')").run(modelId, stamp);
        for (const name of ['launch-settings', 'inference-settings', 'speculative-settings'])
          db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)').run('managed-local.' + name, JSON.stringify({ [modelId]: { saved: true } }), stamp);
      }
      const result = {
        selection: db.prepare('SELECT connection_id, requested_provider, requested_model FROM tasks WHERE id = ?').get(taskId),
        turns: db.prepare('SELECT id, connection_id, requested_provider, requested_model FROM turns WHERE task_id = ? ORDER BY id').all(taskId),
        connections: db.prepare("SELECT * FROM provider_connections WHERE id = 'managed-local:runtime'").all(),
        models: db.prepare('SELECT * FROM local_models ORDER BY id').all(),
        artifacts: db.prepare('SELECT * FROM local_model_artifacts ORDER BY model_id, ordinal').all(),
        jobs: db.prepare('SELECT * FROM local_model_download_jobs ORDER BY id').all(),
        verifications: db.prepare('SELECT * FROM local_model_verifications ORDER BY model_id').all(),
        settings: db.prepare("SELECT * FROM settings WHERE key LIKE 'managed-local.%' ORDER BY key").all(),
        migrations: db.prepare('SELECT * FROM schema_migrations WHERE version IN (75,76,77,83) ORDER BY version').all(),
      };
      db.close();
      process.stdout.write(JSON.stringify(result));
      `,
      join(REPO_ROOT, 'node_modules', 'better-sqlite3'),
      join(userDataDir, 'sprint-coder.sqlite3'),
      taskId,
      seed ? 'seed' : 'read',
    ],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
  );
  return JSON.parse(output) as unknown;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires fixture destructuring to access testInfo.
test('preserves retired local models and history while refusing execution without provider fallback', async ({}, testInfo) => {
  const userDataDir = createUserDataDir('retired-local-models');
  let app: ElectronApplication | null = await launchApp(userDataDir);
  try {
    let page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    const historyText = '旧モデル設定の履歴保持を確認するためのモック会話';
    await page.getByTestId('composer-textarea').fill(historyText);
    await page.getByTestId('composer-textarea').press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText('決定論的なモック応答です');
    const taskId = await page.evaluate(async () => (await window.sprintCoder!.tasks.list())[0]!.id);
    const previousMessages = await page.evaluate(
      async (id) => window.sprintCoder!.tasks.messages(id),
      taskId,
    );
    await closeApp(app);
    app = null;

    // Seed only the stopped, isolated fixture profile. No model is installed or executed.
    const modelRoot = join(userDataDir, 'local-models');
    const installedRoot = join(modelRoot, 'models', retiredSelection.requestedModel);
    const partialRoot = join(modelRoot, 'partials');
    mkdirSync(installedRoot, { recursive: true });
    mkdirSync(partialRoot, { recursive: true });
    const installedPath = join(installedRoot, '001.gguf');
    const partialPath = join(partialRoot, `${'b'.repeat(64)}-001.partial`);
    const installedBytes = Buffer.alloc(32, 0x41);
    const partialBytes = Buffer.alloc(32, 0x42);
    writeFileSync(installedPath, installedBytes);
    writeFileSync(partialPath, partialBytes);
    const before = legacyDatabase(userDataDir, taskId, true);

    app = await launchApp(userDataDir);
    page = await firstWindow(app);
    await expect(page.getByTestId('user-message')).toHaveText(historyText);
    expect(await page.evaluate(() => 'localAI' in window.sprintCoder!)).toBe(false);
    expect(
      await page.evaluate(async (id) => window.sprintCoder!.tasks.messages(id), taskId),
    ).toEqual(previousMessages);
    const selection = async () =>
      page.evaluate(
        async (id) =>
          await window.sprintCoder!.models.query({
            taskId: id,
            text: '',
            connectionIds: [],
            providerIds: [],
            accessTypes: [],
            capabilities: [],
            availableOnly: true,
            cursor: null,
            limit: 50,
          }),
        taskId,
      );
    const catalog = await selection();
    expect(catalog.selection).toEqual(retiredSelection);
    expect(
      catalog.items.some(({ connectionId }) => connectionId === retiredSelection.connectionId),
    ).toBe(false);
    expect(legacyDatabase(userDataDir, taskId, false)).toEqual(before);
    expect(readFileSync(installedPath)).toEqual(installedBytes);
    expect(readFileSync(partialPath)).toEqual(partialBytes);

    await page.getByTestId('composer-textarea').fill('廃止されたモデルへ送信しないでください');
    await page.getByTestId('composer-send-button').click();
    await expect(page.getByRole('alert').filter({ hasText: retirementMessage })).toBeVisible();
    expect((await selection()).selection).toEqual(retiredSelection);
    expect(
      await page.evaluate(async (id) => window.sprintCoder!.turns.snapshot(id), taskId),
    ).toMatchObject({ activeTurn: null, queued: [] });
    // A fallback to the fixture mock would persist a new Turn/message; neither may be created.
    expect(
      await page.evaluate(async (id) => window.sprintCoder!.tasks.messages(id), taskId),
    ).toEqual(previousMessages);
    expect(legacyDatabase(userDataDir, taskId, false)).toEqual(before);
    expect(readFileSync(installedPath)).toEqual(installedBytes);
    expect(readFileSync(partialPath)).toEqual(partialBytes);
    const screenshot = testInfo.outputPath('retired-local-model-rejected.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Saved local model requires an explicit provider change', {
      path: screenshot,
      contentType: 'image/png',
    });
  } finally {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  }
});
