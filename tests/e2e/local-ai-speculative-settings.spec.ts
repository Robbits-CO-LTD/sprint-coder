import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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

test('shows draft-only models and refuses to enable DFlash on an unsupported bundled runtime', async ({}, testInfo) => {
  const userDataDir = createUserDataDir('dflash-settings');
  let app = await launchApp(userDataDir);
  try {
    await firstWindow(app);
    await closeApp(app);
    // Seed only synthetic installed rows while the isolated app is stopped. No model is run.
    execFileSync(
      resolveDevElectronBinary(),
      [
        '-e',
        `
      const Database = require(process.argv[1]);
      const db = new Database(process.argv[2]);
      const insert = db.prepare("INSERT INTO local_models(id, source, source_id, immutable_revision, quantization, artifact_count, total_bytes, state, created_at, updated_at, purpose, base_model_id) VALUES (?, 'hugging_face', ?, ?, 'Q8_0', 1, 1024, 'installed', ?, ?, ?, 'fixture/base')");
      const now = new Date().toISOString();
      insert.run('a'.repeat(64), 'fixture/target', 'c'.repeat(40), now, now, 'normal');
      insert.run('b'.repeat(64), 'fixture/draft', 'c'.repeat(40), now, now, 'draft-dflash');
      db.close();
    `,
        join(REPO_ROOT, 'node_modules', 'better-sqlite3'),
        join(userDataDir, 'sprint-coder.sqlite3'),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    app = await launchApp(userDataDir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-settings-button').click();
    await page.getByTestId('settings-nav-models').click();
    const draft = page.getByText('fixture/draft', { exact: true }).locator('xpath=ancestor::li');
    await expect(draft).toContainText('下書き専用');
    await expect(draft.getByRole('button', { name: '動作確認', exact: true })).toBeDisabled();
    await expect(draft.getByText('Managed Localの起動設定', { exact: true })).toHaveCount(0);
    const target = page.getByTestId(`local-ai-launch-${'a'.repeat(64)}`);
    await target.getByText('投機的デコード（DFlash2）', { exact: true }).click();
    await expect(target.getByRole('combobox', { name: '方式', exact: true })).toHaveValue('off');
    await expect(target.locator('option[value="draft-dflash"]')).toHaveJSProperty('disabled', true);
    await expect(target).toContainText('同梱RuntimeはDFlash2に対応していません。');
    await target.getByRole('button', { name: '投機的デコード設定を保存' }).scrollIntoViewIfNeeded();
    const screenshot = testInfo.outputPath('dflash-settings.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('DFlash settings unsupported boundary', {
      path: screenshot,
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 900, height: 800 });
    const form = target.getByRole('region', { name: '投機的デコード設定' });
    await expect(form).toBeVisible();
    expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    const narrow = testInfo.outputPath('dflash-settings-narrow.png');
    await form.screenshot({ path: narrow });
    await testInfo.attach('DFlash settings narrow layout', {
      path: narrow,
      contentType: 'image/png',
    });
    await target.getByRole('button', { name: '下書きモデルを探す' }).click();
    await expect(page.getByPlaceholder('モデルを検索')).toHaveValue('DFlash2');
  } finally {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  }
});
