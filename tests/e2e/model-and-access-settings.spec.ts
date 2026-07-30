import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

const LEGACY_PICKER_ENV = { SPRINT_CODER_MULTI_PROVIDER_MODEL_PICKER_V2: '0' };

test.describe('runtime model and access settings', () => {
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('model-access-settings');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('selects and restores a Codex model and an Access preset', async () => {
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
    let page: Page = await firstWindow(app);
    if ((await page.getByTestId('runtime-selector').count()) === 0)
      await page.getByTestId('empty-state-create-task-button').click();

    await page.getByTestId('runtime-selector').click();
    const codexOption = page.getByTestId('runtime-option-codex');
    await expect(codexOption).toBeEnabled();
    await codexOption.click();

    await expect(page.getByTestId('model-selector')).toBeEnabled();
    await page.getByTestId('model-selector').click();
    await page.getByTestId('model-option-gpt-5.6-terra').click();
    await expect(page.getByTestId('model-selector')).toHaveText('GPT-5.6-Terra');

    await page.getByTestId('access-selector').click();
    await page.getByTestId('access-option-auto').click();
    await expect(page.getByTestId('access-selector')).toHaveText('安全時は自動');

    await closeApp(app);
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
    page = await firstWindow(app);
    await expect(page.getByTestId('runtime-selector')).toHaveText('Codex');
    await expect(page.getByTestId('model-selector')).toHaveText('GPT-5.6-Terra');
    await expect(page.getByTestId('access-selector')).toHaveText('安全時は自動');
  });
});

test.describe('claude model clarity and effort settings', () => {
  // Own describe block with its own userDataDir/app: the sibling suite above never closes its
  // `app` after its final (re-)launch, so sharing state would race two Electron instances against
  // the same userDataDir (single-instance-lock collision) — see the fix history on this file.
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('claude-model-effort-settings');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('shows clarified Claude model labels and persists a selected effort level', async () => {
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
    let page: Page = await firstWindow(app);
    if ((await page.getByTestId('runtime-selector').count()) === 0)
      await page.getByTestId('empty-state-create-task-button').click();

    await page.getByTestId('runtime-selector').click();
    const claudeOption = page.getByTestId('runtime-option-claude');
    await expect(claudeOption).toBeEnabled();
    await claudeOption.click();
    await expect(page.getByTestId('runtime-selector')).toHaveText('Claude Code');

    // Task 1: the curated Claude model list now spells out the concrete resolved model id in
    // each entry's displayName rather than a bare "Sonnet"/"Opus"/"Haiku" label.
    await expect(page.getByTestId('model-selector')).toBeEnabled();
    await page.getByTestId('model-selector').click();
    await expect(page.getByTestId('model-option-sonnet')).toContainText('Sonnet 5');
    // The top tier pins the concrete id rather than the `opus` alias, which still resolves to
    // claude-opus-4-8 on CLI 2.1.218 (issue #7) — hence the id-shaped testid here.
    await expect(page.getByTestId('model-option-claude-opus-5')).toContainText('Opus 5');
    await expect(page.getByTestId('model-option-claude-opus-5')).toContainText('claude-opus-5');
    await expect(page.getByTestId('model-option-haiku')).toContainText('Haiku 4.5');
    await expect(page.getByTestId('model-option-auto')).toContainText('claude-sonnet-5');
    await page.getByTestId('model-option-auto').click();

    // Task 2: the effort chip is a real interactive control for Claude (not the static
    // "effort: medium" placeholder), and the selection survives an app restart.
    await expect(page.getByTestId('effort-selector')).toBeEnabled();
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: Medium');
    await page.getByTestId('effort-selector').click();
    await page.getByTestId('effort-option-high').click();
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: High');

    // Task 3 (issue #8): Ultracode is the sixth level. It is reachable from the same menu, keeps
    // the menuitemradio semantics, and persists like the documented five.
    await page.getByTestId('effort-selector').click();
    const ultracode = page.getByTestId('effort-option-ultracode');
    await expect(ultracode).toHaveAttribute('role', 'menuitemradio');
    await expect(ultracode).toHaveAttribute('aria-checked', 'false');
    await ultracode.click();
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: Ultracode');

    await closeApp(app);
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
    page = await firstWindow(app);
    await expect(page.getByTestId('runtime-selector')).toHaveText('Claude Code');
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: Ultracode');

    // Keyboard-only round trip through the enlarged menu: the trigger is reachable by Tab-less
    // focus, Enter opens it, the option takes focus, Enter selects, and Escape closes.
    await page.getByTestId('effort-selector').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('effort-selector')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('effort-option-ultracode')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.getByTestId('effort-option-max').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: Max');
    await page.getByTestId('effort-selector').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('effort-selector')).toHaveAttribute('aria-expanded', 'false');

    // Switching to mock disables the effort selector (mock has no effort concept) without losing
    // the persisted preference.
    await page.getByTestId('runtime-selector').click();
    await page.getByTestId('runtime-option-mock').click();
    await expect(page.getByTestId('effort-selector')).toBeDisabled();
  });
});

