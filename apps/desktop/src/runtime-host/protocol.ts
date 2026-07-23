import {
  codexModelIdSchema,
  codexModelOptionSchema,
  publicErrorSchema,
  toolCatalogSnapshotSchema,
  turnStageSchema,
  type PublicError,
  type CodexModelOption,
  type TurnStage,
} from '@sprint-coder/contracts';
import { verifyToolCatalogSnapshot, type ToolCatalogSnapshot } from '@sprint-coder/domain';

export const RUNTIME_PROTOCOL_VERSION = 4;

export type RuntimeContextFragment = Readonly<{
  id: string;
  source: 'system' | 'history' | 'goal' | 'compaction' | 'background';
  trust: 'system' | 'user' | 'assistant';
  authority: 'system' | 'user' | 'none';
  content: string;
}>;

type EnvelopeBase = {
  protocolVersion: typeof RUNTIME_PROTOCOL_VERSION;
  runtimeInstanceId: string;
  taskId: string;
  turnId: string;
  seq: number;
  operationId: string;
};

export type RuntimeCanonicalEvent =
  | { type: 'stage'; stage: TurnStage }
  | { type: 'delta'; messageId: string; delta: string }
  | { type: 'completed' };

export type MainToRuntimeEnvelope =
  | (EnvelopeBase & { type: 'hello' })
  | (EnvelopeBase & {
      type: 'start';
      input: string;
      workspacePath: string | null;
      model: string;
      contextFragments: RuntimeContextFragment[];
      toolCatalogSnapshot: ToolCatalogSnapshot;
    })
  | (EnvelopeBase & { type: 'cancel' });

export type RuntimeToMainEnvelope =
  | (EnvelopeBase & {
      type: 'hello';
      codexAvailable: boolean;
      codexVersion?: string;
      codexModels: CodexModelOption[];
    })
  | (EnvelopeBase & { type: 'started'; acceptedContextFragmentIds: string[] })
  | (EnvelopeBase & { type: 'event'; event: RuntimeCanonicalEvent })
  | (EnvelopeBase & { type: 'exit'; code: number; canceled: boolean })
  | (EnvelopeBase & { type: 'error'; error: PublicError });

export function isMainToRuntimeEnvelope(value: unknown): value is MainToRuntimeEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello' || value.type === 'cancel') return true;
  return (
    value.type === 'start' &&
    'input' in value &&
    typeof value.input === 'string' &&
    'workspacePath' in value &&
    (value.workspacePath === null || typeof value.workspacePath === 'string') &&
    'model' in value &&
    codexModelIdSchema.safeParse(value.model).success &&
    'contextFragments' in value &&
    isRuntimeContextFragments(value.contextFragments) &&
    'toolCatalogSnapshot' in value &&
    isVerifiedReadOnlyCatalog(value.toolCatalogSnapshot)
  );
}

function isRuntimeContextFragments(value: unknown): value is RuntimeContextFragment[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  let totalCharacters = 0;
  const ids = new Set<string>();
  for (const fragment of value) {
    if (typeof fragment !== 'object' || fragment === null) return false;
    const record = fragment as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['id', 'source', 'trust', 'authority', 'content'].includes(key),
      ) ||
      typeof record['id'] !== 'string' ||
      record['id'].length < 1 ||
      record['id'].length > 128 ||
      ids.has(record['id']) ||
      !['system', 'history', 'goal', 'compaction', 'background'].includes(
        record['source'] as string,
      ) ||
      !['system', 'user', 'assistant'].includes(record['trust'] as string) ||
      !['system', 'user', 'none'].includes(record['authority'] as string) ||
      !hasValidFragmentAuthority(record) ||
      typeof record['content'] !== 'string' ||
      record['content'].length > 40_000
    )
      return false;
    ids.add(record['id']);
    totalCharacters += record['content'].length;
    if (totalCharacters > 128_000) return false;
  }
  return true;
}

function hasValidFragmentAuthority(fragment: Record<string, unknown>): boolean {
  if (fragment['source'] === 'system') return fragment['authority'] === 'system';
  if (fragment['source'] === 'goal') return fragment['authority'] === 'user';
  if (fragment['source'] === 'history')
    return fragment['authority'] === (fragment['trust'] === 'user' ? 'user' : 'none');
  return fragment['authority'] === 'none';
}

function isVerifiedReadOnlyCatalog(value: unknown): value is ToolCatalogSnapshot {
  const parsed = toolCatalogSnapshotSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.entries.length === 0 &&
    verifyToolCatalogSnapshot(parsed.data as unknown as ToolCatalogSnapshot)
  );
}

export function isRuntimeToMainEnvelope(value: unknown): value is RuntimeToMainEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello')
    return (
      'codexAvailable' in value &&
      typeof value.codexAvailable === 'boolean' &&
      (!('codexVersion' in value) || typeof value.codexVersion === 'string') &&
      'codexModels' in value &&
      Array.isArray(value.codexModels) &&
      value.codexModels.length <= 32 &&
      value.codexModels.every((model) => codexModelOptionSchema.safeParse(model).success)
    );
  if (value.type === 'started')
    return (
      'acceptedContextFragmentIds' in value &&
      Array.isArray(value.acceptedContextFragmentIds) &&
      value.acceptedContextFragmentIds.length <= 256 &&
      new Set(value.acceptedContextFragmentIds).size === value.acceptedContextFragmentIds.length &&
      value.acceptedContextFragmentIds.every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
      )
    );
  if (value.type === 'event') return 'event' in value && isRuntimeCanonicalEvent(value.event);
  if (value.type === 'exit')
    return (
      'code' in value &&
      typeof value.code === 'number' &&
      Number.isInteger(value.code) &&
      'canceled' in value &&
      typeof value.canceled === 'boolean'
    );
  return (
    value.type === 'error' && 'error' in value && publicErrorSchema.safeParse(value.error).success
  );
}

function isRuntimeCanonicalEvent(value: unknown): value is RuntimeCanonicalEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  if (value.type === 'completed') return true;
  if (value.type === 'stage')
    return 'stage' in value && turnStageSchema.safeParse(value.stage).success;
  return (
    value.type === 'delta' &&
    'messageId' in value &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    'delta' in value &&
    typeof value.delta === 'string' &&
    value.delta.length > 0 &&
    value.delta.length <= 16_384
  );
}

function hasValidBase(value: unknown): value is EnvelopeBase & { type: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocolVersion' in value &&
    value.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    'runtimeInstanceId' in value &&
    typeof value.runtimeInstanceId === 'string' &&
    value.runtimeInstanceId.length > 0 &&
    'taskId' in value &&
    typeof value.taskId === 'string' &&
    'turnId' in value &&
    typeof value.turnId === 'string' &&
    'seq' in value &&
    typeof value.seq === 'number' &&
    Number.isInteger(value.seq) &&
    value.seq > 0 &&
    'operationId' in value &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    'type' in value &&
    typeof value.type === 'string'
  );
}
