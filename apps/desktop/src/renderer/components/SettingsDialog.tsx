import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { Check, X } from './icons';
import {
  EFFORT_DESC,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  RUNTIME_CLI_MISSING_HINT,
  RUNTIME_DESC,
  RUNTIME_KINDS,
  RUNTIME_LABEL,
  effortUnavailableReason,
} from '../lib/runtime-labels';
import type { RuntimeKind } from '../types/sprint-coder';
import { SkillSettingsSection } from './SkillSettingsSection';

// Settings dialog (issue #5). The sidebar's "設定" button had no onClick and was not disabled
// either, so it looked pressable and did nothing — and no settings screen existed anywhere in the
// renderer.
//
// Modal rather than a right panel, of the two the issue left open: the right edge is claimed by the
// Team List View today (and by the inspector panel in #16), settings are a modal task (open,
// adjust, close) rather than an ambient one, and a modal is what the app's own focus-restoration
// conventions are already built around.
//
// Built on the native <dialog> element with `showModal()`, which gives the focus trap, Escape
// handling, top-layer stacking (so it is never clipped by `.team-canvas`'s `overflow: clip`), and
// the inert backdrop for free. Hand-rolling those is where accessibility bugs come from; the only
// thing added on top is explicit focus restoration, because the acceptance criterion names it and
// this app is deliberate about it elsewhere.

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const runtime = useAppStore((s) => s.runtime);
  const setRuntime = useAppStore((s) => s.setRuntime);
  const setModel = useAppStore((s) => s.setModel);
  const setEffort = useAppStore((s) => s.setEffort);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The element that had focus when the dialog opened. Chromium's <dialog> restores focus itself,
  // but capturing it makes the guarantee explicit and independently testable.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (open) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }, [open]);

  const supported =
    typeof window !== 'undefined' && typeof window.sprintCoder?.settings?.getRuntime === 'function';
  const effortReason = effortUnavailableReason(runtime.kind, runtime.claudeAvailable);
  const selectedModel = runtime.models.find(({ id }) => id === runtime.model);

  function availabilityOf(kind: RuntimeKind): { available: boolean; reason: string | null } {
    if (kind === 'mock') return { available: true, reason: null };
    const available = kind === 'codex' ? runtime.codexAvailable : runtime.claudeAvailable;
    return { available, reason: available ? null : RUNTIME_CLI_MISSING_HINT[kind] };
  }

  return (
    <dialog
      ref={dialogRef}
      className="settings-dialog"
      data-testid="settings-dialog"
      aria-labelledby="settings-dialog-title"
      // `cancel` is Escape; `close` also covers the backdrop-click path below. Both route through
      // the parent so `open` and the element's own state can never disagree.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      // Clicking the backdrop lands on the <dialog> element itself, never on its children.
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className="settings-body">
        <header className="settings-header">
          <h2 id="settings-dialog-title">設定</h2>
          <button
            type="button"
            className="settings-close"
            data-testid="settings-close"
            aria-label="設定を閉じる"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <p className="settings-note">
          ここで選んだ値はComposerのチップと同じ設定を指します。チップはそのターンで何を使うかの
          即時切替として引き続き使えます。
        </p>

        {!supported ? (
          <p className="settings-note" data-testid="settings-unsupported">
            この環境では設定APIが利用できません。
          </p>
        ) : (
          <>
            <fieldset className="settings-group">
              <legend>Runtime</legend>
              {RUNTIME_KINDS.map((kind) => {
                const { available, reason } = availabilityOf(kind);
                return (
                  <label
                    key={kind}
                    className={`settings-radio${available ? '' : ' disabled'}`}
                    data-testid={`settings-runtime-${kind}`}
                  >
                    <input
                      type="radio"
                      name="settings-runtime"
                      value={kind}
                      checked={runtime.kind === kind}
                      disabled={!available}
                      onChange={() => void setRuntime(kind)}
                    />
                    <span className="settings-radio-text">
                      <span className="settings-radio-title">{RUNTIME_LABEL[kind]}</span>
                      <span className="settings-radio-desc">{reason ?? RUNTIME_DESC[kind]}</span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <div className="settings-group">
              <label className="settings-field" htmlFor="settings-model">
                <span className="settings-field-label">モデル</span>
                <select
                  id="settings-model"
                  data-testid="settings-model"
                  value={runtime.model}
                  disabled={runtime.models.length === 0}
                  onChange={(e) => void setModel(e.target.value)}
                >
                  {runtime.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              {selectedModel !== undefined && selectedModel.description !== '' && (
                <p className="settings-hint">{selectedModel.description}</p>
              )}
            </div>

            <div className="settings-group">
              <label className="settings-field" htmlFor="settings-effort">
                <span className="settings-field-label">Effort</span>
                <select
                  id="settings-effort"
                  data-testid="settings-effort"
                  value={runtime.effort}
                  disabled={effortReason !== null}
                  onChange={(e) => void setEffort(e.target.value as (typeof EFFORT_LEVELS)[number])}
                >
                  {EFFORT_LEVELS.map((effort) => (
                    <option key={effort} value={effort}>
                      {EFFORT_LABEL[effort]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="settings-hint" data-testid="settings-effort-hint">
                {effortReason ?? EFFORT_DESC[runtime.effort]}
              </p>
            </div>

            {/* CLI detection. Previously only reachable as a tooltip on a disabled menu item, which
                is exactly where a user who cannot select a Runtime will not look. */}
            <div className="settings-group">
              <span className="settings-field-label">CLI検出状況</span>
              <ul className="settings-status">
                {(['codex', 'claude'] as const).map((kind) => {
                  const { available, reason } = availabilityOf(kind);
                  return (
                    <li key={kind} data-testid={`settings-cli-${kind}`}>
                      <span className={available ? 'settings-ok' : 'settings-missing'}>
                        {available ? <Check size={14} /> : <X size={14} />}
                      </span>
                      <span>{RUNTIME_LABEL[kind]}</span>
                      <span className="settings-hint">
                        {available ? '検出済み' : (reason ?? '未検出')}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <SkillSettingsSection active={open} />
          </>
        )}
      </div>
    </dialog>
  );
}
