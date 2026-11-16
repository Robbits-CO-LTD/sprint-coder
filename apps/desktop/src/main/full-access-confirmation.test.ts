import { describe, expect, it } from 'vitest';
import { fullAccessConfirmationDetail } from './full-access-confirmation';

// The detail shown before macOS got its own file manager name (Issue #1320). Windows keeps it as is.
const WINDOWS_DETAIL =
  'コマンドと、デスクトップ操作（ほかのアプリの窓を読む・押す・入力する、アプリの起動。ログイン済みのブラウザーやメールのアプリも含む）を、確認なしで実行します。管理deny、秘密情報保護、provider egress、Renderer非特権は解除されません。ただし、これらはファイル・コマンド・ネットワークの道具に効く保護で、デスクトップ操作が開いている窓（端末、エクスプローラー、パスワード管理のアプリ、ブラウザーなど）を読んだり入力したりすることは止めません。';

describe('fullAccessConfirmationDetail', () => {
  it('names Finder on macOS', () => {
    const detail = fullAccessConfirmationDetail('darwin');
    expect(detail).toContain('（端末、Finder、パスワード管理のアプリ');
    expect(detail).not.toContain('エクスプローラー');
    expect(detail).toBe(WINDOWS_DETAIL.replace('エクスプローラー', 'Finder'));
  });

  it.each(['win32', 'linux'] as const)('keeps the current text on %s', (platform) => {
    expect(fullAccessConfirmationDetail(platform)).toBe(WINDOWS_DETAIL);
  });
});
