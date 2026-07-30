import { randomUUID } from 'node:crypto';
import type { ChatMessage, RuntimeKind, RuntimeWriteScope } from '@sprint-coder/contracts';
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
import type { TeamEnvelope } from '@sprint-coder/domain';
import type { RuntimeTeamMcpOption } from '../runtime-host/protocol';

// Real Worker execution (Phase 7 follow-up: "Team must work without mocks"). Each dispatched
// Worker task runs one ephemeral, read-only/no-tools turn on a production runtime (Claude/Codex)
// through the same UtilityProcess adapter boundary as chat turns — provider output never reaches
// Main un-normalized. When no production runtime is selectable (probe failed, egress denied, or
// the app runs on the mock runtime without any real CLI available) execution fails explicitly.
// Production must never present simulated Worker output as a real Team report.

type RealRuntimeChoice = Readonly<{ kind: 'claude' | 'codex'; model: string }>;

export type TeamWorkerRuntimeDeps = Readonly<{
  /** Which real runtime (if any) worker executions should use right now. */
  selectRuntime: () => RealRuntimeChoice | null;
  workspaceFor: (taskId: string) => string | null;
  catalogFor: (kind: 'claude' | 'codex', workspacePath: string | null) => unknown;
  /** Provider egress gate; returns false when policy denies the dispatch. */
  authorizeEgress: (
    kind: 'claude' | 'codex',
    taskId: string,
    turnId: string,
    prompt: string,
  ) => boolean;
  contextFor?: (worker: AgentRecord) => PreparedContext;
  writeScopeFor?: (worker: AgentRecord, workspacePath: string | null) => RuntimeWriteScope;
  teamMcpFor?: (worker: AgentRecord, turnId: string) => RuntimeTeamMcpOption | undefined;
  releaseTeamMcp?: (turnId: string) => void;
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
};

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
        if (event.type === 'stage')
          run.onEvent?.({
            type: 'activity',
            phase: event.stage,
            label: stageLabel(event.stage),
            at: new Date().toISOString(),
          });
        if (event.type === 'delta') {
          run.buffer.push(event.delta);
          run.deltaBuffer.push(event.delta);
          if (run.deltaTimer === null) run.deltaTimer = setTimeout(() => flushDelta(run), 75);
        }
        if (event.type === 'reasoning' && !run.reasoningActive) {
          run.reasoningActive = true;
          run.onEvent?.({ type: 'reasoningPresence', active: true });
        }
        if (event.type === 'fileChange')
          run.onEvent?.({ type: 'fileChange', changes: event.changes });
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
        run.onEvent?.({ type: 'failed', error: error.userMessage });
        this.pending.delete(turnId);
        run.reject(new Error(error.userMessage));
      },
      undefined,
      undefined,
      kind,
    );
    this.clients.set(kind, created);
    return created;
  }

  async start(worker: AgentRecord): Promise<{ pid: null }> {
    void worker;
    return { pid: null };
  }

  async execute(input: {
    worker: AgentRecord;
    envelope: TeamEnvelope;
    content: string;
    priorConversation?: readonly TeamRuntimeConversationItem[];
    onEvent?: (event: WorkerActivityEvent) => void;
  }): Promise<WorkerRuntimeResult> {
    const choice = this.deps.selectRuntime();
    if (choice === null) {
      if (this.deps.allowSimulation === true) return this.simulator.execute(input);
      throw new Error('Real Team Worker runtime is unavailable');
    }
    const capability = await this.client(choice.kind).probe();
    if (!capability.available) throw new Error(`${choice.kind} Team Worker runtime is unavailable`);

    const taskId = input.worker.taskId;
    const turnId = randomUUID();
    const prompt = [
      `あなたはチームの「${input.worker.role}」担当Workerです。`,
      `あなたのAgent ID: ${input.worker.id}`,
      `親Agent ID: ${input.worker.parentAgentId ?? 'Leader'}`,
      input.worker.objective === null ? '' : `目的: ${input.worker.objective}`,
      `Context継承: ${input.worker.contextInheritancePolicy}`,
      `Workspace書き込み: ${input.worker.writeCapable ? '許可範囲内で可' : '禁止（読み取り専用）'}`,
      '以下のLeaderからの依頼に対応し、結果を日本語で簡潔に報告してください。',
      formatPriorTeamConversation(input.priorConversation),
      '',
      `依頼: ${input.content}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    if (!this.deps.authorizeEgress(choice.kind, taskId, turnId, prompt))
      throw new Error(`${choice.kind} Team Worker egress was denied`);
    const teamMcp = this.deps.teamMcpFor?.(input.worker, turnId);
    if (input.worker.canDelegate === true && teamMcp === undefined)
      throw new Error('Manager Team MCP is unavailable');

    const workspacePath = this.deps.workspaceFor(taskId);
    const context = this.deps.contextFor?.(input.worker);
    const writeScope =
      input.worker.writeCapable === true
        ? (this.deps.writeScopeFor?.(input.worker, workspacePath) ?? 'read-only')
        : 'read-only';
    const startedAt = Date.now();
    const finalText = await new Promise<string>((resolve, reject) => {
      this.pending.set(turnId, {
        resolve,
        reject,
        buffer: [],
        ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
        deltaBuffer: [],
        deltaTimer: null,
        reasoningActive: false,
      });
      this.activeByAgent.set(input.worker.id, { kind: choice.kind, taskId, turnId });
      input.onEvent?.({ type: 'accepted', at: new Date().toISOString() });
      this.client(choice.kind).start(
        taskId,
        turnId,
        prompt,
        workspacePath,
        choice.model,
        this.deps.catalogFor(choice.kind, workspacePath) as never,
        context,
        teamMcp,
        undefined,
        writeScope,
      );
    }).finally(() => {
      this.pending.delete(turnId);
      this.activeByAgent.delete(input.worker.id);
      if (teamMcp !== undefined) this.deps.releaseTeamMcp?.(turnId);
    });

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
    };
  }

  async stop(agentId: string): Promise<void> {
    const active = this.activeByAgent.get(agentId);
    if (active === undefined) return;
    this.client(active.kind).cancel(active.taskId, active.turnId);
    const run = this.pending.get(active.turnId);
    if (run !== undefined) {
      flushDelta(run);
      run.onEvent?.({ type: 'canceled', reason: 'Worker execution stopped' });
      this.pending.delete(active.turnId);
      run.reject(new Error('Worker execution stopped'));
    }
    this.activeByAgent.delete(agentId);
  }

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
  }
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
    return { fragments: [], usageEvents: [], compacted: false };
  if (worker.contextInheritancePolicy === 'summary') {
    const content = relevant
      .slice(-6)
      .map(
        ({ author, content: message }) => `${author === 'user' ? 'User' : 'Assistant'}: ${message}`,
      )
      .join('\n')
      .slice(-8_000);
    if (content.length === 0) return { fragments: [], usageEvents: [], compacted: false };
    return {
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
