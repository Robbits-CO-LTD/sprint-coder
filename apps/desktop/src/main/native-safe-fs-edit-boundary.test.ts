import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NativeSafeFsEditEffectBoundary } from './native-safe-fs-edit-boundary';
import {
  createEditSagaSnapshot,
  stageEditSagaRequest,
  type EditArtifactRepository,
  type EditSagaSnapshot,
  type EditSagaStep,
  type OperationObservation,
} from './edit-saga';
import {
  createEditArtifactReference,
  type EditArtifactOwner,
  type EditArtifactRef,
} from './edit-artifact-store';
import { structuredPatchDigest, type PreparedStructuredPatch } from './structured-patch';
import { NativeSafeFsError, type NativeSafeFsSession } from './native-safe-fs';
import {
  createNativeMutationIntentSnapshot,
  transitionNativeMutationIntent,
  type NativeMutationEffectObservation,
  type NativeMutationEndpointExpectation,
  type NativeMutationIntentSeed,
  type NativeMutationIntentSnapshot,
  type NativeMutationIntentTransition,
  type NativeMutationRevision,
} from './native-mutation-intent';
import { MutationLeaseStaleError, type MutationLeaseToken } from './mutation-lease';

const WORKSPACE = '/workspace';
const ABSENT = { state: 'absent' } as const;

class MemoryArtifacts implements Pick<EditArtifactRepository, 'read' | 'put'> {
  readonly values = new Map<string, Buffer>();
  async put(input: { owner: EditArtifactOwner; bytes: Buffer }): Promise<EditArtifactRef> {
    const reference = createEditArtifactReference(input.owner, input.bytes);
    this.values.set(reference.artifactId, Buffer.from(input.bytes));
    return reference;
  }
  async read(reference: EditArtifactRef): Promise<Buffer> {
    const value = this.values.get(reference.artifactId);
    if (value === undefined) throw new Error('artifact missing');
    return Buffer.from(value);
  }
}

// Records ordering and reasserts the intent-consistent observations the native
// authority boundary would return for each journaled effect, so the durable intent
// state machine validates exactly as production Persistence would.
class FakeNative {
  readonly calls: string[] = [];
  failAssertOn: number | null = null;
  afterObserve: (() => void) | null = null;
  private assertCount = 0;
  nextObserve: NativeMutationEffectObservation | null = null;
  directoryIdentity: string | null = null;
  crashAfterCreate = false;
  crashAfterCleanup = false;

  assertSession(): void {
    this.assertCount += 1;
    this.calls.push('assert');
    if (this.assertCount === this.failAssertOn)
      throw new NativeSafeFsError('STALE_SESSION', 'NativeSafeFs session is stale');
  }

  async observeIntent(
    _session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
  ): Promise<NativeMutationEffectObservation> {
    this.calls.push('observe');
    this.afterObserve?.();
    this.afterObserve = null;
    return (
      this.nextObserve ?? { source: intent.expectedSource, destination: ABSENT, auxiliary: ABSENT }
    );
  }

  async stageIntentArtifact(
    _session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
  ): Promise<NativeMutationRevision> {
    this.calls.push('stage');
    const temp = intent.temp!;
    return {
      state: 'present',
      identityDigest: '9'.repeat(64),
      contentHash: temp.expectedContentHash,
      size: temp.expectedSize,
      mode: temp.expectedMode,
      nlink: 1,
    };
  }

  async applyIntentEffect(
    _session: NativeSafeFsSession,
    intent: NativeMutationIntentSnapshot,
  ): Promise<NativeMutationEffectObservation> {
    this.calls.push('apply');
    const aux = intent.auxObservation as NativeMutationEndpointExpectation | null;
    switch (intent.kind) {
      case 'add':
        return { source: aux!, destination: ABSENT, auxiliary: ABSENT };
      case 'update':
        return { source: aux!, destination: ABSENT, auxiliary: intent.expectedSource };
      case 'delete':
        return { source: ABSENT, destination: ABSENT, auxiliary: intent.expectedSource };
      default:
        return { source: ABSENT, destination: intent.expectedSource, auxiliary: ABSENT };
    }
  }

  async cleanupIntentAuxiliary(): Promise<Readonly<{ state: 'absent' }>> {
    this.calls.push('cleanup');
    return ABSENT;
  }

  async observeDirectory() {
    return this.directoryIdentity === null
      ? ({ state: 'absent' } as const)
      : ({ state: 'present', identityDigest: this.directoryIdentity } as const);
  }
  async inspectDirectoryOwnership() {
    this.calls.push('inspect-directory');
    return this.observeDirectory();
  }
  async createDirectory() {
    this.calls.push('mkdir');
    this.directoryIdentity = 'd'.repeat(64);
    if (this.crashAfterCreate) {
      this.crashAfterCreate = false;
      throw new Error('simulated process crash after mkdir');
    }
    return { state: 'present' as const, identityDigest: this.directoryIdentity };
  }
  async cleanupDirectoryOwnership() {
    this.calls.push('cleanup-directory-marker');
    if (this.crashAfterCleanup) {
      this.crashAfterCleanup = false;
      throw new Error('simulated process crash after marker cleanup');
    }
  }
  async removeDirectory() {
    this.calls.push('rmdir');
    this.directoryIdentity = null;
  }
}

