import { useEffect, useId, useRef, useState } from 'react';
import { useAppStore, type TeamPolicyValues } from '../store/appStore';
import { X } from './icons';
import type { TeamDetail } from '../types/sprint-coder';

// Team Policy settings UI (Team v2 Core C4b). The backend contract
// (`window.sprintCoder.teams.updatePolicy`) has been complete since "expose policy settings
// contract", but nothing in the renderer could reach it: the Team's depth/concurrency limits were
// only ever set at promotion time and were invisible afterwards.
//
// ONE component, mounted by BOTH Team views (TeamCanvas and TeamListView). The two views are
// alternate projections of the same store state and already share testids and wording deliberately
// (see TeamListView.tsx's header note) — a second, drifting copy of a form that writes a
// revision-checked record is exactly the kind of thing that ends up disagreeing with itself.
//
// Built on the native <dialog> + `showModal()` for the same reasons SettingsDialog.tsx is (focus
// trap, Escape, top-layer stacking above `.team-canvas`'s `overflow: clip`, inert backdrop), plus
// the same explicit focus restoration. Reusing that element also means reduced motion is already
// handled: the open animation is a plain CSS `animation` covered by the global
// `prefers-reduced-motion` squash at the top of index.css, so nothing new opts in to motion.

/** Same bounds the contract enforces (`z.number().int().min(1).max(4)` / `.max(8)`). Kept here so
 * the inputs cannot express a value the backend will reject for range — the only rejection a user
 * should ever see is the one the client genuinely cannot predict (a stale revision, or a depth
 * that is below the hierarchy that already exists). */
export const MAX_AGENT_DEPTH_RANGE = { min: 1, max: 4 } as const;
export const MAX_CONCURRENT_EXECUTIONS_RANGE = { min: 1, max: 8 } as const;

/** Contract default (DEFAULT_TEAM_POLICY in packages/domain/src/team.ts), used only when a detail
 * predates the policy column and carries no policy at all. */
const FALLBACK_POLICY: TeamPolicyValues = {
  maxAgentDepth: 4,
  maxConcurrentExecutions: 8,
  allowWorkerDirectMessages: true,
  budgetMode: 'bounded',
};

