import {
  publicErrorSchema,
  turnStageSchema,
  type PublicError,
  type TurnStage,
} from '@vibe/contracts';

export const RUNTIME_PROTOCOL_VERSION = 1;

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
    })
  | (EnvelopeBase & { type: 'cancel' });

export type RuntimeToMainEnvelope =
  | (EnvelopeBase & { type: 'hello'; codexAvailable: boolean; codexVersion?: string })
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
    (value.workspacePath === null || typeof value.workspacePath === 'string')
  );
}

export function isRuntimeToMainEnvelope(value: unknown): value is RuntimeToMainEnvelope {
  if (!hasValidBase(value)) return false;
  if (value.type === 'hello')
    return (
      'codexAvailable' in value &&
      typeof value.codexAvailable === 'boolean' &&
      (!('codexVersion' in value) || typeof value.codexVersion === 'string')
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
