import { createHash, randomBytes } from 'node:crypto';

const MAX_NATIVE_MUTATION_FILE_BYTES = 1024 * 1024;

export type NativeMutationIntentKind = 'add' | 'update' | 'delete' | 'rename';
export type NativeMutationDirection = 'forward' | 'compensation';
export type NativeMutationIntentState =
  | 'planned'
  | 'aux_pending'
  | 'aux_observed'
  | 'effect_pending'
  | 'effect_observed'
  | 'cleanup_pending'
  | 'completed'
  | 'recovery_required';

export type NativeMutationEndpointExpectation =
  Readonly<{ state: 'absent' }> | NativeMutationRevision;

export type NativeMutationRevision = Readonly<{
  state: 'present';
  identityDigest: string;
  contentHash: string;
  size: number;
  mode: number;
  nlink: 1;
}>;

export type NativeMutationArtifactBinding = Readonly<{
  artifactId: string;
  contentHash: string;
  size: number;
  expectedMode: number;
}>;

export type NativeMutationAuxiliaryPlan = Readonly<{
  role: 'post_temp' | 'tombstone';
  parentSegments: readonly string[];
  leafName: string;
  expectedContentHash: string;
  expectedSize: number;
  expectedMode: number;
  expectedIdentityDigest: string | null;
}>;

export type NativeMutationIntentSeed = Readonly<{
  version: 1;
  id: string;
  sagaId: string;
  ordinal: number;
  direction: NativeMutationDirection;
  kind: NativeMutationIntentKind;
  operationDigest: string;
  workspaceKey: string;
  rootIdentityDigest: string;
  policyEpoch: number;
  leaseFence: string;
  nativeSessionId: string;
  sourceSegments: readonly string[];
  destinationSegments: readonly string[] | null;
  expectedSource: NativeMutationEndpointExpectation;
  expectedDestination: NativeMutationEndpointExpectation;
  artifact: NativeMutationArtifactBinding | null;
  createdAt: string;
  seedDigest: string;
}>;

export type NativeMutationEffectObservation = Readonly<{
  source: NativeMutationEndpointExpectation;
  destination: NativeMutationEndpointExpectation;
  auxiliary: NativeMutationEndpointExpectation;
}>;

export type NativeMutationIntentSnapshot = NativeMutationIntentSeed &
  Readonly<{
    intentDigest: string;
    recordDigest: string;
    temp: NativeMutationAuxiliaryPlan | null;
    tombstone: NativeMutationAuxiliaryPlan | null;
    state: NativeMutationIntentState;
    revision: number;
    auxObservation: NativeMutationRevision | null;
    effectObservation: NativeMutationEffectObservation | null;
    cleanupObservation: Readonly<{ state: 'absent' }> | null;
    recoveryReason: string | null;
    updatedAt: string;
  }>;

export type NativeMutationIntentSeedInput = Omit<
  NativeMutationIntentSeed,
  'version' | 'seedDigest'
>;

export type NativeMutationIntentTransition =
  | Readonly<{ state: 'aux_pending' }>
  | Readonly<{ state: 'aux_observed'; auxObservation: NativeMutationRevision }>
  | Readonly<{ state: 'effect_pending' }>
  | Readonly<{ state: 'effect_observed'; effectObservation: NativeMutationEffectObservation }>
  | Readonly<{ state: 'cleanup_pending' }>
  | Readonly<{ state: 'completed'; cleanupObservation: Readonly<{ state: 'absent' }> | null }>;

export function deriveNativeMutationEffectKind(
  originalKind: NativeMutationIntentKind,
  direction: NativeMutationDirection,
): NativeMutationIntentKind {
  if (direction === 'forward' || originalKind === 'update' || originalKind === 'rename')
    return originalKind;
  return originalKind === 'add' ? 'delete' : 'add';
}

