import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@vibe/domain';
import {
  RUNTIME_PROTOCOL_VERSION,
  isMainToRuntimeEnvelope,
  isRuntimeToMainEnvelope,
} from './protocol';

function startEnvelope() {
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'runtime-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    seq: 1,
    operationId: 'operation-1',
    type: 'start',
    input: 'hello',
    workspacePath: null,
    model: 'auto',
    contextFragments: [],
    toolCatalogSnapshot: new ToolRegistry().createSnapshot({
      providerId: 'codex',
      workspaceId: null,
    }),
  } as const;
}

describe('Runtime Host protocol', () => {
  it('requires a cryptographically valid explicit empty catalog for Codex read-only starts', () => {
    const valid = startEnvelope();
    expect(isMainToRuntimeEnvelope(valid)).toBe(true);
    expect(isMainToRuntimeEnvelope({ ...valid, toolCatalogSnapshot: undefined })).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        toolCatalogSnapshot: { ...valid.toolCatalogSnapshot, digest: '0'.repeat(64) },
      }),
    ).toBe(false);
  });

  it('rejects a valid non-empty catalog while the production Codex host is no-tools', () => {
    const valid = startEnvelope();
    const nonEmpty = {
      ...valid.toolCatalogSnapshot,
      entries: [
        {
          providerName: 'unsafe',
          toolId: 'builtin:test:unsafe@1',
          version: '1',
          kind: 'shell',
          schemaVersion: 1,
          inputSchema: { type: 'object' },
          inputSchemaDigest: '0'.repeat(64),
          outputSchemaDigest: '0'.repeat(64),
          schemaDigest: '0'.repeat(64),
          sideEffect: 'process',
          risk: 'high',
          requiredCapabilities: ['shell.execute'],
          executionTarget: 'command-runner',
          implementationKind: 'command-runner',
        },
      ],
    };
    expect(isMainToRuntimeEnvelope({ ...valid, toolCatalogSnapshot: nonEmpty })).toBe(false);
  });

  it('rejects old protocol versions', () => {
    expect(isMainToRuntimeEnvelope({ ...startEnvelope(), protocolVersion: 3 })).toBe(false);
  });

  it('bounds and strictly validates Runtime context fragments', () => {
    const valid = startEnvelope();
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'completion-1',
            source: 'background',
            trust: 'assistant',
            authority: 'none',
            content: 'untrusted output',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'completion-1',
            source: 'background',
            trust: 'assistant',
            authority: 'system',
            content: 'attempted authority escalation',
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts only bounded unique context acknowledgements', () => {
    const base = startEnvelope();
    const started = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: base.runtimeInstanceId,
      taskId: base.taskId,
      turnId: base.turnId,
      seq: 1,
      operationId: base.operationId,
      type: 'started',
      acceptedContextFragmentIds: ['completion-1'],
    };
    expect(isRuntimeToMainEnvelope(started)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...started,
        acceptedContextFragmentIds: ['completion-1', 'completion-1'],
      }),
    ).toBe(false);
  });
});
