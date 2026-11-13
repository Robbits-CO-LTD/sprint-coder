import { requestSetupReplay } from '../lib/setup-preference';
import { RefreshCw } from './icons';

/** The last row of Settings' "詳細" page: runs the Setup again over the current choices. */
export function SetupReplayGroup() {
  return (
    <div className="settings-group" data-testid="settings-setup-replay">
      <span className="settings-field-label">セットアップ</span>
      <p className="settings-hint">
        返事の仕方や Team
        の使い方などを、最初の画面と同じ流れで選び直せます。今の設定が選ばれた状態で始まります。
      </p>
      <div>
        <button
          type="button"
          className="settings-secondary-button setup-replay-button"
          data-testid="settings-setup-replay-button"
          onClick={requestSetupReplay}
        >
          <RefreshCw size={14} /> セットアップをもう一度
        </button>
      </div>
    </div>
  );
}