// In-memory journal that reuses the real intent state machine (transition validation,
// digest recomputation, effect semantics) so persisted transitions are authentic.
class FakeJournal {
  readonly intents = new Map<string, NativeMutationIntentSnapshot>();
  readonly leaseRevisions: number[] = [];

  constructor(private readonly expectedLease?: () => MutationLeaseToken) {}

  getMutationWorkspacePath(): string | null {
    return WORKSPACE;
  }
  getNativeMutationIntent(id: string): NativeMutationIntentSnapshot {
    const intent = this.intents.get(id);
    if (intent === undefined) throw new Error('intent missing');
    return intent;
  }
  prepareNativeMutationIntent(
    seed: NativeMutationIntentSeed,
    lease: MutationLeaseToken,
    _now: string,
  ): NativeMutationIntentSnapshot {
    this.assertLease(lease);
    const existing = this.intents.get(seed.id);
    if (existing !== undefined) return existing;
    const snapshot = createNativeMutationIntentSnapshot(seed, 'a'.repeat(32));
    this.intents.set(snapshot.id, snapshot);
    return snapshot;
  }
  updateNativeMutationIntent(
    id: string,
    expectedRevision: number,
    lease: MutationLeaseToken,
    now: string,
    _nativeSessionId: string,
    transition: NativeMutationIntentTransition,
  ): NativeMutationIntentSnapshot {
    this.assertLease(lease);
    const current = this.intents.get(id);
    if (current === undefined) throw new Error('intent not found');
    if (current.revision !== expectedRevision) throw new Error('stale intent revision');
    const next = transitionNativeMutationIntent(current, transition, now);
    this.intents.set(id, next);
    return next;
  }

