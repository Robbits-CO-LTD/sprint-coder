import { randomUUID } from 'node:crypto';
import type { ContextUsage, TurnEvent } from '@sprint-coder/contracts';
import { formatStateReminder, type LiveState } from './context-reminder';

export const CONTEXT_HARD_CAP_TOKENS = 32_000;
export const CONTEXT_SYSTEM_PROMPT =
  'あなたはSprint Coderの実行エージェントです。現在の依頼を最優先し、実際に観測したツール結果だけを使って簡潔かつ正確に回答してください。実行していないツール、存在しないWorker、届いていない報告を作ってはいけません。';

export type ContextSource = 'system' | 'history' | 'goal' | 'compaction' | 'background' | 'skill';
export type ContextTrust = 'system' | 'user' | 'assistant';

export type ContextFragment = {
  id: string;
  taskId: string;
  source: ContextSource;
  trust: ContextTrust;
  tokenEstimate: number;
  content: string;
  createdAt: string;
  messageId: string | null;
};

export type LedgerMessage = {
  id: string;
  author: 'user' | 'assistant';
  content: string;
  createdAt: string;
  fragmentId: string | null;
  supersededByCompactionId: string | null;
};

export type ContextLedgerState = {
  goal: string | null;
  messages: LedgerMessage[];
  compactions: ContextFragment[];
  background: ContextFragment[];
};

export type PersistedFragment = Omit<ContextFragment, 'content'>;

export type ProjectContextItem = Readonly<{
  id: string;
  kind: 'instruction' | 'memory' | 'reference';
  authority: 'user' | 'none';
  localOnly: boolean;
  content: string;
  sealedDigest: string;
  sourceTaskId: string | null;
  sourceTurnId: string | null;
  sourceReferenceId: string | null;
  capturedAt: string;
}>;

export interface ContextLedgerStorage {
  loadContextLedgerState(taskId: string, turnId: string): ContextLedgerState;
  recordContextFragments(fragments: PersistedFragment[]): void;
  recordContextUsage(taskId: string, turnId: string, usage: ContextUsage): TurnEvent;
  recordContextCompaction(
    taskId: string,
    turnId: string,
    fragment: ContextFragment,
    supersededFragmentIds: string[],
  ): void;
}

export type PreparedContext = {
  fragments: ContextFragment[];
  projectItems: ProjectContextItem[];
  projectSnapshotDigest: string | null;
  usageEvents: TurnEvent[];
  compacted: boolean;
};

/**
 * Supplies the live state to restate after a compaction.
 *
 * A callback rather than a constructor value because the answer is only correct at the moment the
 * context is assembled — a snapshot taken when the ledger was built would be the stale reading the
 * reminder exists to prevent. Optional, so a caller with nothing live to report keeps today's
 * behaviour unchanged.
 */
export type LiveStateSource = (taskId: string, turnId: string) => LiveState;

export class ContextLedger {
  constructor(
    private readonly storage: ContextLedgerStorage,
    private readonly liveState: LiveStateSource | null = null,
  ) {}

