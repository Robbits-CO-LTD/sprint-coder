import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CodexModelOption, PublicError, RuntimeWriteScope } from '@sprint-coder/contracts';
import type { ToolCatalogSnapshot } from '@sprint-coder/domain';
import type { PreparedContext } from './context-ledger';
import {
  serializeCliExecutionPayload,
  type SerializedExecutionPayload,
} from '../runtime-host/execution-payload';
import {
  RUNTIME_PROTOCOL_VERSION,
  isRuntimeToMainEnvelope,
  type MainToRuntimeEnvelope,
  type RuntimeCanonicalEvent,
  type RuntimeContextFragment,
  type RuntimeProjectContextItem,
  type RuntimeSkillInput,
  type RuntimeTeamMcpOption,
  type RuntimeWorkspaceSet,
  runtimeWorkspaceSetFromLegacyPath,
} from '../runtime-host/protocol';
import { RUNTIME_HOST_HELLO_TIMEOUT_MS } from '../runtime-host/probe-budget';
import {
  IMAGE_ATTACHMENT_CAPABILITY_MAX_AGE_MS,
  runtimeCapabilityCatalogRevision,
  type ImageAttachmentRuntimeCurrent,
  type ImageAttachmentRuntimeSnapshot,
} from './image-attachment-capability';