function clampInt(value: unknown, { min, max }: { min: number; max: number }, fallback: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Reads the canonical policy off a TeamDetail's team, defensively.
 *
 * Every open initializes from this (never from the previous edit session), so a policy changed in
 * the other view — or by the backend — is what the user sees when they open the form. */
export function readPolicy(team: TeamDetail['team']): TeamPolicyValues {
  const raw = (team as { policy?: unknown }).policy;
  if (raw === null || typeof raw !== 'object') return FALLBACK_POLICY;
  const policy = raw as Partial<TeamPolicyValues>;
  return {
    maxAgentDepth: clampInt(
      policy.maxAgentDepth,
      MAX_AGENT_DEPTH_RANGE,
      FALLBACK_POLICY.maxAgentDepth,
    ),
    maxConcurrentExecutions: clampInt(
      policy.maxConcurrentExecutions,
      MAX_CONCURRENT_EXECUTIONS_RANGE,
      FALLBACK_POLICY.maxConcurrentExecutions,
    ),
    allowWorkerDirectMessages:
      typeof policy.allowWorkerDirectMessages === 'boolean'
        ? policy.allowWorkerDirectMessages
        : FALLBACK_POLICY.allowWorkerDirectMessages,
    budgetMode: policy.budgetMode === 'unlimited' ? 'unlimited' : FALLBACK_POLICY.budgetMode,
  };
}

/** The integer fields are `<select>`s, not `<input type="number">`s. Both ranges are tiny and
 * closed (1-4, 1-8), and a select cannot hold a half-typed or out-of-range value, so there is no
 * client-side validation error state to design, announce, or colour — the form is always
 * submittable and the payload is always contract-valid. */
function integerOptions({ min, max }: { min: number; max: number }): number[] {
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export function TeamPolicyDialog({
  open,
  taskId,
  detail,
  onClose,
}: {
  open: boolean;
  taskId: string;
  /** Current canonical detail. Both the policy and the revision the save is checked against come
   * from here, so the two can never be read from different snapshots. */
  detail: TeamDetail;
  onClose: () => void;
}) {
  const updateTeamPolicy = useAppStore((state) => state.updateTeamPolicy);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // The element focused when the dialog opened. Chromium's <dialog> restores focus on its own, but
  // capturing it makes the guarantee explicit and independently testable — same as SettingsDialog.
  const openerRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const fieldId = useId();

  const [values, setValues] = useState<TeamPolicyValues>(() => readPolicy(detail.team));
  const [revision] = useState(detail.team.revision);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
  }, [open]);

  function closeAndRestoreFocus(): void {
    if (closingRef.current) return;
    closingRef.current = true;
    const opener = openerRef.current;
    const openerTestId = opener?.dataset.testid;
    openerRef.current = null;
    // Close the native top-layer entry before unmounting it. Removing an open <dialog> directly can
    // make Chromium perform its own delayed focus restoration after our animation-frame callback,
    // which overwrote the trigger focus under the slower Windows dev build. The closing guard
    // prevents the synchronous native `close` event from entering this function a second time.
    dialogRef.current?.close();
    onClose();
    // The parent conditionally renders this dialog, so closing means unmounting it. Restore focus
    // after that commit; doing it synchronously would target the trigger while the modal is still
    // in Chromium's top layer. In particular, do not call dialog.close() from an effect cleanup:
    // React StrictMode deliberately runs setup -> cleanup -> setup in development, and the cleanup
    // close event previously collapsed the freshly opened policy dialog during dev E2E.
    const restore = (): void => {
      // Resolve the trigger again on every frame. Saving replaces the canonical Team detail and
      // can therefore replace the header button after the dialog itself has already unmounted.
      const currentTrigger = openerTestId
        ? document.querySelector<HTMLElement>(`[data-testid="${openerTestId}"]`)
        : null;
      const target = currentTrigger ?? (opener && document.contains(opener) ? opener : null);
      target?.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => {
      restore();
      requestAnimationFrame(restore);
    });
  }

  async function save() {
    // Guards a double-submit: Enter in a field and a click on 保存 both land here, and the second
    // one would carry the same now-consumed `expectedRevision` and fail for a reason the user did
    // not cause. The button is disabled too; this is the one that survives a fast keyboard.
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await updateTeamPolicy(taskId, values, revision);
    if (result.ok) {
      // teamByTask has already been replaced with the canonical detail the backend returned.
      setSaving(false);
      closeAndRestoreFocus();
      return;
    }
    // Failure keeps the dialog open with the user's edits intact. Nothing local is written to the
    // store on this path, so a rejected save can never leave the UI claiming a value the backend
    // does not hold.
    setSaving(false);
    setError(result.message);
  }

  return (
    <dialog
      ref={dialogRef}
      className="team-policy-dialog"
      data-testid="team-policy-dialog"
      aria-labelledby={`${fieldId}-title`}
      aria-describedby={`${fieldId}-note`}
      onCancel={(e) => {
        // Escape. Routed through the parent so `open` and the element's own state never disagree;
        // focus restoration then runs in the effect above.
        e.preventDefault();
        if (!saving) closeAndRestoreFocus();
      }}
      onClose={() => {
        if (!saving) closeAndRestoreFocus();
      }}
      onClick={(e) => {
        // Backdrop clicks land on the <dialog> element itself, never on its children.
        if (e.target === dialogRef.current && !saving) closeAndRestoreFocus();
      }}
    >
      <form
        className="team-policy-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="team-policy-header">
          <h2 id={`${fieldId}-title`}>Teamのポリシー</h2>
          <button
            type="button"
            className="settings-close"
            data-testid="team-policy-close"
            aria-label="ポリシー設定を閉じる"
            disabled={saving}
            onClick={closeAndRestoreFocus}
          >
            <X size={16} />
          </button>
        </header>

        <p className="settings-note" id={`${fieldId}-note`}>
          このTeamの動き方を決める設定です。保存すると、いま表示している内容がそのまま反映されます。
        </p>

        <div className="settings-group">
          <label className="settings-field" htmlFor={`${fieldId}-depth`}>
            <span className="settings-field-label">Workerの階層の深さ</span>
            <select
              id={`${fieldId}-depth`}
              data-testid="team-policy-max-depth"
              aria-describedby={`${fieldId}-depth-desc`}
              value={values.maxAgentDepth}
              disabled={saving}
              onChange={(e) => setValues((v) => ({ ...v, maxAgentDepth: Number(e.target.value) }))}
            >
              {integerOptions(MAX_AGENT_DEPTH_RANGE).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-hint" id={`${fieldId}-depth-desc`}>
            Workerがさらに下のWorkerを雇える段数です。1にすると、Leaderが直接雇うWorkerだけになります。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-field" htmlFor={`${fieldId}-concurrency`}>
            <span className="settings-field-label">同時に動かせるWorkerの数</span>
            <select
              id={`${fieldId}-concurrency`}
              data-testid="team-policy-max-concurrent"
              aria-describedby={`${fieldId}-concurrency-desc`}
              value={values.maxConcurrentExecutions}
              disabled={saving}
              onChange={(e) =>
                setValues((v) => ({ ...v, maxConcurrentExecutions: Number(e.target.value) }))
              }
            >
              {integerOptions(MAX_CONCURRENT_EXECUTIONS_RANGE).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-hint" id={`${fieldId}-concurrency-desc`}>
            同じ時間に作業できるWorkerの上限です。少なくすると順番待ちが増えますが、負荷は下がります。
          </p>
        </div>

        <div className="settings-group">
          <label className="settings-skill-row">
            <input
              id={`${fieldId}-direct-messages`}
              type="checkbox"
              data-testid="team-policy-direct-messages"
              aria-describedby={`${fieldId}-direct-messages-desc`}
              checked={values.allowWorkerDirectMessages}
              disabled={saving}
              onChange={(e) =>
                setValues((v) => ({ ...v, allowWorkerDirectMessages: e.target.checked }))
              }
            />
            <span>
              <strong>Worker同士が直接やり取りすることを許可する</strong>
              <small id={`${fieldId}-direct-messages-desc`}>
                オフにすると、やり取りはかならずLeaderを通ります。
              </small>
            </span>
          </label>
        </div>

        <fieldset className="settings-group" aria-describedby={`${fieldId}-budget-desc`}>
          <legend>使う量の上限</legend>
          <p className="settings-hint" id={`${fieldId}-budget-desc`}>
            このTeamがどれだけ使えるかの決め方です。
          </p>
          {(
            [
              {
                mode: 'bounded' as const,
                title: '上限を決める',
                desc: '決めた範囲を超えそうになったら、Teamの作業を止めます。',
              },
              {
                mode: 'unlimited' as const,
                title: '上限を決めない',
                desc: '使う量では止めません。長く動き続けることがあります。',
              },
            ] satisfies { mode: TeamPolicyValues['budgetMode']; title: string; desc: string }[]
          ).map(({ mode, title, desc }) => (
            <label key={mode} className="settings-radio" data-testid={`team-policy-budget-${mode}`}>
              <input
                type="radio"
                name={`${fieldId}-budget-mode`}
                value={mode}
                checked={values.budgetMode === mode}
                disabled={saving}
                onChange={() => setValues((v) => ({ ...v, budgetMode: mode }))}
              />
              <span className="settings-radio-text">
                <span className="settings-radio-title">{title}</span>
                <span className="settings-radio-desc">{desc}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {/* Failure surface. `role="alert"` so it is announced without moving focus off the field
            the user was in, and it carries the reload guidance as words — the red border and the
            "!" glyph are both redundant with the text, never the only carrier (NFR-A11Y). */}
        {error !== null && (
          <p className="team-policy-error" data-testid="team-policy-error" role="alert">
            <span aria-hidden="true">!</span> {error}
          </p>
        )}

        <div className="team-policy-actions">
          <span className="settings-hint" data-testid="team-policy-revision">
            現在の版: {revision}
          </span>
          <button
            type="button"
            className="settings-secondary-button"
            data-testid="team-policy-cancel"
            disabled={saving}
            onClick={closeAndRestoreFocus}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="settings-primary-button"
            data-testid="team-policy-save"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Shared trigger for both Team views, so the button, its label and its testid cannot drift apart
 * between Canvas and List the way two hand-written copies would. */
export function TeamPolicyTrigger({
  onOpen,
  disabled = false,
}: {
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="team-policy-btn"
      data-testid="team-policy-open"
      disabled={disabled}
      onClick={onOpen}
    >
      ポリシー設定
    </button>
  );
}
