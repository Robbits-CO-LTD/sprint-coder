import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { PreparedPatchOperation, PreparedStructuredPatch } from './structured-patch';
import { structuredPatchDigest } from './structured-patch';
import {
  createEditArtifactReference,
  validateEditArtifactReference,
  type EditArtifactOwner,
  type EditArtifactRef,
} from './edit-artifact-store';

const editSagaStates: readonly EditSagaState[] = [
  'prepared',
  'applying',
  'compensating',
  'committed',
  'restored',
  'recovery_required',
];
const editSagaStepStates: readonly EditSagaStepState[] = [
  'pending',
  'effect_pending',
  'effect_observed',
  'compensation_pending',
  'restored',
];

export type EditSagaState =
  'prepared' | 'applying' | 'compensating' | 'committed' | 'restored' | 'recovery_required';
export type EditSagaStepState =
  'pending' | 'effect_pending' | 'effect_observed' | 'compensation_pending' | 'restored';

export type FileRevisionObservation = Readonly<{
  entryKind?: never;
  identityDigest: string;
  contentHash: string;
  size: number;
}>;
export type DirectoryRevisionObservation = Readonly<{
  entryKind: 'directory';
  identityDigest: string;
  contentHash?: never;
  size?: never;
}>;
export type RevisionObservation = FileRevisionObservation | DirectoryRevisionObservation;
export type EndpointObservation =
  Readonly<{ state: 'absent' }> | Readonly<{ state: 'present'; revision: RevisionObservation }>;
export type OperationObservation = Readonly<{
  source: EndpointObservation;
  destination: EndpointObservation;
}>;

export type EditSagaStep = Readonly<{
  ordinal: number;
  operation: JournaledPatchOperation;
  state: EditSagaStepState;
  postObservation: OperationObservation | null;
  restoredObservation: OperationObservation | null;
}>;

export type TurnDiffEntry = Readonly<{
  ordinal: number;
  kind: PreparedPatchOperation['kind'];
  path: string;
  destination: string | null;
  preHash: string | null;
  postHash: string | null;
  provenance: 'agent_edit';
  status: 'applied' | 'external_drift';
  actualHash: string | null;
}>;

type TurnDiffLineage = {
  order: number;
  baselinePath: string | null;
  baselineHash: string | null;
  currentPath: string | null;
  currentHash: string | null;
  status: TurnDiffEntry['status'];
  actualHash: string | null;
};

export type JournaledPatchOperation = Readonly<{
  kind: PreparedPatchOperation['kind'];
  path: string;
  canonicalPath: string;
  destination: string | null;
  canonicalDestination: string | null;
  revisionTokenId: string | null;
  preRevision: PreparedPatchOperation['preRevision'];
  preArtifact: EditArtifactRef | null;
  postArtifact: EditArtifactRef | null;
  preHash: string | null;
  postHash: string | null;
}>;

export type EditRecoveryRecord = Readonly<{
  reason:
    'effect_outcome_unknown' | 'compensation_precondition_failed' | 'compensation_effect_unknown';
  ordinal: number;
  message: string;
  observed: OperationObservation | null;
}>;

export type EditEffectObservation =
  | Readonly<{ state: 'pre'; observation: OperationObservation }>
  | Readonly<{ state: 'post'; observation: OperationObservation }>
  | Readonly<{ state: 'drift'; observation: OperationObservation }>;