export class InMemoryNativeMutationIntentStore {
  private readonly intents = new Map<string, NativeMutationIntentSnapshot>();
  private readonly keys = new Map<string, string>();
  private readonly auxiliaryKeys = new Set<string>();

  constructor(private readonly nonce: () => string = () => randomBytes(16).toString('hex')) {}

  prepare(seed: NativeMutationIntentSeed): NativeMutationIntentSnapshot {
    const parsedSeed = parseNativeMutationIntentSeed(seed);
    const key = intentKey(parsedSeed);
    const existingId = this.keys.get(key);
    if (existingId !== undefined) {
      const existing = this.get(existingId);
      if (existing.seedDigest !== parsedSeed.seedDigest)
        throw new Error('Native mutation intent key was reused with changed facts');
      return existing;
    }
    if (this.intents.has(parsedSeed.id)) throw new Error('Duplicate Native mutation intent id');
    const snapshot = createNativeMutationIntentSnapshot(parsedSeed, this.nonce());
    const auxiliaryKey = inMemoryAuxiliaryKey(snapshot);
    if (auxiliaryKey !== null && this.auxiliaryKeys.has(auxiliaryKey))
      throw new Error('Native mutation auxiliary name collision');
    this.intents.set(snapshot.id, snapshot);
    this.keys.set(key, snapshot.id);
    if (auxiliaryKey !== null) this.auxiliaryKeys.add(auxiliaryKey);
    return snapshot;
  }

  get(id: string): NativeMutationIntentSnapshot {
    const snapshot = this.intents.get(id);
    if (snapshot === undefined) throw new Error('Native mutation intent not found');
    return snapshot;
  }

  update(
    id: string,
    expectedRevision: number,
    mutate: (current: NativeMutationIntentSnapshot) => NativeMutationIntentSnapshot,
  ): NativeMutationIntentSnapshot {
    const current = this.get(id);
    if (current.revision !== expectedRevision)
      throw new Error('Stale Native mutation intent revision');
    const candidate = parseNativeMutationIntentSnapshot(mutate(current));
    assertImmutableIntent(current, candidate);
    if (candidate.revision !== current.revision + 1)
      throw new Error('Native mutation intent revision did not advance exactly once');
    this.intents.set(id, candidate);
    return candidate;
  }
}

export function createNativeMutationIntentSeed(
  input: NativeMutationIntentSeedInput,
): NativeMutationIntentSeed {
  const facts = {
    version: 1 as const,
    ...input,
    sourceSegments: Object.freeze([...input.sourceSegments]),
    destinationSegments:
      input.destinationSegments === null ? null : Object.freeze([...input.destinationSegments]),
  };
  validateSeedFacts(facts);
  return freezeSeed({ ...facts, seedDigest: digest(seedDigestFacts(facts)) });
}

