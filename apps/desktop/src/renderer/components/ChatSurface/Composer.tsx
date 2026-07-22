import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { useAppStore } from '../../store/appStore';
import { ContextBar } from './ContextBar';

export function Composer({ taskId }: { taskId: string }) {
  const draft = useAppStore((s) => s.draftByTask[taskId]) ?? '';
  const setDraft = useAppStore((s) => s.setDraft);
  const sendMessage = useAppStore((s) => s.sendMessage);
  const cancelActiveTurn = useAppStore((s) => s.cancelActiveTurn);
  const sending = useAppStore((s) => s.sendingByTask[taskId]) ?? false;
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const turnActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;
  const busy = sending || turnActive;
  const canStop = turn && turn.status === 'running';

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 140)}px`;
  }, [draft]);

  function handleSend() {
    const text = draft.trim();
    if (!text || busy) return;
    void sendMessage(taskId, text);
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
        <ContextBar />
        <div className="composer">
          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            placeholder="メッセージを送信 (Enterで送信 / Shift+Enterで改行)"
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(taskId, e.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="メッセージ入力"
          />
          <div className="composer-row">
            <button type="button" className="cmp-chip" disabled title="モデル選択は今回のスコープ外です">
              GPT-6.2 mini
            </button>
            <button type="button" className="cmp-chip" disabled title="Reasoning effort選択は今回のスコープ外です">
              effort: medium
            </button>
            <button type="button" className="cmp-chip" disabled title="添付は今回のスコープ外です" aria-label="添付">
              📎
            </button>
            {canStop ? (
              <button
                type="button"
                className="send-btn stop"
                onClick={() => void cancelActiveTurn(taskId)}
                aria-label="生成を停止"
                title="停止"
              >
                ■
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                disabled={!draft.trim() || busy}
                onClick={handleSend}
                aria-label="送信"
                title="送信"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
