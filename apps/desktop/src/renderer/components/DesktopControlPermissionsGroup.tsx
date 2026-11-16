import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesktopControlPermissionPane,
  DesktopControlPermissionState,
  DesktopControlPermissions,
} from '@sprint-coder/contracts';
import { Check, RefreshCw, X } from './icons';

type ReadState =
  | { phase: 'loading' }
  | { phase: 'ready'; permissions: DesktopControlPermissions }
  | { phase: 'failed' };

const STATE_LABEL: Record<DesktopControlPermissionState, string> = {
  granted: '許可済み',
  denied: '未許可',
  unknown: '確認できません',
};

const ROWS: ReadonlyArray<{
  pane: DesktopControlPermissionPane;
  key: 'accessibility' | 'screenRecording';
  label: string;
}> = [
  { pane: 'accessibility', key: 'accessibility', label: 'アクセシビリティ' },
  { pane: 'screen-recording', key: 'screenRecording', label: '画面収録' },
];

function desktopControlApi() {
  if (typeof window === 'undefined') return null;
  const api = window.sprintCoder?.desktopControl;
  if (window.sprintCoder?.windowControls?.platform !== 'darwin') return null;
  if (typeof api?.getPermissions !== 'function') return null;
  return api;
}

/**
 * Settings' "詳細" row for the macOS permissions desktop control needs. Only drawn on macOS builds
 * that run desktop control. Reads again on 再確認 and whenever the window gets focus back while the
 * page is shown, which is when the user returns from System Settings.
 */
export function DesktopControlPermissionsGroup({ active }: { active: boolean }) {
  const [api] = useState(desktopControlApi);
  const [state, setState] = useState<ReadState>({ phase: 'loading' });
  const generation = useRef(0);

  const read = useCallback(async () => {
    if (api === null) return;
    const request = ++generation.current;
    setState((current) => (current.phase === 'ready' ? current : { phase: 'loading' }));
    try {
      const permissions = await api.getPermissions();
      if (request === generation.current) setState({ phase: 'ready', permissions });
    } catch {
      if (request === generation.current) setState({ phase: 'failed' });
    }
  }, [api]);

  useEffect(() => {
    if (!active || api === null) return;
    let cancelled = false;
    // The first read starts after the effect, so the effect itself sets no state.
    void Promise.resolve().then(() => {
      if (!cancelled) void read();
    });
    const onFocus = () => void read();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      generation.current += 1;
    };
  }, [active, api, read]);

  if (api === null) return null;
  if (state.phase === 'ready' && !state.permissions.applicable) return null;

  return (
    <div className="settings-group" data-testid="settings-desktop-control-permissions">
      <span className="settings-field-label">デスクトップ操作の権限</span>
      <p className="settings-hint">
        デスクトップ操作でほかのアプリを読み取り・操作するには、macOS
        の「アクセシビリティ」の許可が必要です。画面の撮影を使うときは「画面収録」の許可も必要です。
      </p>
      {state.phase === 'loading' && (
        <p className="settings-hint" role="status" aria-live="polite">
          権限の状態を読み込んでいます。
        </p>
      )}
      {state.phase === 'failed' && (
        <p
          className="settings-skill-error"
          role="alert"
          data-testid="settings-desktop-control-permissions-error"
        >
          権限の状態を読み取れませんでした。「再確認」でもう一度お試しください。
        </p>
      )}
      {state.phase === 'ready' && (
        <ul className="settings-status">
          {ROWS.map(({ pane, key, label }) => {
            const value = state.permissions[key];
            return (
              <li key={pane} data-testid={`settings-desktop-control-permission-${pane}`}>
                {value === 'granted' ? (
                  <span className="settings-ok" aria-hidden="true">
                    <Check size={14} />
                  </span>
                ) : value === 'denied' ? (
                  <span className="settings-missing" aria-hidden="true">
                    <X size={14} />
                  </span>
                ) : null}
                <span>{label}</span>
                <span className="settings-hint">{STATE_LABEL[value]}</span>
                <button
                  type="button"
                  className="settings-secondary-button"
                  aria-label={`${label}のシステム設定を開く`}
                  onClick={() => api.openPermissionSettings(pane)}
                >
                  システム設定を開く
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="settings-inline-actions">
        <button
          type="button"
          className="settings-secondary-button"
          data-testid="settings-desktop-control-permissions-recheck"
          onClick={() => void read()}
        >
          <RefreshCw size={14} /> 再確認
        </button>
      </div>
      <p className="settings-hint">
        許可を変えた後は、Sprint Coder を再起動すると確実に反映されます。
      </p>
    </div>
  );
}