export function transitionNativeMutationIntent(
  current: NativeMutationIntentSnapshot,
  transition: NativeMutationIntentTransition,
  updatedAt?: string,
): NativeMutationIntentSnapshot {
  const staging = current.temp;
  const requiresStaging = staging !== null;
  if (transition.state === 'aux_pending') {
    if (current.state !== 'planned' || !requiresStaging)
      throw new Error('Invalid Native mutation auxiliary transition');
    return nextSnapshot(current, { state: 'aux_pending' }, updatedAt);
  }
  if (transition.state === 'aux_observed') {
    if (current.state !== 'aux_pending' || staging === null)
      throw new Error('Invalid Native mutation auxiliary observation transition');
    validateRevision(transition.auxObservation);
    if (
      transition.auxObservation.contentHash !== staging.expectedContentHash ||
      transition.auxObservation.size !== staging.expectedSize ||
      transition.auxObservation.mode !== staging.expectedMode ||
      (staging.expectedIdentityDigest !== null &&
        transition.auxObservation.identityDigest !== staging.expectedIdentityDigest)
    )
      throw new Error('Native mutation auxiliary identity does not match the sealed artifact');
    return nextSnapshot(
      current,
      {
        state: 'aux_observed',
        auxObservation: transition.auxObservation,
      },
      updatedAt,
    );
  }
  if (transition.state === 'effect_pending') {
    if (
      (requiresStaging && (current.state !== 'aux_observed' || current.auxObservation === null)) ||
      (!requiresStaging && current.state !== 'planned')
    )
      throw new Error('Native mutation effect requires a durable auxiliary identity');
    return nextSnapshot(current, { state: 'effect_pending' }, updatedAt);
  }
  if (transition.state === 'effect_observed') {
    if (current.state !== 'effect_pending')
      throw new Error('Invalid Native mutation effect observation transition');
    validateEffectObservation(transition.effectObservation);
    validateEffectSemantics(current, transition.effectObservation);
    return nextSnapshot(
      current,
      {
        state: 'effect_observed',
        effectObservation: transition.effectObservation,
      },
      updatedAt,
    );
  }
  if (transition.state === 'cleanup_pending') {
    if (current.state !== 'effect_observed')
      throw new Error('Invalid Native mutation cleanup transition');
    return nextSnapshot(current, { state: 'cleanup_pending' }, updatedAt);
  }
  if (transition.state === 'completed') {
    const cleanupRequired = current.temp !== null || current.tombstone !== null;
    if (
      current.state !== 'effect_observed' &&
      !(cleanupRequired && current.state === 'cleanup_pending')
    )
      throw new Error('Invalid Native mutation completion transition');
    if (cleanupRequired && current.state !== 'cleanup_pending')
      throw new Error('Native mutation auxiliary cleanup is not durable');
    if (
      (cleanupRequired && transition.cleanupObservation?.state !== 'absent') ||
      (!cleanupRequired && transition.cleanupObservation !== null)
    )
      throw new Error('Native mutation cleanup observation does not prove the auxiliary is absent');
    return nextSnapshot(
      current,
      {
        state: 'completed',
        cleanupObservation: transition.cleanupObservation,
      },
      updatedAt,
    );
  }
  const unreachable: never = transition;
  throw new Error(`Unsupported Native mutation transition: ${JSON.stringify(unreachable)}`);
}