test.describe('codex per-model effort settings', () => {
  // Own describe block + userDataDir for the same reason as the Claude suite above.
  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('codex-effort-settings');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  // issue #6: Codex's reasoning levels come from the selected model's own
  // `supported_reasoning_levels` in models_cache.json, not a fixed list — so what this asserts is
  // the *rule*, not a specific level set, which differs per install and per CLI version.
  test('offers the selected model own levels, and nothing at all for Auto', async () => {
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
    let page: Page = await firstWindow(app);
    if ((await page.getByTestId('runtime-selector').count()) === 0)
      await page.getByTestId('empty-state-create-task-button').click();

    await page.getByTestId('runtime-selector').click();
    const codexOption = page.getByTestId('runtime-option-codex');
    await expect(codexOption).toBeEnabled();
    await codexOption.click();
    await expect(page.getByTestId('runtime-selector')).toHaveText('Codex');

    // Auto is the default model: the CLI resolves the concrete model itself, so there is no
    // advertised level set to choose from and the chip stays disabled with that as its reason.
    await expect(page.getByTestId('model-selector')).toHaveText('Auto');
    const effortChip = page.getByTestId('effort-selector');
    await expect(effortChip).toBeDisabled();
    await expect(effortChip).toHaveAttribute('title', /Auto以外/);
    await expect(effortChip).toHaveText('effort: —');

    // Pick a concrete model; the chip becomes usable and lists exactly what that model advertises.
    await page.getByTestId('model-selector').click();
    await page.getByTestId('model-option-gpt-5.6-terra').click();
    await expect(page.getByTestId('model-selector')).toHaveText('GPT-5.6-Terra');
    await expect(effortChip).toBeEnabled();

    await effortChip.click();
    const options = page.locator('.effort-menu [role="menuitemradio"]');
    await expect(options.first()).toBeVisible();
    const offered = await options.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-testid')),
    );
    // Every level the CLI advertises for this model, and descriptions taken from the CLI itself
    // rather than invented here.
    expect(offered).toContain('effort-option-low');
    expect(offered).toContain('effort-option-high');
    expect(offered.length).toBeGreaterThanOrEqual(4);
    await expect(options.first()).not.toHaveText(/^\s*$/);

    // Selecting the highest offered level persists across a restart, under its own settings key —
    // the Claude preference set by the sibling suite lives elsewhere and is unaffected.
    const highest = offered.at(-1);
    if (highest === null || highest === undefined) throw new Error('no effort options offered');
    const highestId = highest.replace('effort-option-', '');
    await page.getByTestId(highest).click();
    await expect(effortChip).toHaveText(new RegExp(`effort: `, 'i'));
    const labelAfterPick = await effortChip.textContent();

    await closeApp(app);
    app = await launchApp(userDataDir, undefined, LEGACY_PICKER_ENV);
    page = await firstWindow(app);
    await expect(page.getByTestId('runtime-selector')).toHaveText('Codex');
    await expect(page.getByTestId('model-selector')).toHaveText('GPT-5.6-Terra');
    await expect(page.getByTestId('effort-selector')).toHaveText(labelAfterPick ?? '');

    // Switching back to Auto drops the override rather than carrying a level the CLI cannot be
    // promised to accept.
    await page.getByTestId('model-selector').click();
    await page.getByTestId('model-option-auto').click();
    await expect(page.getByTestId('effort-selector')).toHaveText('effort: —');
    await expect(page.getByTestId('effort-selector')).toBeDisabled();

    // ...and coming back to the model restores a usable level (clamped to that model's default if
    // the stored one is no longer advertised), never a stale value that would fail the turn.
    await page.getByTestId('model-selector').click();
    await page.getByTestId('model-option-gpt-5.6-terra').click();
    await expect(page.getByTestId('effort-selector')).toBeEnabled();
    await page.getByTestId('effort-selector').click();
    await expect(page.getByTestId(`effort-option-${highestId}`)).toBeVisible();
  });
});
