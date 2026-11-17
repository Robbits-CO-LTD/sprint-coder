// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionChip } from './ContextBar';
import { useAppStore } from '../../store/appStore';

// The text shown before macOS got its own file manager name (Issue #1320). Windows keeps it as is.
const WINDOWS_TEXT =
  'Workspace操作、Shell、Networkなどをpolicy上は許可します。実際の書込み・コマンド実行は 安全な実行境界が完成した機能だけ利用でき、コマンド実行と実行中コマンドへの標準入力書き込みは 都度の承認なしで実行します。デスクトップ操作（ほかのアプリの窓を読む・押す・入力する、 アプリの起動。ログイン済みのブラウザーやメールのアプリも含む）も、確認なしで実行します。 窓や画面の画像を撮る操作も含み、撮った画像はこの Task の AI（接続先のサービス）に送ります。 Workspace内ファイルの読み取りは、秘密情報を 含む可能性があるものもredact済みの本文をProviderへ都度確認なしで渡します。管理deny、 秘密情報、provider egress、Renderer非特権は常に維持されます。ただし、これらはファイル・ コマンド・ネットワークの道具に効く保護で、デスクトップ操作が開いている窓（端末、 エクスプローラー、パスワード管理のアプリ、ブラウザーなど）を読んだり入力したりすることは止めません。';

const taskId = 'full-access-wording';
let container: HTMLDivElement;
let root: Root;

async function renderWith(platform: string | undefined) {
  Object.defineProperty(window, 'sprintCoder', {
    configurable: true,
    value: {
      permissions: { set: vi.fn() },
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
