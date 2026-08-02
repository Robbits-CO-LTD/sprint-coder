import { describe, expect, it, vi } from 'vitest';
import type { ModelSelection } from '@sprint-coder/contracts';
import { executeTeamTool } from './team-tools';
import type { TeamCoordinator } from './team-coordinator';

// executeTeamTool is the single execution path shared by the mock ToolBroker (team-tools.test.ts,
// gated behind the Electron ABI because it needs real SQLite persistence) and the MCP bridge. Its
// own routing/validation/long-poll logic never touches persistence directly — it only calls
// TeamCoordinator methods — so it can be exercised here against a lightweight fake coordinator
// without any Electron ABI dependency at all.
function fakeCoordinator(overrides: Partial<TeamCoordinator> = {}): TeamCoordinator {
  return {
    hireWorker: vi.fn(
      async () =>
        ({
          id: 'worker-1',
          role: 'role',
          state: 'ready',
          parentAgentId: 'leader-1',
          depth: 1,
          canDelegate: false,
          managerPolicy: null,
        }) as never,
    ),
    hireWorkerAs: vi.fn(
      async () =>
        ({
          id: 'worker-1',
          role: 'role',
          state: 'ready',
          parentAgentId: 'manager-1',
          depth: 2,
          canDelegate: false,
          managerPolicy: null,
        }) as never,
    ),
    sendToWorker: vi.fn(
      async () => ({ id: 'message-1', state: 'delivered', deliveryState: 'acked' }) as never,
    ),
    assignTask: vi.fn(async () => ({ executionId: 'execution-2', state: 'queued' }) as never),
    assignTaskAs: vi.fn(async () => ({ executionId: 'execution-2', state: 'queued' }) as never),
    assignMission: vi.fn(
      async () =>
        ({ id: 'mission-1', state: 'running', currentStepOrdinal: 0, steps: [] }) as never,
    ),
    resumeMission: vi.fn(
      async () =>
        ({ id: 'mission-1', state: 'running', currentStepOrdinal: 0, steps: [] }) as never,
    ),
    steerExecution: vi.fn(async () => ({ executionId: 'execution-2', state: 'queued' }) as never),
    cancelExecution: vi.fn(
      async () => ({ executionId: 'execution-2', state: 'canceled' }) as never,
    ),
    get: vi.fn(() => null),
    listWorkerReports: vi.fn(() => []),
    listAgentMessages: vi.fn(() => []),
    sendAgentMessageAs: vi.fn(
      async () =>
        ({
          id: 'message-direct-1',
          targetAgentId: 'worker-2',
          seq: 3,
          state: 'delivered',
        }) as never,
    ),
    hasBusyWorkers: vi.fn(() => false),
    stopWorker: vi.fn(async () => ({ id: 'worker-1', state: 'stopped' }) as never),
    ...overrides,
  } as unknown as TeamCoordinator;
}

