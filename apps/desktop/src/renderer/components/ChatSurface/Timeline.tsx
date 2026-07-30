import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApprovalSummary,
  AutoPermissionDecision,
  ChatMessage,
  TeamActivitySummary,
  TurnDiff,
} from '../../types/sprint-coder';
import { useAppStore } from '../../store/appStore';
import { isPinnedToBottom } from '../../lib/scroll-follow';
import { groupActivitiesByMessage } from '../../lib/team-activity-display';
import { TeamActivityCard, TeamActivityGroup } from '../TeamActivityCard';
import { ArrowDown } from '../icons';
import { MessageBubble } from '../MessageBubble';
import { RunCard } from '../RunCard';
import { ApprovalCard } from '../ApprovalCard';
import { CommandCard } from '../CommandCard';
import { ApprovalAuditRow } from '../ApprovalAuditRow';
import { AutoDecisionAuditRow } from '../AutoDecisionAuditRow';
import { TurnDiffCard } from '../TurnDiffCard';
import { GeneratedImageCard, MissingGeneratedImageNotice } from '../GeneratedImageCard';
import { FileChangeCard } from '../FileChangeCard';
import { SkillDraftCard } from '../SkillDraftCard';
import { IMAGEGEN_PREFIX } from './imagegen';
import { useLiveFileEdits } from '../../lib/useLiveFileEdits';
import {
  summarizeRuntimeChanges,
  type WorkspaceChangeSummary,
} from '../../lib/workspace-change-summary';

