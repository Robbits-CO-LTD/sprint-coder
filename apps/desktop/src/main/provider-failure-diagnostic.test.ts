import { describe, expect, it } from 'vitest';
import {
  buildProviderFailureDiagnostic,
  isPersistedFailureDiagnostic,
  isProviderFailureDiagnostic,
  providerCauseFromDeadline,
  providerCauseFromNormalizedError,
  providerCauseFromPreparation,
  providerStreamFailureCause,
} from './provider-failure-diagnostic';

describe('Provider failure diagnostic', () => {
  it('builds a strict safe diagnostic without raw Provider fields', () => {
    const cause = providerCauseFromNormalizedError(
      {
        category: 'provider_unavailable',
        message: 'raw response with token and /Users/private/file',
        retryable: true,
        retryAfterMs: 2_000,
        providerCode: 'http_503',
      },
      'completed',
    )!;
    const diagnostic = buildProviderFailureDiagnostic({
      cause,
      providerId: 'ollama',
      profileId: 'ollama',
      elapsedMs: 45_072,
      appVersion: '0.4.0',
      recordedAt: '2026-08-22T00:00:00.000Z',
    });

    expect(diagnostic).toMatchObject({
      runtimeKind: 'provider',
      failureStage: 'provider_error',
      category: 'provider_unavailable',
      providerCode: 'http_503',
      modelPreparation: 'completed',
      elapsedMs: 45_072,
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain('raw response');
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('retryAfterMs');
    expect(isProviderFailureDiagnostic(diagnostic)).toBe(true);
    expect(isPersistedFailureDiagnostic(diagnostic)).toBe(true);
  });

  it('rejects cancel, unknown keys, unsafe identifiers, and unallowlisted codes', () => {
    expect(
      providerCauseFromNormalizedError(
        {
          category: 'canceled',
          message: 'canceled',
          retryable: false,
          retryAfterMs: null,
          providerCode: null,
        },
        'completed',
      ),
    ).toBeNull();
    const valid = buildProviderFailureDiagnostic({
      cause: {
        failureStage: 'network',
        category: 'network',
        retryable: true,
        providerCode: 'raw secret code',
        modelPreparation: 'completed',
      },
      providerId: 'openrouter',
      profileId: 'openrouter',
      elapsedMs: 1,
      appVersion: '0.4.0',
    });
    expect(valid.providerCode).toBeNull();
    expect(isProviderFailureDiagnostic({ ...valid, prompt: 'secret' })).toBe(false);
    expect(isProviderFailureDiagnostic({ ...valid, providerId: 'https://secret.example' })).toBe(
      false,
    );
  });

  it('maps only enumerated preparation, deadline, and stream facts', () => {
    expect(providerCauseFromPreparation('preload_timeout')).toMatchObject({
      failureStage: 'model_preparation',
      category: 'timeout',
      modelPreparation: 'failed',
    });
    expect(providerCauseFromDeadline('idle', 'completed')).toMatchObject({
      failureStage: 'idle_timeout',
      category: 'timeout',
      modelPreparation: 'completed',
    });
    expect(providerStreamFailureCause('not_required', false)).toEqual({
      failureStage: 'stream_error',
      category: 'internal',
      retryable: false,
      providerCode: null,
      modelPreparation: 'not_required',
    });
  });

  it('accepts Grok billing and rate-limit diagnostics and rejects them for other runtimes', () => {
    const grok = {
      version: 1,
      diagnosticId: '123e4567-e89b-42d3-a456-426614174000',
      runtimeKind: 'grok',
      failureStage: 'billing_error',
      httpStatus: 402,
      elapsedMs: 10,
      appVersion: '0.7.0',
      cliVersion: null,
      teamMcp: { enabled: false, status: 'not_configured' },
      lastRecognizedNotification: null,
      lastReceivedNotification: null,
      unsupportedNotificationCount: 0,
      stderrObserved: false,
      stderrTruncated: false,
      recordedAt: '2026-09-23T00:00:00.000Z',
    };
    const { httpStatus: _status, ...withoutStatus } = grok;
    expect(isPersistedFailureDiagnostic(grok)).toBe(true);
    expect(isPersistedFailureDiagnostic(withoutStatus)).toBe(true);
    expect(
      isPersistedFailureDiagnostic({ ...grok, failureStage: 'rate_limit', httpStatus: 429 }),
    ).toBe(true);
    expect(isPersistedFailureDiagnostic({ ...withoutStatus, failureStage: 'rate_limit' })).toBe(
      true,
    );
    for (const httpStatus of [100, 599]) {
      expect(isPersistedFailureDiagnostic({ ...grok, httpStatus })).toBe(true);
    }
    expect(
      isPersistedFailureDiagnostic({
        ...grok,
        runtimeKind: 'codex',
        failureStage: 'billing_error',
      }),
    ).toBe(false);
    expect(
      isPersistedFailureDiagnostic({
        ...grok,
        runtimeKind: 'codex',
        failureStage: 'protocol_error',
      }),
    ).toBe(false);
    expect(
      isPersistedFailureDiagnostic({
        ...withoutStatus,
        runtimeKind: 'claude',
        failureStage: 'rate_limit',
      }),
    ).toBe(false);
    for (const httpStatus of [99, 600, 402.5, '402', null]) {
      expect(isPersistedFailureDiagnostic({ ...grok, httpStatus })).toBe(false);
    }
    const provider = buildProviderFailureDiagnostic({
      cause: {
        failureStage: 'provider_error',
        category: 'provider_unavailable',
        retryable: true,
        providerCode: 'http_503',
        modelPreparation: 'completed',
      },
      providerId: 'ollama',
      profileId: 'ollama',
      elapsedMs: 1,
      appVersion: '0.7.0',
      recordedAt: '2026-09-23T00:00:00.000Z',
    });
    expect(isPersistedFailureDiagnostic({ ...provider, httpStatus: 402 })).toBe(false);
  });
});