describe('executeTeamTool routing', () => {
  it('throws for an unknown tool name instead of silently no-op-ing', async () => {
    await expect(
      executeTeamTool(fakeCoordinator(), 'task-1', 'team_delete_everything', {}),
    ).rejects.toThrow('Unknown team tool');
  });

  it('routes team_hire_worker to TeamCoordinator.hireWorker with the caller-bound taskId', async () => {
    const coordinator = fakeCoordinator();
    const result = await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'worker',
      role: '調査',
      objective: '調べる',
    });
    expect(coordinator.hireWorker).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        role: '調査',
        objective: '調べる',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      },
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      workerId: 'worker-1',
      agentKind: 'worker',
      parentAgentId: 'leader-1',
      depth: 1,
      canDelegate: false,
      remainingDelegationLevels: 0,
    });
  });

  it('enforces the discriminated worker/manager hire contract and rejects the legacy field', async () => {
    const coordinator = fakeCoordinator();
    const leafWithPolicy = await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'worker',
      role: 'leaf',
      objective: 'work',
      managerPolicy: {
        maxDirectChildren: 2,
        maxDelegationLevels: 1,
        allowManagerChildren: false,
      },
    });
    const managerWithoutPolicy = await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'manager',
      role: 'manager',
      objective: 'manage',
    });
    const zeroLevels = await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'manager',
      role: 'manager',
      objective: 'manage',
      managerPolicy: {
        maxDirectChildren: 2,
        maxDelegationLevels: 0,
        allowManagerChildren: false,
      },
    });
    const legacy = await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'manager',
      role: 'manager',
      objective: 'manage',
      managerPolicy: {
        maxDirectChildren: 2,
        maxDelegationDepth: 2,
        allowManagerChildren: false,
      },
    });

    expect(leafWithPolicy).toMatchObject({ ok: false, error: 'ZodError' });
    expect(managerWithoutPolicy).toMatchObject({ ok: false, error: 'ZodError' });
    expect(zeroLevels).toMatchObject({ ok: false, error: 'ZodError' });
    expect(legacy).toMatchObject({
      ok: false,
      code: 'legacy_delegation_field',
      message: expect.stringContaining('maxDelegationLevels'),
    });
    expect(coordinator.hireWorker).not.toHaveBeenCalled();
  });

  it('requires an audited catalog selection on the real Leader and Manager path', async () => {
    const coordinator = fakeCoordinator();
    let queried = false;
    const result = (await executeTeamTool(
      coordinator,
      'task-1',
      'team_hire_worker',
      {
        agentKind: 'worker',
        role: '調査',
        objective: '調べる',
      },
      {
        listModelCandidates: vi.fn(),
        modelCatalogAudit: {
          wasQueried: () => queried,
          markQueried: () => {
            queried = true;
          },
        },
      },
    )) as { ok: false; message: string };

    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('query the model catalog');
    expect(coordinator.hireWorker).not.toHaveBeenCalled();
  });

  it('allows the audited real path after catalog lookup and persists its selection reason', async () => {
    const coordinator = fakeCoordinator();
    let queried = false;
    const options = {
      listModelCandidates: vi.fn(async () => ({ items: [] })),
      modelCatalogAudit: {
        wasQueried: () => queried,
        markQueried: () => {
          queried = true;
        },
      },
    };
    await executeTeamTool(coordinator, 'task-1', 'team_list_models', {}, options);
    const selection = {
      connectionId: 'builtin:codex-cli',
      requestedProvider: 'openai',
      requestedModel: 'gpt-5.6-sol',
    };
    await executeTeamTool(
      coordinator,
      'task-1',
      'team_hire_worker',
      {
        agentKind: 'worker',
        role: '実装',
        objective: '実装する',
        modelSelection: selection,
        modelSelectionReason: 'catalogのtoolCalling情報を確認した',
      },
      options,
    );

    expect(coordinator.hireWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: selection,
        modelSelectionReason: 'catalogのtoolCalling情報を確認した',
      }),
      null,
    );
  });

  it('requires Web research evidence for the exact selected model when the setting is enabled', async () => {
    const coordinator = fakeCoordinator();
    const researched = new Set<string>();
    const selection = {
      connectionId: 'openrouter:primary',
      requestedProvider: 'openrouter',
      requestedModel: 'anthropic/claude-opus-5',
    };
    const key = (value: ModelSelection) =>
      `${value.connectionId}\0${value.requestedProvider}\0${value.requestedModel}`;
    const options = {
      listModelCandidates: vi.fn(async () => ({ items: [] })),
      modelCatalogAudit: {
        wasQueried: () => true,
        markQueried: vi.fn(),
      },
      modelResearchAudit: {
        required: true,
        record: (input: { modelSelection: ModelSelection }) => {
          researched.add(key(input.modelSelection));
        },
        hasEvidence: (candidate: ModelSelection) => researched.has(key(candidate)),
      },
    };

    const before = (await executeTeamTool(
      coordinator,
      'task-1',
      'team_hire_worker',
      {
        agentKind: 'worker',
        role: '実装',
        objective: '実装する',
        modelSelection: selection,
        modelSelectionReason: 'Web調査に基づく',
      },
      options,
    )) as { ok: false; message: string };
    expect(before.message).toContain('Web research evidence');
    expect(coordinator.hireWorker).not.toHaveBeenCalled();

    await executeTeamTool(
      coordinator,
      'task-1',
      'team_record_model_research',
      {
        modelSelection: selection,
        summary: '公式情報でtool useと長いcontextを確認した',
        sources: ['https://openrouter.ai/models/anthropic/claude-opus-5'],
      },
      options,
    );
    await executeTeamTool(
      coordinator,
      'task-1',
      'team_hire_worker',
      {
        agentKind: 'worker',
        role: '実装',
        objective: '実装する',
        modelSelection: selection,
        modelSelectionReason: '公式情報のWeb調査に基づく',
      },
      options,
    );
    expect(coordinator.hireWorker).toHaveBeenCalledOnce();
  });

  it('maps a TeamCoordinator rejection to an {ok:false} tool result instead of throwing', async () => {
    const coordinator = fakeCoordinator({
      hireWorker: vi.fn(async () => {
        throw new Error('Team worker hard cap exceeded: 3');
      }),
    });
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'worker',
      role: 'x',
      objective: 'y',
    })) as { ok: false; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain('hard cap');
  });

  it('routes formal assignment, status, and cursor waits through the caller-bound Team', async () => {
    const coordinator = fakeCoordinator();
    const assigned = await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
      workerId: 'worker-1',
      objective: '実装する',
      doneCriteria: ['targeted test passes'],
    });
    expect(coordinator.assignTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      targetAgentId: 'worker-1',
      content: '実装する',
      doneCriteria: ['targeted test passes'],
      accessMode: 'read-only',
    });
    expect(assigned).toMatchObject({ ok: true, executionId: 'execution-2', state: 'queued' });

    expect(
      await executeTeamTool(coordinator, 'task-1', 'team_steer_execution', {
        executionId: 'execution-2',
        instruction: 'add the regression test',
      }),
    ).toMatchObject({ ok: true, executionId: 'execution-2', state: 'queued' });
    expect(coordinator.steerExecution).toHaveBeenCalledWith(
      'task-1',
      'execution-2',
      'add the regression test',
      null,
      'read-only',
    );
    expect(
      await executeTeamTool(coordinator, 'task-1', 'team_cancel_execution', {
        executionId: 'execution-2',
      }),
    ).toMatchObject({ ok: true, executionId: 'execution-2', state: 'canceled' });
    expect(coordinator.cancelExecution).toHaveBeenCalledWith('task-1', 'execution-2', null);

    expect(await executeTeamTool(coordinator, 'task-1', 'team_get_status', {})).toEqual({
      ok: true,
      team: null,
    });
    await executeTeamTool(coordinator, 'task-1', 'team_wait_events', { cursor: 7 });
    expect(coordinator.listWorkerReports).toHaveBeenCalledWith('task-1', 7, undefined);
  });

  it('passes an explicit workspace-write mode to the execution contract', async () => {
    const coordinator = fakeCoordinator();
    await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
      workerId: 'worker-1',
      objective: '隔離環境で実装する',
      doneCriteria: ['tests pass'],
      access: 'workspace-write',
    });
    expect(coordinator.assignTask).toHaveBeenCalledWith(
      expect.objectContaining({ accessMode: 'workspace-write' }),
    );
  });

  it('prevents a read-only Manager execution from delegating workspace writes', async () => {
    const coordinator = fakeCoordinator();
    const options = { requesterAgentId: 'manager-1', accessCeiling: 'read-only' as const };
    await expect(
      executeTeamTool(
        coordinator,
        'task-1',
        'team_assign_task',
        {
          workerId: 'worker-1',
          objective: 'write',
          doneCriteria: ['done'],
          access: 'workspace-write',
        },
        options,
      ),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('read-only') });
    await expect(
      executeTeamTool(
        coordinator,
        'task-1',
        'team_assign_mission',
        {
          objective: 'write mission',
          doneCriteria: ['done'],
          steps: [
            { workerId: 'worker-1', objective: 'one', doneCriteria: ['one'], access: 'read-only' },
            {
              workerId: 'worker-2',
              objective: 'two',
              doneCriteria: ['two'],
              access: 'workspace-write',
            },
          ],
        },
        options,
      ),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('read-only') });
    expect(coordinator.assignTaskAs).not.toHaveBeenCalled();
    expect(coordinator.assignMission).not.toHaveBeenCalled();
  });

  it('allows a workspace-write Manager execution to delegate within the same ceiling', async () => {
    const coordinator = fakeCoordinator();
    await expect(
      executeTeamTool(
        coordinator,
        'task-1',
        'team_assign_task',
        {
          workerId: 'worker-1',
          objective: 'write',
          doneCriteria: ['done'],
          access: 'workspace-write',
        },
        { requesterAgentId: 'manager-1', accessCeiling: 'workspace-write' },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(coordinator.assignTaskAs).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        targetAgentId: 'worker-1',
        content: 'write',
        doneCriteria: ['done'],
        accessMode: 'workspace-write',
      },
      'manager-1',
    );
  });

  it('routes Manager tools with only the caller identity bound to the MCP registration', async () => {
    const coordinator = fakeCoordinator();
    const options = {
      requesterAgentId: 'manager-1',
      contextOwner: { type: 'team_execution' as const, id: 'parent-execution-1' },
    };
    const managerPolicy = {
      maxDirectChildren: 2,
      maxDelegationLevels: 1,
      allowManagerChildren: false,
    };

    await executeTeamTool(
      coordinator,
      'task-1',
      'team_hire_worker',
      { agentKind: 'manager', role: '実装担当', objective: '実装する', managerPolicy },
      options,
    );
    expect(coordinator.hireWorkerAs).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        role: '実装担当',
        objective: '実装する',
        contextInheritancePolicy: 'summary',
        writeCapable: false,
      },
      'manager-1',
      managerPolicy,
    );

    await executeTeamTool(
      coordinator,
      'task-1',
      'team_assign_task',
      { workerId: 'worker-1', objective: '実装する', doneCriteria: ['完了'] },
      options,
    );
    expect(coordinator.assignTaskAs).toHaveBeenCalledWith(
      {
        taskId: 'task-1',
        targetAgentId: 'worker-1',
        content: '実装する',
        doneCriteria: ['完了'],
        accessMode: 'read-only',
      },
      'manager-1',
      { type: 'team_execution', id: 'parent-execution-1' },
    );

    await executeTeamTool(
      coordinator,
      'task-1',
      'team_resume_mission',
      { missionId: 'mission-1' },
      options,
    );
    expect(coordinator.resumeMission).toHaveBeenCalledWith(
      'task-1',
      'mission-1',
      'manager-1',
      'read-only',
    );

    await executeTeamTool(
      coordinator,
      'task-1',
      'team_steer_execution',
      { executionId: 'execution-2', instruction: '修正する' },
      options,
    );
    expect(coordinator.steerExecution).toHaveBeenCalledWith(
      'task-1',
      'execution-2',
      '修正する',
      'manager-1',
      'read-only',
    );

    await executeTeamTool(
      coordinator,
      'task-1',
      'team_cancel_execution',
      { executionId: 'execution-2' },
      options,
    );
    expect(coordinator.cancelExecution).toHaveBeenCalledWith('task-1', 'execution-2', 'manager-1');

    await executeTeamTool(coordinator, 'task-1', 'team_wait_reports', {}, options);
    expect(coordinator.listWorkerReports).toHaveBeenCalledWith('task-1', 0, 'manager-1');
  });

  it('routes Worker communication with caller identity fixed outside model arguments', async () => {
    const coordinator = fakeCoordinator();
    const options = { requesterAgentId: 'worker-1' };

    expect(
      await executeTeamTool(
        coordinator,
        'task-1',
        'team_send_message',
        { targetAgentId: 'worker-2', content: 'APIの契約は確定しました' },
        options,
      ),
    ).toMatchObject({ ok: true, messageId: 'message-direct-1', seq: 3 });
    expect(coordinator.sendAgentMessageAs).toHaveBeenCalledWith(
      'task-1',
      'worker-1',
      'worker-2',
      'APIの契約は確定しました',
    );

    await executeTeamTool(coordinator, 'task-1', 'team_read_messages', { afterSeq: 2 }, options);
    expect(coordinator.listAgentMessages).toHaveBeenCalledWith('task-1', 'worker-1', 2);
  });

  it('rejects Manager identity forgery and Manager-only legacy control calls', async () => {
    const coordinator = fakeCoordinator();
    const options = { requesterAgentId: 'manager-1' };
    await expect(
      executeTeamTool(
        coordinator,
        'task-1',
        'team_assign_task',
        {
          workerId: 'worker-1',
          objective: '実装する',
          doneCriteria: [],
          requesterAgentId: 'forged-manager',
        },
        options,
      ),
    ).rejects.toThrow();
    expect(coordinator.assignTaskAs).not.toHaveBeenCalled();

    expect(
      await executeTeamTool(
        coordinator,
        'task-1',
        'team_send_to_worker',
        { workerId: 'worker-1', content: 'legacy direct call' },
        options,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await executeTeamTool(
        coordinator,
        'task-1',
        'team_stop_worker',
        { workerId: 'worker-1' },
        options,
      ),
    ).toMatchObject({ ok: false });
    expect(coordinator.sendToWorker).not.toHaveBeenCalled();
    expect(coordinator.stopWorker).not.toHaveBeenCalled();
  });

  it('rejects a forged identity/taskId field in the wire args before TeamCoordinator ever sees it', async () => {
    const coordinator = fakeCoordinator();
    await expect(
      executeTeamTool(coordinator, 'task-1', 'team_send_to_worker', {
        workerId: 'worker-1',
        content: 'hi',
        sourceAgentId: 'attacker-supplied-leader-id',
      }),
    ).rejects.toThrow();
    expect(coordinator.sendToWorker).not.toHaveBeenCalled();

    const rejected = await executeTeamTool(coordinator, 'task-1', 'team_hire_worker', {
      agentKind: 'worker',
      role: 'r',
      objective: 'o',
      taskId: 'attacker-supplied-task-id',
    });
    expect(rejected).toMatchObject({ ok: false, error: 'ZodError' });
    expect(coordinator.hireWorker).not.toHaveBeenCalled();
  });

  it('rejects malformed team_wait_reports/team_stop_worker args', async () => {
    const coordinator = fakeCoordinator();
    await expect(
      executeTeamTool(coordinator, 'task-1', 'team_wait_reports', { extra: true }),
    ).rejects.toThrow();
    await expect(executeTeamTool(coordinator, 'task-1', 'team_stop_worker', {})).rejects.toThrow();
  });
});