  private assertLease(lease: MutationLeaseToken): void {
    this.leaseRevisions.push(lease.revision);
    const expected = this.expectedLease?.();
    if (expected !== undefined && lease.revision !== expected.revision)
      throw new MutationLeaseStaleError();
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sealedRevision(value: string, identity: string) {
  return Object.freeze({
    identityDigest: identity.repeat(64),
    contentHash: hash(value),
    size: Buffer.byteLength(value),
    mode: 0o100644,
    nlink: 1 as const,
  });
}

function singlePlan(
  kind: 'add' | 'mkdir' | 'update' | 'delete' | 'rename',
): PreparedStructuredPatch {
  const pre = kind === 'add' || kind === 'mkdir' ? null : 'BEFORE';
  const post =
    kind === 'mkdir' || kind === 'delete' ? null : kind === 'rename' ? 'BEFORE' : 'AFTER';
  const operation = Object.freeze({
    kind,
    path: `src/${kind}.ts`,
    canonicalPath: `${WORKSPACE}/src/${kind}.ts`,
    destination: kind === 'rename' ? 'src/moved.ts' : null,
    canonicalDestination: kind === 'rename' ? `${WORKSPACE}/src/moved.ts` : null,
    revisionTokenId: kind === 'add' || kind === 'mkdir' ? null : `token-${kind}`,
    preRevision: pre === null ? null : sealedRevision(pre, 'd'),
    preImage: pre,
    postImage: post,
    preHash: pre === null ? null : hash(pre),
    postHash: post === null ? null : hash(post),
  });
  const facts = { version: 1 as const, policyEpoch: 0, operations: Object.freeze([operation]) };
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

async function stageSaga(
  plan: PreparedStructuredPatch,
  artifacts: MemoryArtifacts,
): Promise<EditSagaSnapshot> {
  const request = await stageEditSagaRequest({
    id: 'saga-native-boundary',
    taskId: 'task-1',
    turnId: 'turn-1',
    operationId: 'operation-1',
    plan,
    createdAt: '2026-07-23T00:00:00.000Z',
  });
  const saga = createEditSagaSnapshot(request);
  for (const step of saga.steps) {
    const source = plan.operations[step.ordinal - 1]!;
    for (const item of [
      { reference: step.operation.preArtifact, image: source.preImage },
      { reference: step.operation.postArtifact, image: source.postImage },
    ]) {
      if (item.reference === null || item.image === null) continue;
      await artifacts.put({ owner: item.reference.owner, bytes: Buffer.from(item.image, 'utf8') });
    }
  }
  return saga;
}

function lease(): MutationLeaseToken {
  return Object.freeze({
    version: 1,
    rootId: null,
    workspaceKey: 'a'.repeat(64),
    rootIdentityDigest: '2'.repeat(64),
    leaseId: 'lease-1',
    holderInstanceId: 'instance-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    sagaId: 'saga-native-boundary',
    purpose: 'forward',
    policyEpoch: 0,
    intentDigest: 'c'.repeat(64),
    fence: 7,
    revision: 1,
    acquiredAt: '2026-07-23T00:00:00.000Z',
    renewedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-23T01:00:00.000Z',
  });
}

function session(): NativeSafeFsSession {
  return Object.freeze({
    id: '6'.repeat(32),
    rootId: 'legacy-primary',
    workspaceKey: 'a'.repeat(64),
    fence: '7',
    rootDev: '10',
    rootIno: '20',
  });
}

function makeBoundary(native: FakeNative, journal: FakeJournal, artifacts: MemoryArtifacts) {
  let clock = Date.parse('2026-07-23T00:00:10.000Z');
  return new NativeSafeFsEditEffectBoundary({
    native,
    journal,
    artifacts,
    resolveSession: async () => session(),
    now: () => new Date((clock += 5)).toISOString(),
  });
}

function presentObservation(contentHash: string, size: number): OperationObservation {
  return {
    source: { state: 'present', revision: { identityDigest: 'e'.repeat(64), contentHash, size } },
    destination: { state: 'absent' },
  };
}

describe('NativeSafeFsEditEffectBoundary', () => {
  it('routes mkdir through the sealed directory lifecycle and converges an effect_pending retry', async () => {
    const native = new FakeNative();
    const journal = new FakeJournal();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('mkdir'), artifacts);
    const boundary = new NativeSafeFsEditEffectBoundary({
      native,
      journal,
      artifacts,
      resolveSession: async () => session(),
      now: (() => {
        let tick = 0;
        return () => new Date(Date.parse('2026-07-23T00:00:00.000Z') + tick++).toISOString();
      })(),
    });

    native.crashAfterCreate = true;
    await expect(boundary.apply(saga.steps[0]!, lease())).rejects.toThrow(
      'simulated process crash',
    );
    expect([...journal.intents.values()][0]).toMatchObject({ state: 'effect_pending' });
    native.crashAfterCleanup = true;
    await expect(boundary.apply(saga.steps[0]!, lease())).rejects.toThrow(
      'simulated process crash after marker cleanup',
    );
    expect([...journal.intents.values()][0]).toMatchObject({ state: 'cleanup_pending' });
    const first = await boundary.apply(saga.steps[0]!, lease());
    expect(first.source).toMatchObject({
      state: 'present',
      revision: { entryKind: 'directory', identityDigest: 'd'.repeat(64) },
    });
    expect(native.calls).toEqual([
      'assert',
      'inspect-directory',
      'mkdir',
      'assert',
      'inspect-directory',
      'assert',
      'cleanup-directory-marker',
      'assert',
      'cleanup-directory-marker',
    ]);
    const second = await boundary.apply(saga.steps[0]!, lease());
    expect(second).toEqual(first);
    expect(native.calls).toHaveLength(9);
    expect([...journal.intents.values()][0]).toMatchObject({ state: 'completed' });
  });

  it.each(['add', 'update', 'delete', 'rename'] as const)(
    'drives the journaled native effect lifecycle for a %s effect',
    async (kind) => {
      const native = new FakeNative();
      const journal = new FakeJournal();
      const artifacts = new MemoryArtifacts();
      const saga = await stageSaga(singlePlan(kind), artifacts);
      const boundary = makeBoundary(native, journal, artifacts);

      const observation = await boundary.apply(saga.steps[0]!, lease());

      const expectedCalls =
        kind === 'add' || kind === 'update'
          ? ['assert', 'observe', 'assert', 'stage', 'assert', 'apply', 'assert', 'cleanup']
          : kind === 'delete'
            ? ['assert', 'observe', 'assert', 'apply', 'assert', 'cleanup']
            : ['assert', 'observe', 'assert', 'apply'];
      expect(native.calls).toEqual(expectedCalls);
      expect([...journal.intents.values()][0]).toMatchObject({ state: 'completed' });
      const primary = kind === 'rename' ? observation.destination : observation.source;
      if (kind === 'delete') expect(primary.state).toBe('absent');
      else {
        expect(primary.state).toBe('present');
        if (primary.state === 'present' && primary.revision.entryKind !== 'directory')
          expect(primary.revision.contentHash).toBe(saga.steps[0]!.operation.postHash);
      }
    },
  );

  it('reasserts the live session before every native effect and fails closed', async () => {
    const native = new FakeNative();
    native.failAssertOn = 3; // just before applyIntentEffect on an update
    const journal = new FakeJournal();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('update'), artifacts);
    const boundary = makeBoundary(native, journal, artifacts);

    await expect(boundary.apply(saga.steps[0]!, lease())).rejects.toBeInstanceOf(NativeSafeFsError);
    // The effect never entered the addon and the intent stayed durably pending.
    expect(native.calls).toEqual(['assert', 'observe', 'assert', 'stage', 'assert']);
    expect([...journal.intents.values()][0]).toMatchObject({ state: 'effect_pending' });
  });

  it('resolves the latest renewed lease before every native journal transition', async () => {
    const native = new FakeNative();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('update'), artifacts);
    let current = lease();
    const journal = new FakeJournal(() => current);
    const boundary = makeBoundary(native, journal, artifacts);
    native.afterObserve = () => {
      current = Object.freeze({
        ...current,
        revision: current.revision + 1,
        renewedAt: '2026-07-23T00:00:20.000Z',
        expiresAt: '2026-07-23T01:00:20.000Z',
      });
    };

    await expect(boundary.apply(saga.steps[0]!, { current: () => current })).resolves.toBeDefined();

    expect(journal.leaseRevisions[0]).toBe(1);
    expect(journal.leaseRevisions.slice(1)).toEqual(
      Array(journal.leaseRevisions.length - 1).fill(2),
    );
    expect([...journal.intents.values()][0]).toMatchObject({ state: 'completed' });
  });

  it('refuses to enter the addon when the session cannot be reasserted at all', async () => {
    const native = new FakeNative();
    native.failAssertOn = 1;
    const journal = new FakeJournal();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('add'), artifacts);
    const boundary = makeBoundary(native, journal, artifacts);

    await expect(boundary.apply(saga.steps[0]!, lease())).rejects.toBeInstanceOf(NativeSafeFsError);
    expect(native.calls).toEqual(['assert']);
  });

