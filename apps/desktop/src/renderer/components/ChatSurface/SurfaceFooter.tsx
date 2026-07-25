import { useAppStore } from '../../store/appStore';
import { Check, Circle, TriangleAlert, X } from './../icons';
import { RUNTIME_LABEL } from '../../lib/runtime-labels';
import type { DatabaseRecovery, RuntimeStatus } from '../../types/sprint-coder';

// SurfaceFooter (issue #9): the fifth ChatSurface element from docs §4.2, the only one that was
// never built — recovery, connection, background activity.
//
// Answering the issue's own open question ("常設1行に収めるか、異常時のみ出現させるか"): one always-
// present slim row for connection, and additional rows only when there is something abnormal to
// say. A permanently-visible "0 件" or "正常" for every slot would spend a line of the conversation
// column on nothing, which is the opposite of "常時うるさく主張せず、異常時・復元時にだけ存在感が出る".
//
// Shown in both variants (main Chat and the Canvas Leader node), like SurfaceHeader — a Runtime that
// died is exactly as relevant inside the Canvas, where the Run Card is out of view. The node variant
// gets tighter padding so it fits the fixed 620px card.

/** Human-readable summary of the recovery pass, or null when nothing happened. */
export function describeRecovery(recovery: DatabaseRecovery | null): string | null {
  if (recovery === null) return null;
  const parts: string[] = [];
  if (recovery.restoredFromBackup) parts.push('データベースをバックアップから復元しました');
  else if (recovery.corruptionDetected)
    parts.push('データベースが破損していたため退避しました（バックアップなし）');
  if (recovery.interruptedTurns > 0)
    parts.push(
      `前回終了時に実行中だったRun ${recovery.interruptedTurns}件を中断として確定しました`,
    );
  return parts.length === 0 ? null : parts.join(' / ');
}

/** The connection line. Always present, so it has to read sanely in the ordinary case too. */
export function describeConnection(
  status: RuntimeStatus | null,
  fallbackKind: RuntimeStatus['kind'],
): { tone: 'idle' | 'running' | 'failed'; text: string } {
  const kind = status?.kind ?? fallbackKind;
  const label = RUNTIME_LABEL[kind];
  if (status?.state === 'failed')
    return {
      tone: 'failed',
      // The reason was previously discarded in main, so this line could only ever have said
      // "something failed" — now it can say which thing.
      text:
        status.userMessage === null
          ? `${label}: 接続が失われました`
          : `${label}: ${status.userMessage}`,
    };
  if (status?.state === 'running') return { tone: 'running', text: `${label}: 実行中` };
  return { tone: 'idle', text: `${label}: 待機中` };
}

export function SurfaceFooter({ variant = 'main' }: { variant?: 'main' | 'node' }) {
  const recovery = useAppStore((s) => s.recovery);
  const recoveryAcknowledged = useAppStore((s) => s.recoveryAcknowledged);
  const acknowledgeRecovery = useAppStore((s) => s.acknowledgeRecovery);
  const runtimeStatus = useAppStore((s) => s.runtimeStatus);
  const runtimeKind = useAppStore((s) => s.runtime.kind);

  const recoveryText = recoveryAcknowledged ? null : describeRecovery(recovery);
  const connection = describeConnection(runtimeStatus, runtimeKind);

  return (
    <div
      className={`surface-footer${variant === 'node' ? ' surface-footer--node' : ''}`}
      data-testid="surface-footer"
    >
      {recoveryText !== null && (
        <div className="sf-row sf-row--notice" data-testid="surface-footer-recovery">
          <TriangleAlert size={13} />
          <span className="sf-text">{recoveryText}</span>
          <button
            type="button"
            className="sf-dismiss"
            data-testid="surface-footer-recovery-dismiss"
            aria-label="復元の通知を閉じる"
            onClick={acknowledgeRecovery}
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="sf-row" data-testid="surface-footer-connection" data-tone={connection.tone}>
        <span className={`sf-dot sf-dot--${connection.tone}`} aria-hidden="true">
          {connection.tone === 'failed' ? (
            <X size={11} />
          ) : connection.tone === 'running' ? (
            <Circle size={9} />
          ) : (
            <Check size={11} />
          )}
        </span>
        <span className="sf-text">{connection.text}</span>
        {/* Background activity would sit here. Deliberately not rendered: `background_activities`
            has a domain model and persistence, but nothing in the running app ever creates one
            (verified — the only callers of createBackgroundActivity are persistence.ts itself and
            its tests), so a slot for it could only ever display a hardcoded zero. It gets a row
            once a producer exists, not before. */}
      </div>
    </div>
  );
}
