import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createToolDefinition,
  createToolId,
  type Capability,
  type ToolExecutionContext,
} from '@vibe/domain';
import { ApprovalCoordinator } from './approval-coordinator';
import { ToolBroker, type ToolAuthorizationRequest } from './tool-broker';

const NOW = '2026-07-22T12:00:00.000Z';
const EXPIRES_AT = '2026-07-22T13:00:00.000Z';

type Decision = 'allow_once' | 'allow_task' | 'deny';
type ApprovalState = 'pending' | 'resolved' | 'canceled' | 'stale' | 'expired';

type StoredApproval = {
  id: string;
  taskId: string;
  turnId: string;
  callId: string;
  requestDigest: string;
  policyEpoch: number;
  capabilities: readonly Capability[];
  challenge: string;
  challengeHash: string;
  revision: number;
  state: ApprovalState;
  decision: Decision | null;
  expiresAt: string;
};

type StoredGrant = {
  taskId: string;
  requestDigest: string;
  policyEpoch: number;
  expiresAt: string;
};

/**
 * Deliberately small persistence port for the coordinator tests. The fake models the security
 * properties that SQLite must later enforce transactionally: immutable request facts, a single
 * pending -> terminal CAS, and an exact request digest for Task-scoped reuse.
 */
class InMemoryApprovalPersistence {
  readonly timeline: string[] = [];
  readonly approvals = new Map<string, StoredApproval>();
  readonly grants: StoredGrant[] = [];

  requestApproval(raw: unknown): { approval: StoredApproval; event: { type: string } } {
    const input = raw as Omit<StoredApproval, 'revision' | 'state' | 'decision'>;
    if (this.approvals.has(input.id)) throw new Error('DUPLICATE_APPROVAL');
    const stored: StoredApproval = Object.freeze({
      ...input,
      revision: 0,
      state: 'pending',
      decision: null,
    });
    this.approvals.set(stored.id, stored);
    this.timeline.push(`committed:${stored.id}`);
    return { approval: stored, event: { type: 'approval.requested' } };
  }

  getApproval(taskId: string, approvalId: string): StoredApproval | undefined {
    const approval = this.approvals.get(approvalId);
    return approval?.taskId === taskId ? approval : undefined;
  }

  listPendingApprovals(taskId: string): StoredApproval[] {
    return [...this.approvals.values()].filter(
      (approval) => approval.taskId === taskId && approval.state === 'pending',
    );
  }

  resolveApproval(raw: unknown): {
    approval: StoredApproval;
    event: { type: string };
    oneTimePermitToken?: string;
  } {
    const input = raw as {
      taskId: string;
      turnId: string;
      approvalId: string;
      expectedRevision: number;
      challengeHash: string;
      decision: Decision;
    };
    const current = this.approvals.get(input.approvalId);
    if (current === undefined || current.taskId !== input.taskId || current.turnId !== input.turnId)
      throw new Error('APPROVAL_NOT_FOUND');
    if (current.state !== 'pending' || current.revision !== input.expectedRevision)
      throw new Error('APPROVAL_STALE');
    if (current.challengeHash !== input.challengeHash)
      throw new Error('APPROVAL_CHALLENGE_INVALID');
    const resolved = Object.freeze({
      ...current,
      state: 'resolved' as const,
      decision: input.decision,
      revision: current.revision + 1,
    });
    this.approvals.set(current.id, resolved);
    this.timeline.push(`resolved:${current.id}:${input.decision}`);
    return {
      approval: resolved,
      event: { type: 'approval.resolved' },
      ...(input.decision === 'allow_once' ? { oneTimePermitToken: `permit:${current.id}` } : {}),
    };
  }

  endTurnApprovals(taskId: string, turnId: string, _reason: 'canceled' | 'finished'): string[] {
    const ended: string[] = [];
    for (const approval of this.approvals.values()) {
      if (approval.taskId !== taskId || approval.turnId !== turnId || approval.state !== 'pending')
        continue;
      this.approvals.set(
        approval.id,
        Object.freeze({
          ...approval,
          state: 'canceled',
          decision: null,
          revision: approval.revision + 1,
        }),
      );
      this.timeline.push(`ended:${approval.id}`);
      ended.push(approval.id);
    }
    return ended;
  }