  it('fails closed when no mutation lease is supplied', async () => {
    const native = new FakeNative();
    const journal = new FakeJournal();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('update'), artifacts);
    const boundary = makeBoundary(native, journal, artifacts);

    await expect(boundary.apply(saga.steps[0]!, null)).rejects.toBeInstanceOf(
      MutationLeaseStaleError,
    );
    expect(native.calls).toEqual([]);
  });

  it('classifies pre-image, post-image, and external drift observations', async () => {
    const native = new FakeNative();
    const journal = new FakeJournal();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('update'), artifacts);
    const boundary = makeBoundary(native, journal, artifacts);
    const step = saga.steps[0]!;
    const preHash = step.operation.preHash!;
    const postHash = step.operation.postHash!;
    const size = step.operation.preArtifact!.size;

    native.nextObserve = {
      source: presentEndpoint(preHash, size),
      destination: ABSENT,
      auxiliary: ABSENT,
    };
    await expect(boundary.observe(step, lease())).resolves.toMatchObject({ state: 'pre' });

    native.nextObserve = {
      source: presentEndpoint(postHash, step.operation.postArtifact!.size),
      destination: ABSENT,
      auxiliary: ABSENT,
    };
    await expect(boundary.observe(step, lease())).resolves.toMatchObject({ state: 'post' });

    native.nextObserve = {
      source: presentEndpoint(hash('EXTERNAL'), 8),
      destination: ABSENT,
      auxiliary: ABSENT,
    };
    await expect(boundary.observe(step, lease())).resolves.toMatchObject({ state: 'drift' });
  });

  it('compensates a committed update through a reverse native intent', async () => {
    const native = new FakeNative();
    const journal = new FakeJournal();
    const artifacts = new MemoryArtifacts();
    const saga = await stageSaga(singlePlan('update'), artifacts);
    const step = saga.steps[0]!;
    const committed: EditSagaStep = {
      ...step,
      state: 'effect_observed',
      postObservation: presentObservation(
        step.operation.postHash!,
        step.operation.postArtifact!.size,
      ),
    };
    const boundary = makeBoundary(native, journal, artifacts);

    const restored = await boundary.restore(committed, committed.postObservation!, lease());

    expect(native.calls).toEqual([
      'assert',
      'observe',
      'assert',
      'stage',
      'assert',
      'apply',
      'assert',
      'cleanup',
    ]);
    const intent = [...journal.intents.values()][0]!;
    expect(intent).toMatchObject({ direction: 'compensation', state: 'completed' });
    expect(restored.source.state).toBe('present');
    if (restored.source.state === 'present' && restored.source.revision.entryKind !== 'directory')
      expect(restored.source.revision.contentHash).toBe(step.operation.preHash);
  });
});

function presentEndpoint(contentHash: string, size: number): NativeMutationRevision {
  return {
    state: 'present',
    identityDigest: 'f'.repeat(64),
    contentHash,
    size,
    mode: 0o100644,
    nlink: 1,
  };
}