const SUGGESTIONS = ['変更をテストして、結果を要約して', 'このリポジトリの構成を教えて'];
const NO_MESSAGES: ChatMessage[] = [];
const NO_APPROVALS: ApprovalSummary[] = [];
const NO_COMMANDS: ReturnType<typeof useAppStore.getState>['commandsByTask'][string] = [];
const NO_AUTO_DECISIONS: AutoPermissionDecision[] = [];
const NO_IMAGES: ReturnType<typeof useAppStore.getState>['imagesByTask'][string] = [];
const NO_FILE_CHANGES: ReturnType<typeof useAppStore.getState>['fileChangesByTask'][string] = [];
const NO_ACTIVITIES: TeamActivitySummary[] = [];
const NO_SKILL_DRAFTS: ReturnType<typeof useAppStore.getState>['skillDraftsByTask'][string] = [];

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
  const fileChanges = useAppStore((s) => s.fileChangesByTask[taskId]) ?? NO_FILE_CHANGES;
  const liveFileEdits = useLiveFileEdits();
  const skillDrafts = useAppStore((s) => s.skillDraftsByTask[taskId]) ?? NO_SKILL_DRAFTS;
  const installSkillDraft = useAppStore((s) => s.installSkillDraft);
  const discardSkillDraft = useAppStore((s) => s.discardSkillDraft);
  const resolving = useAppStore((s) => s.resolvingApprovalIds);
  const resolveApproval = useAppStore((s) => s.resolveApproval);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Persisted Team history (Core C2b), slotted into the gaps between messages by `recordedAt` so
  // "誰を雇い、誰に任せたか" reads in the same column as the conversation. Message order and every
  // per-message card association below stay exactly as they were; a task with no Team activity
  // gets the shared empty grouping and renders the timeline it rendered before.
  const teamDetail = useAppStore((s) => s.teamByTask[taskId]);
  const activities = teamDetail?.activities ?? NO_ACTIVITIES;
  const activityGroups = useMemo(
    () => groupActivitiesByMessage(messages, activities),
    [messages, activities],
  );
  const assistantCreatedAtByTurn = useMemo(() => {
    const timestamps = new Map<string, number>();
    for (const message of messages) {
      if (message.author !== 'assistant' || message.turnId === null) continue;
      const createdAt = Date.parse(message.createdAt);
      if (Number.isFinite(createdAt)) timestamps.set(message.turnId, createdAt);
    }
    return timestamps;
  }, [messages]);

  const runtimeSummaryByTurn = useMemo(() => {
    const recordsByTurn = new Map<string, { changes: (typeof fileChanges)[number]['changes'] }[]>();
    for (const record of fileChanges) {
      const records = recordsByTurn.get(record.turnId) ?? [];
      records.push({ changes: record.changes });
      recordsByTurn.set(record.turnId, records);
    }
    const summaries = new Map<string, WorkspaceChangeSummary>();
    for (const [turnId, records] of recordsByTurn) {
      const summary = summarizeRuntimeChanges(turnId, records, liveFileEdits);
      if (summary !== null) summaries.set(turnId, summary);
    }
    return summaries;
  }, [fileChanges, liveFileEdits]);

  const latestAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.author === 'assistant') return message.id;
    }
    return null;
  }, [messages]);

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
    activityGroups,
    skillDrafts,
  ]);

  const isEmpty = messages.length === 0 && !turn && activityGroups.leading.length === 0;

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

        {activityGroups.leading.map((activity) => (
          <TeamActivityCard key={activity.id} activity={activity} />
        ))}

        {messages.map((message) => {
          const messageActivities = activityGroups.byMessageId[message.id] ?? [];
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
          // One card per tool call rather than one merged list per Turn (issue #37): the order and
          // grouping are what the Runtime actually did, and collapsing them would turn "edited A,
          // ran the test, then edited B" into a flat set that reads as a single batch.
          const turnFileChanges =
            message.author === 'user' && message.turnId !== null
              ? fileChanges.filter((entry) => entry.turnId === message.turnId)
              : [];
          const turnSkillDrafts =
            message.author === 'assistant' && message.turnId !== null
              ? skillDrafts.filter(({ turnId }) => turnId === message.turnId)
              : [];
          const runtimeSummary =
            message.author === 'assistant' && message.turnId !== null
              ? runtimeSummaryByTurn.get(message.turnId)
              : undefined;
          const persistedDiff =
            message.author === 'assistant' &&
            message.turnId !== null &&
            turnDiff?.turnId === message.turnId
              ? turnDiff
              : undefined;
          const workspaceDiff = mergeWorkspaceDiffs(persistedDiff, runtimeSummary?.diff);
          const workerBreakdown =
            message.id === latestAssistantMessageId
              ? (teamDetail?.workers ?? []).map((worker) => ({
                  role: worker.role,
                  status: workerStateLabel(worker.state),
                }))
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
          const activityGroupActive =
            message.author === 'user' &&
            message.turnId !== null &&
            isActive &&
            turn?.turnId === message.turnId;
          const activityStartedAtMs =
            turn?.turnId === message.turnId ? turn.startedAt : Date.parse(message.createdAt);
          const activityFinishedAtMs =
            turn?.turnId === message.turnId && turn.finishedAt !== undefined
              ? turn.finishedAt
              : message.turnId === null
                ? null
                : (assistantCreatedAtByTurn.get(message.turnId) ?? null);
          return (
            <div key={message.id} style={{ display: 'contents' }}>
              <MessageBubble author={message.author} content={message.content} />
              {showRunCardAfter && (isActive || messageActivities.length === 0) && (
                <RunCard turn={turn} taskId={taskId} onStop={() => void cancelActiveTurn(taskId)} />
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
              {turnFileChanges.map((entry) => (
                <FileChangeCard key={entry.seq} changes={entry.changes} />
              ))}
              {turnImages.map((image) => (
                <GeneratedImageCard key={image.id} image={image} />
              ))}
              {turnSkillDrafts.map(({ draft }) => (
                <SkillDraftCard
                  key={draft.id}
                  draft={draft}
                  onInstall={() => void installSkillDraft(taskId, draft)}
                  onDiscard={() => void discardSkillDraft(taskId, draft.id)}
                />
              ))}
              {imageRequestUnfulfilled && <MissingGeneratedImageNotice />}
              {workspaceDiff !== null && (
                <TurnDiffCard
                  diff={workspaceDiff}
                  lineStats={runtimeSummary?.lineStats ?? null}
                  workerBreakdown={workerBreakdown}
                  elapsedMs={
                    turn?.turnId === workspaceDiff.turnId && turn.finishedAt !== undefined
                      ? turn.finishedAt - turn.startedAt
                      : null
                  }
                />
              )}
              {messageActivities.length > 0 && (
                <TeamActivityGroup
                  activities={messageActivities}
                  active={activityGroupActive}
                  startedAtMs={activityStartedAtMs}
                  finishedAtMs={activityFinishedAtMs}
                />
              )}
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

function mergeWorkspaceDiffs(
  persisted: TurnDiff | undefined,
  runtime: TurnDiff | undefined,
): TurnDiff | null {
  if (persisted === undefined) return runtime ?? null;
  if (runtime === undefined) return persisted.entries.length === 0 ? null : persisted;
  const entries = [...runtime.entries];
  const known = new Set(
    entries.map((entry) => `${entry.path}\u0000${entry.destination ?? ''}\u0000${entry.kind}`),
  );
  for (const entry of persisted.entries) {
    const key = `${entry.path}\u0000${entry.destination ?? ''}\u0000${entry.kind}`;
    if (!known.has(key)) entries.push(entry);
  }
  return {
    turnId: runtime.turnId,
    entries: entries.map((entry, index) => ({ ...entry, ordinal: index + 1 })),
  };
}

function workerStateLabel(state: string): string {
  switch (state) {
    case 'done':
      return '完了';
    case 'busy':
      return '実行中';
    case 'waiting':
      return '待機中';
    case 'failed':
      return '失敗';
    case 'stopped':
      return '停止';
    default:
      return state;
  }
}
