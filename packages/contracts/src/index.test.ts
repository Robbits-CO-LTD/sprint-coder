import { describe, expect, it } from 'vitest';
import * as contracts from './index';
import {
  claudeEffortSchema,
  commandEnvelopeSchema,
  permissionSettingsSchema,
  permissionSetInputSchema,
  publicErrorSchema,
  runtimeSettingsSchema,
  taskRenameInputSchema,
  teamBudgetStatusSchema,
  teamDetailSchema,
  teamEventSchema,
  teamHireWorkerInputSchema,
  teamMessageSummarySchema,
  teamSendMessageInputSchema,
  teamSummarySchema,
  teamWorkerRefSchema,
  toolCatalogSnapshotSchema,
  turnEventSchema,
  turnSnapshotSchema,
  workerCompletionSchema,
  workerSummarySchema,
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
  it('validates the bounded Team promotion result', () => {
    expect(
      teamSummarySchema.parse({
        id: 'team-1',
        taskId: 'task-1',
        state: 'draft',
        leaderAgentId: 'agent-1',
        budget: {},
        revision: 0,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      }),
    ).toMatchObject({ taskId: 'task-1', state: 'draft', leaderAgentId: 'agent-1' });
    expect(() =>
      teamSummarySchema.parse({
        id: 'team-1',
        taskId: 'task-1',
        state: 'running',
        leaderAgentId: 'agent-1',
        budget: {},
        revision: 0,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      }),
    ).toThrow();
  });

  const teamUsage = { costCents: 0, tokens: 0, timeMs: 0, toolCalls: 0 };
  const worker = {
    id: 'worker-1',
    teamId: 'team-1',
    threadId: 'thread-1',
    taskId: 'task-1',
    kind: 'worker',
    role: 'implementer',
    state: 'ready',
    objective: 'Ship the feature',
    writeCapable: true,
    currentActivity: null,
    usage: teamUsage,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const teamMessage = {
    id: 'message-1',
    teamId: 'team-1',
    sourceAgentId: 'worker-1',
    targetAgentId: 'leader-1',
    sourceKind: 'worker',
    targetKind: 'leader',
    seq: 1,
    state: 'delivered',
    content: 'status update',
    deliveryState: 'acked',
    attempt: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const team = {
    id: 'team-1',
    taskId: 'task-1',
    state: 'active',
    leaderAgentId: 'leader-1',
    budget: {},
    revision: 1,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  } as const;
  const budget = {
    scope: 'team',
    kind: 'costCents',
    cap: 1000,
    committed: 100,
    reserved: 0,
  } as const;

  it('validates worker summaries and rejects unknown worker states or extra fields', () => {
    expect(workerSummarySchema.parse(worker)).toMatchObject({ id: 'worker-1', state: 'ready' });
    expect(() => workerSummarySchema.parse({ ...worker, state: 'blocked' })).toThrow();
    expect(() => workerSummarySchema.parse({ ...worker, unknown: true })).toThrow();
  });

  it('validates team message summaries including a nullable delivery state', () => {
    expect(teamMessageSummarySchema.parse(teamMessage)).toMatchObject({ state: 'delivered' });
    expect(
      teamMessageSummarySchema.parse({ ...teamMessage, deliveryState: null }).deliveryState,
    ).toBeNull();
    expect(() =>
      teamMessageSummarySchema.parse({ ...teamMessage, deliveryState: 'queued' }),
    ).toThrow();
    expect(() => teamMessageSummarySchema.parse({ ...teamMessage, unknown: true })).toThrow();
  });

  it('validates team budget status scopes and rejects negative amounts', () => {
    expect(teamBudgetStatusSchema.parse(budget)).toMatchObject({ scope: 'team' });
    expect(() => teamBudgetStatusSchema.parse({ ...budget, scope: 'worker-pool' })).toThrow();
    expect(() => teamBudgetStatusSchema.parse({ ...budget, cap: -1 })).toThrow();
  });

  it('validates a team detail aggregate of workers, messages, and budgets', () => {
    const detail = { team, workers: [worker], messages: [teamMessage], budgets: [budget] };
    expect(teamDetailSchema.parse(detail)).toMatchObject({ team: { id: 'team-1' } });
    expect(() => teamDetailSchema.parse({ ...detail, unknown: true })).toThrow();
  });

  it('validates worker completion boundaries for summary length, artifacts, and digests', () => {
    const completion = {
      status: 'succeeded',
      summary: 'Implemented the feature end to end.',
      artifacts: [{ kind: 'file', reference: 'src/index.ts', digest: 'a'.repeat(64) }],
      verification: [{ name: 'unit tests', outcome: 'pass' }],
      risks: [],
    };
    expect(workerCompletionSchema.parse(completion)).toMatchObject({ status: 'succeeded' });
    expect(() => workerCompletionSchema.parse({ ...completion, summary: '' })).toThrow();
    expect(() =>
      workerCompletionSchema.parse({ ...completion, summary: 'x'.repeat(4_001) }),
    ).toThrow();
    expect(
      workerCompletionSchema.parse({ ...completion, summary: 'x'.repeat(4_000) }).summary.length,
    ).toBe(4_000);
    expect(() =>
      workerCompletionSchema.parse({
        ...completion,
        artifacts: [{ kind: 'file', reference: 'r', digest: 'not-a-digest' }],
      }),
    ).toThrow();
    expect(() =>
      workerCompletionSchema.parse({
        ...completion,
        artifacts: Array.from({ length: 21 }, () => ({ kind: 'note', reference: 'r' })),
      }),
    ).toThrow();
    expect(
      workerCompletionSchema.parse({
        ...completion,
        artifacts: Array.from({ length: 20 }, () => ({ kind: 'note', reference: 'r' })),
      }).artifacts,
    ).toHaveLength(20);
    expect(() =>
      workerCompletionSchema.parse({
        ...completion,
        verification: [{ name: 'x', outcome: 'inconclusive' }],
      }),
    ).toThrow();
    expect(() => workerCompletionSchema.parse({ ...completion, unknown: true })).toThrow();
  });

  it('validates team hire-worker and send-message inputs and rejects out-of-range values', () => {
    const hire = {
      taskId: 'task-1',
      role: 'reviewer',
      objective: 'Review the diff for correctness.',
      contextInheritancePolicy: 'summary',
      writeCapable: false,
    };
    expect(teamHireWorkerInputSchema.parse(hire)).toMatchObject({ role: 'reviewer' });
    expect(() => teamHireWorkerInputSchema.parse({ ...hire, role: 'x'.repeat(101) })).toThrow();
    expect(() =>
      teamHireWorkerInputSchema.parse({ ...hire, contextInheritancePolicy: 'everything' }),
    ).toThrow();
    expect(() => teamHireWorkerInputSchema.parse({ ...hire, unknown: true })).toThrow();

    const send = { taskId: 'task-1', targetAgentId: 'worker-1', content: 'hello' };
    expect(teamSendMessageInputSchema.parse(send)).toMatchObject({ targetAgentId: 'worker-1' });
    expect(() => teamSendMessageInputSchema.parse({ ...send, content: '' })).toThrow();
    expect(() =>
      teamSendMessageInputSchema.parse({ ...send, content: 'x'.repeat(20_001) }),
    ).toThrow();
    expect(() => teamSendMessageInputSchema.parse({ ...send, unknown: true })).toThrow();
  });

  it('validates the team worker reference and rejects extra fields', () => {
    const ref = { taskId: 'task-1', agentId: 'worker-1' };
    expect(teamWorkerRefSchema.parse(ref)).toEqual(ref);
    expect(() => teamWorkerRefSchema.parse({ ...ref, unknown: true })).toThrow();
  });

  it('validates the team event shape and rejects unknown event types', () => {
    const detail = { team, workers: [worker], messages: [teamMessage], budgets: [budget] };
    const event = { type: 'updated', detail };
    expect(teamEventSchema.parse(event)).toMatchObject({ type: 'updated' });
    expect(() => teamEventSchema.parse({ ...event, type: 'deleted' })).toThrow();
    expect(() => teamEventSchema.parse({ ...event, unknown: true })).toThrow();
  });

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
      turnEventSchema.parse({
        type: 'delivery.acknowledged',
        taskId: 't',
        turnId: 'u',
        seq: 5,
        deliveryId: 'a'.repeat(64),
        completionId: 'completion-1',
        fragmentId: 'completion-1',
      }),
    ).toMatchObject({ type: 'delivery.acknowledged', seq: 5 });
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
          fragments: [
            { source: 'history', tokens: 6 },
            { source: 'background', tokens: 1 },
          ],
        },
      }).lastSeq,
    ).toBe(3);
  });

  it('validates runtime settings and the runtime error codes', () => {
    expect(
      runtimeSettingsSchema.parse({
        kind: 'codex',
        codexAvailable: true,
        claudeAvailable: false,
        model: 'gpt-5.6-terra',
        models: [
          {
            id: 'gpt-5.6-terra',
            displayName: 'GPT-5.6-Terra',
            description: 'Balanced model',
          },
        ],
        effort: 'medium',
        codexEffort: 'high',
      }),
    ).toMatchObject({
      kind: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'medium',
      codexEffort: 'high',
    });
    expect(() => claudeEffortSchema.parse('bogus')).toThrow();
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
      expect(claudeEffortSchema.parse(effort)).toBe(effort);
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

  it('validates durable command lifecycle and bounded sequenced output events', () => {
    const command = {
      id: 'command-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      specDigest: 'a'.repeat(64),
      executable: '/usr/bin/printf',
      argv: ['ok'],
      cwd: '/workspace',
      envDelta: { PATH: '/usr/bin:/bin' },
      purpose: '変更の整合性を確認します',
      risk: 'high',
      state: 'running',
      pid: 123,
      exitCode: null,
      signal: null,
      outputBytes: 0,
      truncated: false,
      createdAt: '2026-07-23T00:00:00.000Z',
      startedAt: '2026-07-23T00:00:01.000Z',
      finishedAt: null,
    };
    expect(
      turnEventSchema.parse({
        type: 'command.started',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 7,
        command,
      }),
    ).toMatchObject({ type: 'command.started', command: { state: 'running' } });
    expect(
      turnEventSchema.parse({
        type: 'command.output',
        taskId: 'task-1',
        turnId: 'turn-1',
        seq: 8,
        commandId: 'command-1',
        outputSeq: 1,
        stream: 'stderr',
        text: 'safe output',
        byteLength: 11,
      }),
    ).toMatchObject({ type: 'command.output', outputSeq: 1 });
  });

  it('binds Auto audit events to immutable reviewer and effective-decision facts', () => {
    const event = turnEventSchema.parse({
      type: 'permission.auto_decided',
      taskId: 'task-1',
      turnId: 'turn-1',
      seq: 9,
      autoDecision: {
        id: 'auto-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-1',
        reviewRequestId: 'review-1',
        capability: 'workspace.read',
        source: 'narrow_allow',
        decision: 'allow',
        outcome: 'preset_auto_safe',
        reason: 'preset_auto_safe',
        risk: 'low',
        model: 'policy-engine',
        templateVersion: 'preset-auto-v1',
        requestFingerprint: 'a'.repeat(64),
        executionSpecDigest: 'b'.repeat(64),
        inputDigest: 'c'.repeat(64),
        policyEpoch: 3,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    });
    expect(event).toMatchObject({
      type: 'permission.auto_decided',
      autoDecision: { decision: 'allow', inputDigest: 'c'.repeat(64) },
    });
    if (event.type !== 'permission.auto_decided') throw new Error('Expected Auto decision event');
    expect(() =>
      turnEventSchema.parse({
        ...event,
        autoDecision: { ...event.autoDecision, inputDigest: 'not-a-digest' },
      }),
    ).toThrow();
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
