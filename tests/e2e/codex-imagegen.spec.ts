import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { closeApp, createUserDataDir, firstWindow, launchApp, removeUserDataDir } from './helpers';

// Issue #11. The image *pipeline* against the real CLI is covered by codex-smoke.test.ts (opt-in,
// spends real usage); these cover the parts that must hold without a real Codex turn — the UI gating,
// the prefix that reaches the message, and the "asked but got nothing" outcome.

async function withApp(label: string, body: (page: Page) => Promise<void>): Promise<void> {
  const dir = createUserDataDir(label);
  let app: ElectronApplication | null = null;
  try {
    app = await launchApp(dir);
    const page = await firstWindow(app);
    await page.getByTestId('sidebar-new-task-button').click();
    await expect(page.getByTestId('composer-textarea')).toBeVisible();
    await body(page);
  } finally {
    await closeApp(app);
    removeUserDataDir(dir);
  }
}

test.describe('codex image generation', () => {
  test('is selectable only for Codex, and states the Runtime requirement otherwise', async () => {
    await withApp('imagegen-gating', async (page) => {
      // Mock is the default Runtime: the item is present (so the feature is discoverable) but
      // announced unavailable with the reason, matching how the effort chip treats an unusable
      // option.
      await page.getByTestId('composer-plus').click();
      const item = page.getByTestId('composer-menu-imagegen');
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await expect(item).toContainText('Codex Runtime');
      await page.keyboard.press('Escape');

      // Claude must not offer it either — `$imagegen` is a Codex CLI facility with no equivalent.
      await page.getByTestId('runtime-selector').click();
      await page.getByTestId('runtime-option-claude').click();
      await expect(page.getByTestId('runtime-selector')).toHaveText('Claude Code');
      await page.getByTestId('composer-plus').click();
      await expect(page.getByTestId('composer-menu-imagegen')).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await page.keyboard.press('Escape');

      // Codex enables it.
      await page.getByTestId('runtime-selector').click();
      await page.getByTestId('runtime-option-codex').click();
      await expect(page.getByTestId('runtime-selector')).toHaveText('Codex');
      await page.getByTestId('composer-plus').click();
      await expect(page.getByTestId('composer-menu-imagegen')).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    });
  });

  test('arms for one send only, and can be cancelled before sending', async () => {
    await withApp('imagegen-arming', async (page) => {
      await page.getByTestId('runtime-selector').click();
      await page.getByTestId('runtime-option-codex').click();

      await expect(page.getByTestId('composer-imagegen-armed')).toHaveCount(0);
      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-imagegen').click();
      // Visible state, so the next send cannot silently become an image request.
      await expect(page.getByTestId('composer-imagegen-armed')).toBeVisible();

      // Clicking the indicator disarms it — a one-shot, not a mode the user gets stuck in.
      await page.getByTestId('composer-imagegen-armed').click();
      await expect(page.getByTestId('composer-imagegen-armed')).toHaveCount(0);
    });
  });

  test('puts the directive in the sent message, and reports an unfulfilled request', async () => {
    // Run against the mock Runtime on purpose: mock never generates an image, which is exactly the
    // "Codex answered without calling the image tool" case the issue insists must not read as
    // success. Driving it through mock makes that path deterministic instead of hoping the real CLI
    // misbehaves.
    await withApp('imagegen-unfulfilled', async (page) => {
      await page.getByTestId('runtime-selector').click();
      await page.getByTestId('runtime-option-codex').click();
      await page.getByTestId('composer-plus').click();
      await page.getByTestId('composer-menu-imagegen').click();
      await expect(page.getByTestId('composer-imagegen-armed')).toBeVisible();

      // Back to mock so the turn completes locally and deterministically; the armed state survives
      // the Runtime switch because it is a property of the pending send, not of the Runtime.
      await page.getByTestId('runtime-selector').click();
      await page.getByTestId('runtime-option-mock').click();

      await page.getByTestId('composer-textarea').fill('青いアイコンを作って');
      await page.getByTestId('composer-textarea').press('Enter');

      // The directive is in the stored message rather than injected invisibly in the adapter, so
      // "why did this turn generate an image?" stays answerable from the history alone.
      const userMessage = page.getByTestId('user-message').last();
      await expect(userMessage).toContainText('$imagegen');
      await expect(userMessage).toContainText('青いアイコンを作って');
      // And the instruction that keeps the model from attempting a copy the sandbox would refuse.
      await expect(userMessage).toContainText('コピーや移動は行わないでください');

      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });

      // No image arrived, and that is stated rather than left as blank space.
      await expect(page.getByTestId('generated-image-missing')).toBeVisible();
      await expect(page.getByTestId('generated-image-card')).toHaveCount(0);
      // The arming was consumed by the send.
      await expect(page.getByTestId('composer-imagegen-armed')).toHaveCount(0);
    });
  });

  test('an ordinary message shows no image notice at all', async () => {
    await withApp('imagegen-absent', async (page) => {
      await page.getByTestId('composer-textarea').fill('画像とは関係のない普通の依頼');
      await page.getByTestId('composer-textarea').press('Enter');
      await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('generated-image-missing')).toHaveCount(0);
      await expect(page.getByTestId('generated-image-card')).toHaveCount(0);
    });
  });
});
