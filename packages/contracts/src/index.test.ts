import { describe, expect, it } from 'vitest';
import {
  commandEnvelopeSchema,
  permissionSettingsSchema,
  permissionSetInputSchema,
  publicErrorSchema,
  runtimeSettingsSchema,
  taskRenameInputSchema,
  toolCatalogSnapshotSchema,
  turnEventSchema,
  turnSnapshotSchema,
} from './index';

describe('public contracts', () => {
  it('rejects unknown command fields', () => {
    expect(() =>
      commandEnvelopeSchema(taskRenameInputSchema).parse({
        requestId: 'r',
        operationId: 'o',
        payload: { taskId: 't', title: 'x' },
        unknown: true,
      }),
    ).toThrow();
  });

  it('rejects malformed turn events', () => {
    expect(() =>
      turnEventSchema.parse({
        type: 'message.delta',
        taskId: 't',
        turnId: 'u',
        seq: 0,
        messageId: 'm',
        delta: '',
      }),
    ).toThrow();
  });

  it('accepts task-scoped events and snapshots with context usage', () => {
    expect(
      turnEventSchema.parse({
        type: 'queue.changed',
        taskId: 't',
        seq: 3,
        queued: [{ ordinal: 1, text: 'next' }],
      }),
    ).toMatchObject({ type: 'queue.changed', seq: 3 });
    expect(
      turnEventSchema.parse({
        type: 'context.usage',
        taskId: 't',
        seq: 4,
        usage: {
          usedTokens: 7,
          hardCapTokens: 32_000,
          fragments: [{ source: 'history', tokens: 7 }],
        },
      }),
    ).toMatchObject({ type: 'context.usage', seq: 4 });
    expect(
      turnSnapshotSchema.parse({
        lastSeq: 3,
        activeTurn: {
          turnId: 'turn',
          stage: 'executing',
          startedAtEpochMs: 1,
          streamedText: 'partial',
          messageId: 'message',
        },
        queued: [{ ordinal: 1, text: 'next' }],
        contextUsage: {
          usedTokens: 7,
          hardCapTokens: 32_000,
          fragments: [{ source: 'history', tokens: 7 }],
        },
      }).lastSeq,
    ).toBe(3);
  });

  it('validates runtime settings and the runtime error codes', () => {
    expect(
      runtimeSettingsSchema.parse({
        kind: 'codex',
        codexAvailable: true,
        model: 'gpt-5.6-terra',
        models: [
          {
            id: 'gpt-5.6-terra',
            displayName: 'GPT-5.6-Terra',
            description: 'Balanced model',
          },
        ],
      }),
    ).toMatchObject({ kind: 'codex', model: 'gpt-5.6-terra' });
    expect(
      publicErrorSchema.parse({
        code: 'STEER_UNSUPPORTED',
        userMessage: 'unsupported',
        retryable: false,
      }).code,
    ).toBe('STEER_UNSUPPORTED');
  });

  it('validates task-scoped permission preset settings', () => {
    expect(permissionSettingsSchema.parse({ preset: 'auto', policyEpoch: 3 })).toEqual({
      preset: 'auto',
      policyEpoch: 3,
    });
    expect(() => permissionSettingsSchema.parse({ preset: 'root', policyEpoch: -1 })).toThrow();
    expect(
      permissionSetInputSchema.parse({
        taskId: 'task-1',
        preset: 'full',
        expectedPolicyEpoch: 3,
      }),
    ).toMatchObject({ preset: 'full', expectedPolicyEpoch: 3 });
    expect(() => permissionSetInputSchema.parse({ taskId: 'task-1', preset: 'full' })).toThrow();
  });

  it('validates immutable Tool Catalog metadata at the runtime boundary', () => {
    const digest = 'a'.repeat(64);
    const snapshot = {
      revision: 2,
      providerId: 'codex',
      workspaceId: 'workspace-1',
      entries: [
        {
          providerName: 'read_file',
          toolId: 'builtin:workspace:read-file@1',
          version: '1',
          kind: 'fileRead',
          schemaVersion: 1,
          inputSchema: { type: 'object' },
          inputSchemaDigest: digest,
          outputSchemaDigest: digest,
          schemaDigest: digest,
          sideEffect: 'read',
          risk: 'low',
          requiredCapabilities: ['workspace.read'],
          executionTarget: 'main',
          implementationKind: 'built-in',
        },
      ],
      digest,
    };
    expect(toolCatalogSnapshotSchema.parse(snapshot)).toMatchObject({ providerId: 'codex' });
    for (const invalid of [
      { ...snapshot, entries: [{ ...snapshot.entries[0], risk: 'root' }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], sideEffect: 'unknown' }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], schemaVersion: 0 }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], requiredCapabilities: ['root'] }] },
      { ...snapshot, entries: [{ ...snapshot.entries[0], version: '2' }] },
      {
        ...snapshot,
        entries: [
          {
            ...snapshot.entries[0],
            implementationKind: 'built-in',
            executionTarget: 'mcp-gateway',
          },
        ],
      },
      { ...snapshot, providerId: 'Codex\nspoof' },
    ])
      expect(() => toolCatalogSnapshotSchema.parse(invalid)).toThrow();
  });
});
