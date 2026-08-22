import { randomUUID } from 'node:crypto';
import type { NormalizedProviderError } from '@sprint-coder/contracts';
import {
  isRuntimeFailureDiagnostic,
  type RuntimeFailureDiagnostic,
} from '../runtime-host/protocol';

export type ProviderFailureStage =
  | 'model_preparation'
  | 'first_event_timeout'
  | 'idle_timeout'
  | 'provider_error'
  | 'network'
  | 'stream_error';

export type ProviderFailureCategory = Exclude<NormalizedProviderError['category'], 'canceled'>;

export type ProviderSafeFailureCause = Readonly<{
  failureStage: ProviderFailureStage;
  category: ProviderFailureCategory;
  retryable: boolean;
  providerCode: string | null;
  modelPreparation: 'not_required' | 'completed' | 'failed';
}>;

export type ProviderFailureDiagnosticV1 = Readonly<{
  version: 1;
  diagnosticId: string;
  runtimeKind: 'provider';
  failureStage: ProviderFailureStage;
  category: ProviderFailureCategory;
  retryable: boolean;
  providerId: string;
  profileId: string;
  providerCode: string | null;
  modelPreparation: 'not_required' | 'completed' | 'failed';
  elapsedMs: number;
  appVersion: string;
  recordedAt: string;
}>;

export type PersistedFailureDiagnostic = RuntimeFailureDiagnostic | ProviderFailureDiagnosticV1;

const PROVIDER_STAGES: readonly ProviderFailureStage[] = [
  'model_preparation',
  'first_event_timeout',
  'idle_timeout',
  'provider_error',
  'network',
  'stream_error',
];
const PROVIDER_CATEGORIES: readonly ProviderFailureCategory[] = [
  'credentials',
  'not_found',
  'rate_limited',
  'timeout',
  'network',
  'invalid_request',
  'provider_unavailable',
  'internal',
];

export function isProviderFailureDiagnostic(value: unknown): value is ProviderFailureDiagnosticV1 {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every((key) =>
      [
        'version',
        'diagnosticId',
        'runtimeKind',
        'failureStage',
        'category',
        'retryable',
        'providerId',
        'profileId',
        'providerCode',
        'modelPreparation',
        'elapsedMs',
        'appVersion',
        'recordedAt',
      ].includes(key),
    ) &&
    Object.keys(record).length === 13 &&
    record['version'] === 1 &&
    record['runtimeKind'] === 'provider' &&
    typeof record['diagnosticId'] === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      record['diagnosticId'],
    ) &&
    PROVIDER_STAGES.includes(record['failureStage'] as ProviderFailureStage) &&
    PROVIDER_CATEGORIES.includes(record['category'] as ProviderFailureCategory) &&
    typeof record['retryable'] === 'boolean' &&
    safeProviderIdentifier(record['providerId']) &&
    safeProviderIdentifier(record['profileId']) &&
    (record['providerCode'] === null ||
      (typeof record['providerCode'] === 'string' &&
        /^(?:http_[1-5][0-9]{2}|[a-z][a-z0-9_]{0,63})$/.test(record['providerCode']))) &&
    ['not_required', 'completed', 'failed'].includes(String(record['modelPreparation'])) &&
    typeof record['elapsedMs'] === 'number' &&
    Number.isSafeInteger(record['elapsedMs']) &&
    record['elapsedMs'] >= 0 &&
    typeof record['appVersion'] === 'string' &&
    record['appVersion'].length > 0 &&
    record['appVersion'].length <= 64 &&
    typeof record['recordedAt'] === 'string' &&
    record['recordedAt'].length <= 64 &&
    !Number.isNaN(Date.parse(record['recordedAt']))
  );
}

export function isPersistedFailureDiagnostic(value: unknown): value is PersistedFailureDiagnostic {
  return isRuntimeFailureDiagnostic(value) || isProviderFailureDiagnostic(value);
}

export function buildProviderFailureDiagnostic(input: {
  cause: ProviderSafeFailureCause;
  providerId: string;
  profileId: string;
  elapsedMs: number;
  appVersion: string;
  recordedAt?: string;
}): ProviderFailureDiagnosticV1 {
  const diagnostic: ProviderFailureDiagnosticV1 = Object.freeze({
    version: 1,
    diagnosticId: randomUUID(),
    runtimeKind: 'provider',
    failureStage: input.cause.failureStage,
    category: input.cause.category,
    retryable: input.cause.retryable,
    providerId: input.providerId,
    profileId: input.profileId,
    providerCode: allowlistedProviderCode(input.cause.providerCode),
    modelPreparation: input.cause.modelPreparation,
    elapsedMs: Math.max(0, Math.trunc(input.elapsedMs)),
    appVersion: input.appVersion,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  });
  if (!isProviderFailureDiagnostic(diagnostic)) throw new Error('Invalid Provider diagnostic');
  return diagnostic;
}

export function providerCauseFromNormalizedError(
  error: NormalizedProviderError,
  modelPreparation: 'not_required' | 'completed',
): ProviderSafeFailureCause | null {
  if (error.category === 'canceled') return null;
  return Object.freeze({
    failureStage: error.category === 'network' ? 'network' : 'provider_error',
    category: error.category,
    retryable: error.retryable,
    providerCode: allowlistedProviderCode(error.providerCode),
    modelPreparation,
  });
}

export function providerCauseFromPreparation(
  category: 'preload_timeout' | 'not_found' | 'provider_unavailable' | 'network',
): ProviderSafeFailureCause {
  return Object.freeze({
    failureStage: 'model_preparation',
    category:
      category === 'preload_timeout'
        ? 'timeout'
        : category === 'not_found'
          ? 'not_found'
          : category,
    retryable: category !== 'not_found',
    providerCode: null,
    modelPreparation: 'failed',
  });
}

export function providerCauseFromDeadline(
  phase: 'first_event' | 'idle',
  modelPreparation: 'not_required' | 'completed',
): ProviderSafeFailureCause {
  return Object.freeze({
    failureStage: phase === 'first_event' ? 'first_event_timeout' : 'idle_timeout',
    category: 'timeout',
    retryable: true,
    providerCode: null,
    modelPreparation,
  });
}

export function providerStreamFailureCause(
  modelPreparation: 'not_required' | 'completed',
  retryable: boolean,
): ProviderSafeFailureCause {
  return Object.freeze({
    failureStage: 'stream_error',
    category: 'internal',
    retryable,
    providerCode: null,
    modelPreparation,
  });
}

function allowlistedProviderCode(value: string | null): string | null {
  return value !== null && /^(?:http_[1-5][0-9]{2}|[a-z][a-z0-9_]{0,63})$/.test(value)
    ? value
    : null;
}

function safeProviderIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z0-9][a-z0-9._:-]*$/i.test(value)
  );
}
