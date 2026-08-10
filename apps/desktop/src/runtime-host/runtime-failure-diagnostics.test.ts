import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DIAGNOSTIC_MAX_BYTES,
  RuntimeFailureDiagnosticCollector,
} from './runtime-failure-diagnostics';

describe('RuntimeFailureDiagnosticCollector', () => {
  it('records recognized notifications and counts unsupported names without retaining them', () => {
    const collector = new RuntimeFailureDiagnosticCollector('codex', '0.2.1', 'codex 1.2.3', true);
    collector.recordNotification('turn/started');
    collector.recordNotification('future/unknown');

    expect(collector.snapshot('protocol_error')).toMatchObject({
      runtimeKind: 'codex',
      appVersion: '0.2.1',
      cliVersion: 'codex 1.2.3',
      teamMcp: { enabled: true, status: 'configured' },
      lastRecognizedNotification: 'turn/started',
      lastReceivedNotification: '[unsupported]',
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
