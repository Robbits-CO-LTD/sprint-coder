import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  PublicError,
  RuntimeKind,
  RuntimeWriteScope,
} from '@sprint-coder/contracts';
import { verifyToolCatalogSnapshot, type ToolCatalogSnapshot } from '@sprint-coder/domain';
import { RuntimeHostClient } from './runtime-host';
import {
  DeterministicTeamWorkerRuntime,
  type TeamRuntimeConversationItem,
  type TeamWorkerRuntime,
  type WorkerActivityEvent,
  type WorkerRuntimeResult,
} from './team-coordinator';
import type { AgentRecord } from './persistence';
import type { PreparedContext } from './context-ledger';
import { serializeCliExecutionPayload } from '../runtime-host/execution-payload';
import {
  runtimeWorkspaceSetFromLegacyPath,
  type RuntimeProcessIdentity,
  type RuntimeTeamMcpOption,
  type RuntimeToolRequest,
  type RuntimeWorkspaceSet,
} from '../runtime-host/protocol';
import { compilePromptGuidance, injectPromptGuidance } from './prompt-context';

// Real Worker execution (Phase 7 follow-up: "Team must work without mocks"). Each dispatched
// Worker task runs one ephemeral, read-only/no-tools turn on a production runtime (Claude/Codex)
// through the same UtilityProcess adapter boundary as chat turns — provider output never reaches
// Main un-normalized. When no production runtime is selectable (probe failed, egress denied, or
// the app runs on the mock runtime without any real CLI available) execution fails explicitly.
// Production must never present simulated Worker output as a real Team report.

export type RealRuntimeChoice = Readonly<{ kind: 'claude' | 'codex'; model: string }>;

const UNKNOWN_RUNTIME_RETRY_DELAY_MS = 60_000;

export class TeamRuntimeAvailabilityTracker {
  private readonly unavailableUntil = new Map<'claude' | 'codex', number>();

  isAvailable(kind: 'claude' | 'codex', now = Date.now()): boolean {
    const until = this.unavailableUntil.get(kind);
    if (until === undefined) return true;
    if (until > now) return false;
    this.unavailableUntil.delete(kind);
    return true;
  }

  markUnavailable(kind: 'claude' | 'codex', retryAt?: string, now = Date.now()): void {
    const parsed = retryAt === undefined ? Number.NaN : Date.parse(retryAt);
    this.unavailableUntil.set(
      kind,
      Number.isFinite(parsed) ? parsed : now + UNKNOWN_RUNTIME_RETRY_DELAY_MS,
    );
  }
}

