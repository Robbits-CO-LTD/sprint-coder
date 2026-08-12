import { Buffer } from 'node:buffer';
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DIAGNOSTIC_MAX_BYTES,
  RuntimeFailureDiagnosticCollector,
  resolveRuntimeFailureDiagnostic,
} from './runtime-failure-diagnostics';

describe('resolveRuntimeFailureDiagnostic', () => {
  it('creates a safe protocol-error fallback without retaining untrusted failure details', () => {
    const untrusted = {
      userMessage: 'private request body',
      toolArguments: { token: 'secret-token' },
      environment: { API_KEY: 'credential-value' },
      path: '/Users/private/workspace/file.ts',
    };

    const diagnostic = resolveRuntimeFailureDiagnostic({
      ...untrusted,
      errorCode: 'RUNTIME_PROTOCOL_ERROR',
      diagnostic: undefined,
      runtimeKind: 'codex',
      appVersion: '0.2.3',
      startedAtMs: 1_000,
      teamMcpEnabled: true,
      nowMs: 1_025,
    });

    expect(diagnostic).toMatchObject({
      runtimeKind: 'codex',
      failureStage: 'protocol_error',
      elapsedMs: 25,
      appVersion: '0.2.3',
      teamMcp: { enabled: true, status: 'configured' },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(untrusted.userMessage);
    expect(JSON.stringify(diagnostic)).not.toContain(untrusted.toolArguments.token);
    expect(JSON.stringify(diagnostic)).not.toContain(untrusted.environment.API_KEY);
    expect(JSON.stringify(diagnostic)).not.toContain(untrusted.path);
  });

  it('preserves an existing diagnostic and does not infer non-protocol failures', () => {
    const existing = new RuntimeFailureDiagnosticCollector(
      'codex',
      '0.2.3',
      'codex 1.2.3',
      false,
    ).snapshot('protocol_error', 2_000);

    expect(
      resolveRuntimeFailureDiagnostic({
        errorCode: 'RUNTIME_PROTOCOL_ERROR',
        diagnostic: existing,
        runtimeKind: 'codex',
        appVersion: 'ignored',
        startedAtMs: 1_000,
        teamMcpEnabled: true,
        nowMs: 2_000,
      }),
    ).toBe(existing);
    expect(
      resolveRuntimeFailureDiagnostic({
        errorCode: 'RUNTIME_FAILED',
        diagnostic: undefined,
        runtimeKind: 'codex',
        appVersion: '0.2.3',
        startedAtMs: 1_000,
        teamMcpEnabled: false,
        nowMs: 2_000,
      }),
    ).toBeUndefined();
  });

  it('replaces a wrong-runtime protocol diagnostic with one for the failing runtime', () => {
    const wrongRuntime = new RuntimeFailureDiagnosticCollector(
      'claude',
      '0.2.3',
      '2.1.218 (Claude Code)',
      false,
    ).snapshot('protocol_error', 2_000);

    const diagnostic = resolveRuntimeFailureDiagnostic({
      errorCode: 'RUNTIME_PROTOCOL_ERROR',
      diagnostic: wrongRuntime,
      runtimeKind: 'codex',
      appVersion: '0.2.3',
      startedAtMs: 1_000,
      teamMcpEnabled: true,
      nowMs: 2_000,
    });

    expect(diagnostic).toMatchObject({
      runtimeKind: 'codex',
      failureStage: 'protocol_error',
      elapsedMs: 1_000,
    });
    expect(diagnostic).not.toBe(wrongRuntime);
  });

  it('enriches a bounded start-rejection reason with canonical Main context', () => {
    const transportDiagnostic = {
      ...new RuntimeFailureDiagnosticCollector('codex', 'unknown', null, false).snapshot(
        'protocol_error',
        1_000,
      ),
      reasonCode: 'invalid_payload_digest' as const,
    };

    const diagnostic = resolveRuntimeFailureDiagnostic({
      errorCode: 'RUNTIME_PROTOCOL_ERROR',
      diagnostic: transportDiagnostic,
      runtimeKind: 'codex',
      appVersion: '0.2.3',
      startedAtMs: 900,
      teamMcpEnabled: true,
      nowMs: 1_025,
    });

    expect(diagnostic).toMatchObject({
      appVersion: '0.2.3',
      elapsedMs: 125,
      reasonCode: 'invalid_payload_digest',
      teamMcp: { enabled: true, status: 'configured' },
    });
  });
});

describe('RuntimeFailureDiagnosticCollector CLI resolution', () => {
  it('redacts the user home while retaining compatibility metadata', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.3', null, false);
    collector.setCliResolution({
      source: 'npm',
      executable: `${homedir()}/.npm/bin/codex`,
      version: '0.144.4',
      compatibility: 'verified',
      capabilities: ['app-server'],
    });

    const diagnostic = collector.snapshot('spawn_error');
    expect(diagnostic.cliResolution).toEqual({
      source: 'npm',
      executable: '<home>/.npm/bin/codex',
      version: '0.144.4',
      compatibility: 'verified',
      capabilities: ['app-server'],
    });
    expect(JSON.stringify(diagnostic)).not.toContain(homedir());
  });
});

describe('RuntimeFailureDiagnosticCollector', () => {
  it('records bounded protocol method names while counting unsupported notifications', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', 'codex 1.2.3', true);
    collector.recordNotification('turn/started');
    collector.recordNotification('future/unknown');

    expect(collector.snapshot('protocol_error')).toMatchObject({
      runtimeKind: 'codex',
      appVersion: '0.2.1',
      cliVersion: 'codex 1.2.3',
      teamMcp: { enabled: true, status: 'configured' },
      lastRecognizedNotification: 'turn/started',
      lastReceivedNotification: 'future/unknown',
      unsupportedNotificationCount: 1,
    });
  });

  it('records stderr metadata without retaining ANSI, split secrets, paths, or arbitrary text', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', null, false);
    collector.recordStderr('\u001b[31mfailed token=abcd');
    collector.recordStderr('efghijkl at /Users/example/private/project.ts\u001b[0m');

    const diagnostic = collector.snapshot('abnormal_exit');
    expect(diagnostic.stderrObserved).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain('abcdefghijkl');
    expect(JSON.stringify(diagnostic)).not.toContain('/Users/example');
    expect(JSON.stringify(diagnostic)).not.toContain('\u001b');
  });

  it('removes Windows home paths including spaces', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', null, false);
    collector.recordStderr('failed at C:\\Users\\Jane Doe\\project\\file.ts\n');

    const diagnostic = collector.snapshot('startup_error');
    expect(diagnostic.stderrObserved).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain('Jane Doe');
  });

  it('removes a request body or bridge credential echoed by stderr', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', null, true);
    collector.recordStderr('failed: private user request; bridge-token-value');

    const serialized = JSON.stringify(collector.snapshot('abnormal_exit'));
    expect(serialized).not.toContain('private user request');
    expect(serialized).not.toContain('bridge-token-value');
  });

  it('caps the serialized diagnostic byte size', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', null, false);
    collector.recordStderr('x'.repeat(RUNTIME_DIAGNOSTIC_MAX_BYTES * 4));

    const diagnostic = collector.snapshot('idle_timeout');
    expect(Buffer.byteLength(JSON.stringify(diagnostic), 'utf8')).toBeLessThanOrEqual(
      RUNTIME_DIAGNOSTIC_MAX_BYTES,
    );
    expect(diagnostic.stderrObserved).toBe(true);
    expect(diagnostic.stderrTruncated).toBe(true);
  });

  it('drops untrusted CLI versions and unsupported notification names', () => {
    const collector = new RuntimeFailureDiagnosticCollector(
      'codex',
      '0.2.1',
      'codex 1.2.3\n/private/request',
      false,
    );
    collector.recordNotification('private/request/value');

    const diagnostic = collector.snapshot('protocol_error');
    expect(diagnostic.cliVersion).toBeNull();
    expect(diagnostic.lastReceivedNotification).toBe('[unsupported]');
    expect(JSON.stringify(diagnostic)).not.toContain('private/request/value');

    collector.setCliVersion('codex sk-proj-secret-value');
    expect(collector.snapshot('protocol_error').cliVersion).toBeNull();
  });

  it('does not retain nested sensitive namespaces or Windows paths as notification names', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', null, false);
    collector.recordNotification('remote/user/alice');
    expect(collector.snapshot('protocol_error').lastReceivedNotification).toBe('[unsupported]');
    collector.recordNotification('C:/Users/Alice/private');
    expect(collector.snapshot('protocol_error').lastReceivedNotification).toBe('[unsupported]');
  });

  it('accepts only the documented Claude version shape', () => {
    const collector = new RuntimeFailureDiagnosticCollector(
      'claude',
      '0.2.1',
      '2.1.218 (Claude Code)',
      false,
    );
    expect(collector.snapshot('abnormal_exit').cliVersion).toBe('2.1.218 (Claude Code)');
    collector.setCliVersion('claude-code /Users/private');
    expect(collector.snapshot('abnormal_exit').cliVersion).toBeNull();
  });
});
