// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionChip } from './ContextBar';
import { useAppStore } from '../../store/appStore';

// The text shown before macOS got its own file manager name (Issue #1320). Windows keeps it as is.
const WINDOWS_TEXT =
  '作業フォルダー内のファイル操作とコマンド実行を許可します。コマンドは外部と通信できないため、GitHubへの起票やpush、パッケージのダウンロードには使えません。 利用できるコマンドの実行と、実行中のコマンドへの入力は 都度の承認なしで実行します。デスクトップ操作（ほかのアプリの窓を読む・押す・入力する、 アプリの起動。ログイン済みのブラウザーやメールのアプリも含む）も、確認なしで実行します。 窓や画面の画像を撮る操作も含み、撮った画像はこの Task の AI（接続先のサービス）に送ります。クラウドAPIには、画像を送るたびに接続先とモデルを表示し、承認を求めます。 Workspace内ファイルの読み取りは、秘密情報を 含む可能性があるものもredact済みの本文をProviderへ都度確認なしで渡します。管理deny、 秘密情報、provider egress、Renderer非特権は常に維持されます。ただし、これらはファイル・ コマンド・ネットワークの道具に効く保護で、デスクトップ操作が開いている窓（端末、 エクスプローラー、パスワード管理のアプリ、ブラウザーなど）を読んだり入力したりすることは止めません。';

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
    expect(text).toContain('（端末、 Finder、パスワード管理のアプリ');
    expect(text).not.toContain('エクスプローラー');
    expect(text).toBe(WINDOWS_TEXT.replace('エクスプローラー', 'Finder'));
  });

  it.each(['win32', 'linux', undefined])(
    'keeps the current text unchanged elsewhere (platform=%s)',
    async (platform) => {
      await renderWith(platform);
      expect(await openFullAccessImpact()).toBe(WINDOWS_TEXT);
    },
  );
});
