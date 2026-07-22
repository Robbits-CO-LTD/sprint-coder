import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PublicError } from '@vibe/contracts';
import {
  RUNTIME_PROTOCOL_VERSION,
  isRuntimeToMainEnvelope,
  type MainToRuntimeEnvelope,
  type RuntimeCanonicalEvent,
} from '../runtime-host/protocol';

type ActiveTurn = { taskId: string; operationId: string; lastSeq: number };
type EventHandler = (taskId: string, turnId: string, event: RuntimeCanonicalEvent) => void;
type FailureHandler = (taskId: string, turnId: string, error: PublicError) => void;
type PrepareContext = (taskId: string, turnId: string) => void;

export class RuntimeHostClient {
  private process: UtilityProcess | null = null;
  private runtimeInstanceId = '';
  private spawnReady: Promise<void> = Promise.resolve();
  private resolveProbe: ((available: boolean) => void) | null = null;
  private probeResult: Promise<boolean> = Promise.resolve(false);
  private readonly active = new Map<string, ActiveTurn>();
  private disposed = false;

  constructor(
    private readonly onEvent: EventHandler,
    private readonly onFailure: FailureHandler,
    private readonly prepareContext?: PrepareContext,
  ) {
    this.launch();
  }

  async probe(): Promise<boolean> {
    if (this.process === null && !this.disposed) this.launch();
    return this.probeResult;
  }

  start(taskId: string, turnId: string, input: string, workspacePath: string | null): void {
    this.prepareContext?.(taskId, turnId);
    if (this.disposed) {
      this.onFailure(taskId, turnId, unavailableError());
      return;
    }
    if (this.process === null) this.launch();
    if (this.process === null) {
      this.onFailure(taskId, turnId, unavailableError());
      return;
    }
    const operationId = randomUUID();
    this.active.set(turnId, { taskId, operationId, lastSeq: 0 });
    this.post({
      ...this.base(taskId, turnId, operationId, 1),
      type: 'start',
      input,
      workspacePath,
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
    this.probeResult = new Promise<boolean>((resolve) => {
      this.resolveProbe = resolve;
      setTimeout(() => {
        if (this.resolveProbe === resolve) {
          this.resolveProbe = null;
          resolve(false);
        }
      }, 7_000);
    });
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(
        join(__dirname, 'runtime-host.js'),
        ['--runtime-instance-id', instanceId],
        { serviceName: 'Vibe Codex Runtime Host', stdio: 'ignore' },
      );
    } catch {
      this.resolveProbe?.(false);
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
      this.resolveProbe?.(raw.codexAvailable);
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
    } else if (raw.type === 'error') {
      this.active.delete(raw.turnId);
      this.onFailure(raw.taskId, raw.turnId, raw.error);
    } else if (raw.type === 'exit' && !raw.canceled && raw.code !== 0) {
      this.active.delete(raw.turnId);
      this.onFailure(raw.taskId, raw.turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: 'Codex runtimeが異常終了しました。',
        retryable: true,
      });
    }
  }

  private handleExit(instanceId: string): void {
    if (instanceId !== this.runtimeInstanceId) return;
    this.resolveProbe?.(false);
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
}

function unavailableError(): PublicError {
  return {
    code: 'RUNTIME_UNAVAILABLE',
    userMessage: 'Codex runtimeを利用できません。',
    retryable: false,
  };
}
