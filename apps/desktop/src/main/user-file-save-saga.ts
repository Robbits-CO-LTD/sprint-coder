import { createHash } from 'node:crypto';
import type { TurnEvent } from '@sprint-coder/contracts';
import type { SaveOutcome } from './workspace-edit';
import { observeWorkspaceFileDigest, saveWorkspaceFile } from './workspace-edit';

export type UserFileSaveRoot = Readonly<{ rootId: string; label: string; path: string }>;
export type UserFileSaveRequest = Readonly<{
  principal: string;
  taskId: string;
  kind: string;
  operationId: string;
  requestHash: string;
  root: UserFileSaveRoot;
  path: string;
  text: string;
  baseDigest: string;
}>;

export type UserFileSaveIntent = Readonly<{
  principal: string;
  taskId: string;
  kind: string;
  operationId: string;
  requestHash: string;
  rootId: string;
  rootLabel: string;
  path: string;
  baseDigest: string;
  replacementDigest: string;
  byteLength: number;
  state: 'prepared' | 'completed' | 'recovery_required';
}>;

export interface UserFileSaveJournal {
  getOperationResult<T>(
    principal: string,
    taskId: string,
    kind: string,
    operationId: string,
    requestHash: string,
  ): { found: boolean; value?: T };
  prepareUserFileSaveIntent(intent: Omit<UserFileSaveIntent, 'state'>): UserFileSaveIntent;
  listRecoverableUserFileSaveIntents(): readonly UserFileSaveIntent[];
  finalizeUserFileSaveIntent(
    intent: UserFileSaveIntent,
    result: SaveOutcome,
  ): { result: SaveOutcome; event: TurnEvent | null };
  requireUserFileSaveRecovery(intent: UserFileSaveIntent): void;
}

type Hooks = Readonly<{
  afterPublish?: () => void | Promise<void>;
  onFinalized?: (event: TurnEvent) => void;
}>;

export async function executeUserFileSave(
  journal: UserFileSaveJournal,
  request: UserFileSaveRequest,
  hooks: Hooks = {},
): Promise<SaveOutcome> {
  const cached = journal.getOperationResult<SaveOutcome>(
    request.principal,
    request.taskId,
    request.kind,
    request.operationId,
    request.requestHash,
  );
  if (cached.found) return cached.value as SaveOutcome;
  const replacementDigest = createHash('sha256').update(request.text).digest('hex');
  const intent = journal.prepareUserFileSaveIntent({
    principal: request.principal,
    taskId: request.taskId,
    kind: request.kind,
    operationId: request.operationId,
    requestHash: request.requestHash,
    rootId: request.root.rootId,
    rootLabel: request.root.label,
    path: request.path,
    baseDigest: request.baseDigest,
    replacementDigest,
    byteLength: Buffer.byteLength(request.text, 'utf8'),
  });
  if (intent.state === 'completed')
    return journal.getOperationResult<SaveOutcome>(
      intent.principal,
      intent.taskId,
      intent.kind,
      intent.operationId,
      intent.requestHash,
    ).value as SaveOutcome;

  const observed = observeWorkspaceFileDigest(request.root.path, request.path);
  if (observed === replacementDigest)
    return finalize(journal, intent, saved(replacementDigest), hooks);
  if (observed !== null && observed !== request.baseDigest) {
    const result: SaveOutcome = {
      outcome: 'conflict',
      digest: null,
      reason: null,
      conflictPath: null,
    };
    return finalize(journal, intent, result, hooks);
  }

  const result = saveWorkspaceFile(
    request.root.path,
    request.path,
    request.text,
    request.baseDigest,
  );
  if (result.outcome === 'saved') await hooks.afterPublish?.();
  return finalize(journal, intent, result, hooks);
}

export async function reconcileUserFileSaves(
  journal: UserFileSaveJournal,
  resolveRoot: (taskId: string, rootId: string) => UserFileSaveRoot | null,
): Promise<void> {
  for (const intent of journal.listRecoverableUserFileSaveIntents()) {
    const root = resolveRoot(intent.taskId, intent.rootId);
    if (root === null) {
      journal.requireUserFileSaveRecovery(intent);
      continue;
    }
    const observed = observeWorkspaceFileDigest(root.path, intent.path);
    if (observed === intent.replacementDigest)
      journal.finalizeUserFileSaveIntent(intent, saved(intent.replacementDigest));
    else if (observed !== intent.baseDigest) journal.requireUserFileSaveRecovery(intent);
  }
}

function saved(digest: string): SaveOutcome {
  return { outcome: 'saved', digest, reason: null, conflictPath: null };
}

function finalize(
  journal: UserFileSaveJournal,
  intent: UserFileSaveIntent,
  result: SaveOutcome,
  hooks: Hooks,
): SaveOutcome {
  const finalized = journal.finalizeUserFileSaveIntent(intent, result);
  if (finalized.event !== null) hooks.onFinalized?.(finalized.event);
  return finalized.result;
}