export function parseNativeMutationIntentSnapshot(value: unknown): NativeMutationIntentSnapshot {
  if (!isRecord(value)) throw new Error('Invalid persisted Native mutation intent');
  assertExactKeys(value, [
    'version',
    'id',
    'sagaId',
    'ordinal',
    'direction',
    'kind',
    'operationDigest',
    'workspaceKey',
    'rootIdentityDigest',
    'policyEpoch',
    'leaseFence',
    'nativeSessionId',
    'sourceSegments',
    'destinationSegments',
    'expectedSource',
    'expectedDestination',
    'artifact',
    'createdAt',
    'seedDigest',
    'intentDigest',
    'recordDigest',
    'temp',
    'tombstone',
    'state',
    'revision',
    'auxObservation',
    'effectObservation',
    'cleanupObservation',
    'recoveryReason',
    'updatedAt',
  ]);
  const snapshot = value as unknown as NativeMutationIntentSnapshot;
  const seed = parseNativeMutationIntentSeed(snapshot);
  if (!isDigest(snapshot.intentDigest) || !isDigest(snapshot.recordDigest))
    throw new Error('Invalid Native mutation intent digest');
  validateAuxiliary(snapshot.temp, 'post_temp');
  validateAuxiliary(snapshot.tombstone, 'tombstone');
  validateIntentShape(seed, snapshot.temp, snapshot.tombstone);
  if (
    digest(intentDigestFacts(seed, snapshot.temp, snapshot.tombstone)) !== snapshot.intentDigest ||
    digest(recordDigestFacts(snapshot)) !== snapshot.recordDigest ||
    !nativeMutationStates.includes(snapshot.state) ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !isIsoDate(snapshot.updatedAt) ||
    Date.parse(snapshot.updatedAt) < Date.parse(snapshot.createdAt)
  )
    throw new Error('Invalid persisted Native mutation intent');
  if (snapshot.auxObservation !== null) validateRevision(snapshot.auxObservation);
  if (snapshot.effectObservation !== null) validateEffectObservation(snapshot.effectObservation);
  if (snapshot.cleanupObservation !== null) validateAbsent(snapshot.cleanupObservation);
  if (
    (snapshot.state === 'planned' || snapshot.state === 'aux_pending') &&
    (snapshot.auxObservation !== null ||
      snapshot.effectObservation !== null ||
      snapshot.cleanupObservation !== null)
  )
    throw new Error('Native mutation intent has an impossible observation');
  const isAuxiliaryObservedState =
    snapshot.state === 'aux_observed' || snapshot.state === 'effect_pending';
  if (
    isAuxiliaryObservedState &&
    snapshot.temp !== null &&
    (snapshot.auxObservation === null ||
      snapshot.effectObservation !== null ||
      snapshot.cleanupObservation !== null)
  )
    throw new Error('Native mutation intent is missing its auxiliary observation');
  if (
    isAuxiliaryObservedState &&
    snapshot.temp === null &&
    (snapshot.auxObservation !== null ||
      snapshot.effectObservation !== null ||
      snapshot.cleanupObservation !== null)
  )
    throw new Error('Native mutation intent has an impossible auxiliary observation');
  if (
    (snapshot.state === 'effect_observed' ||
      snapshot.state === 'cleanup_pending' ||
      snapshot.state === 'completed') &&
    snapshot.effectObservation === null
  )
    throw new Error('Native mutation intent is missing its effect observation');
  const cleanupRequired = snapshot.temp !== null || snapshot.tombstone !== null;
  if (
    (snapshot.state === 'completed' && cleanupRequired) !==
      (snapshot.cleanupObservation?.state === 'absent') ||
    (!cleanupRequired && snapshot.cleanupObservation !== null)
  )
    throw new Error('Native mutation cleanup observation does not match state');
  if ((snapshot.state === 'recovery_required') !== (snapshot.recoveryReason !== null))
    throw new Error('Native mutation recovery reason does not match state');
  return freezeSnapshot(snapshot);
}

export function parseNativeMutationIntentSeed(value: unknown): NativeMutationIntentSeed {
  if (!isRecord(value)) throw new Error('Invalid Native mutation intent seed');
  const seed = {
    version: value['version'],
    id: value['id'],
    sagaId: value['sagaId'],
    ordinal: value['ordinal'],
    direction: value['direction'],
    kind: value['kind'],
    operationDigest: value['operationDigest'],
    workspaceKey: value['workspaceKey'],
    rootIdentityDigest: value['rootIdentityDigest'],
    policyEpoch: value['policyEpoch'],
    leaseFence: value['leaseFence'],
    nativeSessionId: value['nativeSessionId'],
    sourceSegments: value['sourceSegments'],
    destinationSegments: value['destinationSegments'],
    expectedSource: value['expectedSource'],
    expectedDestination: value['expectedDestination'],
    artifact: value['artifact'],
    createdAt: value['createdAt'],
    seedDigest: value['seedDigest'],
  } as NativeMutationIntentSeed;
  validateSeedFacts(seed);
  if (!isDigest(seed.seedDigest) || digest(seedDigestFacts(seed)) !== seed.seedDigest)
    throw new Error('Invalid Native mutation intent seed digest');
  return freezeSeed(seed);
}

