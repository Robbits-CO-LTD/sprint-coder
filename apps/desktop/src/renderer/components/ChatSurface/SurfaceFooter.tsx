import { useAppStore } from '../../store/appStore';
import { TriangleAlert, X } from './../icons';
import { RUNTIME_LABEL } from '../../lib/runtime-labels';
import type { DatabaseRecovery, RuntimeStatus } from '../../types/sprint-coder';

// SurfaceFooter (issue #9): the fifth ChatSurface element from docs §4.2, the only one that was
// never built — recovery, connection, background activity.
//
// Answering the issue's own open question ("常設1行に収めるか、異常時のみ出現させるか"):
// show the footer only when there is something abnormal to say. Idle and running state are already
// evident from the Composer and Timeline, so repeating them below the Composer adds noise.
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
  if (recovery.possibleCommittedDataLoss)
    parts.push(
      `復元前のWALに確定データが残っている可能性があります${
        recovery.corruptBundlePath === null ? '' : `（回収先: ${recovery.corruptBundlePath}）`
      }`,
    );
  if (recovery.interruptedTurns > 0)
    parts.push(
      `前回終了時に実行中だったRun ${recovery.interruptedTurns}件を中断として確定しました`,
    );
  return parts.length === 0 ? null : parts.join(' / ');
}

/** A connection failure worth surfacing, or null for ordinary idle/running states. */
export function describeConnection(
  status: RuntimeStatus | null,
  fallbackKind: RuntimeStatus['kind'],
): { tone: 'failed'; text: string } | null {
  if (status?.state !== 'failed') return null;
  const kind = status?.kind ?? fallbackKind;
  const label = RUNTIME_LABEL[kind];
  return {
    tone: 'failed',
    // The reason was previously discarded in main, so this line could only ever have said
    // "something failed" — now it can say which thing.
    text:
      status.userMessage === null
        ? `${label}: 接続が失われました`
        : `${label}: ${status.userMessage}`,
  };
}

export function SurfaceFooter({ variant = 'main' }: { variant?: 'main' | 'node' }) {
  const recovery = useAppStore((s) => s.recovery);
  const recoveryAcknowledged = useAppStore((s) => s.recoveryAcknowledged);
  const acknowledgeRecovery = useAppStore((s) => s.acknowledgeRecovery);
  const runtimeStatus = useAppStore((s) => s.runtimeStatus);
  const runtimeKind = useAppStore((s) => s.runtime.kind);

  const recoveryText = recoveryAcknowledged ? null : describeRecovery(recovery);
  const connection = describeConnection(runtimeStatus, runtimeKind);

  if (recoveryText === null && connection === null) return null;

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
      {connection !== null && (
        <div className="sf-row" data-testid="surface-footer-connection" data-tone={connection.tone}>
          <span className="sf-dot sf-dot--failed" aria-hidden="true">
            <X size={11} />
          </span>
          <span className="sf-text">{connection.text}</span>
        </div>
      )}
    </div>
  );
}
