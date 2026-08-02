import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  aggregateTurnDiff,
  EditSagaCrashError,
  EditSagaExecutor,
  InMemoryEditSagaStore,
  stageEditSagaRequest,
  type EditArtifactRepository,
  type EditEffectObservation,
  type EditEffectBoundary,
  type EditSagaFaultPoint,
  type EditSagaStep,
  type OperationObservation,
  type RevisionObservation,
  type TurnDiffEntry,
} from './edit-saga';
import {
  createEditArtifactReference,
  type EditArtifactOwner,
  type EditArtifactRef,
} from './edit-artifact-store';
import type { PreparedStructuredPatch } from './structured-patch';
import { structuredPatchDigest } from './structured-patch';

function plan(): PreparedStructuredPatch {
  const operations = [
    {
      kind: 'update' as const,
      path: 'a.txt',
      canonicalPath: '/workspace/a.txt',
      destination: null,
      canonicalDestination: null,
      revisionTokenId: 'token-a',
      preRevision: sealedRevision('A0', 'a'),
      preImage: 'A0',
      postImage: 'A1',
      preHash: hash('A0'),
      postHash: hash('A1'),
    },
    {
      kind: 'update' as const,
      path: 'b.txt',
      canonicalPath: '/workspace/b.txt',
      destination: null,
      canonicalDestination: null,
      revisionTokenId: 'token-b',
      preRevision: sealedRevision('B0', 'b'),
      preImage: 'B0',
      postImage: 'B1',
      preHash: hash('B0'),
      postHash: hash('B1'),
    },
  ];
  const facts = {
    version: 1 as const,
    policyEpoch: 2,
    operations: Object.freeze(operations.map((operation) => Object.freeze(operation))),
  };
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

class FakeBoundary implements EditEffectBoundary {
  readonly files = new Map([
    ['/workspace/a.txt', 'A0'],
    ['/workspace/b.txt', 'B0'],
  ]);
  readonly applied: number[] = [];
  readonly restored: number[] = [];
  failApplyOrdinal: number | null = null;

  constructor(private readonly artifacts: EditArtifactRepository) {}

  async apply(step: EditSagaStep): Promise<OperationObservation> {
    if (step.ordinal === this.failApplyOrdinal) throw new Error('injected apply failure');
    const preImage = await readText(this.artifacts, step.operation.preArtifact);
    const postImage = await readText(this.artifacts, step.operation.postArtifact);
    expect(this.files.get(step.operation.canonicalPath)).toBe(preImage);
    this.files.set(step.operation.canonicalPath, postImage ?? '');
    this.applied.push(step.ordinal);
    return operationObservation(
      step.operation.postHash!,
      Buffer.byteLength(postImage ?? '', 'utf8'),
    );
  }

  async observe(step: EditSagaStep): Promise<EditEffectObservation> {
    const current = this.files.get(step.operation.canonicalPath);
    const preImage = await readText(this.artifacts, step.operation.preArtifact);
    const postImage = await readText(this.artifacts, step.operation.postArtifact);
    if (current === preImage)
      return {
        state: 'pre',
        observation: operationObservation(
          step.operation.preHash!,
          Buffer.byteLength(preImage ?? '', 'utf8'),
        ),
      };
    if (current === postImage)
      return {
        state: 'post',
        observation: operationObservation(
          step.operation.postHash!,
          Buffer.byteLength(postImage ?? '', 'utf8'),
        ),
      };
    return {
      state: 'drift',
      observation: operationObservation(
        hash('USER CHANGE'),
        Buffer.byteLength(current ?? '', 'utf8'),
      ),
    };
  }

  async restore(
    step: EditSagaStep,
    expectedPost: OperationObservation,
  ): Promise<OperationObservation> {
    if ((await this.observe(step)).state === 'drift') throw new Error('external drift');
    expect(expectedPost.source.state).toBe('present');
    const preImage = await readText(this.artifacts, step.operation.preArtifact);
    this.files.set(step.operation.canonicalPath, preImage ?? '');
    this.restored.push(step.ordinal);
    return operationObservation(step.operation.preHash!, Buffer.byteLength(preImage ?? '', 'utf8'));
  }
}

class SemanticBoundary implements EditEffectBoundary {
  readonly files: Map<string, string>;
  constructor(
    private readonly artifacts: EditArtifactRepository,
    initial: readonly (readonly [string, string])[],
  ) {
    this.files = new Map(initial);
  }
  async apply(step: EditSagaStep): Promise<OperationObservation> {
    expect((await this.observe(step)).state).toBe('pre');
    const post = await readText(this.artifacts, step.operation.postArtifact);
    if (step.operation.kind === 'delete' || step.operation.kind === 'rename')
      this.files.delete(step.operation.canonicalPath);
    if (step.operation.kind === 'rename')
      this.files.set(step.operation.canonicalDestination!, post!);
    else if (post !== null) this.files.set(step.operation.canonicalPath, post);
    return this.snapshot(step);
  }
  async observe(step: EditSagaStep): Promise<EditEffectObservation> {
    const observation = this.snapshot(step);
    if (matchesPhase(step, observation, 'pre')) return { state: 'pre', observation };
    if (matchesPhase(step, observation, 'post')) return { state: 'post', observation };
    return { state: 'drift', observation };
  }
  async restore(
    step: EditSagaStep,
    _expectedPost: OperationObservation,
  ): Promise<OperationObservation> {
    expect((await this.observe(step)).state).toBe('post');
    const pre = await readText(this.artifacts, step.operation.preArtifact);
    if (step.operation.kind === 'add') this.files.delete(step.operation.canonicalPath);
    else this.files.set(step.operation.canonicalPath, pre!);
    if (step.operation.kind === 'rename') this.files.delete(step.operation.canonicalDestination!);
    return this.snapshot(step);
  }
  private snapshot(step: EditSagaStep): OperationObservation {
    return {
      source: endpoint(this.files.get(step.operation.canonicalPath)),
      destination: endpoint(
        step.operation.canonicalDestination === null
          ? undefined
          : this.files.get(step.operation.canonicalDestination),
      ),
    };
  }
}

class MemoryArtifacts implements EditArtifactRepository {
  readonly values = new Map<string, Buffer>();
  putCount = 0;
  failPutAt: number | null = null;
  failReleaseAt: number | null = null;
  releaseCount = 0;
  async put(input: { owner: EditArtifactOwner; bytes: Buffer }): Promise<EditArtifactRef> {
    this.putCount += 1;
    if (this.putCount === this.failPutAt) throw new Error('injected artifact write failure');
    const reference = createEditArtifactReference(input.owner, input.bytes);
    this.values.set(reference.artifactId, Buffer.from(input.bytes));
    return reference;
  }
  async read(reference: EditArtifactRef): Promise<Buffer> {
    const value = this.values.get(reference.artifactId);
    if (value === undefined) throw new Error('artifact missing');
    return Buffer.from(value);
  }
  async release(reference: EditArtifactRef): Promise<void> {
    this.releaseCount += 1;
    if (this.releaseCount === this.failReleaseAt) throw new Error('injected release failure');
    this.values.delete(reference.artifactId);
  }
}

describe('EditSagaExecutor', () => {
  it('durably retries terminal artifact cleanup after a crash or release failure', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    const executor = new EditSagaExecutor(store, boundary, artifacts, {
      hit(point) {
        if (point.kind === 'afterTerminalBeforeCleanup')
          throw new EditSagaCrashError('terminal crash');
      },
    });
    await expect(executor.apply(request())).rejects.toBeInstanceOf(EditSagaCrashError);
    expect(store.get('saga-1')).toMatchObject({
      state: 'committed',
      artifactCleanupPending: true,
    });
    expect(artifacts.values.size).toBe(4);

    artifacts.failReleaseAt = 1;
    const firstRetry = await new EditSagaExecutor(store, boundary, artifacts).reconcileAll();
    expect(firstRetry[0]).toMatchObject({ artifactCleanupPending: true });
    artifacts.failReleaseAt = null;
    const secondRetry = await new EditSagaExecutor(store, boundary, artifacts).reconcileAll();
    expect(secondRetry[0]).toMatchObject({ artifactCleanupPending: false });
    expect(artifacts.values.size).toBe(0);
    expect(await new EditSagaExecutor(store, boundary, artifacts).reconcileAll()).toEqual([]);
  });

  it.each(['add', 'delete', 'rename'] as const)(
    'commits and validates %s endpoint presence semantics',
    async (kind) => {
      const patch = singleOperationPlan(kind);
      const operation = patch.operations[0]!;
      const initial =
        operation.preImage === null
          ? []
          : ([[operation.canonicalPath, operation.preImage]] as const);
      const artifacts = new MemoryArtifacts();
      const boundary = new SemanticBoundary(artifacts, initial);
      const result = await new EditSagaExecutor(
        new InMemoryEditSagaStore(),
        boundary,
        artifacts,
      ).apply({
        id: `saga-${kind}`,
        taskId: 'task-1',
        turnId: 'turn-1',
        operationId: `operation-${kind}`,
        plan: patch,
        createdAt: '2026-07-23T00:00:00.000Z',
      });

      expect(result.state).toBe('committed');
      expect(result.diff[0]).toMatchObject({ kind, status: 'applied' });
    },
  );

  it('journals before artifact publication and cleans a partial staging failure', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    artifacts.failPutAt = 2;
    const boundary = new FakeBoundary(artifacts);

    const result = await new EditSagaExecutor(store, boundary, artifacts).apply(request());

    expect(result.state).toBe('restored');
    expect(boundary.applied).toEqual([]);
    expect(artifacts.values.size).toBe(0);
  });

  it('recovers a crash after the journal but before artifact publication without an orphan', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    await expect(
      new EditSagaExecutor(store, boundary, artifacts, {
        hit(point) {
          if (point.kind === 'afterJournalPrepared') throw new EditSagaCrashError('crash');
        },
      }).apply(request()),
    ).rejects.toBeInstanceOf(EditSagaCrashError);
    expect(artifacts.values.size).toBe(0);

    const recovered = await new EditSagaExecutor(store, boundary, artifacts).recover('saga-1');
    expect(recovered.state).toBe('restored');
    expect(boundary.applied).toEqual([]);
  });

  it('rejects plan mutation and impossible state transitions at the store boundary', async () => {
    const store = new InMemoryEditSagaStore();
    const created = store.create(await stageEditSagaRequest(request(), new MemoryArtifacts()));
    expect(() =>
      store.update(created.id, created.revision, (current) => {
        const { revision: _revision, ...snapshot } = current;
        return {
          ...snapshot,
          steps: current.steps.map((step, index) =>
            index === 0
              ? { ...step, operation: { ...step.operation, canonicalPath: '/other/a.txt' } }
              : step,
          ),
        };
      }),
    ).toThrow('plan changed');
    expect(() =>
      store.update(created.id, created.revision, (current) => {
        const { revision: _revision, ...snapshot } = current;
        return { ...snapshot, state: 'committed', updatedAt: current.updatedAt };
      }),
    ).toThrow('state transition');
    expect(() =>
      store.update(created.id, created.revision, (current) => {
        const { revision: _revision, ...snapshot } = current;
        return {
          ...snapshot,
          state: 'applying',
          steps: current.steps.map((step, index) =>
            index === 0
              ? {
                  ...step,
                  state: 'effect_pending',
                  operation: { ...step.operation, preImage: 'must never reach SQLite' },
                }
              : step,
          ),
        };
      }),
    ).toThrow('unknown or missing fields');
  });

  it('journals before effects and compensates committed files in reverse order', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    boundary.failApplyOrdinal = 2;
    const executor = new EditSagaExecutor(store, boundary, artifacts);

    const result = await executor.apply(request());

    expect(result.state).toBe('restored');
    expect(boundary.applied).toEqual([1]);
    expect(boundary.restored).toEqual([1]);
    expect([...boundary.files.values()]).toEqual(['A0', 'B0']);
    expect(store.get(result.id).revision).toBeGreaterThanOrEqual(4);
  });

  it('quarantines a crash-unknown effect without replaying or overwriting it', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    const executor = new EditSagaExecutor(store, boundary, artifacts, {
      hit(point: EditSagaFaultPoint) {
        if (point.kind === 'afterEffectBeforeJournal' && point.ordinal === 1)
          throw new EditSagaCrashError('simulated crash');
      },
    });

    await expect(executor.apply(request())).rejects.toBeInstanceOf(EditSagaCrashError);
    expect(boundary.applied).toEqual([1]);
    const recovered = await new EditSagaExecutor(store, boundary, artifacts).recover('saga-1');

    expect(recovered.state).toBe('recovery_required');
    expect(boundary.applied).toEqual([1]);
    expect(boundary.restored).toEqual([]);
    expect([...boundary.files.values()]).toEqual(['A1', 'B0']);
  });

  it('recognizes a restore completed immediately before process death', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    boundary.failApplyOrdinal = 2;
    const executor = new EditSagaExecutor(store, boundary, artifacts, {
      hit(point: EditSagaFaultPoint) {
        if (point.kind === 'afterRestoreBeforeJournal' && point.ordinal === 1)
          throw new EditSagaCrashError('simulated crash after restore');
      },
    });

    await expect(executor.apply(request())).rejects.toBeInstanceOf(EditSagaCrashError);
    expect(boundary.files.get('/workspace/a.txt')).toBe('A0');
    const recovered = await new EditSagaExecutor(store, boundary, artifacts).recover('saga-1');

    expect(recovered.state).toBe('restored');
    expect(boundary.applied).toEqual([1]);
    expect(boundary.restored).toEqual([1]);
  });

  it('never overwrites external drift during compensation and records recovery_required', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    boundary.failApplyOrdinal = 2;
    const executor = new EditSagaExecutor(store, boundary, artifacts, {
      hit(point: EditSagaFaultPoint) {
        if (point.kind === 'beforeRestore' && point.ordinal === 1)
          boundary.files.set('/workspace/a.txt', 'USER CHANGE');
      },
    });

    const result = await executor.apply(request());

    expect(result.state).toBe('recovery_required');
    expect(boundary.files.get('/workspace/a.txt')).toBe('USER CHANGE');
    expect(result.recovery).toMatchObject({ reason: 'compensation_precondition_failed' });
    expect(result.diff).toEqual([
      expect.objectContaining({
        ordinal: 1,
        status: 'external_drift',
        actualHash: hash('USER CHANGE'),
      }),
    ]);
  });

  it('never commits a boundary result that disagrees with the sealed post-image', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    boundary.apply = async function (step) {
      const postImage = await readText(artifacts, step.operation.postArtifact);
      this.files.set(step.operation.canonicalPath, postImage ?? '');
      this.applied.push(step.ordinal);
      return operationObservation('f'.repeat(64), Buffer.byteLength(postImage ?? '', 'utf8'));
    };

    const result = await new EditSagaExecutor(store, boundary, artifacts).apply(request());

    expect(result.state).toBe('recovery_required');
    expect(result.diff).toEqual([expect.objectContaining({ status: 'external_drift' })]);
    expect([...boundary.files.values()]).toEqual(['A1', 'B0']);
  });

  it('keeps an external edit after a crash-unknown effect and never retries the effect', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    const executor = new EditSagaExecutor(store, boundary, artifacts, {
      hit(point: EditSagaFaultPoint) {
        if (point.kind === 'afterEffectBeforeJournal') throw new EditSagaCrashError('crash');
      },
    });
    await expect(executor.apply(request())).rejects.toBeInstanceOf(EditSagaCrashError);
    boundary.files.set('/workspace/a.txt', 'USER CHANGE');

    const recovered = await new EditSagaExecutor(store, boundary, artifacts).recover('saga-1');

    expect(recovered).toMatchObject({
      state: 'recovery_required',
      recovery: { reason: 'effect_outcome_unknown' },
    });
    expect(boundary.applied).toEqual([1]);
    expect(boundary.restored).toEqual([]);
    expect(boundary.files.get('/workspace/a.txt')).toBe('USER CHANGE');
  });

  it('finalizes a successful multi-file edit with one stable Turn diff', async () => {
    const store = new InMemoryEditSagaStore();
    const artifacts = new MemoryArtifacts();
    const boundary = new FakeBoundary(artifacts);
    const result = await new EditSagaExecutor(store, boundary, artifacts).apply(request());

    expect(result.state).toBe('committed');
    expect(result.diff).toEqual([
      expect.objectContaining({
        kind: 'update',
        path: 'a.txt',
        preHash: hash('A0'),
        postHash: hash('A1'),
      }),
      expect.objectContaining({
        kind: 'update',
        path: 'b.txt',
        preHash: hash('B0'),
        postHash: hash('B1'),
      }),
    ]);
    expect([...boundary.files.values()]).toEqual(['A1', 'B1']);

    const replay = await new EditSagaExecutor(store, boundary, artifacts).apply(request());
    expect(replay).toEqual(result);
    expect(boundary.applied).toEqual([1, 2]);
  });

  it('persists only opaque artifact references, never edit source bytes', async () => {
    const artifacts = new MemoryArtifacts();
    const staged = await stageEditSagaRequest(request(), artifacts);
    const snapshot = new InMemoryEditSagaStore().create(staged);
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain('A0');
    expect(serialized).not.toContain('A1');
    expect(serialized).not.toContain('B0');
    expect(serialized).not.toContain('B1');
    expect(snapshot.steps[0]?.operation.preArtifact).toMatchObject({
      owner: { sagaId: 'saga-1', ordinal: 1, role: 'preimage' },
      contentHash: hash('A0'),
    });
  });

  it('rejects a patch whose operations escape its sealed root', async () => {
    const original = plan();
    const operations = original.operations.map((operation, index) =>
      Object.freeze({
        ...operation,
        ...(index === 1 ? { canonicalPath: '/other-root/b.txt' } : {}),
      }),
    );
    const facts = { version: 1 as const, policyEpoch: original.policyEpoch, operations };
    const escapedPlan = Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });

    await expect(
      stageEditSagaRequest({
        ...request(),
        plan: escapedPlan,
        mutationBinding: {
          rootId: 'root-a',
          workspacePath: '/workspace',
          workspaceKey: 'a'.repeat(64),
          rootIdentityDigest: 'b'.repeat(64),
        },
      }),
    ).rejects.toThrow('cannot span multiple Workspace roots');
  });

  it('aggregates repeated edits and rename chains from the Turn baseline', () => {
    const aggregated = aggregateTurnDiff([
      [diffEntry('update', 'a.txt', hash('A0'), hash('A1'))],
      [
        diffEntry('rename', 'a.txt', hash('A1'), hash('A1'), 'b.txt'),
        diffEntry('update', 'b.txt', hash('A1'), hash('A2')),
      ],
    ]);

    expect(aggregated).toEqual([
      expect.objectContaining({
        ordinal: 1,
        kind: 'rename',
        path: 'a.txt',
        destination: 'b.txt',
        preHash: hash('A0'),
        postHash: hash('A2'),
      }),
    ]);
  });

  it('collapses add-delete to no diff and delete-add to an update', () => {
    expect(
      aggregateTurnDiff([
        [diffEntry('add', 'new.txt', null, hash('NEW'))],
        [diffEntry('delete', 'new.txt', hash('NEW'), null)],
      ]),
    ).toEqual([]);
    expect(
      aggregateTurnDiff([
        [diffEntry('delete', 'existing.txt', hash('OLD'), null)],
        [diffEntry('add', 'existing.txt', null, hash('NEW'))],
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: 'update',
        path: 'existing.txt',
        preHash: hash('OLD'),
        postHash: hash('NEW'),
      }),
    ]);
  });
});

