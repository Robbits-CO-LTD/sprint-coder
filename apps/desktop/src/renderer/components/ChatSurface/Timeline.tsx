import { useEffect, useRef } from 'react';
import type {
  ApprovalSummary,
  AutoPermissionDecision,
  ChatMessage,
} from '../../types/sprint-coder';
import { useAppStore } from '../../store/appStore';
import { MessageBubble } from '../MessageBubble';
import { RunCard } from '../RunCard';
import { ApprovalCard } from '../ApprovalCard';
import { CommandCard } from '../CommandCard';
import { ApprovalAuditRow } from '../ApprovalAuditRow';
import { AutoDecisionAuditRow } from '../AutoDecisionAuditRow';
import { TurnDiffCard } from '../TurnDiffCard';
import { GeneratedImageCard, MissingGeneratedImageNotice } from '../GeneratedImageCard';
import { IMAGEGEN_PREFIX } from './imagegen';

const SUGGESTIONS = ['変更をテストして、結果を要約して', 'このリポジトリの構成を教えて'];
const NO_MESSAGES: ChatMessage[] = [];
const NO_APPROVALS: ApprovalSummary[] = [];
const NO_COMMANDS: ReturnType<typeof useAppStore.getState>['commandsByTask'][string] = [];
const NO_AUTO_DECISIONS: AutoPermissionDecision[] = [];
const NO_IMAGES: ReturnType<typeof useAppStore.getState>['imagesByTask'][string] = [];

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
  const images = useAppStore((s) => s.imagesByTask[taskId]) ?? NO_IMAGES;
  const resolving = useAppStore((s) => s.resolvingApprovalIds);
  const resolveApproval = useAppStore((s) => s.resolveApproval);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isActive = turn ? turn.status === 'running' || turn.status === 'canceling' : false;

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [
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
          const turnImages =
            message.author === 'user' && message.turnId !== null
              ? images.filter((image) => image.turnId === message.turnId)
              : [];
          // A request that produced nothing must not read as success (issue #11). Detected from the
          // stored message, which is exactly why the directive is kept in the message text rather
          // than injected invisibly in the adapter.
          // Only once this message's Turn has actually stopped. The Run Card stays mounted after
          // completion (with a terminal status), so "is `turn` still about this message" is not the
          // question — "is it still working" is.
          const stillRunning =
            turn !== undefined &&
            turn.turnId === message.turnId &&
            (turn.status === 'running' || turn.status === 'canceling');
          const imageRequestUnfulfilled =
            message.author === 'user' &&
            message.turnId !== null &&
            message.content.startsWith(IMAGEGEN_PREFIX) &&
            turnImages.length === 0 &&
            !stillRunning;
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
              {turnImages.map((image) => (
                <GeneratedImageCard key={image.id} image={image} />
              ))}
              {imageRequestUnfulfilled && <MissingGeneratedImageNotice />}
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
    </div>
  );
}