export function createNativeMutationIntentSnapshot(
  seed: NativeMutationIntentSeed,
  nonce = randomBytes(16).toString('hex'),
): NativeMutationIntentSnapshot {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new Error('Invalid Native mutation nonce');
  const parentSegments = Object.freeze(seed.sourceSegments.slice(0, -1));
  const temp =
    seed.kind === 'add' || seed.kind === 'update'
      ? Object.freeze({
          role: 'post_temp' as const,
          parentSegments,
          leafName: `.sprint-coder-temp-${nonce}`,
          expectedContentHash: seed.artifact!.contentHash,
          expectedSize: seed.artifact!.size,
          expectedMode: seed.artifact!.expectedMode,
          expectedIdentityDigest: null,
        })
      : null;
  const tombstone =
    seed.kind === 'delete'
      ? Object.freeze({
          role: 'tombstone' as const,
          parentSegments,
          leafName: `.sprint-coder-tomb-${nonce}`,
          expectedContentHash:
            seed.expectedSource.state === 'present' ? seed.expectedSource.contentHash : '',
          expectedSize: seed.expectedSource.state === 'present' ? seed.expectedSource.size : 0,
          expectedMode:
            seed.expectedSource.state === 'present' ? seed.expectedSource.mode : 0o100600,
          expectedIdentityDigest:
            seed.expectedSource.state === 'present' ? seed.expectedSource.identityDigest : null,
        })
      : null;
  const record = {
    ...seed,
    intentDigest: digest(intentDigestFacts(seed, temp, tombstone)),
    temp,
    tombstone,
    state: 'planned',
    revision: 0,
    auxObservation: null,
    effectObservation: null,
    cleanupObservation: null,
    recoveryReason: null,
    updatedAt: seed.createdAt,
  };
  return parseNativeMutationIntentSnapshot({ ...record, recordDigest: digest(record) });
}

function nextSnapshot(
  current: NativeMutationIntentSnapshot,
  changes: Partial<NativeMutationIntentSnapshot>,
  updatedAt?: string,
): NativeMutationIntentSnapshot {
  const nextUpdatedAt = updatedAt ?? new Date(Date.parse(current.updatedAt) + 1).toISOString();
  if (!isIsoDate(nextUpdatedAt) || Date.parse(nextUpdatedAt) < Date.parse(current.updatedAt))
    throw new Error('Native mutation intent time moved backward');
  const record = {
    ...current,
    ...changes,
    revision: current.revision + 1,
    updatedAt: nextUpdatedAt,
  };
  return parseNativeMutationIntentSnapshot({
    ...record,
    recordDigest: digest(recordDigestFacts(record)),
  });
}

function assertImmutableIntent(
  current: NativeMutationIntentSnapshot,
  candidate: NativeMutationIntentSnapshot,
): void {
  const immutable = [
    'version',
    'id',
    'sagaId',
    'ordinal',
    'direction',
    'kind',
    'operationDigest',
    'workspaceKey',
    'rootIdentityDigest',
    'policyEpoch',
    'leaseFence',
    'nativeSessionId',
    'sourceSegments',
    'destinationSegments',
    'expectedSource',
    'expectedDestination',
    'artifact',
    'createdAt',
    'seedDigest',
    'intentDigest',
    'temp',
    'tombstone',
  ] as const;
  if (immutable.some((key) => JSON.stringify(current[key]) !== JSON.stringify(candidate[key])))
    throw new Error('Native mutation immutable intent changed');
  if (
    current.auxObservation !== null &&
    JSON.stringify(current.auxObservation) !== JSON.stringify(candidate.auxObservation)
  )
    throw new Error('Native mutation observed auxiliary identity changed');
  if (
    current.effectObservation !== null &&
    JSON.stringify(current.effectObservation) !== JSON.stringify(candidate.effectObservation)
  )
    throw new Error('Native mutation observed effect changed');
  if (
    current.cleanupObservation !== null &&
    JSON.stringify(current.cleanupObservation) !== JSON.stringify(candidate.cleanupObservation)
  )
    throw new Error('Native mutation observed cleanup changed');
}

