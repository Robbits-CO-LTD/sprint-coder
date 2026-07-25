import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApprovalSummary,
  AutoPermissionDecision,
  ChatMessage,
} from '../../types/sprint-coder';
import { useAppStore } from '../../store/appStore';
import { isPinnedToBottom } from '../../lib/scroll-follow';
import { ArrowDown } from '../icons';
import { MessageBubble } from '../MessageBubble';
import { RunCard } from '../RunCard';
import { ApprovalCard } from '../ApprovalCard';
import { CommandCard } from '../CommandCard';
import { ApprovalAuditRow } from '../ApprovalAuditRow';
import { AutoDecisionAuditRow } from '../AutoDecisionAuditRow';
import { TurnDiffCard } from '../TurnDiffCard';

const SUGGESTIONS = ['変更をテストして、結果を要約して', 'このリポジトリの構成を教えて'];
const NO_MESSAGES: ChatMessage[] = [];
const NO_APPROVALS: ApprovalSummary[] = [];
const NO_COMMANDS: ReturnType<typeof useAppStore.getState>['commandsByTask'][string] = [];
const NO_AUTO_DECISIONS: AutoPermissionDecision[] = [];

export function Timeline({ taskId }: { taskId: string }) {
  const messages = useAppStore((s) => s.messagesByTask[taskId]) ?? NO_MESSAGES;
  const turn = useAppStore((s) => s.turnByTask[taskId]);
  const setDraft = useAppStore((s) => s.setDraft);
  const cancelActiveTurn = useAppStore((s) => s.cancelActiveTurn);
  const approvals = useAppStore((s) => s.approvalsByTask[taskId]) ?? NO_APPROVALS;
  const commands = useAppStore((s) => s.commandsByTask[taskId]) ?? NO_COMMANDS;
  const approvalHistory = useAppStore((s) => s.approvalHistoryByTask[taskId]) ?? NO_APPROVALS;
  const autoDecisions = useAppStore((s) => s.autoDecisionsByTask[taskId]) ?? NO_AUTO_DECISIONS;
  const turnDiff = useAppStore((s) => s.turnDiffByTask[taskId]);
  const resolving = useAppStore((s) => s.resolvingApprovalIds);
  const resolveApproval = useAppStore((s) => s.resolveApproval);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  // Autoscroll follows the live tail only while the reader is actually parked at the bottom
  // (issue #3). The state is tagged with the task it was measured on so switching tasks derives
  // back to "following" without an effect having to reset it, and `setFollowState` returns the
  // previous object unchanged on a no-op so the scroll events fired by streaming autoscroll cost
  // no React render.
  const [followState, setFollowState] = useState({ taskId, following: true });
  const following = followState.taskId === taskId ? followState.following : true;

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const next = isPinnedToBottom(node);
    setFollowState((prev) =>
      prev.taskId === taskId && prev.following === next ? prev : { taskId, following: next },
    );
  }, [taskId]);

  const jumpToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
    setFollowState({ taskId, following: true });
  }, [taskId]);

  // Switching tasks starts the reader at the newest message. Timeline is not keyed by taskId, so
  // the DOM scroll position carries over from the task we just left.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [taskId]);

  useEffect(() => {
    if (!following) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [
    following,
    messages,
    approvals,
    approvalHistory,
    autoDecisions,
    commands,
    turnDiff,
    turn?.stage,
    turn?.streamingContent,
    turn?.status,
  ]);

  const isEmpty = messages.length === 0 && !turn;

  return (
    <div
      className="timeline-scroll"
      data-testid="timeline-scroll"
      ref={scrollRef}
      onScroll={handleScroll}
    >
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
          const showRunCardAfter =
            turn && message.author === 'user' && message.turnId === turn.turnId;
          const commandCards =
            message.author === 'user' && message.turnId !== null
              ? commands.filter(({ command }) => command.turnId === message.turnId)
              : [];
          const approvalRows =
            message.author === 'user' && message.turnId !== null
              ? approvalHistory.filter((approval) => approval.turnId === message.turnId)
              : [];
          const autoDecisionRows =
            message.author === 'user' && message.turnId !== null
              ? autoDecisions.filter((decision) => decision.turnId === message.turnId)
              : [];
          return (
            <div key={message.id} style={{ display: 'contents' }}>
              <MessageBubble author={message.author} content={message.content} />
              {showRunCardAfter && (
                <RunCard turn={turn} onStop={() => void cancelActiveTurn(taskId)} />
              )}
              {approvalRows.map((approval) => (
                <ApprovalAuditRow key={approval.id} approval={approval} />
              ))}
              {autoDecisionRows.map((decision) => (
                <AutoDecisionAuditRow key={decision.id} decision={decision} />
              ))}
              {commandCards.map((card) => (
                <CommandCard key={card.command.id} taskId={taskId} card={card} />
              ))}
              {turnDiff?.turnId === message.turnId && <TurnDiffCard diff={turnDiff} />}
            </div>
          );
        })}

        {isActive && turn && turn.streamingMessageId && (
          <MessageBubble author="assistant" content={turn.streamingContent} isStreaming />
        )}
        {approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            busy={resolving[approval.id] === true}
            onDecision={(decision) => void resolveApproval(taskId, approval.id, decision)}
          />
        ))}
      </div>

      {/* Sticky, zero-height rail so the button hovers over the tail of the timeline without
          taking layout space or scrolling away. Rendered only while following is off, which also
          means it never appears when there is nothing to scroll. */}
      {!following && (
        <div className="timeline-jump">
          <button
            type="button"
            className="timeline-jump-button"
            data-testid="timeline-jump-latest"
            onClick={jumpToLatest}
          >
            <ArrowDown size={14} /> 最新へ
          </button>
        </div>
      )}
    </div>
  );
}