  prepare(taskId: string, turnId: string): PreparedContext {
    const state = this.storage.loadContextLedgerState(taskId, turnId);
    const now = new Date().toISOString();
    const persisted: PersistedFragment[] = [];
    const system = makeFragment(taskId, 'system', 'system', CONTEXT_SYSTEM_PROMPT, now, null);
    persisted.push(withoutContent(system));

    const goal =
      state.goal === null || state.goal.length === 0
        ? null
        : makeFragment(taskId, 'goal', 'user', state.goal, now, null);
    if (goal !== null) persisted.push(withoutContent(goal));

    const history = state.messages.map((message) => {
      const fragment: ContextFragment = {
        id: message.fragmentId ?? randomUUID(),
        taskId,
        source: 'history',
        trust: message.author,
        tokenEstimate: estimateTokens(message.content),
        content: message.content,
        createdAt: message.createdAt,
        messageId: message.id,
      };
      if (message.fragmentId === null) persisted.push(withoutContent(fragment));
      return { fragment, supersededByCompactionId: message.supersededByCompactionId };
    });
    this.storage.recordContextFragments(persisted);

    const activeHistory = history
      .filter(({ supersededByCompactionId }) => supersededByCompactionId === null)
      .map(({ fragment }) => fragment);
    const before = [
      system,
      ...(goal === null ? [] : [goal]),
      ...activeHistory,
      ...state.compactions,
      ...state.background,
    ];
    const usageEvents = [
      this.storage.recordContextUsage(taskId, turnId, aggregateContextUsage(before)),
    ];
    const superseded = selectHistoryForCompaction(activeHistory);
    if (superseded.length === 0)
      return {
        fragments: before,
        projectItems: [],
        projectSnapshotDigest: null,
        usageEvents,
        compacted: false,
      };

    const summaryContent = createCompactionStub(superseded);
    const compaction = makeFragment(
      taskId,
      'compaction',
      lowestTrust(superseded),
      summaryContent,
      now,
      null,
    );
    this.storage.recordContextCompaction(
      taskId,
      turnId,
      compaction,
      superseded.map((fragment) => fragment.id),
    );
    const supersededIds = new Set(superseded.map((fragment) => fragment.id));
    // Last, so it is the most recent thing the model reads: the summary above it is history, and
    // this is what is still true. Deliberately not persisted — it is derived from live state, and a
    // replayed Turn must rebuild it from the state of that moment rather than restore this one.
    const reminderContent =
      this.liveState === null ? null : formatStateReminder(this.liveState(taskId, turnId));
    const reminder =
      reminderContent === null
        ? null
        : makeFragment(taskId, 'background', 'assistant', reminderContent, now, null);
    const after = [
      system,
      ...(goal === null ? [] : [goal]),
      ...activeHistory.filter((fragment) => !supersededIds.has(fragment.id)),
      ...state.compactions,
      compaction,
      ...state.background,
      ...(reminder === null ? [] : [reminder]),
    ];
    usageEvents.push(this.storage.recordContextUsage(taskId, turnId, aggregateContextUsage(after)));
    return {
      fragments: after,
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents,
      compacted: true,
    };
  }
}

export function estimateTokens(content: string): number {
  return Math.ceil(Array.from(content).length / 3);
}

export function selectHistoryForCompaction(
  history: readonly ContextFragment[],
  hardCapTokens = CONTEXT_HARD_CAP_TOKENS,
): ContextFragment[] {
  let remaining = history.reduce((total, fragment) => total + fragment.tokenEstimate, 0);
  if (remaining <= hardCapTokens * 0.8) return [];
  const superseded: ContextFragment[] = [];
  for (const fragment of history) {
    if (remaining <= hardCapTokens * 0.5) break;
    superseded.push(fragment);
    remaining -= fragment.tokenEstimate;
  }
  return superseded;
}

export function aggregateContextUsage(
  fragments: readonly Pick<ContextFragment, 'source' | 'tokenEstimate'>[],
  projectTokens = 0,
): ContextUsage {
  const tokensBySource = new Map<ContextSource, number>();
  for (const fragment of fragments)
    tokensBySource.set(
      fragment.source,
      (tokensBySource.get(fragment.source) ?? 0) + fragment.tokenEstimate,
    );
  const sources: ContextSource[] = [
    'system',
    'history',
    'goal',
    'compaction',
    'background',
    'skill',
  ];
  const aggregated = sources.flatMap((source) => {
    const tokens = tokensBySource.get(source);
    return tokens === undefined ? [] : [{ source, tokens }];
  });
  return {
    usedTokens: aggregated.reduce((total, fragment) => total + fragment.tokens, projectTokens),
    hardCapTokens: CONTEXT_HARD_CAP_TOKENS,
    projectTokens,
    fragments: aggregated,
  };
}

export function createCompactionStub(fragments: readonly ContextFragment[]): string {
  return fragments
    .map((fragment) => Array.from(fragment.content).slice(0, 80).join(''))
    .join('\n---\n');
}

export function defaultContextUsage(): ContextUsage {
  return aggregateContextUsage([
    { source: 'system', tokenEstimate: estimateTokens(CONTEXT_SYSTEM_PROMPT) },
  ]);
}

function makeFragment(
  taskId: string,
  source: ContextSource,
  trust: ContextTrust,
  content: string,
  createdAt: string,
  messageId: string | null,
): ContextFragment {
  return {
    id: randomUUID(),
    taskId,
    source,
    trust,
    tokenEstimate: estimateTokens(content),
    content,
    createdAt,
    messageId,
  };
}

function withoutContent(fragment: ContextFragment): PersistedFragment {
  const { content: _content, ...persisted } = fragment;
  return persisted;
}

function lowestTrust(fragments: readonly ContextFragment[]): ContextTrust {
  const rank: Record<ContextTrust, number> = { assistant: 0, user: 1, system: 2 };
  return fragments.reduce<ContextTrust>(
    (lowest, fragment) => (rank[fragment.trust] < rank[lowest] ? fragment.trust : lowest),
    'system',
  );
}
