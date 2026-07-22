import { useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { MessageBubble } from '../MessageBubble';
import { RunCard } from '../RunCard';

const SUGGESTIONS = ['変更をテストして、結果を要約して', 'このリポジトリの構成を教えて'];

export function Timeline({ taskId }: { taskId: string }) {
  const messages = useAppStore((s) => s.messagesByTask[taskId]) ?? [];
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const setDraft = useAppStore((s) => s.setDraft);
  const cancelActiveTurn = useAppStore((s) => s.cancelActiveTurn);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, turn?.stage, turn?.streamingContent, turn?.status]);

  const isEmpty = messages.length === 0 && !turn;

  return (
    <div className="timeline-scroll" ref={scrollRef}>
      <div className="timeline">
        {isEmpty && (
          <div className="empty-state">
            <div className="avatar-lg" aria-hidden="true">
              V
            </div>
            <h2>なんでも相談してください</h2>
            <p>Workspaceを選ばなくても会話できます。実行が必要になったら承認を求めます。</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="chip" onClick={() => setDraft(taskId, s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message) => {
          const showRunCardAfter = turn && message.author === 'user' && message.turnId === turn.turnId;
          return (
            <div key={message.id} style={{ display: 'contents' }}>
              <MessageBubble author={message.author} content={message.content} />
              {showRunCardAfter && <RunCard turn={turn} onStop={() => void cancelActiveTurn(taskId)} />}
            </div>
          );
        })}

        {isActive && turn && turn.streamingMessageId && (
          <MessageBubble author="assistant" content={turn.streamingContent} isStreaming />
        )}
      </div>
    </div>
  );
}