function diffEntry(
  kind: TurnDiffEntry['kind'],
  path: string,
  preHash: string | null,
  postHash: string | null,
  destination: string | null = null,
): TurnDiffEntry {
  return {
    ordinal: 1,
    kind,
    path,
    destination,
    preHash,
    postHash,
    provenance: 'agent_edit',
    status: 'applied',
    actualHash: postHash,
  };
}

function request() {
  return {
    id: 'saga-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    operationId: 'operation-1',
    plan: plan(),
    createdAt: '2026-07-23T00:00:00.000Z',
  } as const;
}

async function readText(
  artifacts: EditArtifactRepository,
  reference: EditArtifactRef | null,
): Promise<string | null> {
  return reference === null ? null : (await artifacts.read(reference)).toString('utf8');
}

function observation(contentHash: string, size: number): RevisionObservation {
  return Object.freeze({ identityDigest: `identity:${contentHash}`, contentHash, size });
}

function operationObservation(contentHash: string, size: number): OperationObservation {
  return Object.freeze({
    source: Object.freeze({ state: 'present' as const, revision: observation(contentHash, size) }),
    destination: Object.freeze({ state: 'absent' as const }),
  });
}

function endpoint(content: string | undefined): OperationObservation['source'] {
  return content === undefined
    ? { state: 'absent' }
    : {
        state: 'present',
        revision: {
          identityDigest: `identity:${hash(content)}`,
          contentHash: hash(content),
          size: Buffer.byteLength(content),
        },
      };
}

