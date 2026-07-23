import type { NativeSafeFs, NativeSafeFsSession } from './native-safe-fs';
import type {
  EditArtifactRepository,
  EditEffectBoundary,
  EditEffectObservation,
  EditSagaStep,
  EndpointObservation,
  OperationObservation,
} from './edit-saga';
import {
  createNativeMutationIntentSeed,
  createNativeMutationIntentSnapshot,
  type NativeMutationDirection,
  type NativeMutationEffectObservation,
  type NativeMutationEndpointExpectation,
  type NativeMutationIntentSeed,
  type NativeMutationIntentSnapshot,
  type NativeMutationIntentTransition,
} from './native-mutation-intent';
import {
  expectedNativeMutationBinding,
  nativeMutationOperationDigest,
  type NativeMutationSagaCoordinator,
} from './persistence';
import { MutationLeaseStaleError, type MutationLeaseToken } from './mutation-lease';
import { randomBytes } from 'node:crypto';

// The durable intent driver seam. SqlitePersistenceClient satisfies this; every
// transition is journaled before the matching native effect (ADR §Decision).
export interface NativeMutationJournal {
  getWorkspace(taskId: string): string | null;
  prepareNativeMutationIntent(
    seed: NativeMutationIntentSeed,
    lease: MutationLeaseToken,
    now: string,
    coordinator?: NativeMutationSagaCoordinator,
  ): NativeMutationIntentSnapshot;
  updateNativeMutationIntent(
    id: string,
    expectedRevision: number,
    lease: MutationLeaseToken,
    now: string,
    nativeSessionId: string,
    transition: NativeMutationIntentTransition,
    coordinator?: NativeMutationSagaCoordinator,
  ): NativeMutationIntentSnapshot;
}

// Only the bounded edit primitives are ever exposed to the boundary; the raw addon
// object never escapes NativeSafeFs.
export type NativeSafeFsEffectPort = Pick<
  NativeSafeFs,
  | 'assertSession'
  | 'observeIntent'
  | 'stageIntentArtifact'
  | 'applyIntentEffect'
  | 'cleanupIntentAuxiliary'
>;

export type NativeSafeFsEditBoundaryOptions = Readonly<{
  native: NativeSafeFsEffectPort;
  journal: NativeMutationJournal;
  artifacts: Pick<EditArtifactRepository, 'read'>;
  // Resolves the live NativeSafeFs session for a lease. Production keeps this
  // fail-closed until the platform gate advertises mutation authority.
  resolveSession: (lease: MutationLeaseToken) => Promise<NativeSafeFsSession>;
  now?: () => string;
  intentId?: (sagaId: string, ordinal: number, direction: NativeMutationDirection) => string;
}>;

// Production EditEffectBoundary backed by the NativeSafeFs authority boundary. Each
// forward effect and compensation restore is driven through the journaled native
// intent lifecycle (observe -> stage -> apply -> cleanup), reasserting the live
// session immediately before every native effect (ADR §Decision, S4b3a/S4b3b).
export class NativeSafeFsEditEffectBoundary implements EditEffectBoundary {
  private readonly native: NativeSafeFsEffectPort;
  private readonly journal: NativeMutationJournal;
  private readonly artifacts: Pick<EditArtifactRepository, 'read'>;
  private readonly resolveSession: (lease: MutationLeaseToken) => Promise<NativeSafeFsSession>;
  private readonly now: () => string;
  private readonly intentId: (
    sagaId: string,
    ordinal: number,
    direction: NativeMutationDirection,
  ) => string;

  constructor(options: NativeSafeFsEditBoundaryOptions) {
    this.native = options.native;
    this.journal = options.journal;
    this.artifacts = options.artifacts;
    this.resolveSession = options.resolveSession;
    this.now = options.now ?? (() => new Date().toISOString());
    this.intentId = options.intentId ?? defaultIntentId;
  }

