import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeApp,
  createUserDataDir,
  DESKTOP_ROOT,
  findPackagedExecutable,
  firstWindow,
  launchApp,
  removeUserDataDir,
  resolveDevElectronBinary,
  resolveE2EMode,
} from './helpers';

test.describe('macOS window lifecycle', () => {
  test.skip(
    process.platform !== 'darwin',
    'macOS keeps the app alive after its last window closes',
  );

  let userDataDir: string;
  let app: ElectronApplication | null = null;

  test.beforeAll(() => {
    userDataDir = createUserDataDir('macos-window-lifecycle');
  });

  test.afterAll(async () => {
    await closeApp(app);
    removeUserDataDir(userDataDir);
  });

  test('close hides the window and a second launch restores it without losing the Task', async () => {
    const messageText = 'macOS close and reopen lifecycle';
    app = await launchApp(userDataDir);
    const page: Page = await firstWindow(app);

    await page.getByTestId('sidebar-new-task-button').click();
    const textarea = page.getByTestId('composer-textarea');
    await textarea.fill(messageText);
    await textarea.press('Enter');
    await expect(page.getByTestId('run-card')).toHaveAttribute('data-run-status', 'completed', {
      timeout: 20_000,
    });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
      )
      .toBe(false);

    const second = launchSecondInstance(userDataDir);
    const stderr: Buffer[] = [];
    second.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const exitCode = await waitForExit(second, 10_000);

    expect(exitCode).toBe(0);
    expect(Buffer.concat(stderr).toString('utf8')).not.toContain('Object has been destroyed');
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
      )
      .toBe(true);
    await expect(page.getByTestId('user-message')).toHaveText(messageText);
    await expect(page.getByTestId('assistant-message')).toContainText('決定論的なモック応答です');
  });
});

function launchSecondInstance(userDataDir: string): ChildProcess {
  const mode = resolveE2EMode();
  return spawn(
    mode === 'packaged' ? findPackagedExecutable() : resolveDevElectronBinary(),
    mode === 'packaged' ? [] : [DESKTOP_ROOT],
    {
      cwd: DESKTOP_ROOT,
      env: {
        ...process.env,
        SPRINT_CODER_USER_DATA_DIR: userDataDir,
        SPRINT_CODER_SKILL_HOME: userDataDir,
        SPRINT_CODER_RUNTIME_ADOPT: '0',
        SPRINT_CODER_ALLOW_SIMULATED_TEAM_WORKERS: '1',
        SPRINT_CODER_E2E_CLI_FIXTURES: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Second Sprint Coder instance did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
