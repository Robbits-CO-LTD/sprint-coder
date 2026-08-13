import { describe, expect, it } from 'vitest';
import {
  InMemoryNativeMutationIntentStore,
  createNativeMutationIntentSeed,
  deriveNativeMutationEffectKind,
  nativeMutationDirectoryOwnership,
  transitionNativeMutationIntent,
  type NativeMutationEndpointExpectation,
  type NativeMutationIntentKind,
} from './native-mutation-intent';

const absent = Object.freeze({ state: 'absent' as const });
const present = Object.freeze({
  state: 'present' as const,
  identityDigest: '1'.repeat(64),
  contentHash: '2'.repeat(64),
  size: 2,
  mode: 0o100600,
  nlink: 1,
});
const stagedPost = Object.freeze({
  ...present,
  contentHash: '7'.repeat(64),
  size: 4,
});

describe('Native mutation intent journal', () => {
  it.each([
    ['add', 'forward', 'add'],
    ['update', 'forward', 'update'],
    ['delete', 'forward', 'delete'],
    ['rename', 'forward', 'rename'],
    ['add', 'compensation', 'delete'],
    ['update', 'compensation', 'update'],
    ['delete', 'compensation', 'add'],
    ['rename', 'compensation', 'rename'],
  ] as const)('derives %s/%s as the actual %s effect', (original, direction, effect) => {
    expect(deriveNativeMutationEffectKind(original, direction)).toBe(effect);
  });

  it.each([
    ['add', absent, null, 'post_temp', null],
    ['update', present, null, 'post_temp', null],
    ['delete', present, null, null, 'tombstone'],
    ['rename', present, ['renamed.txt'], null, null],
  ] as const)(
    'seals the %s auxiliary shape before any native effect',
    (kind, expectedSource, destinationSegments, tempRole, tombstoneRole) => {
      const store = new InMemoryNativeMutationIntentStore(() => 'a'.repeat(32));
      const intent = store.prepare(
        seed(kind, expectedSource, destinationSegments, kind === 'add' || kind === 'update'),
      );

      expect(intent.state).toBe('planned');
      expect(intent.temp?.role ?? null).toBe(tempRole);
      expect(intent.tombstone?.role ?? null).toBe(tombstoneRole);
      const auxiliaryName = intent.temp?.leafName ?? intent.tombstone?.leafName ?? null;
      if (kind === 'rename') expect(auxiliaryName).toBeNull();
      else expect(auxiliaryName).toMatch(/^\.sprint-coder-(?:temp|tomb)-[a-f0-9]{32}$/);
      expect(intent.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('returns the same immutable names for an idempotent retry and rejects changed facts', () => {
    const store = new InMemoryNativeMutationIntentStore(() => 'b'.repeat(32));
    const request = seed('update', present, null, true);
    const first = store.prepare(request);
    expect(store.prepare(request)).toEqual(first);
    const { version: _version, seedDigest: _seedDigest, ...input } = request;
    expect(() =>
      store.prepare(createNativeMutationIntentSeed({ ...input, operationDigest: 'f'.repeat(64) })),
    ).toThrow('reused');
  });

  it('keeps the mkdir ownership seal stable across journal transitions', () => {
    let intent = new InMemoryNativeMutationIntentStore(() => 'c'.repeat(32)).prepare(
      seed('mkdir', absent, null, false),
    );
    const ownership = nativeMutationDirectoryOwnership(intent);
    intent = transitionNativeMutationIntent(intent, { state: 'effect_pending' });
    expect(nativeMutationDirectoryOwnership(intent)).toEqual(ownership);
    intent = transitionNativeMutationIntent(intent, {
      state: 'effect_observed',
      effectObservation: {
        source: {
          state: 'present',
          entryKind: 'directory',
          identityDigest: '8'.repeat(64),
        },
        destination: absent,
        auxiliary: absent,
      },
    });
    expect(nativeMutationDirectoryOwnership(intent)).toEqual(ownership);
  });

  it('rejects an auxiliary nonce collision across intents in the same workspace', () => {
    const store = new InMemoryNativeMutationIntentStore(() => 'b'.repeat(32));
    store.prepare(seed('update', present, null, true));
    const second = seed('update', present, null, true);
    const { version: _version, seedDigest: _seedDigest, ...input } = second;
    expect(() =>
      store.prepare(
        createNativeMutationIntentSeed({ ...input, id: 'intent-second', sagaId: 'saga-2' }),
      ),
    ).toThrow('collision');
  });

  it('requires a durable auxiliary identity before an update can become effect-pending', () => {
    const store = new InMemoryNativeMutationIntentStore(() => 'c'.repeat(32));
    let intent = store.prepare(seed('update', present, null, true));
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, { state: 'aux_pending' }),
    );
    expect(() =>
      store.update(intent.id, intent.revision, (current) =>
        transitionNativeMutationIntent(current, { state: 'effect_pending' }),
      ),
    ).toThrow('auxiliary identity');
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, {
        state: 'aux_observed',
        auxObservation: stagedPost,
      }),
    );
    const pending = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, { state: 'effect_pending' }),
    );
    expect(pending.state).toBe('effect_pending');
    expect(pending.auxObservation).toEqual(stagedPost);
  });

  it('rejects staged bytes observed with a mode different from the sealed artifact mode', () => {
    const store = new InMemoryNativeMutationIntentStore(() => '1'.repeat(32));
    let intent = store.prepare(seed('update', present, null, true));
    expect(intent.temp).toMatchObject({ expectedMode: 0o100600 });
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, { state: 'aux_pending' }),
    );
    expect(() =>
      transitionNativeMutationIntent(intent, {
        state: 'aux_observed',
        auxObservation: { ...stagedPost, mode: 0o100644 },
      }),
    ).toThrow('sealed artifact');
  });

  it('never permits immutable intent facts or an observed identity to change', () => {
    const store = new InMemoryNativeMutationIntentStore(() => 'd'.repeat(32));
    const intent = store.prepare(seed('delete', present, null, false));
    expect(() =>
      store.update(intent.id, intent.revision, (current) => ({
        ...current,
        sourceSegments: ['other.txt'],
        revision: current.revision + 1,
      })),
    ).toThrow();
  });

  it('requires a durable absent observation before auxiliary cleanup can complete', () => {
    const store = new InMemoryNativeMutationIntentStore(() => 'e'.repeat(32));
    let intent = store.prepare(seed('delete', present, null, false));
    expect(() => transitionNativeMutationIntent(intent, { state: 'aux_pending' })).toThrow();
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, { state: 'effect_pending' }),
    );
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, {
        state: 'effect_observed',
        effectObservation: { source: absent, destination: absent, auxiliary: present },
      }),
    );
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, { state: 'cleanup_pending' }),
    );
    expect(() =>
      transitionNativeMutationIntent(intent, { state: 'completed', cleanupObservation: null }),
    ).toThrow('does not prove');
    expect(
      transitionNativeMutationIntent(intent, {
        state: 'completed',
        cleanupObservation: absent,
      }),
    ).toMatchObject({ state: 'completed', cleanupObservation: absent });
  });

  it('moves rename directly from a journaled plan to effect-pending and validates topology', () => {
    const store = new InMemoryNativeMutationIntentStore(() => '0'.repeat(32));
    let intent = store.prepare(seed('rename', present, ['renamed.txt'], false));
    intent = store.update(intent.id, intent.revision, (current) =>
      transitionNativeMutationIntent(current, { state: 'effect_pending' }),
    );
    expect(intent).toMatchObject({ state: 'effect_pending', auxObservation: null });
    expect(() =>
      transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: { source: absent, destination: absent, auxiliary: absent },
      }),
    ).toThrow('does not match');
    expect(
      transitionNativeMutationIntent(intent, {
        state: 'effect_observed',
        effectObservation: { source: absent, destination: present, auxiliary: absent },
      }),
    ).toMatchObject({ state: 'effect_observed' });
  });

  it('rejects unknown nested fields instead of persisting unsealed payload bytes', () => {
    const store = new InMemoryNativeMutationIntentStore(() => 'f'.repeat(32));
    const intent = store.prepare(seed('update', present, null, true));
    expect(() =>
      store.update(intent.id, intent.revision, (current) => ({
        ...current,
        expectedSource: { ...current.expectedSource, rawContent: 'secret' },
        revision: current.revision + 1,
      })),
    ).toThrow('unknown or missing');
  });

  it.each([['../escape'], ['folder/file'], ['folder\\file'], ['.'], ['']])(
    'rejects unsafe relative segment %j',
    (segment) => {
      expect(() =>
        createNativeMutationIntentSeed({
          ...seed('add', absent, null, true),
          sourceSegments: [segment],
        }),
      ).toThrow('segment');
    },
  );
});

function seed(
  kind: NativeMutationIntentKind,
  source: NativeMutationEndpointExpectation,
  destinationSegments: readonly string[] | null,
  withArtifact: boolean,
) {
  return createNativeMutationIntentSeed({
    id: `intent-${kind}`,
    sagaId: 'saga-1',
    ordinal: 1,
    direction: 'forward',
    kind,
    operationDigest: '3'.repeat(64),
    workspaceKey: '4'.repeat(64),
    rootIdentityDigest: '5'.repeat(64),
    policyEpoch: 7,
    leaseFence: '9',
    nativeSessionId: '6'.repeat(32),
    sourceSegments: ['source.txt'],
    destinationSegments,
    expectedSource: source,
    expectedDestination: destinationSegments === null ? absent : absent,
    artifact: withArtifact
      ? {
          artifactId: 'artifact-1',
          contentHash: '7'.repeat(64),
          size: 4,
          expectedMode: 0o100600,
        }
      : null,
    createdAt: '2026-07-23T00:00:00.000Z',
  });
}
