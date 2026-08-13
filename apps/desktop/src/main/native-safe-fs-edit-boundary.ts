import type {
  NativeDirectoryObservation,
  NativeSafeFs,
  NativeSafeFsSession,
} from './native-safe-fs';
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
  nativeMutationDirectoryOwnership,
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
  getMutationWorkspacePath(taskId: string, turnId: string, rootId: string | null): string | null;
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
  getNativeMutationIntent?(id: string): NativeMutationIntentSnapshot;
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
> &
  Partial<
    Pick<
      NativeSafeFs,
      | 'observeDirectory'
      | 'createDirectory'
      | 'inspectDirectoryOwnership'
      | 'cleanupDirectoryOwnership'
      | 'removeDirectory'
    >
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
    return this.runIntent(step, asMutationLeaseResolver(lease), 'forward');
  }

  async restore(
    step: EditSagaStep,
    _expectedPost: OperationObservation,
    lease: unknown | null,
  ): Promise<OperationObservation> {
    return this.runIntent(step, asMutationLeaseResolver(lease), 'compensation');
  }

  async observe(step: EditSagaStep, lease: unknown | null): Promise<EditEffectObservation> {
    const resolveToken = asMutationLeaseResolver(lease);
    const session = await this.resolveSession(resolveToken());
    const token = resolveToken();
    if (step.operation.kind === 'mkdir') {
      const id = this.intentId(resolveToken().sagaId, step.ordinal, 'forward');
      let intent: NativeMutationIntentSnapshot | null = null;
      try {
        intent = this.journal.getNativeMutationIntent?.(id) ?? null;
      } catch {
        // No durable native intent means the mkdir effect was never authorized.
      }
      if (intent?.effectObservation !== null && intent?.effectObservation !== undefined) {
        const observed = await this.native.observeDirectory!(session, intent.sourceSegments);
        const expected = intent.effectObservation.source;
        const observation = directorySagaObservation(observed);
        if (
          observed.state === 'present' &&
          expected.state === 'present' &&
          expected.entryKind === 'directory' &&
          observed.identityDigest === expected.identityDigest
        )
          return { state: 'post', observation };
        return { state: 'drift', observation };
      }
      const seed = this.buildSeed(step, token, session, 'forward');
      const owned = await this.native.inspectDirectoryOwnership!(
        session,
        seed.sourceSegments,
        nativeMutationDirectoryOwnership(seed),
      );
      const observation = directorySagaObservation(owned);
      return owned.state === 'absent'
        ? { state: 'pre', observation }
        : { state: 'post', observation };
    }
    const intent = createNativeMutationIntentSnapshot(
      this.buildSeed(step, token, session, 'forward'),
      randomBytes(16).toString('hex'),
    );
    this.assertSession(session, resolveToken());
    const effect = await this.native.observeIntent(session, intent);
    const observation = toSagaObservation('forward', step.operation.kind, effect);
    if (matchesPhase(step, observation, 'pre')) return { state: 'pre', observation };
    if (matchesPhase(step, observation, 'post')) return { state: 'post', observation };
    return { state: 'drift', observation };
  }

  private async runIntent(
    step: EditSagaStep,
    resolveToken: () => MutationLeaseToken,
    direction: NativeMutationDirection,
  ): Promise<OperationObservation> {
    const session = await this.resolveSession(resolveToken());
    const token = resolveToken();
    let intent = this.journal.prepareNativeMutationIntent(
      this.buildSeed(step, token, session, direction),
      token,
      this.now(),
      'edit-saga-executor',
    );
    if (step.operation.kind === 'mkdir')
      return this.runDirectoryIntent(intent, resolveToken, session);
    this.assertSession(session, resolveToken());
    await this.native.observeIntent(session, intent);
    if (intent.temp !== null) {
      intent = this.transition(intent, resolveToken, session, { state: 'aux_pending' });
      const bytes = await this.artifacts.read(stagingArtifact(step, direction));
      this.assertSession(session, resolveToken());
      const auxObservation = await this.native.stageIntentArtifact(session, intent, bytes);
      intent = this.transition(intent, resolveToken, session, {
        state: 'aux_observed',
        auxObservation,
      });
    }
    intent = this.transition(intent, resolveToken, session, { state: 'effect_pending' });
    this.assertSession(session, resolveToken());
    const effectObservation = await this.native.applyIntentEffect(session, intent);
    intent = this.transition(intent, resolveToken, session, {
      state: 'effect_observed',
      effectObservation,
    });
    if (intent.temp !== null || intent.tombstone !== null) {
      intent = this.transition(intent, resolveToken, session, { state: 'cleanup_pending' });
      this.assertSession(session, resolveToken());
      await this.native.cleanupIntentAuxiliary(session, intent);
      this.transition(intent, resolveToken, session, {
        state: 'completed',
        cleanupObservation: { state: 'absent' },
      });
    } else {
      this.transition(intent, resolveToken, session, {
        state: 'completed',
        cleanupObservation: null,
      });
    }
    return toSagaObservation(direction, step.operation.kind, effectObservation);
  }

  private async runDirectoryIntent(
    initial: NativeMutationIntentSnapshot,
    resolveToken: () => MutationLeaseToken,
    session: NativeSafeFsSession,
  ): Promise<OperationObservation> {
    let intent = initial;
    if (intent.state === 'completed' && intent.effectObservation !== null)
      return toSagaObservation(intent.direction, 'mkdir', intent.effectObservation);
    if (intent.state === 'planned')
      intent = this.transition(intent, resolveToken, session, { state: 'effect_pending' });
    if (intent.state === 'effect_pending') {
      this.assertSession(session, resolveToken());
      let effectObservation: NativeMutationEffectObservation;
      if (intent.direction === 'forward') {
        const ownership = nativeMutationDirectoryOwnership(intent);
        let observed = await this.native.inspectDirectoryOwnership!(
          session,
          intent.sourceSegments,
          ownership,
        );
        if (observed.state === 'absent')
          observed = await this.native.createDirectory!(session, intent.sourceSegments, ownership);
        effectObservation = {
          source: {
            state: 'present',
            entryKind: 'directory',
            identityDigest: observed.identityDigest,
          },
          destination: { state: 'absent' },
          auxiliary: { state: 'absent' },
        };
      } else {
        if (
          intent.expectedSource.state !== 'present' ||
          intent.expectedSource.entryKind !== 'directory'
        )
          throw new MutationLeaseStaleError();
        await this.native.removeDirectory!(
          session,
          intent.sourceSegments,
          intent.expectedSource.identityDigest,
        );
        effectObservation = {
          source: { state: 'absent' },
          destination: { state: 'absent' },
          auxiliary: { state: 'absent' },
        };
      }
      intent = this.transition(intent, resolveToken, session, {
        state: 'effect_observed',
        effectObservation,
      });
    }
    if (
      intent.direction === 'forward' &&
      (intent.state === 'effect_observed' || intent.state === 'cleanup_pending')
    ) {
      const source = intent.effectObservation?.source;
      if (source?.state !== 'present' || source.entryKind !== 'directory')
        throw new MutationLeaseStaleError();
      if (intent.state === 'effect_observed')
        intent = this.transition(intent, resolveToken, session, { state: 'cleanup_pending' });
      this.assertSession(session, resolveToken());
      await this.native.cleanupDirectoryOwnership!(
        session,
        intent.sourceSegments,
        source.identityDigest,
        nativeMutationDirectoryOwnership(intent),
      );
      intent = this.transition(intent, resolveToken, session, {
        state: 'completed',
        cleanupObservation: { state: 'absent' },
      });
    } else if (intent.state === 'effect_observed') {
      intent = this.transition(intent, resolveToken, session, {
        state: 'completed',
        cleanupObservation: null,
      });
    }
    if (intent.effectObservation === null) throw new MutationLeaseStaleError();
    return toSagaObservation(intent.direction, 'mkdir', intent.effectObservation);
  }

  private transition(
    intent: NativeMutationIntentSnapshot,
    resolveToken: () => MutationLeaseToken,
    session: NativeSafeFsSession,
    transition: NativeMutationIntentTransition,
  ): NativeMutationIntentSnapshot {
    const token = resolveToken();
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

  private assertSession(session: NativeSafeFsSession, token: MutationLeaseToken): void {
    const expectedRootId = token.rootId ?? 'legacy-primary';
    if (
      session.rootId !== expectedRootId ||
      session.workspaceKey !== token.workspaceKey ||
      session.fence !== String(token.fence)
    )
      throw new MutationLeaseStaleError();
    this.native.assertSession({
      id: session.id,
      rootId: session.rootId,
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
    const workspacePath = this.journal.getMutationWorkspacePath(
      token.taskId,
      token.turnId,
      token.rootId,
    );
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

function directorySagaObservation(value: NativeDirectoryObservation): OperationObservation {
  return {
    source:
      value.state === 'absent'
        ? { state: 'absent' }
        : {
            state: 'present',
            revision: { entryKind: 'directory', identityDigest: value.identityDigest },
          },
    destination: { state: 'absent' },
  };
}

function toEndpointObservation(value: NativeMutationEndpointExpectation): EndpointObservation {
  return value.state === 'absent'
    ? { state: 'absent' }
    : value.entryKind === 'directory'
      ? {
          state: 'present',
          revision: { entryKind: 'directory', identityDigest: value.identityDigest },
        }
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
  if (operation.kind === 'mkdir')
    return (
      observation.destination.state === 'absent' &&
      (phase === 'pre'
        ? observation.source.state === 'absent'
        : observation.source.state === 'present' &&
          observation.source.revision.entryKind === 'directory')
    );
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
        actual.revision.entryKind !== 'directory' &&
        actual.revision.contentHash === expected.contentHash &&
        actual.revision.size === expected.size;
}

function asMutationLease(lease: unknown): MutationLeaseToken {
  if (lease === null || typeof lease !== 'object') throw new MutationLeaseStaleError();
  const token = lease as MutationLeaseToken;
  if (
    typeof token.sagaId !== 'string' ||
    typeof token.taskId !== 'string' ||
    (token.rootId !== null && typeof token.rootId !== 'string') ||
    typeof token.workspaceKey !== 'string' ||
    typeof token.rootIdentityDigest !== 'string' ||
    typeof token.fence !== 'number' ||
    typeof token.policyEpoch !== 'number'
  )
    throw new MutationLeaseStaleError();
  return token;
}

function asMutationLeaseResolver(lease: unknown): () => MutationLeaseToken {
  const current =
    lease !== null && typeof lease === 'object'
      ? (lease as { current?: unknown }).current
      : undefined;
  if (typeof current === 'function') return () => asMutationLease(current());
  const token = asMutationLease(lease);
  return () => token;
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
