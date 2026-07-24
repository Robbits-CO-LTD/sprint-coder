import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CodexModelOption, PublicError } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import type { PreparedContext } from './context-ledger';
import {
  RUNTIME_PROTOCOL_VERSION,
  isRuntimeToMainEnvelope,
  type MainToRuntimeEnvelope,
  type RuntimeCanonicalEvent,
  type RuntimeContextFragment,
  type RuntimeTeamMcpOption,
} from '../runtime-host/protocol';

type ActiveTurn = {
  taskId: string;
  operationId: string;
  lastSeq: number;
  contextFragmentIds: string[];
};
type EventHandler = (taskId: string, turnId: string, event: RuntimeCanonicalEvent) => void;
type FailureHandler = (taskId: string, turnId: string, error: PublicError) => void;
type PrepareContext = (taskId: string, turnId: string) => PreparedContext;
type ContextAccepted = (taskId: string, turnId: string, fragmentIds: readonly string[]) => void;
export type RuntimeCapabilityReport = {
  available: boolean;
  models: CodexModelOption[];
};

export class RuntimeHostClient {
  private process: UtilityProcess | null = null;
  private runtimeInstanceId = '';
  private spawnReady: Promise<void> = Promise.resolve();
  private resolveProbe: ((report: RuntimeCapabilityReport) => void) | null = null;
  private probeResult: Promise<RuntimeCapabilityReport> = Promise.resolve({
    available: false,
    models: [],
  });
  private readonly active = new Map<string, ActiveTurn>();
  private disposed = false;

  constructor(
    private readonly onEvent: EventHandler,
    private readonly onFailure: FailureHandler,
    private readonly prepareContext?: PrepareContext,
    private readonly onContextAccepted?: ContextAccepted,
    private readonly kind: 'codex' | 'claude' = 'codex',
  ) {
    this.launch();
  }

  async probe(): Promise<RuntimeCapabilityReport> {
    if (this.process === null && !this.disposed) this.launch();
    return this.probeResult;
  }

  start(
    taskId: string,
    turnId: string,
    input: string,
    workspacePath: string | null,
    model: string,
    toolCatalogSnapshot: ToolCatalogSnapshot,
    preparedContext?: PreparedContext,
    teamMcp?: RuntimeTeamMcpOption,
  ): void {
    const contextFragments = (
      preparedContext?.fragments ??
      this.prepareContext?.(taskId, turnId).fragments ??
      []
    ).map(toRuntimeContextFragment);
    if (this.disposed) {
      this.onFailure(taskId, turnId, this.unavailableError());
      return;
    }
    if (this.process === null) this.launch();
    if (this.process === null) {
      this.onFailure(taskId, turnId, this.unavailableError());
      return;
    }
    const operationId = randomUUID();
    this.active.set(turnId, {
      taskId,
      operationId,
      lastSeq: 0,
      contextFragmentIds: contextFragments.map((fragment) => fragment.id),
    });
    this.post({
      ...this.base(taskId, turnId, operationId, 1),
      type: 'start',
      input,
      workspacePath,
      model,
      contextFragments,
      toolCatalogSnapshot,
      ...(teamMcp === undefined ? {} : { teamMcp }),
    });
  }

  cancel(taskId: string, turnId: string): void {
    const active = this.active.get(turnId);
    if (active === undefined) return;
    this.post({
      ...this.base(taskId, turnId, active.operationId, active.lastSeq + 1),
      type: 'cancel',
    });
    this.active.delete(turnId);
  }

  dispose(): void {
    this.disposed = true;
    this.active.clear();
    this.process?.kill();
    this.process = null;
  }

