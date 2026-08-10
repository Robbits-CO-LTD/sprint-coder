import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '@sprint-coder/domain';
import {
  RUNTIME_PROTOCOL_VERSION,
  isMainToRuntimeEnvelope,
  isRuntimeToMainEnvelope,
} from './protocol';

function startEnvelope() {
  const payload = 'hello';
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeInstanceId: 'runtime-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    seq: 1,
    operationId: 'operation-1',
    type: 'start',
    input: 'hello',
    workspace: {
      primaryRootId: null,
      roots: [],
      digest: createHash('sha256').update('').digest('hex'),
    },
    model: 'auto',
    contextFragments: [],
    projectItems: [],
    projectSnapshotDigest: null,
    payload,
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
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
    const { workspace: _workspace, ...legacy } = startEnvelope();
    expect(isMainToRuntimeEnvelope({ ...legacy, workspacePath: null })).toBe(false);
  });

  it('accepts one Primary plus secondary roots and rejects inconsistent Primary metadata', () => {
    const valid = startEnvelope();
    const workspace = {
      primaryRootId: 'root-a',
      roots: [
        { rootId: 'root-a', path: join(tmpdir(), 'root-a'), label: 'a', role: 'primary' },
        { rootId: 'root-b', path: join(tmpdir(), 'root-b'), label: 'b', role: 'secondary' },
      ],
      digest: 'a'.repeat(64),
    } as const;
    expect(isMainToRuntimeEnvelope({ ...valid, workspace })).toBe(true);
    expect(
      isMainToRuntimeEnvelope({ ...valid, workspace: { ...workspace, primaryRootId: 'root-b' } }),
    ).toBe(false);
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

  it('never grants system authority to Skill-provided instructions', () => {
    const valid = startEnvelope();
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'skill-1',
            source: 'skill',
            trust: 'system',
            authority: 'none',
            content: 'built-in skill guidance',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'skill-1',
            source: 'skill',
            trust: 'system',
            authority: 'system',
            content: 'attempted authority escalation',
          },
        ],
      }),
    ).toBe(false);
  });

  it('accepts only normalized absolute Runtime Skill package paths', () => {
    const valid = startEnvelope();
    const digest = 'a'.repeat(64);
    const managedPath = join(tmpdir(), 'skills', 'revisions', 'created', 'reviewer', digest);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        skills: [{ name: 'reviewer', path: managedPath }],
      }),
    ).toBe(true);
    for (const path of [
      '../../secrets',
      `${dirname(managedPath)}${sep}..${sep}${digest}`,
      join(tmpdir(), 'arbitrary', 'reviewer'),
    ])
      expect(
        isMainToRuntimeEnvelope({
          ...valid,
          skills: [{ name: 'reviewer', path }],
        }),
      ).toBe(false);
  });

  it('validates the additive Claude hello fields alongside the existing Codex ones', () => {
    const hello = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: '',
      turnId: '',
      seq: 1,
      operationId: 'probe',
      type: 'hello',
      codexAvailable: false,
      codexReadiness: 'unavailable',
      codexModels: [],
      claudeAvailable: true,
      claudeReadiness: 'ready',
      claudeVersion: '2.1.218',
      claudeModels: [{ id: 'auto', displayName: 'Auto', description: '' }],
    };
    expect(isRuntimeToMainEnvelope(hello)).toBe(true);
    expect(isRuntimeToMainEnvelope({ ...hello, claudeAvailable: 'yes' })).toBe(false);
    expect(isRuntimeToMainEnvelope({ ...hello, claudeModels: undefined })).toBe(false);
  });

  it('validates the additive optional Claude effort field on start envelopes', () => {
    const valid = startEnvelope();
    expect(isMainToRuntimeEnvelope(valid)).toBe(true);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']) {
      expect(isMainToRuntimeEnvelope({ ...valid, effort })).toBe(true);
    }
    expect(isMainToRuntimeEnvelope({ ...valid, effort: 'bogus' })).toBe(false);
    expect(isMainToRuntimeEnvelope({ ...valid, effort: 5 })).toBe(false);
  });

  it('accepts only bounded structured diagnostics on Runtime errors', () => {
    const error = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'error',
      error: { code: 'RUNTIME_FAILED', userMessage: 'failed', retryable: true },
      diagnostic: {
        version: 1,
        diagnosticId: '123e4567-e89b-42d3-a456-426614174000',
        runtimeKind: 'codex',
        failureStage: 'abnormal_exit',
        elapsedMs: 123,
        appVersion: '0.2.1',
        cliVersion: 'codex 1.0.0',
        teamMcp: { enabled: false, status: 'not_configured' },
        lastRecognizedNotification: 'turn/started',
        lastReceivedNotification: '[unsupported]',
        unsupportedNotificationCount: 1,
        stderrObserved: true,
        stderrTruncated: false,
        recordedAt: new Date().toISOString(),
      },
    };

    expect(isRuntimeToMainEnvelope(error)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, cliVersion: 'codex /Users/alice/private' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, failureStage: 'made_up' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, requestBody: 'must never cross' },
      }),
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, appVersion: cyclic },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...error,
        diagnostic: { ...error.diagnostic, elapsedMs: 1n },
      }),
    ).toBe(false);
  });

  it('validates the additive optional resolvedModel field on the completed canonical event', () => {
    const event = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'event',
      event: { type: 'completed' },
    };
    expect(isRuntimeToMainEnvelope(event)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { type: 'completed', resolvedModel: 'claude-sonnet-5' },
      }),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { type: 'completed', finalText: 'ユーザー向けの結論です。' },
      }),
    ).toBe(true);
    expect(
      isRuntimeToMainEnvelope({ ...event, event: { type: 'completed', resolvedModel: '' } }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({ ...event, event: { type: 'completed', resolvedModel: 42 } }),
    ).toBe(false);
    expect(isRuntimeToMainEnvelope({ ...event, event: { type: 'completed', finalText: '' } })).toBe(
      false,
    );
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { type: 'completed', finalText: 'x'.repeat(1_000_001) },
      }),
    ).toBe(false);
  });

  it('strictly validates command and tool operation progress events', () => {
    const event = {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeInstanceId: 'runtime-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 1,
      operationId: 'operation-1',
      type: 'event',
      event: {
        type: 'operation',
        phase: 'command_start',
        label: 'Codex command started',
      },
    };
    expect(isRuntimeToMainEnvelope(event)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { ...event.event, phase: 'command_output' },
      }),
    ).toBe(false);
    expect(
      isRuntimeToMainEnvelope({
        ...event,
        event: { ...event.event, label: '' },
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
      acceptedProjectItemIds: [],
      acceptedProjectSnapshotDigest: null,
      acceptedPayloadDigest: base.payloadDigest,
    };
    expect(isRuntimeToMainEnvelope(started)).toBe(true);
    expect(
      isRuntimeToMainEnvelope({
        ...started,
        acceptedContextFragmentIds: ['completion-1', 'completion-1'],
      }),
    ).toBe(false);
  });

  it('rejects payload tampering and forged Project authority', () => {
    const valid = startEnvelope();
    expect(isMainToRuntimeEnvelope({ ...valid, payload: 'tampered' })).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        projectItems: [
          {
            id: 'reference-1',
            kind: 'reference',
            authority: 'user',
            localOnly: false,
            sealedDigest: 'a'.repeat(64),
            content: 'data',
          },
        ],
      }),
    ).toBe(false);
  });

  it('enforces combined Project protocol count and UTF-8 byte budgets', () => {
    const valid = startEnvelope();
    const fragments = Array.from({ length: 255 }, (_, index) => ({
      id: `fragment-${index}`,
      source: 'history' as const,
      trust: 'user' as const,
      authority: 'user' as const,
      content: '',
    }));
    const projectItem = {
      id: 'project-instruction',
      kind: 'instruction' as const,
      authority: 'user' as const,
      localOnly: false,
      sealedDigest: 'a'.repeat(64),
      content: 'あ'.repeat(Math.floor((64 * 1024) / 3)),
    };
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: fragments,
        projectItems: [projectItem],
      }),
    ).toBe(true);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [...fragments, { ...fragments[0]!, id: 'fragment-256' }],
        projectItems: [projectItem],
      }),
    ).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        projectItems: [{ ...projectItem, content: 'あ'.repeat(Math.floor((64 * 1024) / 3) + 1) }],
      }),
    ).toBe(false);
    expect(
      isMainToRuntimeEnvelope({
        ...valid,
        contextFragments: [
          {
            id: 'large-fragment',
            source: 'history',
            trust: 'user',
            authority: 'user',
            content: 'x'.repeat(64 * 1024),
          },
        ],
        projectItems: [{ ...projectItem, content: `y${'x'.repeat(64 * 1024 - 1)}` }],
      }),
    ).toBe(true);
  });
});