function validateSeedFacts(
  value: Omit<NativeMutationIntentSeed, 'seedDigest'> | NativeMutationIntentSeed,
) {
  if (
    value.version !== 1 ||
    !isIdentifier(value.id) ||
    !isIdentifier(value.sagaId) ||
    !Number.isSafeInteger(value.ordinal) ||
    value.ordinal < 1 ||
    value.ordinal > 100 ||
    !['forward', 'compensation'].includes(value.direction) ||
    !['add', 'update', 'delete', 'rename'].includes(value.kind) ||
    !isDigest(value.operationDigest) ||
    !isDigest(value.workspaceKey) ||
    !isDigest(value.rootIdentityDigest) ||
    !Number.isSafeInteger(value.policyEpoch) ||
    value.policyEpoch < 0 ||
    !isPositiveDecimal(value.leaseFence) ||
    !/^[a-f0-9]{32}$/.test(value.nativeSessionId) ||
    !isIsoDate(value.createdAt)
  )
    throw new Error('Invalid Native mutation intent seed');
  validateSegments(value.sourceSegments);
  if (value.destinationSegments !== null) validateSegments(value.destinationSegments);
  validateExpectation(value.expectedSource);
  validateExpectation(value.expectedDestination);
  if (value.artifact !== null) validateArtifact(value.artifact);
  const validShape =
    value.kind === 'add'
      ? value.expectedSource.state === 'absent' &&
        value.destinationSegments === null &&
        value.artifact !== null
      : value.kind === 'update'
        ? value.expectedSource.state === 'present' &&
          value.destinationSegments === null &&
          value.artifact !== null
        : value.kind === 'delete'
          ? value.expectedSource.state === 'present' &&
            value.destinationSegments === null &&
            value.artifact === null
          : value.expectedSource.state === 'present' &&
            value.destinationSegments !== null &&
            value.expectedDestination.state === 'absent' &&
            value.artifact === null;
  if (!validShape) throw new Error('Invalid Native mutation operation shape');
}

function validateIntentShape(
  seed: NativeMutationIntentSeed,
  temp: NativeMutationAuxiliaryPlan | null,
  tombstone: NativeMutationAuxiliaryPlan | null,
) {
  if (
    (seed.kind === 'add' || seed.kind === 'update') !== (temp !== null) ||
    (seed.kind === 'delete') !== (tombstone !== null) ||
    (temp !== null && tombstone !== null) ||
    (temp !== null &&
      seed.artifact !== null &&
      (temp.expectedContentHash !== seed.artifact.contentHash ||
        temp.expectedSize !== seed.artifact.size ||
        temp.expectedMode !== seed.artifact.expectedMode)) ||
    (tombstone !== null &&
      seed.expectedSource.state === 'present' &&
      (tombstone.expectedContentHash !== seed.expectedSource.contentHash ||
        tombstone.expectedSize !== seed.expectedSource.size ||
        tombstone.expectedMode !== seed.expectedSource.mode ||
        tombstone.expectedIdentityDigest !== seed.expectedSource.identityDigest))
  )
    throw new Error('Invalid Native mutation auxiliary shape');
}

function validateAuxiliary(
  value: NativeMutationAuxiliaryPlan | null,
  role: NativeMutationAuxiliaryPlan['role'],
) {
  if (value === null) return;
  if (!isRecord(value)) throw new Error('Invalid Native mutation auxiliary plan');
  assertExactKeys(value, [
    'role',
    'parentSegments',
    'leafName',
    'expectedContentHash',
    'expectedSize',
    'expectedMode',
    'expectedIdentityDigest',
  ]);
  if (
    value.role !== role ||
    !/^\.sprint-coder-(?:temp|tomb)-[a-f0-9]{32}$/.test(value.leafName) ||
    !isDigest(value.expectedContentHash) ||
    !Number.isSafeInteger(value.expectedSize) ||
    value.expectedSize < 0 ||
    !Number.isSafeInteger(value.expectedMode) ||
    (value.expectedMode & 0o170000) !== 0o100000 ||
    (value.expectedIdentityDigest !== null && !isDigest(value.expectedIdentityDigest))
  )
    throw new Error('Invalid Native mutation auxiliary plan');
  validateSegments(value.parentSegments, true);
}

