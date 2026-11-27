import { useEffect, useState } from 'react';
import type { UpdateInstallState } from '@sprint-coder/contracts';
import { useLogoGlyph } from '../lib/logo-glyph';

function fallbackPlatform(): string {
  const navigatorPlatform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (navigatorPlatform.includes('mac') || userAgent.includes('macintosh')) return 'darwin';
  if (navigatorPlatform.includes('win') || userAgent.includes('windows')) return 'win32';
  return 'other';
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="window-control-icon">
      <path d="M1 6.5h10" />
    </svg>
  );
}

function MaximizeIcon({ restored }: { restored: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="window-control-icon">
      {restored ? (
        <>
          <path d="M3.5 1.5h7v7" />
          <rect x="1.5" y="3.5" width="7" height="7" />
        </>
      ) : (
        <rect x="1.5" y="1.5" width="9" height="9" />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" className="window-control-icon">
      <path d="m1.5 1.5 9 9m0-9-9 9" />
    </svg>
  );
}

function TitlebarUpdateButton() {
  const updates = window.sprintCoder?.updates;
  const [state, setState] = useState<UpdateInstallState>('unavailable');
  const [requesting, setRequesting] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (updates?.subscribeInstallState === undefined) return;
    let readSnapshot = true;
    const unsubscribe = updates.subscribeInstallState((next) => {
      readSnapshot = false;
      setState(next);
    });
    void updates
      .getInstallState()
      .then((next) => {
        if (readSnapshot) setState(next);
      })
      .catch(() => undefined);
    return () => {
      readSnapshot = false;
      unsubscribe();
    };
  }, [updates]);

  if (state === 'unavailable' || updates === undefined) return null;

  const restarting = requesting || state === 'restarting';
  const disabled = restarting || state === 'busy';
  const status = restarting
    ? '更新を開始しています。'
    : state === 'busy'
      ? '作業が終わると更新できます。'
      : failed
        ? '更新を開始できませんでした。もう一度お試しください。'
        : 'ダウンロード済みの更新を適用します。';

  async function restart() {
    if (disabled || updates === undefined) return;
    setRequesting(true);
    setFailed(false);
    try {
      await updates.restartToInstall();
    } catch {
      setFailed(true);
    } finally {
      setRequesting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="titlebar-update-button"
        aria-disabled={disabled}
        aria-describedby="titlebar-update-status"
        title={status}
        onClick={() => void restart()}
      >
        {restarting ? '更新を開始中…' : failed && !disabled ? '更新を再試行' : '再起動して更新'}
      </button>
      <span id="titlebar-update-status" className="sr-only" role="status">
        {status}
      </span>
    </>
  );
}

export function AppTitlebar() {
  const controls = window.sprintCoder?.windowControls;
  const platform = controls?.platform ?? fallbackPlatform();
  const windows = platform === 'win32';
  const macOS = platform === 'darwin';
  const [maximized, setMaximized] = useState(false);
  const glyph = useLogoGlyph();

  useEffect(() => {
    if (!windows || controls === undefined) return;
    let active = true;
    const unsubscribe = controls.onMaximizedChanged((next) => {
      if (active) setMaximized(next);
    });
    void controls
      .isMaximized()
      .then((next) => {
        if (active) setMaximized(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controls, windows]);

  if (!macOS && !windows) return null;

  const maximizeLabel = maximized ? '元に戻す' : '最大化';
  return (
    <header
      className={`app-titlebar app-titlebar--${macOS ? 'macos' : 'windows'}`}
      data-testid="app-titlebar"
      data-platform={platform}
    >
      <span className="app-titlebar-name">
        {/* The logo itself, small: the one place the window says whose it is. Its box is kept while
            the image is made, so the name does not move when it arrives. */}
        <span className="app-titlebar-mark" aria-hidden="true">
          {glyph !== null && <img src={glyph} alt="" />}
        </span>
        <span className="app-titlebar-text">Sprint Coder</span>
      </span>
      <TitlebarUpdateButton />
      {windows && controls !== undefined && (
        <div className="window-controls" role="group" aria-label="ウィンドウ操作">
          <button
            type="button"
            className="window-control"
            data-testid="window-minimize"
            aria-label="最小化"
            title="最小化"
            onClick={() => controls.minimize()}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className="window-control"
            data-testid="window-toggle-maximize"
            data-window-state={maximized ? 'maximized' : 'restored'}
            aria-label={maximizeLabel}
            title={maximizeLabel}
            onClick={() => controls.toggleMaximize()}
          >
            <MaximizeIcon restored={maximized} />
          </button>
          <button
            type="button"
            className="window-control window-control--close"
            data-testid="window-close"
            aria-label="閉じる"
            title="閉じる"
            onClick={() => controls.close()}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </header>
  );
}