type ActiveTurn = {
  taskId: string;
  operationId: string;
  lastSeq: number;
  contextFragmentIds: string[];
  projectItemIds: string[];
  projectSnapshotDigest: string | null;
  payloadDigest: string;
};
export type RuntimeStopReceipt = Readonly<{
  turnId: string;
  forced: boolean;
  stoppedAt: string;
}>;
type CancelWaiter = {
  resolve(receipt: RuntimeStopReceipt): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type EventHandler = (taskId: string, turnId: string, event: RuntimeCanonicalEvent) => void;
type FailureHandler = (taskId: string, turnId: string, error: PublicError) => void;
type PrepareContext = (taskId: string, turnId: string) => PreparedContext;
type ContextAccepted = (
  taskId: string,
  turnId: string,
  fragmentIds: readonly string[],
  projectItemIds: readonly string[],
  projectSnapshotDigest: string | null,
  payloadDigest: string,
) => void;
export type RuntimeCapabilityReport = {
  available: boolean;
  readiness: 'ready' | 'authentication_required' | 'unavailable';
  models: readonly CodexModelOption[];
};
type RuntimeCapabilityState = Readonly<{
  report: RuntimeCapabilityReport;
  runtimeInstanceId: string;
  readinessRevision: number;
  catalogRevision: string;
  observedAtMs: number;
}>;

export class RuntimeHostClient {
  private process: UtilityProcess | null = null;
  private runtimeInstanceId = '';
  private spawnReady: Promise<void> = Promise.resolve();
  private resolveProbe: ((report: RuntimeCapabilityReport) => void) | null = null;
  private expectedProbeOperationId: string | null = null;
  private probeResult: Promise<RuntimeCapabilityReport> = Promise.resolve({
    available: false,
    readiness: 'unavailable',
    models: [],
  });
  private readonly active = new Map<string, ActiveTurn>();
  private readonly cancelWaiters = new Map<string, CancelWaiter>();
  private capabilityState: RuntimeCapabilityState = {
    report: { available: false, readiness: 'unavailable', models: [] },
    runtimeInstanceId: '',
    readinessRevision: 0,
    catalogRevision: runtimeCapabilityCatalogRevision([]),
    observedAtMs: 0,
  };
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

  async captureImageAttachmentCapability(): Promise<ImageAttachmentRuntimeSnapshot> {
    await this.probe();
    if (
      this.capabilityState.observedAtMs > 0 &&
      Date.now() - this.capabilityState.observedAtMs > IMAGE_ATTACHMENT_CAPABILITY_MAX_AGE_MS
    )
      await this.refreshCapabilityProbe();
    const state = this.capabilityState;
    return Object.freeze({
      runtimeKind: this.kind,
      available: state.report.available,
      readiness: state.report.readiness,
      runtimeInstanceId: state.runtimeInstanceId,
      readinessRevision: state.readinessRevision,
      catalogRevision: state.catalogRevision,
      modelIds: Object.freeze(state.report.models.map(({ id }) => id)),
      capturedAtMs: state.observedAtMs,
    });
  }

  currentImageAttachmentCapability(): ImageAttachmentRuntimeCurrent {
    const state = this.capabilityState;
    return Object.freeze({
      runtimeKind: this.kind,
      runtimeInstanceId: state.runtimeInstanceId,
      readinessRevision: state.readinessRevision,
      catalogRevision: state.catalogRevision,
    });
  }

  start(
    taskId: string,
    turnId: string,
    input: string,
    workspaceInput: RuntimeWorkspaceSet | string | null,
    model: string,
    toolCatalogSnapshot: ToolCatalogSnapshot,
    preparedContext?: PreparedContext,
    teamMcp?: RuntimeTeamMcpOption,
    // Claude-only reasoning effort (see the ADR amendment); ignored by the Codex adapter.
    effort?: string,
    // How much this Turn may write (issue #37). Decided by the caller from the Task's Access preset
    // and whether a Workspace exists — never defaulted to anything permissive here.
    writeScope?: RuntimeWriteScope,
    skills: readonly RuntimeSkillInput[] = [],
    serializedPayload?: SerializedExecutionPayload,
  ): void {
    const prepared = preparedContext ?? this.prepareContext?.(taskId, turnId);
    const workspace =
      typeof workspaceInput === 'string' || workspaceInput === null
        ? runtimeWorkspaceSetFromLegacyPath(workspaceInput)
        : workspaceInput;
    const contextFragments = (prepared?.fragments ?? []).map(toRuntimeContextFragment);
    const projectItems = (prepared?.projectItems ?? []).map(toRuntimeProjectContextItem);
    const projectSnapshotDigest = prepared?.projectSnapshotDigest ?? null;
    const payload =
      serializedPayload ??
      serializeCliExecutionPayload({
        kind: this.kind,
        request: input,
        contextFragments,
        projectItems,
        ...(teamMcp === undefined ? {} : { teamGuidance: teamMcp.guidance }),
        skills,
      });
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
      projectItemIds: projectItems.map((item) => item.id),
      projectSnapshotDigest,
      payloadDigest: payload.digest,
    });
    this.post({
      ...this.base(taskId, turnId, operationId, 1),
      type: 'start',
      input,
      workspace,
      model,
      contextFragments,
      projectItems,
      projectSnapshotDigest,
      payload: Buffer.from(payload.bytes).toString('utf8'),
      payloadDigest: payload.digest,
      skills: [...skills],
      toolCatalogSnapshot,
      ...(teamMcp === undefined ? {} : { teamMcp }),
      ...(effort === undefined ? {} : { effort }),
      ...(writeScope === undefined ? {} : { writeScope }),
    });
  }

  cancel(taskId: string, turnId: string): Promise<RuntimeStopReceipt> {
    const active = this.active.get(turnId);
    if (active === undefined)
      return Promise.resolve({
        turnId,
        forced: false,
        stoppedAt: new Date().toISOString(),
      });
    const existing = this.cancelWaiters.get(turnId);
    if (existing !== undefined)
      return new Promise<RuntimeStopReceipt>((resolve, reject) => {
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        existing.resolve = (receipt) => {
          originalResolve(receipt);
          resolve(receipt);
        };
        existing.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      });
    this.post({
      ...this.base(taskId, turnId, active.operationId, active.lastSeq + 1),
      type: 'cancel',
    });
    return new Promise<RuntimeStopReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.cancelWaiters.get(turnId);
        if (current === undefined) return;
        this.restartHostAfterUnconfirmedStop(
          new Error('Runtime stop was not confirmed within 5 seconds'),
        );
      }, 5_000);
      this.cancelWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.invalidateCapabilityState();
    const unavailable = { available: false, readiness: 'unavailable' as const, models: [] };
    this.resolveProbe?.(unavailable);
    this.resolveProbe = null;
    this.expectedProbeOperationId = null;
    this.active.clear();
    for (const [turnId, waiter] of this.cancelWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ turnId, forced: true, stoppedAt: new Date().toISOString() });
    }
    this.cancelWaiters.clear();
    this.process?.kill();
    this.process = null;
  }

  private launch(): void {
    this.runtimeInstanceId = randomUUID();
    const instanceId = this.runtimeInstanceId;
    this.invalidateCapabilityState(instanceId);
    this.probeResult = new Promise<RuntimeCapabilityReport>((resolve) => {
      this.resolveProbe = resolve;
      this.expectedProbeOperationId = 'hello';
      setTimeout(() => {
        if (this.resolveProbe === resolve) {
          this.resolveProbe = null;
          this.expectedProbeOperationId = null;
          const report = { available: false, readiness: 'unavailable' as const, models: [] };
          this.recordCapabilityState(instanceId, report);
          resolve(report);
        }
      }, RUNTIME_HOST_HELLO_TIMEOUT_MS);
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
      const report = { available: false, readiness: 'unavailable' as const, models: [] };
      this.recordCapabilityState(instanceId, report);
      this.resolveProbe?.(report);
      this.resolveProbe = null;
      this.expectedProbeOperationId = null;
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
      this.disposed ||
      instanceId !== this.runtimeInstanceId ||
      !isRuntimeToMainEnvelope(raw) ||
      raw.runtimeInstanceId !== this.runtimeInstanceId
    )
      return;
    if (raw.type === 'hello') {
      if (this.resolveProbe === null || raw.operationId !== this.expectedProbeOperationId) return;
      const report =
        this.kind === 'claude'
          ? {
              available: raw.claudeAvailable,
              readiness: raw.claudeReadiness,
              models: raw.claudeModels,
            }
          : {
              available: raw.codexAvailable,
              readiness: raw.codexReadiness,
              models: raw.codexModels,
            };
      this.recordCapabilityState(instanceId, report);
      this.resolveProbe?.(report);
      this.resolveProbe = null;
      this.expectedProbeOperationId = null;
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
      if (
        !sameIds(active.contextFragmentIds, raw.acceptedContextFragmentIds) ||
        !sameIds(active.projectItemIds, raw.acceptedProjectItemIds) ||
        active.projectSnapshotDigest !== raw.acceptedProjectSnapshotDigest ||
        active.payloadDigest !== raw.acceptedPayloadDigest
      ) {
        void this.cancel(raw.taskId, raw.turnId).catch(() => undefined);
        this.onFailure(raw.taskId, raw.turnId, {
          code: 'RUNTIME_PROTOCOL_ERROR',
          userMessage: 'Runtime Hostのcontext受理応答が一致しません。',
          retryable: false,
        });
        return;
      }
      try {
        this.onContextAccepted?.(
          raw.taskId,
          raw.turnId,
          raw.acceptedContextFragmentIds,
          raw.acceptedProjectItemIds,
          raw.acceptedProjectSnapshotDigest,
          raw.acceptedPayloadDigest,
        );
      } catch {
        void this.cancel(raw.taskId, raw.turnId).catch(() => undefined);
        this.onFailure(raw.taskId, raw.turnId, {
          code: 'RUNTIME_FAILED',
          userMessage: 'Runtime contextの受理記録に失敗しました。',
          retryable: true,
        });
      }
    } else if (raw.type === 'stopped') {
      this.finishCancel(raw.turnId, raw.forced);
    } else if (raw.type === 'error') {
      this.active.delete(raw.turnId);
      this.onFailure(raw.taskId, raw.turnId, raw.error);
    } else if (raw.type === 'exit') {
      if (raw.canceled) this.finishCancel(raw.turnId, false);
      else {
        this.active.delete(raw.turnId);
        if (raw.code !== 0)
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
  }

  private finishCancel(turnId: string, forced: boolean): void {
    this.active.delete(turnId);
    const waiter = this.cancelWaiters.get(turnId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.cancelWaiters.delete(turnId);
    if (forced) {
      this.restartHostAfterUnconfirmedStop(
        new Error('Runtime process tree stop could not be confirmed'),
      );
      return;
    }
    waiter.resolve({ turnId, forced: false, stoppedAt: new Date().toISOString() });
  }

  private handleExit(instanceId: string): void {
    if (instanceId !== this.runtimeInstanceId) return;
    const report = { available: false, readiness: 'unavailable' as const, models: [] };
    this.recordCapabilityState(instanceId, report);
    this.resolveProbe?.(report);
    this.resolveProbe = null;
    this.expectedProbeOperationId = null;
    this.process = null;
    const failures = [...this.active.entries()];
    this.active.clear();
    for (const [turnId, waiter] of this.cancelWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Runtime Host exited before stop confirmation'));
      this.cancelWaiters.delete(turnId);
    }
    for (const [turnId, active] of failures)
      this.onFailure(active.taskId, turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: 'Runtime Hostが終了しました。',
        retryable: true,
      });
  }

  private recordCapabilityState(runtimeInstanceId: string, report: RuntimeCapabilityReport): void {
    this.capabilityState = Object.freeze({
      report: Object.freeze({ ...report, models: Object.freeze([...report.models]) }),
      runtimeInstanceId,
      readinessRevision: this.capabilityState.readinessRevision + 1,
      catalogRevision: runtimeCapabilityCatalogRevision(report.models),
      observedAtMs: Date.now(),
    });
  }

  private invalidateCapabilityState(runtimeInstanceId = this.runtimeInstanceId): void {
    this.recordCapabilityState(runtimeInstanceId, {
      available: false,
      readiness: 'unavailable',
      models: [],
    });
  }

  private refreshCapabilityProbe(): Promise<RuntimeCapabilityReport> {
    if (this.disposed)
      return Promise.resolve({ available: false, readiness: 'unavailable', models: [] });
    if (this.process === null) return this.probe();
    if (this.resolveProbe !== null) return this.probeResult;
    const instanceId = this.runtimeInstanceId;
    const operationId = `capability-refresh:${randomUUID()}`;
    this.probeResult = new Promise<RuntimeCapabilityReport>((resolve) => {
      this.resolveProbe = resolve;
      this.expectedProbeOperationId = operationId;
      setTimeout(() => {
        if (this.resolveProbe !== resolve) return;
        this.resolveProbe = null;
        this.expectedProbeOperationId = null;
        const report = { available: false, readiness: 'unavailable' as const, models: [] };
        this.recordCapabilityState(instanceId, report);
        resolve(report);
      }, RUNTIME_HOST_HELLO_TIMEOUT_MS);
    });
    this.post({ ...this.base('', '', operationId, 1), type: 'hello' });
    return this.probeResult;
  }

  private restartHostAfterUnconfirmedStop(error: Error): void {
    const child = this.process;
    this.process = null;
    if (this.resolveProbe !== null) {
      const report = { available: false, readiness: 'unavailable' as const, models: [] };
      this.recordCapabilityState(this.runtimeInstanceId, report);
      this.resolveProbe(report);
      this.resolveProbe = null;
      this.expectedProbeOperationId = null;
    }
    const failures = [...this.active.entries()];
    this.active.clear();
    for (const [turnId, waiter] of this.cancelWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.cancelWaiters.delete(turnId);
    }
    child?.kill();
    for (const [turnId, active] of failures)
      this.onFailure(active.taskId, turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: '停止を確認できなかったためRuntime Hostを再起動しました。',
        retryable: true,
      });
    if (!this.disposed) this.launch();
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

export function toRuntimeContextFragment(
  fragment: PreparedContext['fragments'][number],
): RuntimeContextFragment {
  const authority =
    fragment.source === 'system'
      ? 'system'
      : fragment.source === 'goal' ||
          (fragment.source === 'skill' && fragment.trust === 'user') ||
          (fragment.source === 'history' && fragment.trust === 'user')
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

function toRuntimeProjectContextItem(
  item: PreparedContext['projectItems'][number],
): RuntimeProjectContextItem {
  return {
    id: item.id,
    kind: item.kind,
    authority: item.authority,
    localOnly: item.localOnly,
    sealedDigest: item.sealedDigest,
    content: item.content,
  };
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((id, index) => id === actual[index]);
}