function validateExpectation(value: NativeMutationEndpointExpectation) {
  if (!isRecord(value) || !['absent', 'present'].includes(value['state'] as string))
    throw new Error('Invalid Native mutation endpoint expectation');
  if (value.state === 'present') validateRevision(value);
  else validateAbsent(value);
}

function validateRevision(value: NativeMutationRevision) {
  if (!isRecord(value)) throw new Error('Invalid Native mutation revision observation');
  assertExactKeys(value, ['state', 'identityDigest', 'contentHash', 'size', 'mode', 'nlink']);
  if (
    value.state !== 'present' ||
    !isDigest(value.identityDigest) ||
    !isDigest(value.contentHash) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_NATIVE_MUTATION_FILE_BYTES ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode & 0o170000) !== 0o100000 ||
    value.nlink !== 1
  )
    throw new Error('Invalid Native mutation revision observation');
}

function validateAbsent(value: Readonly<{ state: 'absent' }>) {
  if (!isRecord(value)) throw new Error('Invalid Native mutation absent observation');
  assertExactKeys(value, ['state']);
  if (value.state !== 'absent') throw new Error('Invalid Native mutation absent observation');
}

function validateEffectObservation(value: NativeMutationEffectObservation) {
  if (!isRecord(value)) throw new Error('Invalid Native mutation effect observation');
  assertExactKeys(value, ['source', 'destination', 'auxiliary']);
  validateExpectation(value.source);
  validateExpectation(value.destination);
  validateExpectation(value.auxiliary);
}

function validateEffectSemantics(
  intent: NativeMutationIntentSnapshot,
  observation: NativeMutationEffectObservation,
) {
  const absent: NativeMutationEndpointExpectation = { state: 'absent' };
  const exact = (
    actual: NativeMutationEndpointExpectation,
    expected: NativeMutationEndpointExpectation,
  ) => JSON.stringify(actual) === JSON.stringify(expected);
  const valid =
    intent.kind === 'add'
      ? intent.auxObservation !== null &&
        exact(observation.source, intent.auxObservation) &&
        exact(observation.destination, absent) &&
        exact(observation.auxiliary, absent)
      : intent.kind === 'update'
        ? intent.auxObservation !== null &&
          exact(observation.source, intent.auxObservation) &&
          exact(observation.destination, absent) &&
          exact(observation.auxiliary, intent.expectedSource)
        : intent.kind === 'delete'
          ? exact(observation.source, absent) &&
            exact(observation.destination, absent) &&
            exact(observation.auxiliary, intent.expectedSource)
          : exact(observation.source, absent) &&
            exact(observation.destination, intent.expectedSource) &&
            exact(observation.auxiliary, absent);
  if (!valid)
    throw new Error('Native mutation effect observation does not match the sealed intent');
}

function validateArtifact(value: NativeMutationArtifactBinding) {
  if (!isRecord(value)) throw new Error('Invalid Native mutation artifact binding');
  assertExactKeys(value, ['artifactId', 'contentHash', 'size', 'expectedMode']);
  if (
    !isIdentifier(value.artifactId) ||
    !isDigest(value.contentHash) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > MAX_NATIVE_MUTATION_FILE_BYTES ||
    !Number.isSafeInteger(value.expectedMode) ||
    (value.expectedMode & 0o170000) !== 0o100000
  )
    throw new Error('Invalid Native mutation artifact binding');
}

function validateSegments(value: readonly string[], allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 128)
    throw new Error('Invalid Native mutation relative segments');
  for (const segment of value) {
    if (
      typeof segment !== 'string' ||
      segment.length < 1 ||
      Buffer.byteLength(segment, 'utf8') > 255 ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes('\0') ||
      segment.includes(':')
    )
      throw new Error('Invalid Native mutation relative segment');
  }
}