export type EditSagaSnapshot = Readonly<{
  id: string;
  taskId: string;
  turnId: string;
  operationId: string;
  planDigest: string;
  journalDigest: string;
  policyEpoch: number;
  rootId: string | null;
  workspaceKey: string | null;
  rootIdentityDigest: string | null;
  state: EditSagaState;
  revision: number;
  steps: readonly EditSagaStep[];
  diff: readonly TurnDiffEntry[];
  recovery: EditRecoveryRecord | null;
  artifactCleanupPending: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type EditSagaApplyRequest = Readonly<{
  id: string;
  taskId: string;
  turnId: string;
  operationId: string;
  plan: PreparedStructuredPatch;
  mutationBinding?: Readonly<{
    workspaceKey: string;
    rootIdentityDigest: string;
  }> &
    (
      | Readonly<{ rootId: string; workspacePath: string }>
      | Readonly<{ rootId?: never; workspacePath?: never }>
    );
  createdAt: string;
}>;

export type EditSagaCreateRequest = Readonly<{
  id: string;
  taskId: string;
  turnId: string;
  operationId: string;
  planDigest: string;
  journalDigest: string;
  policyEpoch: number;
  rootId: string | null;
  workspaceKey: string | null;
  rootIdentityDigest: string | null;
  operations: readonly JournaledPatchOperation[];
  createdAt: string;
}>;

export interface EditArtifactRepository {
  put(input: { owner: EditArtifactOwner; bytes: Buffer }): Promise<EditArtifactRef>;
  read(reference: EditArtifactRef): Promise<Buffer>;
  release(reference: EditArtifactRef): Promise<void>;
}

export type EditSagaFaultPoint =
  | Readonly<{ kind: 'afterJournalPrepared' }>
  | Readonly<{ kind: 'afterEffectBeforeJournal'; ordinal: number }>
  | Readonly<{ kind: 'beforeRestore'; ordinal: number }>
  | Readonly<{ kind: 'afterRestoreBeforeJournal'; ordinal: number }>
  | Readonly<{ kind: 'beforeFinalize' }>
  | Readonly<{ kind: 'afterTerminalBeforeCleanup' }>;

export interface EditSagaFaultInjector {
  hit(point: EditSagaFaultPoint): void | Promise<void>;
}

export interface EditEffectBoundary {
  apply(step: EditSagaStep, lease: unknown | null): Promise<OperationObservation>;
  observe(step: EditSagaStep, lease: unknown | null): Promise<EditEffectObservation>;
  restore(
    step: EditSagaStep,
    expectedPost: OperationObservation,
    lease: unknown | null,
  ): Promise<OperationObservation>;
  resume?(
    step: EditSagaStep,
    direction: 'forward' | 'compensation',
    lease: unknown | null,
  ): Promise<OperationObservation>;
}

export interface EditSagaLeaseAccess {
  current(): unknown;
}

export interface EditSagaLeaseGuard {
  acquire(saga: EditSagaSnapshot, purpose: 'forward' | 'recovery'): Promise<unknown>;
  current(lease: unknown, saga: EditSagaSnapshot): unknown;
  assertCurrent(lease: unknown, saga: EditSagaSnapshot): Promise<void>;
  release(lease: unknown, saga: EditSagaSnapshot): Promise<void>;
  stop(lease: unknown, saga: EditSagaSnapshot): Promise<void>;
}

export interface EditSagaStore {
  create(request: EditSagaCreateRequest): EditSagaSnapshot;
  find(taskId: string, turnId: string, operationId: string): EditSagaSnapshot | null;
  get(id: string): EditSagaSnapshot;
  update(
    id: string,
    expectedRevision: number,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot;
  listRecoverable(): readonly EditSagaSnapshot[];
  bindLease?(sagaId: string, resolveLease: (() => unknown) | null): void;
}

export interface DurableEditSagaPersistence {
  prepareEditSaga(request: EditSagaCreateRequest): EditSagaSnapshot;
  findEditSaga(taskId: string, turnId: string, operationId: string): EditSagaSnapshot | null;
  getEditSaga(id: string): EditSagaSnapshot;
  updateEditSaga(
    id: string,
    expectedRevision: number,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot;
  updateEditSagaUnderLease?(
    id: string,
    expectedRevision: number,
    lease: unknown,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot;
  listRecoverableEditSagas(): readonly EditSagaSnapshot[];
}

export class PersistenceEditSagaStore implements EditSagaStore {
  private readonly leases = new Map<string, () => unknown>();
  constructor(private readonly persistence: DurableEditSagaPersistence) {}
  create(request: EditSagaCreateRequest): EditSagaSnapshot {
    return this.persistence.prepareEditSaga(request);
  }
  find(taskId: string, turnId: string, operationId: string): EditSagaSnapshot | null {
    return this.persistence.findEditSaga(taskId, turnId, operationId);
  }
  get(id: string): EditSagaSnapshot {
    return this.persistence.getEditSaga(id);
  }
  update(
    id: string,
    expectedRevision: number,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot {
    const resolveLease = this.leases.get(id);
    if (resolveLease !== undefined && this.persistence.updateEditSagaUnderLease !== undefined)
      return this.persistence.updateEditSagaUnderLease(
        id,
        expectedRevision,
        resolveLease(),
        mutate,
      );
    const current = this.get(id);
    if (
      current.workspaceKey !== null &&
      current.state !== 'committed' &&
      current.state !== 'restored' &&
      current.state !== 'recovery_required'
    )
      throw new Error('Workspace-bound Edit Saga update requires a mutation lease');
    return this.persistence.updateEditSaga(id, expectedRevision, mutate);
  }
  listRecoverable(): readonly EditSagaSnapshot[] {
    return this.persistence.listRecoverableEditSagas();
  }
  bindLease(sagaId: string, resolveLease: (() => unknown) | null): void {
    if (resolveLease === null) this.leases.delete(sagaId);
    else this.leases.set(sagaId, resolveLease);
  }
}

export class EditSagaCrashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditSagaCrashError';
  }
}

export class InMemoryEditSagaStore implements EditSagaStore {
  private readonly sagas = new Map<string, EditSagaSnapshot>();
  private readonly operations = new Map<string, string>();

  create(request: EditSagaCreateRequest): EditSagaSnapshot {
    validateIdentifier(request.id, 'saga id');
    validateIdentifier(request.taskId, 'task id');
    validateIdentifier(request.turnId, 'turn id');
    validateIdentifier(request.operationId, 'operation id');
    const operationKey = JSON.stringify([request.taskId, request.turnId, request.operationId]);
    const existingId = this.operations.get(operationKey);
    if (existingId !== undefined) {
      const existing = this.get(existingId);
      if (existing.planDigest !== request.planDigest)
        throw new Error('Edit operation id was reused with another patch');
      return existing;
    }
    if (this.sagas.has(request.id)) throw new Error('Duplicate Edit Saga id');
    const snapshot = createEditSagaSnapshot(request);
    this.sagas.set(snapshot.id, snapshot);
    this.operations.set(operationKey, snapshot.id);
    return snapshot;
  }

  find(taskId: string, turnId: string, operationId: string): EditSagaSnapshot | null {
    const id = this.operations.get(JSON.stringify([taskId, turnId, operationId]));
    return id === undefined ? null : this.get(id);
  }

  get(id: string): EditSagaSnapshot {
    const snapshot = this.sagas.get(id);
    if (snapshot === undefined) throw new Error('Edit Saga not found');
    return snapshot;
  }

  update(
    id: string,
    expectedRevision: number,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot {
    const current = this.get(id);
    if (current.revision !== expectedRevision) throw new Error('Stale Edit Saga revision');
    const next = transitionEditSagaSnapshot(current, mutate);
    this.sagas.set(id, next);
    return next;
  }

  listRecoverable(): readonly EditSagaSnapshot[] {
    return [...this.sagas.values()].filter(
      (saga) => !isTerminal(saga.state) || saga.artifactCleanupPending,
    );
  }
}

export function createEditSagaSnapshot(request: EditSagaCreateRequest): EditSagaSnapshot {
  if (journaledPatchDigest(request) !== request.journalDigest)
    throw new Error('Prepared Edit journal digest mismatch');
  return parseEditSagaSnapshot({
    id: request.id,
    taskId: request.taskId,
    turnId: request.turnId,
    operationId: request.operationId,
    planDigest: request.planDigest,
    journalDigest: request.journalDigest,
    policyEpoch: request.policyEpoch,
    rootId: request.rootId,
    workspaceKey: request.workspaceKey,
    rootIdentityDigest: request.rootIdentityDigest,
    state: 'prepared',
    revision: 0,
    steps: request.operations.map((operation, index) => ({
      ordinal: index + 1,
      operation,
      state: 'pending' as const,
      postObservation: null,
      restoredObservation: null,
    })),
    diff: [],
    recovery: null,
    artifactCleanupPending: false,
    createdAt: request.createdAt,
    updatedAt: request.createdAt,
  });
}

export async function stageEditSagaRequest(
  request: EditSagaApplyRequest,
  _artifacts?: EditArtifactRepository,
): Promise<EditSagaCreateRequest> {
  if (structuredPatchDigest(request.plan) !== request.plan.digest)
    throw new Error('Prepared Edit plan digest mismatch');
  if (request.mutationBinding?.rootId !== undefined)
    assertPlanBoundToOneRoot(request.plan, request.mutationBinding);
  const operations: JournaledPatchOperation[] = [];
  for (let index = 0; index < request.plan.operations.length; index += 1) {
    const operation = request.plan.operations[index];
    if (operation === undefined) throw new Error('Prepared Edit operation is missing');
    const ordinal = index + 1;
    const preArtifact =
      operation.preImage === null
        ? null
        : createEditArtifactReference(
            { sagaId: request.id, ordinal, role: 'preimage' },
            Buffer.from(operation.preImage, 'utf8'),
          );
    const postArtifact =
      operation.postImage === null
        ? null
        : createEditArtifactReference(
            { sagaId: request.id, ordinal, role: 'postimage' },
            Buffer.from(operation.postImage, 'utf8'),
          );
    operations.push(
      Object.freeze({
        kind: operation.kind,
        path: operation.path,
        canonicalPath: operation.canonicalPath,
        destination: operation.destination,
        canonicalDestination: operation.canonicalDestination,
        revisionTokenId: operation.revisionTokenId,
        preRevision: operation.preRevision,
        preArtifact,
        postArtifact,
        preHash: operation.preHash,
        postHash: operation.postHash,
      }),
    );
  }
  const facts = {
    version: 3 as const,
    policyEpoch: request.plan.policyEpoch,
    rootId: request.mutationBinding?.rootId ?? null,
    workspaceKey: request.mutationBinding?.workspaceKey ?? null,
    rootIdentityDigest: request.mutationBinding?.rootIdentityDigest ?? null,
    operations: Object.freeze(operations),
  };
  return Object.freeze({
    id: request.id,
    taskId: request.taskId,
    turnId: request.turnId,
    operationId: request.operationId,
    planDigest: request.plan.digest,
    journalDigest: journaledPatchDigest(facts),
    policyEpoch: request.plan.policyEpoch,
    rootId: facts.rootId,
    workspaceKey: facts.workspaceKey,
    rootIdentityDigest: facts.rootIdentityDigest,
    operations: facts.operations,
    createdAt: request.createdAt,
  });
}

export function journaledPatchDigest(input: {
  version?: 2 | 3;
  policyEpoch: number;
  rootId?: string | null;
  workspaceKey: string | null;
  rootIdentityDigest: string | null;
  operations: readonly JournaledPatchOperation[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: input.version ?? 3,
        policyEpoch: input.policyEpoch,
        ...((input.version ?? 3) === 3 ? { rootId: input.rootId ?? null } : {}),
        workspaceKey: input.workspaceKey,
        rootIdentityDigest: input.rootIdentityDigest,
        operations: input.operations,
      }),
    )
    .digest('hex');
}

export function transitionEditSagaSnapshot(
  current: EditSagaSnapshot,
  mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
): EditSagaSnapshot {
  const candidate = mutate(current);
  assertStableIdentity(current, candidate);
  if (isTerminal(current.state)) validateTerminalCleanupTransition(current, candidate);
  else validateSagaTransition(current, candidate);
  return parseEditSagaSnapshot({ ...candidate, revision: current.revision + 1 });
}

export function parseEditSagaSnapshot(value: unknown): EditSagaSnapshot {
  if (!isRecord(value)) throw new Error('Invalid persisted Edit Saga');
  assertExactKeys(value, [
    'id',
    'taskId',
    'turnId',
    'operationId',
    'planDigest',
    'journalDigest',
    'policyEpoch',
    'rootId',
    'workspaceKey',
    'rootIdentityDigest',
    'state',
    'revision',
    'steps',
    'diff',
    'recovery',
    'artifactCleanupPending',
    'createdAt',
    'updatedAt',
  ]);
  const state = value['state'];
  const steps = value['steps'];
  const diff = value['diff'];
  if (
    !isString(value['id'], 200) ||
    !isString(value['taskId'], 200) ||
    !isString(value['turnId'], 200) ||
    !isString(value['operationId'], 200) ||
    !isDigest(value['planDigest']) ||
    !isDigest(value['journalDigest']) ||
    !Number.isSafeInteger(value['policyEpoch']) ||
    (value['policyEpoch'] as number) < 0 ||
    (value['rootId'] !== null && !isString(value['rootId'], 200)) ||
    !isOptionalDigest(value['workspaceKey']) ||
    !isOptionalDigest(value['rootIdentityDigest']) ||
    (value['workspaceKey'] === null) !== (value['rootIdentityDigest'] === null) ||
    (value['rootId'] !== null && value['workspaceKey'] === null) ||
    !editSagaStates.includes(state as EditSagaState) ||
    !Number.isSafeInteger(value['revision']) ||
    (value['revision'] as number) < 0 ||
    !Array.isArray(steps) ||
    steps.length < 1 ||
    steps.length > 100 ||
    !Array.isArray(diff) ||
    typeof value['artifactCleanupPending'] !== 'boolean' ||
    !isIsoDate(value['createdAt']) ||
    !isIsoDate(value['updatedAt'])
  )
    throw new Error('Invalid persisted Edit Saga');
  const snapshot = value as unknown as EditSagaSnapshot;
  for (let index = 0; index < snapshot.steps.length; index += 1) {
    const step = snapshot.steps[index];
    validatePersistedStep(step, index + 1);
    if (
      step === undefined ||
      step.operation.preArtifact?.owner.sagaId !==
        (step.operation.preArtifact === null ? undefined : snapshot.id) ||
      step.operation.postArtifact?.owner.sagaId !==
        (step.operation.postArtifact === null ? undefined : snapshot.id)
    )
      throw new Error('Persisted Edit artifact owner mismatch');
  }
  for (const entry of snapshot.diff) validatePersistedDiff(entry);
  if (snapshot.recovery !== null) validateRecovery(snapshot.recovery);
  if (
    journaledPatchDigest({
      version: 3,
      policyEpoch: snapshot.policyEpoch,
      rootId: snapshot.rootId,
      workspaceKey: snapshot.workspaceKey,
      rootIdentityDigest: snapshot.rootIdentityDigest,
      operations: snapshot.steps.map((step) => step.operation),
    }) !== snapshot.journalDigest
  )
    throw new Error('Persisted Edit Saga journal digest mismatch');
  validateSnapshotInvariants(snapshot);
  return freezeSnapshot(snapshot);
}

export class EditSagaExecutor {
  constructor(
    private readonly store: EditSagaStore,
    private readonly boundary: EditEffectBoundary,
    private readonly artifacts: EditArtifactRepository,
    private readonly fault?: EditSagaFaultInjector,
    private readonly leaseGuard?: EditSagaLeaseGuard,
  ) {}

  async apply(request: EditSagaApplyRequest): Promise<EditSagaSnapshot> {
    if (structuredPatchDigest(request.plan) !== request.plan.digest)
      throw new Error('Prepared Edit plan digest mismatch');
    const existing = this.store.find(request.taskId, request.turnId, request.operationId);
    if (existing !== null) {
      if (
        existing.planDigest !== request.plan.digest ||
        existing.rootId !== (request.mutationBinding?.rootId ?? null) ||
        (request.mutationBinding !== undefined &&
          (existing.workspaceKey !== request.mutationBinding.workspaceKey ||
            existing.rootIdentityDigest !== request.mutationBinding.rootIdentityDigest))
      )
        throw new Error('Edit operation id was reused with another patch');
      if (isTerminal(existing.state)) return this.cleanupArtifacts(existing);
      if (existing.state !== 'prepared') return this.recover(existing.id);
    }
    const saga = this.store.create(await stageEditSagaRequest(request, this.artifacts));
    if (isTerminal(saga.state)) return saga;
    if (saga.state !== 'prepared') return this.recover(saga.id);
    await this.fault?.hit({ kind: 'afterJournalPrepared' });
    return this.runWithLease(saga, 'forward', async (lease) => {
      try {
        await this.materializeArtifacts(saga, request.plan);
      } catch {
        return this.cleanupArtifacts(this.transitionTerminal(saga, 'restored', []));
      }
      return this.runForward(saga.id, lease);
    });
  }

  async recover(id: string): Promise<EditSagaSnapshot> {
    const saga = this.store.get(id);
    if (isTerminal(saga.state)) return this.cleanupArtifacts(saga);
    if (saga.state === 'prepared') {
      if (saga.workspaceKey !== null)
        return this.runWithLease(saga, 'recovery', () =>
          this.cleanupArtifacts(this.transitionTerminal(this.store.get(id), 'restored', [])),
        );
      return this.cleanupArtifacts(this.transitionTerminal(saga, 'restored', []));
    }
    if (saga.state === 'applying')
      return this.runWithLease(saga, 'recovery', (lease) => this.resumeApplying(id, lease));
    if (saga.state === 'compensating')
      return this.runWithLease(saga, 'recovery', (lease) =>
        this.compensate(id, 'resume compensation', lease),
      );
    return saga;
  }

  async reconcileAll(): Promise<readonly EditSagaSnapshot[]> {
    const results: EditSagaSnapshot[] = [];
    for (const saga of this.store.listRecoverable()) results.push(await this.recover(saga.id));
    return results;
  }

  private async materializeArtifacts(
    saga: EditSagaSnapshot,
    plan: PreparedStructuredPatch,
  ): Promise<void> {
    for (const step of saga.steps) {
      const source = plan.operations[step.ordinal - 1];
      if (source === undefined) throw new Error('Prepared Edit operation is missing');
      for (const item of [
        { reference: step.operation.preArtifact, image: source.preImage },
        { reference: step.operation.postArtifact, image: source.postImage },
      ]) {
        if (item.reference === null || item.image === null) {
          if (item.reference !== null || item.image !== null)
            throw new Error('Prepared Edit artifact shape mismatch');
          continue;
        }
        const actual = await this.artifacts.put({
          owner: item.reference.owner,
          bytes: Buffer.from(item.image, 'utf8'),
        });
        if (!sameArtifactReference(actual, item.reference))
          throw new Error('Materialized Edit artifact does not match journal');
      }
    }
  }

  private async releaseArtifacts(saga: EditSagaSnapshot): Promise<void> {
    const references = saga.steps.flatMap((step) =>
      [step.operation.preArtifact, step.operation.postArtifact].filter(
        (reference): reference is EditArtifactRef => reference !== null,
      ),
    );
    await Promise.all(references.map((reference) => this.artifacts.release(reference)));
  }

  private async runWithLease(
    saga: EditSagaSnapshot,
    purpose: 'forward' | 'recovery',
    run: (lease: unknown | null) => Promise<EditSagaSnapshot>,
  ): Promise<EditSagaSnapshot> {
    if (saga.workspaceKey !== null && this.leaseGuard === undefined)
      throw new Error('Workspace-bound Edit Saga requires a mutation lease guard');
    const lease =
      this.leaseGuard === undefined ? null : await this.leaseGuard.acquire(saga, purpose);
    this.store.bindLease?.(
      saga.id,
      lease === null || this.leaseGuard === undefined ? null : () => this.currentLease(lease, saga),
    );
    try {
      const result = await run(lease);
      if (
        lease !== null &&
        this.leaseGuard !== undefined &&
        (result.state === 'committed' || result.state === 'restored')
      )
        await this.leaseGuard.release(lease, result);
      return result;
    } finally {
      this.store.bindLease?.(saga.id, null);
      if (lease !== null && this.leaseGuard !== undefined) await this.leaseGuard.stop(lease, saga);
    }
  }

  private currentLease(lease: unknown | null, saga: EditSagaSnapshot): unknown | null {
    if (lease === null || this.leaseGuard === undefined) return null;
    return this.leaseGuard.current(lease, saga);
  }

  private leaseAccess(lease: unknown | null, saga: EditSagaSnapshot): EditSagaLeaseAccess | null {
    const guard = this.leaseGuard;
    if (lease === null || guard === undefined) return null;
    return { current: () => guard.current(lease, saga) };
  }

  private async assertLease(lease: unknown | null, saga: EditSagaSnapshot): Promise<void> {
    if (lease !== null && this.leaseGuard !== undefined)
      await this.leaseGuard.assertCurrent(lease, saga);
  }

  private async runForward(id: string, lease: unknown | null): Promise<EditSagaSnapshot> {
    let saga = this.store.get(id);
    for (const currentStep of saga.steps) {
      if (currentStep.state !== 'pending') continue;
      saga = this.updateStep(
        saga,
        currentStep.ordinal,
        (step) => ({
          ...step,
          state: 'effect_pending',
        }),
        'applying',
      );
      const step = stepAt(saga, currentStep.ordinal);
      try {
        await this.assertLease(lease, saga);
        const observation = await this.boundary.apply(step, this.leaseAccess(lease, saga));
        validatePostObservation(step, observation);
        await this.fault?.hit({ kind: 'afterEffectBeforeJournal', ordinal: step.ordinal });
        await this.assertLease(lease, saga);
        saga = this.updateStep(
          saga,
          step.ordinal,
          (value) => ({
            ...value,
            state: 'effect_observed',
            postObservation: observation,
          }),
          'applying',
        );
      } catch (error) {
        if (error instanceof EditSagaCrashError) throw error;
        return this.compensate(id, errorMessage(error), lease);
      }
    }
    try {
      await this.fault?.hit({ kind: 'beforeFinalize' });
      for (const step of saga.steps) {
        await this.assertLease(lease, saga);
        const observed = await this.boundary.observe(step, this.leaseAccess(lease, saga));
        if (observed.state !== 'post') throw new Error('Final Edit observation is not post-image');
        validatePostObservation(step, observed.observation);
        if (
          step.postObservation === null ||
          !sameOperationObservation(step.postObservation, observed.observation)
        )
          throw new Error('Final Edit identity changed after the effect was journaled');
      }
      return this.cleanupArtifacts(this.transitionTerminal(saga, 'committed', buildDiff(saga)));
    } catch (error) {
      if (error instanceof EditSagaCrashError) throw error;
      return this.compensate(id, errorMessage(error), lease);
    }
  }

  private async resumeApplying(id: string, lease: unknown | null): Promise<EditSagaSnapshot> {
    let saga = this.store.get(id);
    if (saga.steps.filter((step) => step.state === 'effect_pending').length !== 1)
      return this.compensate(id, 'interrupted during apply', lease);
    for (const step of saga.steps) {
      if (step.state !== 'effect_pending') continue;
      await this.assertLease(lease, saga);
      let observation: OperationObservation;
      if (this.boundary.resume !== undefined) {
        observation = await this.boundary.resume(step, 'forward', this.leaseAccess(lease, saga));
      } else if (step.operation.kind === 'mkdir') {
        const observed = await this.boundary.observe(step, this.leaseAccess(lease, saga));
        if (observed.state !== 'post')
          return this.compensate(id, 'interrupted during mkdir apply', lease);
        observation = observed.observation;
      } else return this.compensate(id, 'interrupted during apply', lease);
      validatePostObservation(step, observation);
      saga = this.updateStep(
        saga,
        step.ordinal,
        (current) => ({
          ...current,
          state: 'effect_observed',
          postObservation: observation,
        }),
        'applying',
      );
    }
    if (saga.steps.some((step) => step.state === 'effect_pending'))
      return this.compensate(id, 'interrupted during apply', lease);
    return this.runForward(id, lease);
  }

  private async compensate(
    id: string,
    failure: string,
    lease: unknown | null,
  ): Promise<EditSagaSnapshot> {
    let saga = this.store.get(id);
    if (saga.state !== 'compensating')
      saga = this.transition(saga, (current) => ({
        ...withoutRevision(current),
        state: 'compensating',
        updatedAt: nextTimestamp(current.updatedAt),
      }));

    for (const original of [...saga.steps].reverse()) {
      let step = stepAt(saga, original.ordinal);
      if (step.state === 'pending' || step.state === 'restored') continue;
      if (step.state === 'effect_pending') {
        if (this.boundary.resume !== undefined) {
          try {
            await this.assertLease(lease, saga);
            const observation = await this.boundary.resume(
              step,
              'forward',
              this.leaseAccess(lease, saga),
            );
            validatePostObservation(step, observation);
            saga = this.updateStep(
              saga,
              step.ordinal,
              (value) => ({ ...value, state: 'effect_observed', postObservation: observation }),
              'compensating',
            );
            step = stepAt(saga, step.ordinal);
          } catch (error) {
            return this.requireRecovery(
              saga,
              'effect_outcome_unknown',
              step.ordinal,
              errorMessage(error),
              null,
            );
          }
        } else {
          let observed: EditEffectObservation;
          try {
            await this.assertLease(lease, saga);
            observed = await this.boundary.observe(step, this.leaseAccess(lease, saga));
          } catch (error) {
            return this.requireRecovery(
              saga,
              'effect_outcome_unknown',
              step.ordinal,
              errorMessage(error),
              null,
            );
          }
          if (observed.state === 'pre') {
            saga = this.updateStep(
              saga,
              step.ordinal,
              (value) => ({
                ...value,
                state: 'restored',
              }),
              'compensating',
            );
            continue;
          }
          return this.requireRecovery(
            saga,
            'effect_outcome_unknown',
            step.ordinal,
            failure,
            observed.observation,
          );
        }
      }

      if (step.state === 'compensation_pending') {
        if (this.boundary.resume !== undefined) {
          try {
            await this.assertLease(lease, saga);
            const restored = await this.boundary.resume(
              step,
              'compensation',
              this.leaseAccess(lease, saga),
            );
            validateRestoredObservation(step, restored);
            saga = this.updateStep(
              saga,
              step.ordinal,
              (value) => ({ ...value, state: 'restored', restoredObservation: restored }),
              'compensating',
            );
            continue;
          } catch (error) {
            return this.requireRecovery(
              saga,
              'compensation_effect_unknown',
              step.ordinal,
              errorMessage(error),
              null,
            );
          }
        }
        let observed: EditEffectObservation;
        try {
          await this.assertLease(lease, saga);
          observed = await this.boundary.observe(step, this.leaseAccess(lease, saga));
        } catch (error) {
          return this.requireRecovery(
            saga,
            'compensation_effect_unknown',
            step.ordinal,
            errorMessage(error),
            null,
          );
        }
        if (observed.state === 'pre') {
          saga = this.updateStep(
            saga,
            step.ordinal,
            (value) => ({
              ...value,
              state: 'restored',
            }),
            'compensating',
          );
          continue;
        }
        if (observed.state === 'drift')
          return this.requireRecovery(
            saga,
            'compensation_effect_unknown',
            step.ordinal,
            failure,
            observed.observation,
          );
        if (
          observed.state === 'post' &&
          (step.postObservation === null ||
            !sameOperationObservation(step.postObservation, observed.observation))
        )
          return this.requireRecovery(
            saga,
            'compensation_effect_unknown',
            step.ordinal,
            'Edit identity changed during compensation',
            observed.observation,
          );
      }

      const expectedPost = step.postObservation;
      if (expectedPost === null)
        return this.requireRecovery(saga, 'effect_outcome_unknown', step.ordinal, failure, null);
      saga = this.updateStep(
        saga,
        step.ordinal,
        (value) => ({
          ...value,
          state: 'compensation_pending',
        }),
        'compensating',
      );
      step = stepAt(saga, step.ordinal);
      try {
        await this.fault?.hit({ kind: 'beforeRestore', ordinal: step.ordinal });
        await this.assertLease(lease, saga);
        const restored = await this.boundary.restore(
          step,
          expectedPost,
          this.leaseAccess(lease, saga),
        );
        validateRestoredObservation(step, restored);
        await this.fault?.hit({ kind: 'afterRestoreBeforeJournal', ordinal: step.ordinal });
        saga = this.updateStep(
          saga,
          step.ordinal,
          (value) => ({
            ...value,
            state: 'restored',
            restoredObservation: restored,
          }),
          'compensating',
        );
      } catch (error) {
        if (error instanceof EditSagaCrashError) throw error;
        let observed: EditEffectObservation | null = null;
        try {
          await this.assertLease(lease, saga);
          observed = await this.boundary.observe(step, this.leaseAccess(lease, saga));
        } catch {
          // A missing or corrupted artifact is itself recovery evidence; never retry blindly.
        }
        return this.requireRecovery(
          saga,
          'compensation_precondition_failed',
          step.ordinal,
          errorMessage(error),
          observed?.state === 'drift' ? observed.observation : null,
        );
      }
    }
    return this.cleanupArtifacts(this.transitionTerminal(saga, 'restored', []));
  }

  private updateStep(
    saga: EditSagaSnapshot,
    ordinal: number,
    update: (step: EditSagaStep) => EditSagaStep,
    state: Extract<EditSagaState, 'applying' | 'compensating'>,
  ): EditSagaSnapshot {
    return this.transition(saga, (current) => ({
      ...withoutRevision(current),
      state,
      steps: current.steps.map((step) => (step.ordinal === ordinal ? update(step) : step)),
      updatedAt: nextTimestamp(current.updatedAt),
    }));
  }

  private transitionTerminal(
    saga: EditSagaSnapshot,
    state: Extract<EditSagaState, 'committed' | 'restored'>,
    diff: readonly TurnDiffEntry[],
  ): EditSagaSnapshot {
    return this.transition(saga, (current) => ({
      ...withoutRevision(current),
      state,
      diff,
      artifactCleanupPending: true,
      updatedAt: nextTimestamp(current.updatedAt),
    }));
  }

  private requireRecovery(
    saga: EditSagaSnapshot,
    reason: EditRecoveryRecord['reason'],
    ordinal: number,
    message: string,
    observed: OperationObservation | null,
  ): EditSagaSnapshot {
    return this.transition(saga, (current) => ({
      ...withoutRevision(current),
      state: 'recovery_required',
      recovery: { reason, ordinal, message: sanitizeError(message), observed },
      diff: buildResidualDiff(current, ordinal, observed),
      updatedAt: nextTimestamp(current.updatedAt),
    }));
  }

  private transition(
    saga: EditSagaSnapshot,
    mutate: (current: EditSagaSnapshot) => Omit<EditSagaSnapshot, 'revision'>,
  ): EditSagaSnapshot {
    return this.store.update(saga.id, saga.revision, mutate);
  }

  private async cleanupArtifacts(saga: EditSagaSnapshot): Promise<EditSagaSnapshot> {
    if (!saga.artifactCleanupPending) return saga;
    await this.fault?.hit({ kind: 'afterTerminalBeforeCleanup' });
    try {
      await this.releaseArtifacts(saga);
    } catch {
      return saga;
    }
    return this.store.update(saga.id, saga.revision, (current) => ({
      ...withoutRevision(current),
      artifactCleanupPending: false,
      updatedAt: nextTimestamp(current.updatedAt),
    }));
  }
}

function buildDiff(saga: EditSagaSnapshot): readonly TurnDiffEntry[] {
  return Object.freeze(
    saga.steps.map((step) =>
      Object.freeze({
        ordinal: step.ordinal,
        kind: step.operation.kind,
        path: step.operation.path,
        destination: step.operation.destination,
        preHash: step.operation.preHash,
        postHash: step.operation.postHash,
        provenance: 'agent_edit' as const,
        status: 'applied' as const,
        actualHash: revisionContentHash(primaryRevision(step.operation.kind, step.postObservation)),
      }),
    ),
  );
}

export function aggregateTurnDiff(
  diffs: readonly (readonly TurnDiffEntry[])[],
): readonly TurnDiffEntry[] {
  const currentByPath = new Map<string, TurnDiffLineage>();
  const deletedByPath = new Map<string, TurnDiffLineage>();
  const lineages: TurnDiffLineage[] = [];
  let order = 0;

  const existing = (path: string, preHash: string | null): TurnDiffLineage => {
    const found = currentByPath.get(path);
    if (found !== undefined) return found;
    const created: TurnDiffLineage = {
      order: order++,
      baselinePath: path,
      baselineHash: preHash,
      currentPath: path,
      currentHash: preHash,
      status: 'applied',
      actualHash: preHash,
    };
    lineages.push(created);
    currentByPath.set(path, created);
    return created;
  };

  for (const diff of diffs) {
    for (const entry of diff) {
      const lineage =
        entry.kind === 'add'
          ? (deletedByPath.get(entry.path) ??
            (() => {
              const created: TurnDiffLineage = {
                order: order++,
                baselinePath: null,
                baselineHash: null,
                currentPath: entry.path,
                currentHash: null,
                status: 'applied',
                actualHash: null,
              };
              lineages.push(created);
              currentByPath.set(entry.path, created);
              return created;
            })())
          : existing(entry.path, entry.preHash);

      if (lineage.currentPath !== null) currentByPath.delete(lineage.currentPath);
      deletedByPath.delete(entry.path);
      lineage.status =
        lineage.status === 'external_drift' || entry.status === 'external_drift'
          ? 'external_drift'
          : 'applied';
      lineage.actualHash = entry.actualHash;

      if (entry.kind === 'delete') {
        lineage.currentPath = null;
        lineage.currentHash = null;
        deletedByPath.set(entry.path, lineage);
      } else {
        lineage.currentPath = entry.kind === 'rename' ? entry.destination : entry.path;
        lineage.currentHash = entry.postHash;
        if (lineage.currentPath === null) throw new Error('Rename diff is missing destination');
        currentByPath.set(lineage.currentPath, lineage);
      }
    }
  }

  const result: TurnDiffEntry[] = [];
  for (const lineage of lineages.sort((left, right) => left.order - right.order)) {
    if (
      lineage.baselinePath === lineage.currentPath &&
      lineage.baselineHash === lineage.currentHash &&
      lineage.status === 'applied'
    )
      continue;
    const kind: TurnDiffEntry['kind'] =
      lineage.baselinePath === null
        ? 'add'
        : lineage.currentPath === null
          ? 'delete'
          : lineage.baselinePath === lineage.currentPath
            ? 'update'
            : 'rename';
    result.push(
      Object.freeze({
        ordinal: result.length + 1,
        kind,
        path: lineage.baselinePath ?? lineage.currentPath!,
        destination: kind === 'rename' ? lineage.currentPath : null,
        preHash: lineage.baselineHash,
        postHash: lineage.currentHash,
        provenance: 'agent_edit',
        status: lineage.status,
        actualHash: lineage.actualHash,
      }),
    );
  }
  return Object.freeze(result);
}

function buildResidualDiff(
  saga: EditSagaSnapshot,
  driftOrdinal: number,
  observed: OperationObservation | null,
): readonly TurnDiffEntry[] {
  return buildDiff({
    ...saga,
    steps: saga.steps.filter((step) => step.state !== 'restored' && step.state !== 'pending'),
  }).map((entry) =>
    entry.ordinal === driftOrdinal
      ? Object.freeze({
          ...entry,
          status: 'external_drift' as const,
          actualHash: revisionContentHash(primaryRevision(entry.kind, observed)),
        })
      : entry,
  );
}

function stepAt(saga: EditSagaSnapshot, ordinal: number): EditSagaStep {
  const step = saga.steps.find((candidate) => candidate.ordinal === ordinal);
  if (step === undefined) throw new Error('Edit Saga step not found');
  return step;
}

function validatePostObservation(step: EditSagaStep, observation: OperationObservation): void {
  validateOperationObservation(step.operation, observation, 'post');
}

function validateRestoredObservation(step: EditSagaStep, observation: OperationObservation): void {
  validateOperationObservation(step.operation, observation, 'pre');
}

function validateOperationObservation(
  operation: JournaledPatchOperation,
  observation: OperationObservation,
  phase: 'pre' | 'post',
): void {
  const absent = Object.freeze({ state: 'absent' as const });
  const artifactEndpoint = (artifact: EditArtifactRef | null): EndpointObservation =>
    artifact === null
      ? absent
      : {
          state: 'present',
          revision: {
            identityDigest: observation.source.state === 'present' ? '' : '',
            contentHash: artifact.contentHash,
            size: artifact.size,
          },
        };
  let expectedSource: EndpointObservation;
  let expectedDestination: EndpointObservation = absent;
  if (phase === 'pre') expectedSource = artifactEndpoint(operation.preArtifact);
  else if (operation.kind === 'mkdir') {
    if (
      observation.source.state !== 'present' ||
      observation.source.revision.entryKind !== 'directory'
    )
      throw new Error('Edit mkdir observation is not a directory');
    expectedSource = observation.source;
  } else if (operation.kind === 'rename') {
    expectedSource = absent;
    expectedDestination = artifactEndpoint(operation.postArtifact);
  } else expectedSource = artifactEndpoint(operation.postArtifact);
  assertEndpointMatches(observation.source, expectedSource);
  assertEndpointMatches(observation.destination, expectedDestination);
}

function assertEndpointMatches(actual: EndpointObservation, expected: EndpointObservation): void {
  if (actual.state !== expected.state) throw new Error('Edit observation endpoint state mismatch');
  if (
    actual.state === 'present' &&
    expected.state === 'present' &&
    (actual.revision.entryKind === 'directory' || expected.revision.entryKind === 'directory'
      ? actual.revision.entryKind !== expected.revision.entryKind
      : actual.revision.contentHash !== expected.revision.contentHash ||
        actual.revision.size !== expected.revision.size)
  )
    throw new Error('Edit observation does not match the sealed artifact');
}

function primaryRevision(
  kind: JournaledPatchOperation['kind'],
  observation: OperationObservation | null,
): RevisionObservation | null {
  if (observation === null) return null;
  const endpoint = kind === 'rename' ? observation.destination : observation.source;
  return endpoint.state === 'present' ? endpoint.revision : null;
}

function sameOperationObservation(
  left: OperationObservation,
  right: OperationObservation,
): boolean {
  return (
    sameEndpointObservation(left.source, right.source) &&
    sameEndpointObservation(left.destination, right.destination)
  );
}

function sameEndpointObservation(left: EndpointObservation, right: EndpointObservation): boolean {
  return left.state === 'absent' || right.state === 'absent'
    ? left.state === right.state
    : left.revision.identityDigest === right.revision.identityDigest &&
        (left.revision.entryKind === 'directory' || right.revision.entryKind === 'directory'
          ? left.revision.entryKind === right.revision.entryKind
          : left.revision.contentHash === right.revision.contentHash &&
            left.revision.size === right.revision.size);
}

function revisionContentHash(revision: RevisionObservation | null): string | null {
  return revision === null || revision.entryKind === 'directory' ? null : revision.contentHash;
}

function withoutRevision(snapshot: EditSagaSnapshot): Omit<EditSagaSnapshot, 'revision'> {
  const { revision: _revision, ...rest } = snapshot;
  return rest;
}

function freezeSnapshot(snapshot: EditSagaSnapshot): EditSagaSnapshot {
  const steps = Object.freeze(
    snapshot.steps.map((step) =>
      Object.freeze({
        ...step,
        operation: Object.freeze({
          ...step.operation,
          preRevision:
            step.operation.preRevision === null
              ? null
              : Object.freeze({ ...step.operation.preRevision }),
          preArtifact: freezeArtifactReference(step.operation.preArtifact),
          postArtifact: freezeArtifactReference(step.operation.postArtifact),
        }),
        postObservation:
          step.postObservation === null ? null : Object.freeze({ ...step.postObservation }),
        restoredObservation:
          step.restoredObservation === null ? null : Object.freeze({ ...step.restoredObservation }),
      }),
    ),
  );
  const diff = Object.freeze(snapshot.diff.map((entry) => Object.freeze({ ...entry })));
  return Object.freeze({
    ...snapshot,
    steps,
    diff,
    recovery:
      snapshot.recovery === null
        ? null
        : Object.freeze({
            ...snapshot.recovery,
            observed:
              snapshot.recovery.observed === null
                ? null
                : Object.freeze({ ...snapshot.recovery.observed }),
          }),
  });
}

function assertStableIdentity(
  current: EditSagaSnapshot,
  candidate: Omit<EditSagaSnapshot, 'revision'>,
): void {
  if (
    candidate.id !== current.id ||
    candidate.taskId !== current.taskId ||
    candidate.turnId !== current.turnId ||
    candidate.operationId !== current.operationId ||
    candidate.planDigest !== current.planDigest ||
    candidate.journalDigest !== current.journalDigest ||
    candidate.policyEpoch !== current.policyEpoch ||
    candidate.rootId !== current.rootId ||
    candidate.workspaceKey !== current.workspaceKey ||
    candidate.rootIdentityDigest !== current.rootIdentityDigest ||
    candidate.createdAt !== current.createdAt
  )
    throw new Error('Immutable Edit Saga identity changed');
  if (
    candidate.steps.length !== current.steps.length ||
    candidate.steps.some((step, index) => {
      const previous = current.steps[index];
      return (
        previous === undefined ||
        step.ordinal !== previous.ordinal ||
        !samePreparedOperation(step.operation, previous.operation) ||
        (previous.postObservation !== null &&
          (step.postObservation === null ||
            !sameOperationObservation(previous.postObservation, step.postObservation))) ||
        (previous.restoredObservation !== null &&
          (step.restoredObservation === null ||
            !sameOperationObservation(previous.restoredObservation, step.restoredObservation)))
      );
    })
  )
    throw new Error('Immutable Edit Saga plan changed');
}

function assertPlanBoundToOneRoot(
  plan: PreparedStructuredPatch,
  binding: NonNullable<EditSagaApplyRequest['mutationBinding']> & {
    rootId: string;
    workspacePath: string;
  },
): void {
  if (binding.rootId.length === 0 || !isAbsolute(binding.workspacePath))
    throw new Error('Edit Saga mutation root binding is invalid');
  for (const operation of plan.operations) {
    assertCanonicalPathInsideRoot(binding.workspacePath, operation.canonicalPath);
    if (operation.canonicalDestination !== null)
      assertCanonicalPathInsideRoot(binding.workspacePath, operation.canonicalDestination);
  }
}

function assertCanonicalPathInsideRoot(rootPath: string, candidatePath: string): void {
  const fromRoot = relative(rootPath, candidatePath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
    throw new Error('Edit Saga cannot span multiple Workspace roots');
}

function validateTerminalCleanupTransition(
  current: EditSagaSnapshot,
  candidate: Omit<EditSagaSnapshot, 'revision'>,
): void {
  if (
    !current.artifactCleanupPending ||
    candidate.artifactCleanupPending ||
    candidate.state !== current.state ||
    JSON.stringify(candidate.steps) !== JSON.stringify(current.steps) ||
    JSON.stringify(candidate.diff) !== JSON.stringify(current.diff) ||
    JSON.stringify(candidate.recovery) !== JSON.stringify(current.recovery) ||
    Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt)
  )
    throw new Error('Terminal Edit Saga only allows artifact cleanup completion');
}

function validateSagaTransition(
  current: EditSagaSnapshot,
  candidate: Omit<EditSagaSnapshot, 'revision'>,
): void {
  if (
    current.state === 'committed' ||
    current.state === 'restored' ||
    current.state === 'recovery_required'
  )
    throw new Error('Terminal Edit Saga cannot transition');
  const allowedStates: Record<
    Exclude<EditSagaState, 'committed' | 'restored' | 'recovery_required'>,
    readonly EditSagaState[]
  > = {
    prepared: ['applying', 'restored'],
    applying: ['applying', 'compensating', 'committed'],
    compensating: ['compensating', 'restored', 'recovery_required'],
  };
  if (!allowedStates[current.state].includes(candidate.state))
    throw new Error('Invalid Edit Saga state transition');
  const allowedStepStates: Record<EditSagaStepState, readonly EditSagaStepState[]> = {
    pending: ['pending', 'effect_pending'],
    effect_pending: ['effect_pending', 'effect_observed', 'restored'],
    effect_observed: ['effect_observed', 'compensation_pending'],
    compensation_pending: ['compensation_pending', 'restored'],
    restored: ['restored'],
  };
  for (let index = 0; index < current.steps.length; index += 1) {
    const previous = current.steps[index];
    const next = candidate.steps[index];
    if (
      previous === undefined ||
      next === undefined ||
      !allowedStepStates[previous.state].includes(next.state)
    )
      throw new Error('Invalid Edit Saga step transition');
  }
  if (
    candidate.state === 'committed' &&
    candidate.steps.some((step) => step.state !== 'effect_observed')
  )
    throw new Error('Cannot commit an incompletely observed Edit Saga');
  if (
    candidate.state === 'restored' &&
    candidate.steps.some((step) => step.state !== 'pending' && step.state !== 'restored')
  )
    throw new Error('Cannot restore an incompletely compensated Edit Saga');
  if ((candidate.state === 'recovery_required') !== (candidate.recovery !== null))
    throw new Error('Edit Saga recovery record does not match state');
  if (
    (candidate.state === 'committed' || candidate.state === 'recovery_required') ===
    (candidate.diff.length === 0)
  )
    throw new Error('Edit Saga diff does not match terminal state');
  if (Date.parse(candidate.updatedAt) < Date.parse(current.updatedAt))
    throw new Error('Edit Saga timestamp moved backwards');
}

function samePreparedOperation(
  left: JournaledPatchOperation,
  right: JournaledPatchOperation,
): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.canonicalPath === right.canonicalPath &&
    left.destination === right.destination &&
    left.canonicalDestination === right.canonicalDestination &&
    left.revisionTokenId === right.revisionTokenId &&
    JSON.stringify(left.preRevision) === JSON.stringify(right.preRevision) &&
    sameArtifactReference(left.preArtifact, right.preArtifact) &&
    sameArtifactReference(left.postArtifact, right.postArtifact) &&
    left.preHash === right.preHash &&
    left.postHash === right.postHash
  );
}

function validatePreparedFileRevision(value: JournaledPatchOperation['preRevision']): void {
  if (value === null) return;
  if (!isRecord(value)) throw new Error('Invalid persisted Edit file revision');
  assertExactKeys(value, ['identityDigest', 'contentHash', 'size', 'mode', 'nlink']);
  if (
    !isDigest(value.identityDigest) ||
    !isDigest(value.contentHash) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode & 0o170000) !== 0o100000 ||
    value.nlink !== 1
  )
    throw new Error('Invalid persisted Edit file revision');
}