describe('executeTeamTool team_wait_reports long-poll', () => {
  it('returns immediately (no polling) when longPoll is not requested, matching the mock path', async () => {
    const coordinator = fakeCoordinator({ hasBusyWorkers: vi.fn(() => true) });
    const result = await executeTeamTool(coordinator, 'task-1', 'team_wait_reports', {});
    expect(result).toEqual({ ok: true, reports: [] });
    expect(coordinator.listWorkerReports).toHaveBeenCalledTimes(1);
  });

  it('returns as soon as a report arrives while long-polling', async () => {
    let calls = 0;
    const coordinator = fakeCoordinator({
      hasBusyWorkers: vi.fn(() => true),
      listWorkerReports: vi.fn(() => {
        calls += 1;
        return calls >= 3
          ? [
              {
                sourceAgentId: 'worker-1',
                seq: 1,
                content: '{"status":"succeeded"}',
                executionId: 'execution-1',
                attemptId: 'attempt-1',
              },
            ]
          : [];
      }) as never,
    });
    const result = (await executeTeamTool(
      coordinator,
      'task-1',
      'team_wait_reports',
      {},
      {
        longPoll: true,
        longPollTimeoutMs: 5_000,
        longPollIntervalMs: 5,
      },
    )) as { ok: true; reports: readonly { workerId: string }[] };
    expect(result.ok).toBe(true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]).toMatchObject({
      workerId: 'worker-1',
      executionId: 'execution-1',
      attemptId: 'attempt-1',
    });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('stops polling and returns an empty list once every Worker has settled', async () => {
    const coordinator = fakeCoordinator({ hasBusyWorkers: vi.fn(() => false) });
    const started = Date.now();
    const result = await executeTeamTool(
      coordinator,
      'task-1',
      'team_wait_reports',
      {},
      {
        longPoll: true,
        longPollTimeoutMs: 5_000,
        longPollIntervalMs: 5,
      },
    );
    expect(result).toEqual({ ok: true, reports: [] });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives up after the timeout even if Workers are still busy', async () => {
    const coordinator = fakeCoordinator({ hasBusyWorkers: vi.fn(() => true) });
    const started = Date.now();
    const result = await executeTeamTool(
      coordinator,
      'task-1',
      'team_wait_reports',
      {},
      {
        longPoll: true,
        longPollTimeoutMs: 40,
        longPollIntervalMs: 10,
      },
    );
    expect(result).toEqual({ ok: true, reports: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('advances the caller-supplied cursor past every report it returns', async () => {
    const coordinator = fakeCoordinator({
      listWorkerReports: vi.fn((_taskId: string, after: number) =>
        after === 0
          ? [
              { sourceAgentId: 'w1', seq: 1, content: 'a' },
              { sourceAgentId: 'w2', seq: 2, content: 'b' },
            ]
          : [],
      ) as never,
    });
    let cursor = 0;
    await executeTeamTool(
      coordinator,
      'task-1',
      'team_wait_reports',
      {},
      {
        waitReportsCursor: { read: () => cursor, advance: (seq) => (cursor = seq) },
      },
    );
    expect(cursor).toBe(2);
    const second = await executeTeamTool(
      coordinator,
      'task-1',
      'team_wait_reports',
      {},
      {
        waitReportsCursor: { read: () => cursor, advance: (seq) => (cursor = seq) },
      },
    );
    expect(second).toEqual({ ok: true, reports: [] });
  });
});
