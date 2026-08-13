import { describe, expect, it } from 'vitest';
import { reconcileStartupNativeMutations } from './native-mutation-recovery';
import type { NativeMutationIntentSnapshot } from './native-mutation-intent';

function intent(
  id: string,
  sagaId: string,
  workspaceKey: string,
  state: NativeMutationIntentSnapshot['state'],
): NativeMutationIntentSnapshot {
  return { id, sagaId, workspaceKey, state } as NativeMutationIntentSnapshot;
}

describe('startup Native mutation recovery', () => {
  it('recovers each owning Saga once and clears quarantine only after terminal convergence', async () => {
    const workspaceKey = 'a'.repeat(64);
    let recoverable = [
      intent('intent-1', 'saga-1', workspaceKey, 'effect_pending'),
      intent('intent-2', 'saga-1', workspaceKey, 'cleanup_pending'),
    ];
    const releasedFences = new Map<string, number>();
    const recovered: string[] = [];
    const cleared: [string, number][] = [];

    await reconcileStartupNativeMutations({
      journal: {
        listRecoverableNativeMutationIntents: () => recoverable,
        clearMutationQuarantine: (key, fence) => cleared.push([key, fence]),
      },
      recoverSaga: async (sagaId) => {
        recovered.push(sagaId);
        recoverable = [];
        releasedFences.set(workspaceKey, 12);
      },
      reconcileEditSagas: async () => undefined,
      startupQuarantines: [
        {
          taskId: 'task-1',
          workspaceKey,
          reason: 'unresolved_native_mutation_intent',
          sourceSagaId: 'saga-1',
          fence: 11,
          createdAt: '2026-08-13T00:00:00.000Z',
        },
      ],
      releasedFences,
      now: () => '2026-08-13T00:00:01.000Z',
    });

    expect(recovered).toEqual(['saga-1']);
    expect(cleared).toEqual([[workspaceKey, 12]]);
  });

  it('keeps quarantine when recovery leaves a non-terminal intent', async () => {
    const workspaceKey = 'b'.repeat(64);
    const recoverable = [intent('intent-1', 'saga-1', workspaceKey, 'recovery_required')];
    const cleared: string[] = [];

    await reconcileStartupNativeMutations({
      journal: {
        listRecoverableNativeMutationIntents: () => recoverable,
        clearMutationQuarantine: (key) => cleared.push(key),
      },
      recoverSaga: async () => undefined,
      reconcileEditSagas: async () => undefined,
      startupQuarantines: [],
      releasedFences: new Map([[workspaceKey, 9]]),
      now: () => '2026-08-13T00:00:01.000Z',
    });

    expect(cleared).toEqual([]);
  });

  it('does not clear a workspace without a released recovery fence', async () => {
    const workspaceKey = 'c'.repeat(64);
    const cleared: string[] = [];
    await reconcileStartupNativeMutations({
      journal: {
        listRecoverableNativeMutationIntents: () => [],
        clearMutationQuarantine: (key) => cleared.push(key),
      },
      recoverSaga: async () => undefined,
      reconcileEditSagas: async () => undefined,
      startupQuarantines: [
        {
          taskId: 'task-1',
          workspaceKey,
          reason: 'unresolved_native_mutation_intent',
          sourceSagaId: 'saga-1',
          fence: 4,
          createdAt: '2026-08-13T00:00:00.000Z',
        },
      ],
      releasedFences: new Map(),
      now: () => '2026-08-13T00:00:01.000Z',
    });
    expect(cleared).toEqual([]);
  });
});
