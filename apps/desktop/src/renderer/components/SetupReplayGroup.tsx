import { useSyncExternalStore } from 'react';
import { isSetupShowing, requestSetupReplay, subscribeSetupShowing } from '../lib/setup-preference';
import { RefreshCw } from './icons';

/** The last row of Settings' "詳細" page: runs the Setup again over the current choices. Not
 * offered while a Setup is already on screen (Settings can be opened from inside one). */
export function SetupReplayGroup() {
  const showing = useSyncExternalStore(subscribeSetupShowing, isSetupShowing, () => false);
  return (
    <div className="settings-group" data-testid="settings-setup-replay">
      <span className="settings-field-label">セットアップ</span>
      <p className="settings-hint">
        {showing
          ? 'セットアップの途中です。終わった後で、ここからもう一度選び直せます。'
          : '返事の仕方や Team の使い方などを、最初の画面と同じ流れで選び直せます。今の設定が選ばれた状態で始まります。'}
      </p>
      <div>
        <button
          type="button"
          className="settings-secondary-button setup-replay-button"
          data-testid="settings-setup-replay-button"
          onClick={requestSetupReplay}
          disabled={showing}
        >
          <RefreshCw size={14} /> セットアップをもう一度
        </button>
      </div>
    </div>
  );
}
