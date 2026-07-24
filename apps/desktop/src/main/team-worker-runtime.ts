import { randomUUID } from 'node:crypto';
import type { RuntimeKind } from '@sprint-coder/contracts';
import { RuntimeHostClient } from './runtime-host';
import {
  DeterministicTeamWorkerRuntime,
  type TeamWorkerRuntime,
  type WorkerRuntimeResult,
} from './team-coordinator';
import type { AgentRecord } from './persistence';
import type { TeamEnvelope } from '@sprint-coder/domain';

// Real Worker execution (Phase 7 follow-up: "Team must work without mocks"). Each dispatched
// Worker task runs one ephemeral, read-only/no-tools turn on a production runtime (Claude/Codex)
// through the same UtilityProcess adapter boundary as chat turns — provider output never reaches
// Main un-normalized. When no production runtime is selectable (probe failed, egress denied, or
// the app runs on the mock runtime without any real CLI available) execution falls back to the
// deterministic simulator so tests and offline use keep working.

type RealRuntimeChoice = Readonly<{ kind: 'claude' | 'codex'; model: string }>;

export type TeamWorkerRuntimeDeps = Readonly<{
  /** Which real runtime (if any) worker executions should use right now. */
  selectRuntime: () => RealRuntimeChoice | null;
  workspaceFor: (taskId: string) => string | null;
  catalogFor: (kind: 'claude' | 'codex', workspacePath: string | null) => unknown;
  /** Provider egress gate; returns false when policy denies the dispatch. */
  authorizeEgress: (kind: 'claude' | 'codex', taskId: string, turnId: string, prompt: string) => boolean;
}>;

type PendingRun = {
  resolve: (finalText: string) => void;
  reject: (error: Error) => void;
  buffer: string[];
};

export class RuntimeHostTeamWorkerRuntime implements TeamWorkerRuntime {
  private readonly fallback = new DeterministicTeamWorkerRuntime();
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
        if (event.type === 'delta') run.buffer.push(event.delta);
        if (event.type === 'completed') {
          this.pending.delete(turnId);
          run.resolve(run.buffer.join(''));
        }
      },
      (_taskId, turnId, error) => {
        const run = this.pending.get(turnId);
        if (run === undefined) return;
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
  }): Promise<WorkerRuntimeResult> {
    const choice = this.deps.selectRuntime();
    if (choice === null) return this.fallback.execute(input);
    const capability = await this.client(choice.kind).probe();
    if (!capability.available) return this.fallback.execute(input);

    const taskId = input.worker.taskId;
    const turnId = randomUUID();
    const prompt = [
      `あなたはチームの「${input.worker.role}」担当Workerです。`,
      input.worker.objective === null ? '' : `目的: ${input.worker.objective}`,
      '以下のLeaderからの依頼に対応し、結果を日本語で簡潔に報告してください。',
      '',
      `依頼: ${input.content}`,
    ]
      .filter((line) => line !== '')
      .join('\n');
    if (!this.deps.authorizeEgress(choice.kind, taskId, turnId, prompt))
      return this.fallback.execute(input);

    const workspacePath = this.deps.workspaceFor(taskId);
    const startedAt = Date.now();
    const finalText = await new Promise<string>((resolve, reject) => {
      this.pending.set(turnId, { resolve, reject, buffer: [] });
      this.activeByAgent.set(input.worker.id, { kind: choice.kind, taskId, turnId });
      this.client(choice.kind).start(
        taskId,
        turnId,
        prompt,
        workspacePath,
        choice.model,
        this.deps.catalogFor(choice.kind, workspacePath) as never,
      );
    }).finally(() => {
      this.pending.delete(turnId);
      this.activeByAgent.delete(input.worker.id);
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
    if (active === undefined) return this.fallback.stop(agentId);
    this.client(active.kind).cancel(active.taskId, active.turnId);
    const run = this.pending.get(active.turnId);
    if (run !== undefined) {
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