  async apply(step: EditSagaStep, lease: unknown | null): Promise<OperationObservation> {
    return this.runIntent(step, asMutationLease(lease), 'forward');
  }

  async restore(
    step: EditSagaStep,
    _expectedPost: OperationObservation,
    lease: unknown | null,
  ): Promise<OperationObservation> {
    return this.runIntent(step, asMutationLease(lease), 'compensation');
  }

  async observe(step: EditSagaStep, lease: unknown | null): Promise<EditEffectObservation> {
    const token = asMutationLease(lease);
    const session = await this.resolveSession(token);
    const intent = createNativeMutationIntentSnapshot(
      this.buildSeed(step, token, session, 'forward'),
      randomBytes(16).toString('hex'),
    );
    this.assertSession(session);
    const effect = await this.native.observeIntent(session, intent);
    const observation = toSagaObservation('forward', step.operation.kind, effect);
    if (matchesPhase(step, observation, 'pre')) return { state: 'pre', observation };
    if (matchesPhase(step, observation, 'post')) return { state: 'post', observation };
    return { state: 'drift', observation };
  }

  private async runIntent(
    step: EditSagaStep,
    token: MutationLeaseToken,
    direction: NativeMutationDirection,
  ): Promise<OperationObservation> {
    const session = await this.resolveSession(token);
    let intent = this.journal.prepareNativeMutationIntent(
      this.buildSeed(step, token, session, direction),
      token,
      this.now(),
      'edit-saga-executor',
    );
    this.assertSession(session);
    await this.native.observeIntent(session, intent);
    if (intent.temp !== null) {
      intent = this.transition(intent, token, session, { state: 'aux_pending' });
      const bytes = await this.artifacts.read(stagingArtifact(step, direction));
      this.assertSession(session);
      const auxObservation = await this.native.stageIntentArtifact(session, intent, bytes);
      intent = this.transition(intent, token, session, { state: 'aux_observed', auxObservation });
    }
    intent = this.transition(intent, token, session, { state: 'effect_pending' });
    this.assertSession(session);
    const effectObservation = await this.native.applyIntentEffect(session, intent);
    intent = this.transition(intent, token, session, {
      state: 'effect_observed',
      effectObservation,
    });
    if (intent.temp !== null || intent.tombstone !== null) {
      intent = this.transition(intent, token, session, { state: 'cleanup_pending' });
      this.assertSession(session);
      await this.native.cleanupIntentAuxiliary(session, intent);
      this.transition(intent, token, session, {
        state: 'completed',
        cleanupObservation: { state: 'absent' },
      });
    } else {
      this.transition(intent, token, session, { state: 'completed', cleanupObservation: null });
    }
    return toSagaObservation(direction, step.operation.kind, effectObservation);
  }

  private transition(
    intent: NativeMutationIntentSnapshot,
    token: MutationLeaseToken,
    session: NativeSafeFsSession,
    transition: NativeMutationIntentTransition,
  ): NativeMutationIntentSnapshot {
    return this.journal.updateNativeMutationIntent(
      intent.id,
      intent.revision,
      token,
      this.now(),
      session.id,
      transition,
      'edit-saga-executor',
    );
  }

  private assertSession(session: NativeSafeFsSession): void {
    this.native.assertSession({
      id: session.id,
      workspaceKey: session.workspaceKey,
      fence: session.fence,
    });
  }

