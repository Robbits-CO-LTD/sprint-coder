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
  type RuntimeFailureDiagnostic,
  type RuntimeImageAttachmentManifestEntry,
  type RuntimePreparedImageAttachments,
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
  taskId: string;
  operationId: string;
  resolve(receipt: RuntimeStopReceipt): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type ExitWaiter = {
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type ImagePrepareWaiter = {
  taskId: string;
  turnId: string;
  selectionIdentity: string;
  manifestDigest: string;
  decodedByteLength: number;
  resolve(value: RuntimePreparedImageAttachments): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};
type ImagePreparationPhase = {
  taskId: string;
  turnId: string;
  operationId: string;
  state: 'preparing' | 'prepared';
  receipt?: RuntimePreparedImageAttachments;
};
type EventHandler = (taskId: string, turnId: string, event: RuntimeCanonicalEvent) => void;
type FailureHandler = (
  taskId: string,
  turnId: string,
  error: PublicError,
  diagnostic?: RuntimeFailureDiagnostic,
) => void;
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
  private readonly exitWaiters = new Map<string, ExitWaiter>();
  private readonly recentExits = new Map<string, NodeJS.Timeout>();
  private readonly imagePrepareWaiters = new Map<string, ImagePrepareWaiter>();
  private readonly preparedImageReceipts = new WeakSet<object>();
  private readonly consumedImageReceipts = new WeakSet<object>();
  private readonly invalidImageReceipts = new WeakSet<object>();
  private readonly imagePreparationByTurn = new Map<string, ImagePreparationPhase>();
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
    preparedImages?: RuntimePreparedImageAttachments,
  ): boolean {
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
    if (preparedImages === undefined && this.imagePreparationByTurn.has(turnId)) {
      this.onFailure(taskId, turnId, this.imageProtocolError());
      return false;
    }
    if (this.disposed) {
      this.onFailure(taskId, turnId, this.unavailableError());
      return false;
    }
    if (this.process === null) this.launch();
    if (this.process === null) {
      this.onFailure(taskId, turnId, this.unavailableError());
      return false;
    }
    if (
      preparedImages !== undefined &&
      (!this.preparedImageReceipts.has(preparedImages) ||
        this.consumedImageReceipts.has(preparedImages) ||
        this.invalidImageReceipts.has(preparedImages) ||
        preparedImages.runtimeInstanceId !== this.runtimeInstanceId ||
        preparedImages.taskId !== taskId ||
        preparedImages.turnId !== turnId ||
        this.imagePreparationByTurn.get(turnId)?.receipt !== preparedImages)
    ) {
      this.onFailure(taskId, turnId, this.imageProtocolError());
      return false;
    }
    const operationId = preparedImages?.operationId ?? randomUUID();
    if (preparedImages !== undefined) {
      this.consumedImageReceipts.add(preparedImages);
      this.imagePreparationByTurn.delete(turnId);
    }
    this.active.set(turnId, {
      taskId,
      operationId,
      lastSeq: 0,
      contextFragmentIds: contextFragments.map((fragment) => fragment.id),
      projectItemIds: projectItems.map((item) => item.id),
      projectSnapshotDigest,
      payloadDigest: payload.digest,
    });
    const startPayload = {
      ...this.base(taskId, turnId, operationId, 1),
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
    };
    this.post(
      preparedImages === undefined
        ? { ...startPayload, type: 'start' }
        : {
            ...startPayload,
            type: 'commit_images',
            selectionIdentity: preparedImages.selectionIdentity,
            manifestDigest: preparedImages.manifestDigest,
          },
    );
    return true;
  }

  prepareImageAttachments(input: {
    taskId: string;
    turnId: string;
    selectionIdentity: string;
    manifest: readonly RuntimeImageAttachmentManifestEntry[];
    paths: readonly string[];
    manifestDigest: string;
  }): Promise<RuntimePreparedImageAttachments> {
    if (this.disposed || this.kind !== 'codex')
      return Promise.reject(new Error('Image attachment Runtime is unavailable'));
    if (this.process === null) this.launch();
    if (this.process === null)
      return Promise.reject(new Error('Image attachment Runtime is unavailable'));
    if (this.imagePreparationByTurn.has(input.turnId))
      return Promise.reject(new Error('Image attachment Runtime prepare is already active'));
    const operationId = randomUUID();
    const decodedByteLength = input.manifest.reduce((total, entry) => total + entry.byteLength, 0);
    return new Promise<RuntimePreparedImageAttachments>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.imagePrepareWaiters.get(operationId);
        if (waiter === undefined) return;
        this.imagePrepareWaiters.delete(operationId);
        const phase = this.imagePreparationByTurn.get(input.turnId);
        if (phase?.operationId === operationId) {
          this.post({
            ...this.base(input.taskId, input.turnId, operationId, 2),
            type: 'cancel',
          });
          this.invalidateImagePreparationPhase(phase);
        }
        reject(new Error('Image attachment Runtime prepare timed out'));
      }, 20_000);
      this.imagePreparationByTurn.set(input.turnId, {
        taskId: input.taskId,
        turnId: input.turnId,
        operationId,
        state: 'preparing',
      });
      this.imagePrepareWaiters.set(operationId, {
        taskId: input.taskId,
        turnId: input.turnId,
        selectionIdentity: input.selectionIdentity,
        manifestDigest: input.manifestDigest,
        decodedByteLength,
        resolve,
        reject,
        timer,
      });
      this.post({
        ...this.base(input.taskId, input.turnId, operationId, 1),
        type: 'prepare_images',
        selectionIdentity: input.selectionIdentity,
        manifest: input.manifest.map((entry) => ({ ...entry })),
        paths: [...input.paths],
        manifestDigest: input.manifestDigest,
      });
    });
  }

  cancel(taskId: string, turnId: string): Promise<RuntimeStopReceipt> {
    const existing = this.cancelWaiters.get(turnId);
    if (existing !== undefined) {
      if (existing.taskId !== taskId)
        return Promise.reject(new Error('Runtime stop Task identity mismatch'));
      return this.joinCancelWaiter(existing);
    }
    const imagePhase = this.imagePreparationByTurn.get(turnId);
    if (imagePhase !== undefined) {
      const waiter = this.imagePrepareWaiters.get(imagePhase.operationId);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        this.imagePrepareWaiters.delete(imagePhase.operationId);
        waiter.reject(new Error('Image attachment Runtime prepare was canceled'));
      }
      this.invalidateImagePreparationPhase(imagePhase);
      this.post({
        ...this.base(taskId, turnId, imagePhase.operationId, 2),
        type: 'cancel',
      });
      return this.waitForCancelConfirmation(taskId, turnId, imagePhase.operationId);
    }
    const active = this.active.get(turnId);
    if (active === undefined)
      return Promise.resolve({
        turnId,
        forced: false,
        stoppedAt: new Date().toISOString(),
      });
    this.post({
      ...this.base(taskId, turnId, active.operationId, active.lastSeq + 1),
      type: 'cancel',
    });
    return this.waitForCancelConfirmation(taskId, turnId, active.operationId);
  }

  private joinCancelWaiter(existing: CancelWaiter): Promise<RuntimeStopReceipt> {
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
  }

  private waitForCancelConfirmation(
    taskId: string,
    turnId: string,
    operationId: string,
  ): Promise<RuntimeStopReceipt> {
    return new Promise<RuntimeStopReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this.cancelWaiters.get(turnId);
        if (current === undefined) return;
        this.restartHostAfterUnconfirmedStop(
          new Error('Runtime stop was not confirmed within 5 seconds'),
        );
      }, 5_000);
      this.cancelWaiters.set(turnId, { taskId, operationId, resolve, reject, timer });
    });
  }

  /** Wait until the adapter confirms that the CLI process tree for this turn has exited. */
  waitForTurnExit(turnId: string, timeoutMs = 30_000): Promise<void> {
    const recent = this.recentExits.get(turnId);
    if (recent !== undefined) {
      clearTimeout(recent);
      this.recentExits.delete(turnId);
      return Promise.resolve();
    }
    const existing = this.exitWaiters.get(turnId);
    if (existing !== undefined)
      return Promise.reject(new Error(`Already waiting for runtime exit: ${turnId}`));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.exitWaiters.delete(turnId);
        reject(new Error('Runtime process tree exit was not confirmed within 30 seconds'));
      }, timeoutMs);
      this.exitWaiters.set(turnId, { resolve, reject, timer });
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
    this.rejectExitWaiters(new Error('Runtime Host was disposed before process exit confirmation'));
    for (const timer of this.recentExits.values()) clearTimeout(timer);
    this.recentExits.clear();
    this.rejectAllImagePrepareWaiters(new Error('Runtime Host was disposed'));
    this.invalidateAllImagePreparationPhases();
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
    // An adapter error may have already removed the active turn, but its later exit envelope is
    // still the process-tree confirmation awaited by Team cleanup.
    if (raw.type === 'exit') this.markTurnExited(raw.turnId);
    if (raw.type === 'images_prepared' || raw.type === 'images_prepare_failed') {
      const waiter = this.imagePrepareWaiters.get(raw.operationId);
      const phase = this.imagePreparationByTurn.get(raw.turnId);
      if (waiter === undefined) {
        if (raw.type === 'images_prepare_failed' && phase?.operationId === raw.operationId)
          this.invalidateImagePreparationPhase(phase);
        return;
      }
      clearTimeout(waiter.timer);
      this.imagePrepareWaiters.delete(raw.operationId);
      if (raw.type === 'images_prepare_failed') {
        if (phase?.operationId === raw.operationId) this.invalidateImagePreparationPhase(phase);
        waiter.reject(new Error(raw.error.userMessage));
        return;
      }
      if (
        raw.taskId !== waiter.taskId ||
        raw.turnId !== waiter.turnId ||
        raw.selectionIdentity !== waiter.selectionIdentity ||
        raw.manifestDigest !== waiter.manifestDigest ||
        raw.decodedByteLength !== waiter.decodedByteLength
      ) {
        this.post({
          ...this.base(waiter.taskId, waiter.turnId, raw.operationId, 2),
          type: 'cancel',
        });
        if (phase?.operationId === raw.operationId) this.invalidateImagePreparationPhase(phase);
        waiter.reject(new Error('Image attachment Runtime prepare response mismatch'));
        return;
      }
      const receipt = Object.freeze({
        runtimeInstanceId: raw.runtimeInstanceId,
        taskId: raw.taskId,
        turnId: raw.turnId,
        operationId: raw.operationId,
        selectionIdentity: raw.selectionIdentity,
        manifestDigest: raw.manifestDigest,
        decodedByteLength: raw.decodedByteLength,
      });
      this.preparedImageReceipts.add(receipt);
      if (phase?.operationId !== raw.operationId) {
        this.post({
          ...this.base(waiter.taskId, waiter.turnId, raw.operationId, 2),
          type: 'cancel',
        });
        this.invalidImageReceipts.add(receipt);
        waiter.reject(new Error('Image attachment Runtime prepare phase mismatch'));
        return;
      }
      phase.state = 'prepared';
      phase.receipt = receipt;
      waiter.resolve(receipt);
      return;
    }
    if (raw.type === 'stopped') {
      const waiter = this.cancelWaiters.get(raw.turnId);
      if (
        waiter !== undefined &&
        waiter.taskId === raw.taskId &&
        waiter.operationId === raw.operationId
      ) {
        this.finishCancel(raw.turnId, raw.forced);
        return;
      }
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
      this.onFailure(raw.taskId, raw.turnId, raw.error, raw.diagnostic);
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
    this.rejectAllImagePrepareWaiters(new Error('Runtime Host exited during image prepare'));
    this.invalidateAllImagePreparationPhases();
    const failures = [...this.active.entries()];
    this.active.clear();
    for (const [turnId, waiter] of this.cancelWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Runtime Host exited before stop confirmation'));
      this.cancelWaiters.delete(turnId);
    }
    this.rejectExitWaiters(new Error('Runtime Host exited before process exit confirmation'));
    for (const [turnId, active] of failures)
      this.onFailure(active.taskId, turnId, {
        code: 'RUNTIME_FAILED',
        userMessage: 'Runtime Hostが終了しました。',
        retryable: true,
      });
  }

  private markTurnExited(turnId: string): void {
    const waiter = this.exitWaiters.get(turnId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.exitWaiters.delete(turnId);
      waiter.resolve();
      return;
    }
    const timer = setTimeout(() => this.recentExits.delete(turnId), 60_000);
    timer.unref();
    this.recentExits.set(turnId, timer);
  }

  private rejectExitWaiters(error: Error): void {
    for (const waiter of this.exitWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.exitWaiters.clear();
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
    this.rejectAllImagePrepareWaiters(error);
    this.invalidateAllImagePreparationPhases();
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

  private imageProtocolError(): PublicError {
    return {
      code: 'RUNTIME_PROTOCOL_ERROR',
      userMessage: '画像添付のRuntime準備情報が一致しません。',
      retryable: true,
    };
  }

  private rejectAllImagePrepareWaiters(error: Error): void {
    for (const waiter of this.imagePrepareWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.imagePrepareWaiters.clear();
  }

  private invalidateImagePreparationPhase(phase: ImagePreparationPhase): void {
    if (phase.receipt !== undefined) this.invalidImageReceipts.add(phase.receipt);
    if (this.imagePreparationByTurn.get(phase.turnId) === phase)
      this.imagePreparationByTurn.delete(phase.turnId);
  }

  private invalidateAllImagePreparationPhases(): void {
    for (const phase of this.imagePreparationByTurn.values())
      if (phase.receipt !== undefined) this.invalidImageReceipts.add(phase.receipt);
    this.imagePreparationByTurn.clear();
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
