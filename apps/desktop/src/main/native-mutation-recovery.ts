import type { NativeMutationIntentSnapshot } from './native-mutation-intent';
import type { MutationQuarantine } from './mutation-lease';

type StartupNativeMutationJournal = Readonly<{
  listRecoverableNativeMutationIntents(): readonly NativeMutationIntentSnapshot[];
  clearMutationQuarantine(workspaceKey: string, expectedFence: number, now: string): void;
}>;

export async function reconcileStartupNativeMutations(input: {
  journal: StartupNativeMutationJournal;
  recoverSaga: (sagaId: string) => Promise<unknown>;
  reconcileEditSagas: () => Promise<unknown>;
  startupQuarantines: readonly MutationQuarantine[];
  releasedFences: ReadonlyMap<string, number>;
  now: () => string;
}): Promise<void> {
  const recoverable = input.journal.listRecoverableNativeMutationIntents();
  for (const sagaId of new Set(recoverable.map((intent) => intent.sagaId)))
    await input.recoverSaga(sagaId);
  await input.reconcileEditSagas();

  const remainingWorkspaces = new Set(
    input.journal.listRecoverableNativeMutationIntents().map((intent) => intent.workspaceKey),
  );
  const startupWorkspaces = new Set(input.startupQuarantines.map((item) => item.workspaceKey));
  for (const [workspaceKey, fence] of input.releasedFences) {
    if (!startupWorkspaces.has(workspaceKey) || remainingWorkspaces.has(workspaceKey)) continue;
    input.journal.clearMutationQuarantine(workspaceKey, fence, input.now());
  }
}