  saveTaskGrant(raw: unknown): void {
    const grant = raw as StoredGrant;
    this.grants.push(Object.freeze({ ...grant }));
    this.timeline.push(`grant:${grant.requestDigest}`);
  }

  hasTaskGrant(raw: unknown): boolean {
    const input = raw as {
      taskId: string;
      requestDigest: string;
      policyEpoch: number;
      now: string;
    };
    return this.grants.some(
      (grant) =>
        grant.taskId === input.taskId &&
        grant.requestDigest === input.requestDigest &&
        grant.policyEpoch === input.policyEpoch &&
        Date.parse(grant.expiresAt) > Date.parse(input.now),
    );
  }
}

const toolContext: ToolExecutionContext = {
  taskId: 'task-1',
  turnId: 'turn-1',
  workspaceId: 'workspace-1',
  policyEpoch: 7,
};

function createHarness(input?: {
  evaluatePermission?: (input: {
    capability: Capability;
    request: ToolAuthorizationRequest;
  }) => 'allow' | 'deny' | 'approval_required';
}) {
  const persistence = new InMemoryApprovalPersistence();
  const published: StoredApproval[] = [];
  let policyEpoch = 7;
  const activeTurns = new Set(['task-1\0turn-1', 'task-1\0turn-2', 'task-1\0turn-3']);
  const coordinator = new ApprovalCoordinator({
    persistence,
    now: () => NOW,
    expiresAt: () => EXPIRES_AT,
    getCurrentPolicyEpoch: () => policyEpoch,
    isTurnActive: (taskId: string, turnId: string) => activeTurns.has(`${taskId}\0${turnId}`),
    evaluatePermission: input?.evaluatePermission ?? (() => 'approval_required' as const),
    publish: (approval: StoredApproval) => {
      persistence.timeline.push(`published:${approval.id}`);
      published.push(approval);
    },
  });
  return {
    coordinator,
    persistence,
    published,
    setPolicyEpoch: (epoch: number) => {
      policyEpoch = epoch;
    },
    endTurn: (turnId: string) => activeTurns.delete(`task-1\0${turnId}`),
  };
}

function createBroker(
  authorize: (
    request: ToolAuthorizationRequest,
  ) => ReturnType<ApprovalCoordinator['authorizeTool']>,
  requiredCapabilities: readonly Capability[] = ['network.fetch'],
) {
  const registry = new ToolRegistry();
  const definition = createToolDefinition({
    toolId: createToolId({
      provider: 'builtin',
      namespace: 'approval',
      name: 'fetch',
      version: '1',
    }),
    providerName: 'approval_fetch',
    kind: 'network',
    schemaVersion: 1,
    inputSchema: {
      type: 'object',
      properties: { origin: { type: 'string' } },
      required: ['origin'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    },
    sideEffect: 'network',
    risk: 'medium',
    requiredCapabilities,
    executionTarget: 'main',
    implementationKind: 'built-in',
    priority: 10,
    workspaceBinding: { kind: 'any' },
    providerCompatibility: ['mock'],
  });
  registry.register(definition);
  const broker = new ToolBroker(registry, () => 7, authorize);
  let executions = 0;
  broker.registerImplementation({
    toolId: definition.toolId,
    implementationKind: 'built-in',
    execute: () => {
      executions += 1;
      return { ok: true };
    },
  });
  return { broker, executions: () => executions };
}

async function waitForPublished(
  harness: ReturnType<typeof createHarness>,
): Promise<StoredApproval> {
  await viWaitFor(() => harness.published.length === 1);
  return harness.published[0]!;
}

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for approval fixture');
}

function resolveCommand(approval: StoredApproval, decision: Decision) {
  return {
    taskId: approval.taskId,
    turnId: approval.turnId,
    approvalId: approval.id,
    decision,
    expectedRevision: approval.revision,
    challenge: approval.challenge,
    operationId: randomUUID(),
  } as const;
}

