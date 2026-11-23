// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionChip } from './ContextBar';
import { useAppStore } from '../../store/appStore';

const taskId = 'full-access-wording';
let container: HTMLDivElement;
let root: Root;

async function renderWith(platform: string | undefined, reviewProjectRules = vi.fn()) {
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      permissions: { set: vi.fn(), reviewProjectRules },
      ...(platform === undefined ? {} : { windowControls: { platform } }),
    },
  });
  await act(async () => root.render(<PermissionChip taskId={taskId} />));
}

async function openFullAccessImpact(): Promise<string> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="access-selector"]')!.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="access-option-full"]')!.click();
  });
  return container.querySelector('.permission-confirm .runtime-menu-desc')!.textContent ?? '';
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useAppStore.setState(useAppStore.getInitialState(), true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAppStore.setState(useAppStore.getInitialState(), true);
  Reflect.deleteProperty(window, 'sprintCoder');
  vi.unstubAllGlobals();
});

it('reviews the rules for the current task and announces the result', async () => {
  const review = vi.fn().mockResolvedValue('確認した権限ルールを適用しました。');
  await renderWith('win32', review);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="access-selector"]')!.click(),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(review).toHaveBeenCalledWith(taskId);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    '確認した権限ルールを適用しました。',
  );
});

describe('full access impact text', () => {
  it('names Finder on macOS', async () => {
    await renderWith('darwin');
    const text = await openFullAccessImpact();
    expect(text).toContain('（端末、Finder、パスワード管理アプリ');
    expect(text).not.toContain('エクスプローラー');
  });

  it.each(['win32', 'linux', undefined])(
    'keeps the desktop and image disclosures elsewhere (platform=%s)',
    async (platform) => {
      await renderWith(platform);
      const text = await openFullAccessImpact();
      expect(text).toContain('エクスプローラー');
      expect(text).toContain('ログイン済みのブラウザーやメール');
      expect(text).toContain('撮影した画面の画像は接続先のAIに送ります');
      expect(text).toContain('画像ごとに接続先とモデルを表示し、承認を求めます');
    },
  );
});

it('shows the real restriction by Full Access when the Task has no workspace', async () => {
  useAppStore.setState({ permissionByTask: { [taskId]: { preset: 'full', policyEpoch: 1 } } });
  await renderWith('win32');
  const button = container.querySelector<HTMLButtonElement>('[data-testid="access-selector"]')!;
  expect(button.textContent).toContain('フルアクセス');
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toContain(
    'ファイル・コマンド不可（フォルダー未設定）',
  );
  const text = await openFullAccessImpact();
  expect(text).not.toContain('作業フォルダー内のファイルの読み書き');
  expect(text).not.toContain('コマンドの実行と、実行中のコマンドへの入力');
});

it('distinguishes unavailable commands from available file operations in a workspace', async () => {
  useAppStore.setState({
    workspaceByTask: { [taskId]: { path: '/workspace', name: 'workspace' } },
  });
  await renderWith('win32');
  const text = await openFullAccessImpact();
  expect(container.querySelector('.composer-access-status')?.textContent).toContain(
    'コマンドは使えません',
  );
  expect(text).toContain('作業フォルダー内のファイルの読み書き');
  expect(text).not.toContain('実行中のコマンドへの入力');
});

it('keeps the network restriction when commands are available', async () => {
  useAppStore.setState({
    workspaceByTask: { [taskId]: { path: '/workspace', name: 'workspace' } },
    commandSandbox: {
      available: true,
      backend: 'windows-appcontainer',
      reason: null,
      probedAt: '2026-11-23T00:00:00.000Z',
    },
  });
  await renderWith('win32');
  expect(await openFullAccessImpact()).toContain('コマンドは外部と通信できない');
});