  private buildSeed(
    step: EditSagaStep,
    token: MutationLeaseToken,
    session: NativeSafeFsSession,
    direction: NativeMutationDirection,
  ): NativeMutationIntentSeed {
    const workspacePath = this.journal.getWorkspace(token.taskId);
    if (workspacePath === null) throw new MutationLeaseStaleError();
    const binding = expectedNativeMutationBinding(
      step.operation,
      direction,
      workspacePath,
      step.postObservation,
    );
    return createNativeMutationIntentSeed({
      id: this.intentId(token.sagaId, step.ordinal, direction),
      sagaId: token.sagaId,
      ordinal: step.ordinal,
      direction,
      kind: binding.kind,
      operationDigest: nativeMutationOperationDigest(step.operation),
      workspaceKey: token.workspaceKey,
      rootIdentityDigest: token.rootIdentityDigest,
      policyEpoch: token.policyEpoch,
      leaseFence: String(token.fence),
      nativeSessionId: session.id,
      sourceSegments: binding.sourceSegments,
      destinationSegments: binding.destinationSegments,
      expectedSource: binding.expectedSource,
      expectedDestination: { state: 'absent' },
      artifact: binding.artifact,
      createdAt: this.now(),
    });
  }
}

function stagingArtifact(step: EditSagaStep, direction: NativeMutationDirection) {
  const operation = step.operation;
  const reference =
    direction === 'forward'
      ? operation.kind === 'add' || operation.kind === 'update'
        ? operation.postArtifact
        : null
      : operation.kind === 'update' || operation.kind === 'delete'
        ? operation.preArtifact
        : null;
  if (reference === null) throw new MutationLeaseStaleError();
  return reference;
}

function toSagaObservation(
  direction: NativeMutationDirection,
  originalKind: EditSagaStep['operation']['kind'],
  effect: NativeMutationEffectObservation,
): OperationObservation {
  const source = toEndpointObservation(effect.source);
  const destination = toEndpointObservation(effect.destination);
  // A compensated rename restores the file to its original source path, so the
  // native destination/source endpoints map back onto the Saga source/destination.
  return direction === 'compensation' && originalKind === 'rename'
    ? { source: destination, destination: source }
    : { source, destination };
}

function toEndpointObservation(value: NativeMutationEndpointExpectation): EndpointObservation {
  return value.state === 'absent'
    ? { state: 'absent' }
    : {
        state: 'present',
        revision: {
          identityDigest: value.identityDigest,
          contentHash: value.contentHash,
          size: value.size,
        },
      };
}

function matchesPhase(
  step: EditSagaStep,
  observation: OperationObservation,
  phase: 'pre' | 'post',
): boolean {
  const operation = step.operation;
  const sourceArtifact =
    phase === 'pre'
      ? operation.preArtifact
      : operation.kind === 'rename'
        ? null
        : operation.postArtifact;
  const destinationArtifact =
    phase === 'post' && operation.kind === 'rename' ? operation.postArtifact : null;
  return (
    endpointMatchesArtifact(observation.source, sourceArtifact) &&
    endpointMatchesArtifact(observation.destination, destinationArtifact)
  );
}

function endpointMatchesArtifact(
  actual: EndpointObservation,
  expected: EditSagaStep['operation']['preArtifact'],
): boolean {
  return expected === null
    ? actual.state === 'absent'
    : actual.state === 'present' &&
        actual.revision.contentHash === expected.contentHash &&
        actual.revision.size === expected.size;
}

function asMutationLease(lease: unknown): MutationLeaseToken {
  if (lease === null || typeof lease !== 'object') throw new MutationLeaseStaleError();
  const token = lease as MutationLeaseToken;
  if (
    typeof token.sagaId !== 'string' ||
    typeof token.taskId !== 'string' ||
    typeof token.workspaceKey !== 'string' ||
    typeof token.rootIdentityDigest !== 'string' ||
    typeof token.fence !== 'number' ||
    typeof token.policyEpoch !== 'number'
  )
    throw new MutationLeaseStaleError();
  return token;
}

function defaultIntentId(
  sagaId: string,
  ordinal: number,
  direction: NativeMutationDirection,
): string {
  // Stable within a Saga step so idempotent retries dedup, but bounded to the
  // 200-character intent identifier limit regardless of the Saga id length.
  return `nmi-${direction}-${ordinal}-${sagaId}`.slice(0, 200);
}