describe('ApprovalCoordinator', () => {
  it('commits a pending request before publishing it, then releases allow-once exactly once', async () => {
    const harness = createHarness();
    const { broker, executions } = createBroker(
      harness.coordinator.authorizeTool.bind(harness.coordinator),
    );
    broker.startTurn(toolContext, 'mock');

    const dispatch = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-1',
      providerName: 'approval_fetch',
      input: { origin: 'https://example.test' },
    });
    const approval = await waitForPublished(harness);

    expect(harness.persistence.timeline.slice(0, 2)).toEqual([
      `committed:${approval.id}`,
      `published:${approval.id}`,
    ]);
    expect(executions()).toBe(0);
    expect(harness.coordinator.resolve(resolveCommand(approval, 'allow_once'))).toMatchObject({
      state: 'resolved',
      decision: 'allow_once',
    });
    await expect(dispatch).resolves.toEqual({ ok: true });
    expect(executions()).toBe(1);
    expect(() =>
      harness.coordinator.resolve({
        ...resolveCommand(approval, 'allow_once'),
        expectedRevision: 1,
      }),
    ).toThrow(/STALE|RESOLVED/);
  });

  it.each([
    ['allow_once', 'allow'],
    ['allow_task', 'allow'],
    ['deny', 'deny'],
  ] as const)(
    'maps %s to a terminal persisted decision and waiter result',
    async (decision, result) => {
      const harness = createHarness();
      const authorization = harness.coordinator.authorizeTool({
        context: toolContext,
        callId: `call-${decision}`,
        entry: createBroker(() =>
          Promise.resolve({ decision: 'deny', reason: 'unused' }),
        ).broker.startTurn(toolContext, 'mock').entries[0]!,
        input: { origin: 'https://example.test' },
      });
      const approval = await waitForPublished(harness);

      harness.coordinator.resolve(resolveCommand(approval, decision));

      await expect(authorization).resolves.toMatchObject({ decision: result });
      expect(harness.persistence.approvals.get(approval.id)).toMatchObject({
        state: 'resolved',
        decision,
      });
    },
  );

  it('rejects wrong challenge, Task, and revision without releasing the waiter', async () => {
    const harness = createHarness();
    let released = false;
    const authorization = harness.coordinator
      .authorizeTool({
        context: toolContext,
        callId: 'call-bound',
        entry: createBroker(() =>
          Promise.resolve({ decision: 'deny', reason: 'unused' }),
        ).broker.startTurn(toolContext, 'mock').entries[0]!,
        input: { origin: 'https://example.test' },
      })
      .then((decision) => {
        released = true;
        return decision;
      });
    const approval = await waitForPublished(harness);

    expect(() =>
      harness.coordinator.resolve({
        ...resolveCommand(approval, 'allow_once'),
        challenge: 'wrong-challenge',
      }),
    ).toThrow(/CHALLENGE/);
    expect(() =>
      harness.coordinator.resolve({
        ...resolveCommand(approval, 'allow_once'),
        taskId: 'task-other',
      }),
    ).toThrow(/NOT_FOUND|TASK/);
    expect(() =>
      harness.coordinator.resolve({
        ...resolveCommand(approval, 'allow_once'),
        expectedRevision: approval.revision + 1,
      }),
    ).toThrow(/STALE|REVISION/);
    await Promise.resolve();
    expect(released).toBe(false);

    harness.coordinator.resolve(resolveCommand(approval, 'deny'));
    await expect(authorization).resolves.toMatchObject({ decision: 'deny' });
  });

  it.each(['canceled', 'finished'] as const)(
    'fails closed when the Turn is %s while approval is pending and never executes',
    async (reason) => {
      const harness = createHarness();
      const { broker, executions } = createBroker(
        harness.coordinator.authorizeTool.bind(harness.coordinator),
      );
      broker.startTurn(toolContext, 'mock');
      const dispatch = broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: `call-${reason}`,
        providerName: 'approval_fetch',
        input: { origin: 'https://example.test' },
      });
      const approval = await waitForPublished(harness);

      harness.endTurn('turn-1');
      harness.coordinator.turnEnded('task-1', 'turn-1', reason);
      broker.finishTurn('task-1', 'turn-1');

      await dispatch.catch(() => undefined);
      expect(executions()).toBe(0);
      expect(harness.persistence.approvals.get(approval.id)?.state).toBe('canceled');
    },
  );

  it('fails closed when policyEpoch changes before decision and never executes', async () => {
    const harness = createHarness();
    const { broker, executions } = createBroker(
      harness.coordinator.authorizeTool.bind(harness.coordinator),
    );
    broker.startTurn(toolContext, 'mock');
    const dispatch = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-stale-policy',
      providerName: 'approval_fetch',
      input: { origin: 'https://example.test' },
    });
    const approval = await waitForPublished(harness);
    harness.setPolicyEpoch(8);

    expect(() => harness.coordinator.resolve(resolveCommand(approval, 'allow_once'))).toThrow(
      /POLICY|STALE/,
    );
    await dispatch.catch(() => undefined);
    expect(executions()).toBe(0);
  });

  it('reuses an exact Task grant but requests approval again when the tool input changes', async () => {
    const harness = createHarness();
    const { broker, executions } = createBroker(
      harness.coordinator.authorizeTool.bind(harness.coordinator),
    );
    broker.startTurn(toolContext, 'mock');
    const first = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-task-grant',
      providerName: 'approval_fetch',
      input: { origin: 'https://example.test' },
    });
    const approval = await waitForPublished(harness);
    harness.coordinator.resolve(resolveCommand(approval, 'allow_task'));
    await expect(first).resolves.toEqual({ ok: true });
    broker.finishTurn('task-1', 'turn-1');

    broker.startTurn({ ...toolContext, turnId: 'turn-2' }, 'mock');
    await expect(
      broker.dispatch({
        taskId: 'task-1',
        turnId: 'turn-2',
        callId: 'call-reuse',
        providerName: 'approval_fetch',
        input: { origin: 'https://example.test' },
      }),
    ).resolves.toEqual({ ok: true });
    expect(harness.published).toHaveLength(1);

    const changed = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-2',
      callId: 'call-changed',
      providerName: 'approval_fetch',
      input: { origin: 'https://different.test' },
    });
    await viWaitFor(() => harness.published.length === 2);
    expect(executions()).toBe(2);
    harness.coordinator.resolve(resolveCommand(harness.published[1]!, 'deny'));
    await changed.catch(() => undefined);
    expect(executions()).toBe(2);
  });

  it('requires every capability to allow and never executes after one capability denies', async () => {
    const evaluated: Capability[] = [];
    const harness = createHarness({
      evaluatePermission: ({ capability }) => {
        evaluated.push(capability);
        return capability === 'provider.egress' ? 'deny' : 'allow';
      },
    });
    const { broker, executions } = createBroker(
      harness.coordinator.authorizeTool.bind(harness.coordinator),
      ['network.fetch', 'provider.egress'],
    );
    broker.startTurn(toolContext, 'mock');

    await broker
      .dispatch({
        taskId: 'task-1',
        turnId: 'turn-1',
        callId: 'call-multi-capability',
        providerName: 'approval_fetch',
        input: { origin: 'https://example.test' },
      })
      .catch(() => undefined);

    expect(evaluated).toEqual(['network.fetch', 'provider.egress']);
    expect(harness.published).toHaveLength(0);
    expect(executions()).toBe(0);
  });

  it('requires a separate approval for every capability before executing once', async () => {
    const harness = createHarness();
    const { broker, executions } = createBroker(
      harness.coordinator.authorizeTool.bind(harness.coordinator),
      ['network.fetch', 'provider.egress'],
    );
    broker.startTurn(toolContext, 'mock');
    const dispatch = broker.dispatch({
      taskId: 'task-1',
      turnId: 'turn-1',
      callId: 'call-two-approvals',
      providerName: 'approval_fetch',
      input: { origin: 'https://example.test' },
    });

    const first = await waitForPublished(harness);
    expect(first.capabilities).toEqual(['network.fetch']);
    harness.coordinator.resolve(resolveCommand(first, 'allow_once'));
    await viWaitFor(() => harness.published.length === 2);
    expect(executions()).toBe(0);

    const second = harness.published[1]!;
    expect(second.capabilities).toEqual(['provider.egress']);
    harness.coordinator.resolve(resolveCommand(second, 'allow_once'));
    await expect(dispatch).resolves.toEqual({ ok: true });
    expect(executions()).toBe(1);
  });
});
