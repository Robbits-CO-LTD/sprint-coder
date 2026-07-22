import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import { ContextBar } from './ContextBar';
import type { QueuedInput } from '../../types/vibe';

type SendMode = 'queue' | 'steer' | 'stopAndSend';

const MODE_LABEL: Record<SendMode, string> = {
  queue: 'キュー',
  steer: 'Steer',
  stopAndSend: 'Stop & Send',
};

const MODE_HINT: Record<SendMode, string> = {
  queue: '生成完了後にキューへ追加します',
  steer: '実行中のTurnへ追加指示を送ります（Turnが切り替わると送信し直しが必要です）',
  stopAndSend: '実行中のTurnを停止し、直ちにこのメッセージで開始します',
};

const MODE_ICON: Record<SendMode, string> = {
  queue: '➕',
  steer: '⇄',
  stopAndSend: '⏹',
};

export function Composer({ taskId }: { taskId: string }) {
  const draft = useAppStore((s) => s.draftByTask[taskId]) ?? '';
  const setDraft = useAppStore((s) => s.setDraft);
  const startTurn = useAppStore((s) => s.startTurn);
  const queueMessage = useAppStore((s) => s.queueMessage);
  const steerMessage = useAppStore((s) => s.steerMessage);
  const stopAndSend = useAppStore((s) => s.stopAndSend);
  const sending = useAppStore((s) => s.sendingByTask[taskId]) ?? false;
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const queued = useAppStore((s) => s.queuedByTask[taskId]) ?? [];
  const toast = useAppStore((s) => s.toast);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [sendMode, setSendMode] = useState<SendMode>('queue');
  const [wasTurnActive, setWasTurnActive] = useState(false);

  const turnActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  const canQueue = typeof window.vibe?.turns?.queue === 'function';
  const canSteer = typeof window.vibe?.turns?.steer === 'function';
  const canStopAndSend = typeof window.vibe?.turns?.stopAndSend === 'function';
  const hasAnyActiveModeCapability = canQueue || canSteer || canStopAndSend;

  // Reset the mode selector back to the default once the turn finishes (render-time adjustment
  // instead of an effect, per react-hooks/set-state-in-effect).
  if (turnActive !== wasTurnActive) {
    setWasTurnActive(turnActive);
    if (!turnActive) setSendMode('queue');
  }

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [draft]);

  const activeModeCapable =
    sendMode === 'queue' ? canQueue : sendMode === 'steer' ? canSteer : canStopAndSend;
  const sendDisabled = !draft.trim() || sending || (turnActive && !activeModeCapable);

  function handleSend() {
    const text = draft.trim();
    if (!text || sendDisabled) return;
    if (!turnActive) {
      void startTurn(taskId, text);
      return;
    }
    if (sendMode === 'steer' && canSteer && turn) {
      void steerMessage(taskId, text, turn.turnId);
    } else if (sendMode === 'stopAndSend' && canStopAndSend) {
      void stopAndSend(taskId, text);
    } else if (canQueue) {
      void queueMessage(taskId, text);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="composer-zone">
      <div className="composer-inner">
        <ContextBar taskId={taskId} />
        <QueuedList items={queued} />
        <div className="composer">
          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            placeholder={
              turnActive
                ? 'Turn実行中です。既定ではキューに追加されます (Enter)'
                : 'メッセージを送信 (Enterで送信 / Shift+Enterで改行)'
            }
            value={draft}
            disabled={sending}
            onChange={(e) => setDraft(taskId, e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="メッセージ入力"
          />
          <div className="composer-row">
            <button
              type="button"
              className="cmp-chip"
              disabled
              title="モデル選択は今回のスコープ外です"
            >
              GPT-6.2 mini
            </button>
            <button
              type="button"
              className="cmp-chip"
              disabled
              title="Reasoning effort選択は今回のスコープ外です"
            >
              effort: medium
            </button>
            <button
              type="button"
              className="cmp-chip"
              disabled
              title="添付は今回のスコープ外です"
              aria-label="添付"
            >
              📎
            </button>
            {turnActive && hasAnyActiveModeCapability && (
              <div className="send-mode-group" role="group" aria-label="実行中の送信方法">
                {(['queue', 'steer', 'stopAndSend'] as SendMode[])
                  .filter((mode) =>
                    mode === 'queue' ? canQueue : mode === 'steer' ? canSteer : canStopAndSend,
                  )
                  .map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`send-mode-btn${sendMode === mode ? ' active' : ''}`}
                      onClick={() => setSendMode(mode)}
                      title={MODE_HINT[mode]}
                      aria-pressed={sendMode === mode}
                    >
                      {MODE_LABEL[mode]}
                    </button>
                  ))}
              </div>
            )}
            <button
              type="button"
              className="send-btn"
              disabled={sendDisabled}
              onClick={handleSend}
              aria-label={turnActive ? `${MODE_LABEL[sendMode]}で送信` : '送信'}
              title={turnActive ? MODE_HINT[sendMode] : '送信'}
            >
              {turnActive ? MODE_ICON[sendMode] : '↑'}
            </button>
          </div>
        </div>
      </div>
      {toast && (
        <div className="surface-toast" role="status" onClick={dismissToast}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

function QueuedList({ items }: { items: QueuedInput[] }) {
  if (items.length === 0) return null;
  return (
    <div className="queued-list" aria-label="キュー投入済みの入力">
      {items.map((item) => (
        <div key={item.ordinal} className="queued-item">
          <span className="queued-ordinal">#{item.ordinal}</span>
          <span className="queued-text">{item.text}</span>
        </div>
      ))}
    </div>
  );
}