export type TeamWorkerRuntimeDeps = Readonly<{
  /** Ordered, policy-allowed runtime candidates. The selected model must be first. */
  selectRuntimes: (worker: AgentRecord) => readonly RealRuntimeChoice[];
  availability: TeamRuntimeAvailabilityTracker;
  workspaceFor: (taskId: string) => string | null;
  catalogFor: (
    kind: 'claude' | 'codex',
    taskId: string,
    runtimeTurnId: string,
    workspace: RuntimeWorkspaceSet,
    worker: AgentRecord,
    writeScope: RuntimeWriteScope,
  ) => unknown | Promise<unknown>;
  /** Provider egress gate; returns false when policy denies the dispatch. */
  authorizeEgress: (
    kind: 'claude' | 'codex',
    taskId: string,
    turnId: string,
    prompt: string,
    context: PreparedContext,
  ) => boolean;
  contextFor?: (worker: AgentRecord, executionId?: string) => PreparedContext;
  writeScopeFor?: (worker: AgentRecord, workspacePath: string | null) => RuntimeWriteScope;
  teamMcpFor?: (
    worker: AgentRecord,
    turnId: string,
    executionId?: string,
    toolCatalog?: ToolCatalogSnapshot,
  ) => RuntimeTeamMcpOption | undefined;
  releaseTeamMcp?: (turnId: string) => void;
  releaseManagedTurn?: (turnId: string) => void;
  invokeManagedTool?: (
    taskId: string,
    turnId: string,
    request: RuntimeToolRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  bindTeamMcpProcess?: (turnId: string, identity: RuntimeProcessIdentity) => boolean;
  codexIsolationRoot?: string;
  codexUserConfigEnabled?: () => boolean;
  /** Explicit development/test opt-in. Production callers leave this false. */
  allowSimulation?: boolean;
}>;

type PendingRun = {
  resolve: (finalText: string) => void;
  reject: (error: Error) => void;
  buffer: string[];
  onEvent?: (event: WorkerActivityEvent) => void;
  deltaBuffer: string[];
  deltaTimer: NodeJS.Timeout | null;
  reasoningActive: boolean;
  runtimeStarted: boolean;
  sideEffectsObserved: boolean;
  writeScope: RuntimeWriteScope;
};

class TeamRuntimeExecutionError extends Error {
  constructor(
    readonly publicError: PublicError,
    readonly safeToRetry: boolean,
  ) {
    super(publicError.userMessage);
    this.name = 'TeamRuntimeExecutionError';
  }
}

type TeamWorkerExecutionInput = Parameters<TeamWorkerRuntime['execute']>[0];

export class RuntimeHostTeamWorkerRuntime implements TeamWorkerRuntime {
  private readonly simulator = new DeterministicTeamWorkerRuntime();
  private readonly clients = new Map<'claude' | 'codex', RuntimeHostClient>();
  private readonly pending = new Map<string, PendingRun>();
  private readonly activeByAgent = new Map<
    string,
    { kind: 'claude' | 'codex'; taskId: string; turnId: string }
  >();

  constructor(private readonly deps: TeamWorkerRuntimeDeps) {}

  private client(kind: 'claude' | 'codex'): RuntimeHostClient {
    const existing = this.clients.get(kind);
    if (existing !== undefined) return existing;
    const created = new RuntimeHostClient(
      (_taskId, turnId, event) => {
        const run = this.pending.get(turnId);
        if (run === undefined) return;
        if (event.type === 'heartbeat') {
          run.onEvent?.({ type: 'heartbeat', at: event.at });
          return;
        }
        if (event.type === 'stage')
          run.onEvent?.({
            type: 'activity',
            phase: event.stage,
            label: stageLabel(event.stage),
            at: new Date().toISOString(),
          });
        if (event.type === 'operation') {
          if (event.sideEffect === true) run.sideEffectsObserved = true;
          run.onEvent?.({
            type: 'activity',
            phase: event.phase,
            label: event.label,
            at: new Date().toISOString(),
          });
        }
        if (event.type === 'delta') {
          run.buffer.push(event.delta);
          run.deltaBuffer.push(event.delta);
          if (run.deltaTimer === null) run.deltaTimer = setTimeout(() => flushDelta(run), 75);
        }
        if (event.type === 'reasoning' && !run.reasoningActive) {
          run.reasoningActive = true;
          run.onEvent?.({ type: 'reasoningPresence', active: true });
        }
        if (event.type === 'completed') {
          flushDelta(run);
          if (run.reasoningActive) run.onEvent?.({ type: 'reasoningPresence', active: false });
          run.onEvent?.({ type: 'completed' });
          this.pending.delete(turnId);
          run.resolve(run.buffer.join(''));
        }
      },
      (_taskId, turnId, error) => {
        const run = this.pending.get(turnId);
        if (run === undefined) return;
        flushDelta(run);
        if (run.reasoningActive) run.onEvent?.({ type: 'reasoningPresence', active: false });
        this.pending.delete(turnId);
        run.reject(
          new TeamRuntimeExecutionError(
            error,
            !run.runtimeStarted || (run.writeScope === 'read-only' && !run.sideEffectsObserved),
          ),
        );
      },
      undefined,
      undefined,
      kind,
      this.deps.codexIsolationRoot,
      () => ({ inheritUserConfig: this.deps.codexUserConfigEnabled?.() === true }),
      (_taskId, turnId, identity) => this.deps.bindTeamMcpProcess?.(turnId, identity) === true,
      (taskId, turnId, request, signal) => {
        if (this.deps.invokeManagedTool === undefined)
          return Promise.reject(new Error('Managed Coding Harness is unavailable'));
        return this.deps.invokeManagedTool(taskId, turnId, request, signal);
      },
    );
    this.clients.set(kind, created);
    return created;
  }

  async start(worker: AgentRecord): Promise<{ pid: null }> {
    void worker;
    return { pid: null };
  }

  async execute(input: TeamWorkerExecutionInput): Promise<WorkerRuntimeResult> {
    const choices = uniqueRuntimeChoices(this.deps.selectRuntimes(input.worker)).filter(
      ({ kind }) => this.deps.availability.isAvailable(kind),
    );
    if (choices.length === 0) {
      if (this.deps.allowSimulation === true) return this.simulator.execute(input);
      throw new Error('Real Team Worker runtime is unavailable');
    }

    const taskId = input.worker.taskId;
    const prompt = [
      `あなたはチームの「${input.worker.role}」担当Workerです。`,
      `あなたのAgent ID: ${input.worker.id}`,
      `親Agent ID: ${input.worker.parentAgentId ?? 'Leader'}`,
      input.worker.objective === null ? '' : `目的: ${input.worker.objective}`,
      `Context継承: ${input.worker.contextInheritancePolicy}`,
      `Workspace書き込み: ${input.accessMode === 'workspace-write' ? '隔離範囲内で可' : '禁止（読み取り専用）'}`,
      input.workspacePath === undefined
        ? ''
        : `隔離worktree: ${input.workspacePath ?? '利用不可'}（このディレクトリ内だけを変更してください）`,
      input.workspaceSet === undefined
        ? ''
        : `隔離root: ${input.workspaceSet.roots.map(({ label, path }) => `${label}=${path}`).join(', ')}`,
      '以下のLeaderからの依頼に対応し、結果を日本語で簡潔に報告してください。',
      formatPriorTeamConversation(input.priorConversation),
      '',
      `依頼: ${input.content}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    const context = reserveTeamWorkerContext(
      applyWorkerContextInheritance(
        input.worker,
        this.deps.contextFor?.(input.worker, input.executionId) ?? emptyPreparedContext(),
      ),
    );
    const workspacePath =
      input.workspaceSet?.roots.find(({ rootId }) => rootId === input.workspaceSet?.primaryRootId)
        ?.path ??
      (input.workspacePath === undefined ? this.deps.workspaceFor(taskId) : input.workspacePath);
    const runtimeWorkspace = input.workspaceSet ?? workspacePath;
    const requestedWriteScope =
      input.accessMode === 'workspace-write' && input.worker.writeCapable === true
        ? (this.deps.writeScopeFor?.(input.worker, workspacePath) ?? 'read-only')
        : 'read-only';
    const writeScope = requestedWriteScope === 'full' ? 'workspace-write' : requestedWriteScope;
    const startedAt = Date.now();
    if (input.signal?.aborted) throw new Error('Worker execution was canceled before start');
    input.onEvent?.({ type: 'accepted', at: new Date().toISOString() });

    let lastAvailabilityError: Error | null = null;
    for (const [index, choice] of choices.entries()) {
      const capability = await this.client(choice.kind).probe();
      if (!capability.available || capability.readiness !== 'ready') {
        this.deps.availability.markUnavailable(choice.kind);
        lastAvailabilityError = new Error(`${choice.kind} Team Worker runtime is unavailable`);
        continue;
      }
      if (index > 0)
        input.onEvent?.({
          type: 'activity',
          phase: 'executing',
          label: `${runtimeLabel(choice.kind)}へfallbackして続行`,
          at: new Date().toISOString(),
        });
      try {
        const finalText = await this.executeChoice(
          input,
          choice,
          taskId,
          prompt,
          context,
          workspacePath,
          runtimeWorkspace,
          writeScope,
        );
        const summary = finalText.trim() === '' ? '(空の応答)' : finalText.trim();
        return {
          claims: {
            deliveryId: input.envelope.deliveryId,
            sourceAgentId: input.envelope.sourceAgentId,
            targetAgentId: input.envelope.targetAgentId,
          },
          completion: {
            status: 'succeeded',
            summary,
            artifacts: [],
            verification: [{ name: `worker-runtime:${choice.kind}`, outcome: 'pass' }],
            risks: [],
          },
          usage: {
            costCents: 0,
            tokens: Math.max(1, Math.ceil((prompt.length + summary.length) / 4)),
            timeMs: Date.now() - startedAt,
            toolCalls: 0,
          },
          resolution: {
            resolvedProvider: choice.kind === 'codex' ? 'openai' : 'anthropic',
            resolvedModel: choice.model,
          },
        };
      } catch (error) {
        if (!isRuntimeAvailabilityError(error)) throw error;
        this.deps.availability.markUnavailable(choice.kind, error.publicError.retryAt);
        if (!error.safeToRetry) {
          input.onEvent?.({ type: 'failed', error: error.message });
          throw error;
        }
        lastAvailabilityError = error;
      }
    }
    const failure = lastAvailabilityError ?? new Error('Real Team Worker runtime is unavailable');
    input.onEvent?.({ type: 'failed', error: failure.message });
    throw failure;
  }

  private async executeChoice(
    input: TeamWorkerExecutionInput,
    choice: RealRuntimeChoice,
    taskId: string,
    prompt: string,
    context: PreparedContext,
    workspacePath: string | null,
    runtimeWorkspace: RuntimeWorkspaceSet | string | null,
    writeScope: RuntimeWriteScope,
  ): Promise<string> {
    const turnId = randomUUID();
    const normalizedWorkspace =
      typeof runtimeWorkspace === 'string' || runtimeWorkspace === null
        ? runtimeWorkspaceSetFromLegacyPath(runtimeWorkspace)
        : runtimeWorkspace;
    const toolCatalog = await this.deps.catalogFor(
      choice.kind,
      taskId,
      turnId,
      normalizedWorkspace,
      input.worker,
      writeScope,
    );
    const promptToolCatalog: ToolCatalogSnapshot = isToolCatalogSnapshot(toolCatalog)
      ? toolCatalog
      : {
          revision: 0,
          providerId: choice.kind,
          workspaceId: null,
          entries: [],
          digest: 'unavailable',
        };
    let teamMcp: RuntimeTeamMcpOption | undefined;
    try {
      teamMcp = this.deps.teamMcpFor?.(input.worker, turnId, input.executionId, promptToolCatalog);
    } catch (error) {
      this.deps.releaseManagedTurn?.(turnId);
      throw error;
    }
    if (input.worker.canDelegate === true && teamMcp === undefined) {
      this.deps.releaseManagedTurn?.(turnId);
      throw new Error('Manager Team MCP is unavailable');
    }
    const contextFragments = injectPromptGuidance(
      context.fragments
        .filter(({ source }) => choice.kind !== 'codex' || source !== 'skill')
        .map((fragment) => ({
          id: fragment.id,
          source: fragment.source,
          trust: fragment.trust,
          authority:
            fragment.source === 'system'
              ? ('system' as const)
              : fragment.source === 'goal' ||
                  (fragment.source === 'history' && fragment.trust === 'user')
                ? ('user' as const)
                : ('none' as const),
          content: fragment.content,
        })),
      compilePromptGuidance({
        workspace: normalizedWorkspace,
        toolCatalog: promptToolCatalog,
        writeScope,
        agent: {
          role: 'subagent',
          mode: writeScope === 'read-only' ? 'read-only' : 'write-capable',
        },
        teamMcpEnabled: teamMcp !== undefined,
      }),
    );
    const serializedPayload = serializeCliExecutionPayload({
      kind: choice.kind,
      request: prompt,
      contextFragments,
      projectItems: context.projectItems.map((item) => ({
        id: item.id,
        kind: item.kind,
        authority: item.authority,
        localOnly: item.localOnly,
        sealedDigest: item.sealedDigest,
        content: item.content,
      })),
      ...(teamMcp === undefined ? {} : { teamGuidance: teamMcp.guidance }),
    });
    if (!this.deps.authorizeEgress(choice.kind, taskId, turnId, serializedPayload.text, context)) {
      if (teamMcp !== undefined) this.deps.releaseTeamMcp?.(turnId);
      this.deps.releaseManagedTurn?.(turnId);
      throw new Error(`${choice.kind} Team Worker egress was denied`);
    }
    const abort = (): void => {
      void this.stop(input.worker.id).catch(() => undefined);
    };
    input.signal?.addEventListener('abort', abort, { once: true });
    let runtimeStarted = false;
    try {
      return await new Promise<string>((resolve, reject) => {
        this.pending.set(turnId, {
          resolve,
          reject,
          buffer: [],
          ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
          deltaBuffer: [],
          deltaTimer: null,
          reasoningActive: false,
          runtimeStarted: false,
          sideEffectsObserved: false,
          writeScope,
        });
        this.activeByAgent.set(input.worker.id, { kind: choice.kind, taskId, turnId });
        runtimeStarted = this.client(choice.kind).start(
          taskId,
          turnId,
          prompt,
          runtimeWorkspace,
          choice.model,
          toolCatalog as never,
          context,
          teamMcp,
          undefined,
          writeScope,
          [],
          serializedPayload,
          undefined,
        );
        const run = this.pending.get(turnId);
        if (run !== undefined) run.runtimeStarted = runtimeStarted;
      });
    } finally {
      try {
        if (runtimeStarted) await this.client(choice.kind).waitForTurnExit(turnId);
      } finally {
        input.signal?.removeEventListener('abort', abort);
        this.pending.delete(turnId);
        if (this.activeByAgent.get(input.worker.id)?.turnId === turnId)
          this.activeByAgent.delete(input.worker.id);
        if (teamMcp !== undefined) this.deps.releaseTeamMcp?.(turnId);
        this.deps.releaseManagedTurn?.(turnId);
      }
    }
  }

  recordManagedToolResult(turnId: string, result: unknown): void {
    const run = this.pending.get(turnId);
    if (run === undefined) return;
    const changes = managedResultChanges(result);
    if (changes.length === 0) return;
    run.sideEffectsObserved = true;
    run.onEvent?.({ type: 'fileChange', changes });
  }

  async stop(agentId: string): Promise<void> {
    const active = this.activeByAgent.get(agentId);
    if (active === undefined) return;
    try {
      await this.client(active.kind).cancel(active.taskId, active.turnId);
    } finally {
      const run = this.pending.get(active.turnId);
      if (run !== undefined) {
        flushDelta(run);
        run.onEvent?.({ type: 'canceled', reason: 'Worker execution stopped' });
        this.pending.delete(active.turnId);
        run.reject(new Error('Worker execution stopped'));
      }
      if (this.activeByAgent.get(agentId)?.turnId === active.turnId)
        this.activeByAgent.delete(agentId);
    }
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
}

function managedResultChanges(
  result: unknown,
): { path: string; kind: 'add' | 'update' | 'delete' }[] {
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  const raw = Array.isArray(record['changes'])
    ? record['changes']
    : typeof record['path'] === 'string'
      ? [record]
      : [];
  return raw.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const change = item as Record<string, unknown>;
    const path = change['path'];
    const kind = change['kind'];
    return typeof path === 'string' &&
      path.length > 0 &&
      (kind === 'add' || kind === 'update' || kind === 'delete')
      ? [{ path, kind }]
      : [];
  });
}

function uniqueRuntimeChoices(choices: readonly RealRuntimeChoice[]): RealRuntimeChoice[] {
  const seen = new Set<RealRuntimeChoice['kind']>();
  return choices.filter(({ kind }) => {
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
}

function isRuntimeAvailabilityError(error: unknown): error is TeamRuntimeExecutionError {
  return (
    error instanceof TeamRuntimeExecutionError &&
    ['RUNTIME_RATE_LIMIT', 'RUNTIME_UNAVAILABLE', 'RUNTIME_CLI_MISSING'].includes(
      error.publicError.code,
    )
  );
}

function runtimeLabel(kind: RealRuntimeChoice['kind']): string {
  return kind === 'codex' ? 'Codex' : 'Claude Code';
}

function emptyPreparedContext(): PreparedContext {
  return {
    fragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    usageEvents: [],
    compacted: false,
  };
}

export function reserveTeamWorkerContext(context: PreparedContext): PreparedContext {
  const projectBytes = context.projectItems.reduce(
    (total, item) => total + Buffer.byteLength(item.content, 'utf8'),
    0,
  );
  if (
    context.projectItems.length > 256 ||
    projectBytes > 128 * 1024 ||
    context.projectItems.some((item) => Buffer.byteLength(item.content, 'utf8') > 64 * 1024)
  )
    throw new Error('Inherited Project context cannot fit the Worker protocol budget');
  let remainingBytes = 128 * 1024 - projectBytes;
  let remainingCount = 256 - context.projectItems.length;
  const fragments = [] as PreparedContext['fragments'];
  // Preserve the most recent conversation while shrinking inherited fragments first. Project
  // items are never subsetted: either every sealed item is delivered or execution fails above.
  for (const fragment of [...context.fragments].reverse()) {
    const bytes = Buffer.byteLength(fragment.content, 'utf8');
    if (remainingCount === 0 || bytes > 64 * 1024 || bytes > remainingBytes) continue;
    fragments.unshift(fragment);
    remainingBytes -= bytes;
    remainingCount -= 1;
  }
  return { ...context, fragments };
}

export function applyWorkerContextInheritance(
  worker: AgentRecord,
  sealed: PreparedContext,
): PreparedContext {
  if (
    worker.contextInheritancePolicy === 'none' ||
    worker.contextInheritancePolicy === 'selected_items'
  )
    return { ...sealed, fragments: [], compacted: false };
  if (worker.contextInheritancePolicy === 'full_fork') return sealed;
  const relevant = sealed.fragments.filter(
    ({ source, trust }) =>
      (source === 'history' || source === 'compaction') &&
      (trust === 'user' || trust === 'assistant'),
  );
  const content = relevant
    .slice(-6)
    .map(
      ({ trust, content: fragment }) => `${trust === 'user' ? 'User' : 'Assistant'}: ${fragment}`,
    )
    .join('\n')
    .slice(-8_000);
  return {
    ...sealed,
    fragments:
      content === ''
        ? []
        : [
            {
              id: `team-context-summary:${worker.id}`,
              taskId: worker.taskId,
              source: 'compaction',
              trust: 'assistant',
              tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
              content: `親Taskの直近要約コンテキスト:\n${content}`,
              createdAt: relevant.at(-1)?.createdAt ?? worker.createdAt,
              messageId: null,
            },
          ],
    compacted: content !== '',
  };
}

export function formatPriorTeamConversation(
  conversation: readonly TeamRuntimeConversationItem[] | undefined,
): string {
  if (conversation === undefined || conversation.length === 0) return '';
  return [
    '以下は、このAgent自身が以前に受送信したTeam会話です。',
    '現在の依頼を最優先し、過去の成果は参照資料としてそのまま利用してください。',
    'この内容を取得し直すためにTeamツールを呼ぶ必要はありません。',
    ...conversation.map(
      (item) =>
        `[${item.direction === 'received' ? '受信' : '送信'} / ${item.role}]\n${item.content}`,
    ),
  ].join('\n\n');
}

export function buildInheritedWorkerContext(
  worker: AgentRecord,
  messages: readonly ChatMessage[],
): PreparedContext {
  const relevant = messages.filter(({ author }) => author === 'user' || author === 'assistant');
  if (
    worker.contextInheritancePolicy === 'none' ||
    worker.contextInheritancePolicy === 'selected_items'
  )
    return {
      fragments: [],
      projectItems: [],
      projectSnapshotDigest: null,
      usageEvents: [],
      compacted: false,
    };
  if (worker.contextInheritancePolicy === 'summary') {
    const content = relevant
      .slice(-6)
      .map(
        ({ author, content: message }) => `${author === 'user' ? 'User' : 'Assistant'}: ${message}`,
      )
      .join('\n')
      .slice(-8_000);
    if (content.length === 0)
      return {
        fragments: [],
        projectItems: [],
        projectSnapshotDigest: null,
        usageEvents: [],
        compacted: false,
      };
    return {
      projectItems: [],
      projectSnapshotDigest: null,
      fragments: [
        {
          id: `team-context-summary:${worker.id}`,
          taskId: worker.taskId,
          source: 'compaction',
          trust: 'assistant',
          tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
          content: `親Taskの直近要約コンテキスト:\n${content}`,
          createdAt: relevant.at(-1)?.createdAt ?? worker.createdAt,
          messageId: null,
        },
      ],
      usageEvents: [],
      compacted: true,
    };
  }
  return {
    projectItems: [],
    projectSnapshotDigest: null,
    fragments: relevant.slice(-128).map((message) => ({
      id: `team-context:${message.id}`,
      taskId: worker.taskId,
      source: 'history' as const,
      trust: message.author,
      tokenEstimate: Math.max(1, Math.ceil(message.content.length / 4)),
      content: message.content,
      createdAt: message.createdAt,
      messageId: message.id,
    })),
    usageEvents: [],
    compacted: false,
  };
}

function isToolCatalogSnapshot(value: unknown): value is ToolCatalogSnapshot {
  return verifyToolCatalogSnapshot(value as ToolCatalogSnapshot);
}

function flushDelta(run: PendingRun): void {
  if (run.deltaTimer !== null) clearTimeout(run.deltaTimer);
  run.deltaTimer = null;
  if (run.deltaBuffer.length === 0) return;
  run.onEvent?.({ type: 'outputDelta', text: run.deltaBuffer.join('') });
  run.deltaBuffer.length = 0;
}

function stageLabel(stage: string): string {
  const labels: Record<string, string> = {
    understanding: '依頼を理解中',
    planning: '計画中',
    executing: '実行中',
    waiting_approval: '承認待ち',
    synthesizing: '報告を整理中',
  };
  return labels[stage] ?? stage;
}

/** Kind choice used by ipc: real workers follow the selected runtime; the mock runtime borrows
 *  Claude when it is installed so the default setup gets real Worker output out of the box. */
export function chooseWorkerRuntime(
  selectedKind: RuntimeKind,
  selectedModel: string,
  claudeProbablyAvailable: boolean,
): RealRuntimeChoice | null {
  if (selectedKind === 'claude' || selectedKind === 'codex')
    return { kind: selectedKind, model: selectedModel };
  return claudeProbablyAvailable ? { kind: 'claude', model: 'auto' } : null;
}
