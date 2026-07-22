import { describe, expect, it } from 'vitest';
import * as contracts from './index';
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

type Parser = { parse(value: unknown): unknown };
const approvalContracts = contracts as typeof contracts & {
  approvalDecisionSchema: Parser;
  approvalSummarySchema: Parser;
  approvalResolveInputSchema: Parser;
};

const pendingApproval = {
  id: 'approval-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  callId: 'call-1',
  state: 'pending',
  decision: null,
  revision: 0,
  policyEpoch: 3,
  toolName: 'fetch_url',
  reason: 'The task requested network access.',
  target: 'https://example.com',
  impact: 'Sends a request to an external service.',
  execution: 'GET https://example.com',
  risk: 'medium',
  capability: 'network.fetch',
  challenge: 'approval-challenge-0001',
  createdAt: '2026-07-22T12:00:00.000Z',
  expiresAt: '2026-07-22T12:05:00.000Z',
} as const;

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

  it('validates the three user approval decisions and rejects unknown values', () => {
    for (const decision of ['allow_once', 'allow_task', 'deny'])
      expect(approvalContracts.approvalDecisionSchema.parse(decision)).toBe(decision);
    expect(() => approvalContracts.approvalDecisionSchema.parse('allow_forever')).toThrow();
  });

  it('validates the sanitized pending Approval DTO', () => {
    expect(approvalContracts.approvalSummarySchema.parse(pendingApproval)).toEqual(pendingApproval);
  });

  it('requires a decision only for resolved approvals', () => {
    const resolved = {
      ...pendingApproval,
      state: 'resolved',
      decision: 'deny',
      revision: 1,
      decidedAt: '2026-07-22T12:01:00.000Z',
    };
    expect(approvalContracts.approvalSummarySchema.parse(resolved)).toEqual(resolved);
    expect(() =>
      approvalContracts.approvalSummarySchema.parse({
        ...pendingApproval,
        decision: 'allow_once',
      }),
    ).toThrow();
    expect(() =>
      approvalContracts.approvalSummarySchema.parse({
        ...resolved,
        decision: null,
      }),
    ).toThrow();
  });

  it('keeps approval resolution strict and does not accept Renderer-supplied authority facts', () => {
    const resolve = {
      taskId: 'task-1',
      approvalId: 'approval-1',
      decision: 'allow_once',
      expectedRevision: 0,
      expectedPolicyEpoch: 3,
      challenge: 'approval-challenge-0001',
    };
    expect(approvalContracts.approvalResolveInputSchema.parse(resolve)).toEqual(resolve);
    for (const forged of [
      { ...resolve, capability: 'shell.execute' },
      { ...resolve, resource: { kind: 'all' } },
      { ...resolve, executionSpecDigest: '0'.repeat(64) },
      { ...resolve, unknown: true },
    ])
      expect(() => approvalContracts.approvalResolveInputSchema.parse(forged)).toThrow();
  });

  it('validates approval lifecycle Turn events', () => {
    expect(
      turnEventSchema.parse({
        type: 'approval.requested',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 5,
        approvalId: 'approval-1',
        approval: pendingApproval,
      }),
    ).toMatchObject({ type: 'approval.requested', approval: { state: 'pending' } });
    expect(
      turnEventSchema.parse({
        type: 'approval.resolved',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 6,
        approvalId: 'approval-1',
        decision: 'deny',
        approval: {
          ...pendingApproval,
          state: 'resolved',
          decision: 'deny',
          revision: 1,
          decidedAt: '2026-07-22T12:01:00.000Z',
        },
      }),
    ).toMatchObject({ type: 'approval.resolved', approval: { decision: 'deny' } });
  });

  it('represents waiting approval in reconnect snapshots without widening Runtime stages', () => {
    const snapshot = {
      lastSeq: 5,
      activeTurn: {
        turnId: 'turn-1',
        stage: 'waiting_approval',
        startedAtEpochMs: 1,
        streamedText: '',
        messageId: null,
      },
      queued: [],
      contextUsage: { usedTokens: 0, hardCapTokens: 32_000, fragments: [] },
    };
    expect(turnSnapshotSchema.parse(snapshot)).toMatchObject({
      activeTurn: { turnId: 'turn-1', stage: 'waiting_approval' },
    });
  });
});