function freezeSeed(seed: NativeMutationIntentSeed): NativeMutationIntentSeed {
  return Object.freeze({
    ...seed,
    sourceSegments: Object.freeze([...seed.sourceSegments]),
    destinationSegments:
      seed.destinationSegments === null ? null : Object.freeze([...seed.destinationSegments]),
    expectedSource: Object.freeze({ ...seed.expectedSource }),
    expectedDestination: Object.freeze({ ...seed.expectedDestination }),
    artifact: seed.artifact === null ? null : Object.freeze({ ...seed.artifact }),
  });
}

function freezeSnapshot(snapshot: NativeMutationIntentSnapshot): NativeMutationIntentSnapshot {
  const seed = freezeSeed(snapshot);
  const freezeAuxiliary = (value: NativeMutationAuxiliaryPlan | null) =>
    value === null
      ? null
      : Object.freeze({ ...value, parentSegments: Object.freeze([...value.parentSegments]) });
  return Object.freeze({
    ...seed,
    intentDigest: snapshot.intentDigest,
    recordDigest: snapshot.recordDigest,
    temp: freezeAuxiliary(snapshot.temp),
    tombstone: freezeAuxiliary(snapshot.tombstone),
    state: snapshot.state,
    revision: snapshot.revision,
    auxObservation:
      snapshot.auxObservation === null ? null : Object.freeze({ ...snapshot.auxObservation }),
    effectObservation:
      snapshot.effectObservation === null
        ? null
        : Object.freeze({
            source: Object.freeze({ ...snapshot.effectObservation.source }),
            destination: Object.freeze({ ...snapshot.effectObservation.destination }),
            auxiliary: Object.freeze({ ...snapshot.effectObservation.auxiliary }),
          }),
    cleanupObservation:
      snapshot.cleanupObservation === null
        ? null
        : Object.freeze({ ...snapshot.cleanupObservation }),
    recoveryReason: snapshot.recoveryReason,
    updatedAt: snapshot.updatedAt,
  });
}

function seedDigestFacts(
  seed: Omit<NativeMutationIntentSeed, 'seedDigest'> | NativeMutationIntentSeed,
) {
  const {
    createdAt: _createdAt,
    id: _id,
    seedDigest: _seedDigest,
    ...stable
  } = seed as NativeMutationIntentSeed;
  return stable;
}

function intentDigestFacts(
  seed: NativeMutationIntentSeed,
  temp: NativeMutationAuxiliaryPlan | null,
  tombstone: NativeMutationAuxiliaryPlan | null,
) {
  return { seedDigest: seed.seedDigest, temp, tombstone };
}

function recordDigestFacts(
  snapshot: Omit<NativeMutationIntentSnapshot, 'recordDigest'> | NativeMutationIntentSnapshot,
) {
  const { recordDigest: _recordDigest, ...facts } = snapshot as NativeMutationIntentSnapshot;
  return facts;
}

function intentKey(seed: NativeMutationIntentSeed) {
  return JSON.stringify([seed.sagaId, seed.ordinal, seed.direction]);
}

function inMemoryAuxiliaryKey(snapshot: NativeMutationIntentSnapshot): string | null {
  const auxiliary = snapshot.temp ?? snapshot.tombstone;
  return auxiliary === null
    ? null
    : JSON.stringify([snapshot.workspaceKey, auxiliary.parentSegments, auxiliary.leafName]);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error('Native mutation intent has unknown or missing fields');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isPositiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

const nativeMutationStates: readonly NativeMutationIntentState[] = [
  'planned',
  'aux_pending',
  'aux_observed',
  'effect_pending',
  'effect_observed',
  'cleanup_pending',
  'completed',
  'recovery_required',
];