function sameArtifactReference(
  left: EditArtifactRef | null,
  right: EditArtifactRef | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.version === right.version &&
        left.artifactId === right.artifactId &&
        left.owner.sagaId === right.owner.sagaId &&
        left.owner.ordinal === right.owner.ordinal &&
        left.owner.role === right.owner.role &&
        left.contentHash === right.contentHash &&
        left.size === right.size &&
        left.containsSecrets === right.containsSecrets;
}

function freezeArtifactReference(reference: EditArtifactRef | null): EditArtifactRef | null {
  return reference === null
    ? null
    : Object.freeze({ ...reference, owner: Object.freeze({ ...reference.owner }) });
}

function isTerminal(state: EditSagaState): boolean {
  return state === 'committed' || state === 'restored' || state === 'recovery_required';
}

function validateIdentifier(value: string, name: string): void {
  if (value.length < 1 || value.length > 200) throw new Error(`Invalid ${name}`);
}

function nextTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown edit failure';
}

function sanitizeError(message: string): string {
  return [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .slice(0, 500);
}

function validatePersistedStep(value: EditSagaStep | undefined, ordinal: number): void {
  if (value !== undefined && isRecord(value))
    assertExactKeys(value, [
      'ordinal',
      'operation',
      'state',
      'postObservation',
      'restoredObservation',
    ]);
  if (
    value === undefined ||
    value.ordinal !== ordinal ||
    !editSagaStepStates.includes(value.state) ||
    !isRecord(value.operation) ||
    !['add', 'mkdir', 'update', 'delete', 'rename'].includes(value.operation.kind) ||
    !isString(value.operation.path, 4_096) ||
    !isString(value.operation.canonicalPath, 32_768) ||
    (value.operation.destination !== null && !isString(value.operation.destination, 4_096)) ||
    (value.operation.canonicalDestination !== null &&
      !isString(value.operation.canonicalDestination, 32_768)) ||
    (value.operation.revisionTokenId !== null && !isString(value.operation.revisionTokenId, 200)) ||
    (value.operation.preHash !== null && !isDigest(value.operation.preHash)) ||
    (value.operation.postHash !== null && !isDigest(value.operation.postHash))
  )
    throw new Error('Invalid persisted Edit Saga step');
  const operation = value.operation;
  assertExactKeys(operation, [
    'kind',
    'path',
    'canonicalPath',
    'destination',
    'canonicalDestination',
    'revisionTokenId',
    'preRevision',
    'preArtifact',
    'postArtifact',
    'preHash',
    'postHash',
  ]);
  if (operation.preArtifact !== null) validateEditArtifactReference(operation.preArtifact);
  validatePreparedFileRevision(operation.preRevision);
  if (operation.postArtifact !== null) validateEditArtifactReference(operation.postArtifact);
  if (
    (operation.preArtifact !== null &&
      (operation.preArtifact.owner.ordinal !== ordinal ||
        operation.preArtifact.owner.role !== 'preimage' ||
        operation.preArtifact.contentHash !== operation.preHash ||
        operation.preRevision === null ||
        operation.preRevision.contentHash !== operation.preHash ||
        operation.preRevision.size !== operation.preArtifact.size)) ||
    (operation.postArtifact !== null &&
      (operation.postArtifact.owner.ordinal !== ordinal ||
        operation.postArtifact.owner.role !== 'postimage' ||
        operation.postArtifact.contentHash !== operation.postHash))
  )
    throw new Error('Invalid persisted Edit artifact binding');
  const validShape =
    operation.kind === 'add'
      ? operation.revisionTokenId === null &&
        operation.preRevision === null &&
        operation.preArtifact === null &&
        operation.preHash === null &&
        operation.postArtifact !== null &&
        operation.postHash !== null &&
        operation.destination === null &&
        operation.canonicalDestination === null
      : operation.kind === 'mkdir'
        ? operation.revisionTokenId === null &&
          operation.preRevision === null &&
          operation.preArtifact === null &&
          operation.preHash === null &&
          operation.postArtifact === null &&
          operation.postHash === null &&
          operation.destination === null &&
          operation.canonicalDestination === null
        : operation.kind === 'update'
          ? operation.revisionTokenId !== null &&
            operation.preRevision !== null &&
            operation.preArtifact !== null &&
            operation.preHash !== null &&
            operation.postArtifact !== null &&
            operation.postHash !== null &&
            operation.destination === null &&
            operation.canonicalDestination === null
          : operation.kind === 'delete'
            ? operation.revisionTokenId !== null &&
              operation.preRevision !== null &&
              operation.preArtifact !== null &&
              operation.preHash !== null &&
              operation.postArtifact === null &&
              operation.postHash === null &&
              operation.destination === null &&
              operation.canonicalDestination === null
            : operation.revisionTokenId !== null &&
              operation.preRevision !== null &&
              operation.preArtifact !== null &&
              operation.preHash !== null &&
              operation.postArtifact !== null &&
              operation.postHash !== null &&
              operation.destination !== null &&
              operation.canonicalDestination !== null;
  if (!validShape) throw new Error('Invalid persisted Edit operation shape');
  validateOptionalObservation(value.postObservation);
  validateOptionalObservation(value.restoredObservation);
}

function validateSnapshotInvariants(snapshot: EditSagaSnapshot): void {
  if (snapshot.artifactCleanupPending && !isTerminal(snapshot.state))
    throw new Error('Only terminal Edit Sagas may await artifact cleanup');
  for (const step of snapshot.steps) {
    if (
      (step.state === 'pending' || step.state === 'effect_pending') &&
      (step.postObservation !== null || step.restoredObservation !== null)
    )
      throw new Error('Persisted Edit step has an impossible observation');
    if (
      (step.state === 'effect_observed' || step.state === 'compensation_pending') &&
      (step.postObservation === null || step.restoredObservation !== null)
    )
      throw new Error('Persisted Edit step is missing its post observation');
    if (step.postObservation !== null) validatePostObservation(step, step.postObservation);
    if (step.restoredObservation !== null)
      validateRestoredObservation(step, step.restoredObservation);
  }
  if (snapshot.state === 'committed') {
    if (
      snapshot.recovery !== null ||
      snapshot.steps.some((step) => step.state !== 'effect_observed') ||
      snapshot.diff.length !== snapshot.steps.length
    )
      throw new Error('Invalid committed Edit Saga snapshot');
    if (JSON.stringify(snapshot.diff) !== JSON.stringify(buildDiff(snapshot)))
      throw new Error('Committed Edit Saga diff does not match observations');
    return;
  }
  if (snapshot.state === 'restored') {
    if (
      snapshot.recovery !== null ||
      snapshot.diff.length !== 0 ||
      snapshot.steps.some((step) => step.state !== 'pending' && step.state !== 'restored')
    )
      throw new Error('Invalid restored Edit Saga snapshot');
    return;
  }
  if (snapshot.state === 'recovery_required') {
    if (snapshot.recovery === null || snapshot.diff.length === 0)
      throw new Error('Invalid recovery-required Edit Saga snapshot');
    if (
      JSON.stringify(snapshot.diff) !==
      JSON.stringify(
        buildResidualDiff(snapshot, snapshot.recovery.ordinal, snapshot.recovery.observed),
      )
    )
      throw new Error('Recovery Edit Saga diff does not match observations');
    return;
  }
  if (snapshot.recovery !== null || snapshot.diff.length !== 0)
    throw new Error('Nonterminal Edit Saga contains terminal output');
}

function validatePersistedDiff(value: TurnDiffEntry): void {
  if (isRecord(value))
    assertExactKeys(value, [
      'ordinal',
      'kind',
      'path',
      'destination',
      'preHash',
      'postHash',
      'provenance',
      'status',
      'actualHash',
    ]);
  if (
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    !['add', 'mkdir', 'update', 'delete', 'rename'].includes(value.kind) ||
    !isString(value.path, 4_096) ||
    (value.destination !== null && !isString(value.destination, 4_096)) ||
    (value.preHash !== null && !isDigest(value.preHash)) ||
    (value.postHash !== null && !isDigest(value.postHash)) ||
    value.provenance !== 'agent_edit' ||
    !['applied', 'external_drift'].includes(value.status) ||
    (value.actualHash !== null && !isDigest(value.actualHash))
  )
    throw new Error('Invalid persisted Turn diff');
}

function validateOptionalObservation(value: OperationObservation | null): void {
  if (value === null) return;
  if (!isRecord(value)) throw new Error('Invalid persisted operation observation');
  assertExactKeys(value, ['source', 'destination']);
  validateEndpointObservation(value.source);
  validateEndpointObservation(value.destination);
}

function validateEndpointObservation(value: EndpointObservation): void {
  if (!isRecord(value)) throw new Error('Invalid persisted endpoint observation');
  if (value.state === 'absent') {
    assertExactKeys(value, ['state']);
    return;
  }
  if (
    value.state !== 'present' ||
    !isRecord(value.revision) ||
    !isString(value.revision.identityDigest, 500)
  )
    throw new Error('Invalid persisted revision observation');
  assertExactKeys(value, ['state', 'revision']);
  if (value.revision.entryKind === 'directory') {
    assertExactKeys(value.revision, ['entryKind', 'identityDigest']);
    if (!isDigest(value.revision.identityDigest))
      throw new Error('Invalid persisted directory revision observation');
    return;
  }
  if (
    !isDigest(value.revision.contentHash) ||
    !Number.isSafeInteger(value.revision.size) ||
    value.revision.size < 0 ||
    value.revision.size > 1_048_576
  )
    throw new Error('Invalid persisted revision observation');
  assertExactKeys(value.revision, ['identityDigest', 'contentHash', 'size']);
}

function validateRecovery(value: EditRecoveryRecord): void {
  if (isRecord(value)) assertExactKeys(value, ['reason', 'ordinal', 'message', 'observed']);
  if (
    ![
      'effect_outcome_unknown',
      'compensation_precondition_failed',
      'compensation_effect_unknown',
    ].includes(value.reason) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    !isString(value.message, 500)
  )
    throw new Error('Invalid persisted recovery record');
  validateOptionalObservation(value.observed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sealed = [...expected].sort();
  if (actual.length !== sealed.length || actual.some((key, index) => key !== sealed[index]))
    throw new Error('Persisted Edit Saga contains unknown or missing fields');
}

function isString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isOptionalDigest(value: unknown): value is string | null {
  return value === null || isDigest(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}
