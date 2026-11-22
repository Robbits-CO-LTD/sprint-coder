import { describe, expect, it } from 'vitest';
import { fullAccessConfirmationDetail } from './full-access-confirmation';

// Keep the full risk disclosure while using the platform file manager name (Issue #1320).
const WINDOWS_DETAIL =
  'コマンドと、デスクトップ操作（ほかのアプリの窓を読む・押す・入力する、アプリの起動。ログイン済みのブラウザーやメールのアプリも含む）を、確認なしで実行します。窓や画面の画像を撮る操作も含み、撮った画像はこの Task の AI（接続先のサービス）に送ります。GitHubからSkillを入れるようチャットで頼んだ場合は、用途で指定すると候補の名前と説明を選択中のモデルに渡して比較し、選んだSkillを原文のまま取得して追加の確認なしで登録します。クラウドAPIには、画像を送るたびに接続先とモデルを表示し、承認を求めます。管理deny、秘密情報保護、provider egress、Renderer非特権は解除されません。ただし、これらはファイル・コマンド・ネットワークの道具に効く保護で、デスクトップ操作が開いている窓（端末、エクスプローラー、パスワード管理のアプリ、ブラウザーなど）を読んだり入力したりすることは止めません。';

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