function matchesPhase(
  step: EditSagaStep,
  observation: OperationObservation,
  phase: 'pre' | 'post',
): boolean {
  const sourceHash =
    phase === 'pre'
      ? step.operation.preHash
      : step.operation.kind === 'rename'
        ? null
        : step.operation.postHash;
  const destinationHash =
    phase === 'post' && step.operation.kind === 'rename' ? step.operation.postHash : null;
  return (
    endpointHash(observation.source) === sourceHash &&
    endpointHash(observation.destination) === destinationHash
  );
}

function endpointHash(value: OperationObservation['source']): string | null {
  return value.state === 'present' ? value.revision.contentHash : null;
}

function singleOperationPlan(kind: 'add' | 'delete' | 'rename'): PreparedStructuredPatch {
  const content = kind === 'add' ? 'ADDED' : kind === 'delete' ? 'DELETED' : 'RENAMED';
  const operation = Object.freeze({
    kind,
    path: `${kind}.txt`,
    canonicalPath: `/workspace/${kind}.txt`,
    destination: kind === 'rename' ? 'moved.txt' : null,
    canonicalDestination: kind === 'rename' ? '/workspace/moved.txt' : null,
    revisionTokenId: kind === 'add' ? null : `token-${kind}`,
    preRevision: kind === 'add' ? null : sealedRevision(content, kind === 'delete' ? 'd' : 'e'),
    preImage: kind === 'add' ? null : content,
    postImage: kind === 'delete' ? null : content,
    preHash: kind === 'add' ? null : hash(content),
    postHash: kind === 'delete' ? null : hash(content),
  });
  const facts = { version: 1 as const, policyEpoch: 2, operations: Object.freeze([operation]) };
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sealedRevision(value: string, identity: string) {
  return Object.freeze({
    identityDigest: identity.repeat(64),
    contentHash: hash(value),
    size: Buffer.byteLength(value),
    mode: 0o100600,
    nlink: 1 as const,
  });
}