  private launch(): void {
    this.runtimeInstanceId = randomUUID();
    const instanceId = this.runtimeInstanceId;
    this.probeResult = new Promise<RuntimeCapabilityReport>((resolve) => {
      this.resolveProbe = resolve;
      setTimeout(() => {
        if (this.resolveProbe === resolve) {
          this.resolveProbe = null;
          resolve({ available: false, models: [] });
        }
      }, 7_000);
    });
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(
        join(__dirname, 'runtime-host.js'),
        ['--runtime-instance-id', instanceId, '--runtime-kind', this.kind],
        {
          serviceName:
            this.kind === 'claude'
              ? 'Sprint Coder Runtime Host (Claude)'
              : 'Sprint Coder Runtime Host',
          stdio: 'ignore',
        },
      );
    } catch {
      this.resolveProbe?.({ available: false, models: [] });
      this.resolveProbe = null;
      this.process = null;
      return;
    }
    this.process = child;
    this.spawnReady = new Promise<void>((resolve) =>
      child.once('spawn', () => {
        child.postMessage({ ...this.base('', '', 'hello', 1), type: 'hello' });
        resolve();
      }),
    );
    child.on('message', (message: unknown) => this.receive(instanceId, message));
    child.on('exit', () => this.handleExit(instanceId));
  }

  private receive(instanceId: string, raw: unknown): void {
    if (
      instanceId !== this.runtimeInstanceId ||
      !isRuntimeToMainEnvelope(raw) ||
      raw.runtimeInstanceId !== this.runtimeInstanceId
    )
      return;
    if (raw.type === 'hello') {
      this.resolveProbe?.(
        this.kind === 'claude'
          ? { available: raw.claudeAvailable, models: raw.claudeModels }
          : { available: raw.codexAvailable, models: raw.codexModels },
      );
      this.resolveProbe = null;
      return;
    }
    const active = this.active.get(raw.turnId);
    if (
      active === undefined ||
      active.taskId !== raw.taskId ||
      active.operationId !== raw.operationId ||
      raw.seq <= active.lastSeq
    )
      return;
    active.lastSeq = raw.seq;
    if (raw.type === 'event') {
      this.onEvent(raw.taskId, raw.turnId, raw.event);
      if (raw.event.type === 'completed') this.active.delete(raw.turnId);
    } else if (raw.type === 'started') {
      if (!sameIds(active.contextFragmentIds, raw.acceptedContextFragmentIds)) {
        this.cancel(raw.taskId, raw.turnId);
        this.onFailure(raw.taskId, raw.turnId, {
          code: 'RUNTIME_PROTOCOL_ERROR',
          userMessage: 'Runtime Hostのcontext受理応答が一致しません。',
          retryable: false,
        });
        return;
      }
      try {
        this.onContextAccepted?.(raw.taskId, raw.turnId, raw.acceptedContextFragmentIds);
      } catch {
        this.cancel(raw.taskId, raw.turnId);
        this.onFailure(raw.taskId, raw.turnId, {
          code: 'RUNTIME_FAILED',
          userMessage: 'Runtime contextの受理記録に失敗しました。',
          retryable: true,
        });
      }
    } else if (raw.type === 'error') {
      this.active.delete(raw.turnId);
      this.onFailure(raw.taskId, raw.turnId, raw.error);
    } else if (raw.type === 'exit' && !raw.canceled && raw.code !== 0) {
      this.active.delete(raw.turnId);
      this.onFailure(raw.taskId, raw.turnId, {
        code: 'RUNTIME_FAILED',
        userMessage:
          this.kind === 'claude'
            ? 'Claude runtimeが異常終了しました。'
            : 'Codex runtimeが異常終了しました。',
        retryable: true,
      });
    }
  }

  private handleExit(instanceId: string): void {
    if (instanceId !== this.runtimeInstanceId) return;
    this.resolveProbe?.({ available: false, models: [] });
    this.resolveProbe = null;
    this.process = null;
    const failures = [...this.active.entries()];
    this.active.clear();
    for (const [turnId, active] of failures)
      this.onFailure(active.taskId, turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: 'Runtime Hostが終了しました。',
        retryable: true,
      });
  }

  private post(message: MainToRuntimeEnvelope): void {
    const child = this.process;
    void this.spawnReady.then(() => {
      if (child !== null && child === this.process) child.postMessage(message);
    });
  }

  private base(
    taskId: string,
    turnId: string,
    operationId: string,
    seq: number,
  ): Omit<MainToRuntimeEnvelope, 'type'> {
    return {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: this.runtimeInstanceId,
      taskId,
      turnId,
      seq,
      operationId,
    };
  }

  private unavailableError(): PublicError {
    return {
      code: 'RUNTIME_UNAVAILABLE',
      userMessage:
        this.kind === 'claude'
          ? 'Claude runtimeを利用できません。'
          : 'Codex runtimeを利用できません。',
      retryable: false,
    };
  }
}

function toRuntimeContextFragment(
  fragment: PreparedContext['fragments'][number],
): RuntimeContextFragment {
  const authority =
    fragment.source === 'system'
      ? 'system'
      : fragment.source === 'goal' || (fragment.source === 'history' && fragment.trust === 'user')
        ? 'user'
        : 'none';
  return {
    id: fragment.id,
    source: fragment.source,
    trust: fragment.trust,
    authority,
    content: fragment.content,
  };
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
}
