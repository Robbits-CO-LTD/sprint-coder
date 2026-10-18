import { describe, expect, it, vi } from 'vitest';
import type { ModelSelection } from '@sprint-coder/contracts';
import { TEAM_DEFAULT_CONCURRENT_EXECUTIONS } from '@sprint-coder/domain';
import {
  executeTeamTool,
  LEADER_PROVIDER_TOOLS,
  MANAGER_PROVIDER_TOOLS,
  registerTeamTools,
  TEAM_ASSIGN_TASKS_TOOL,
  TEAM_WAIT_EVENTS_TOOL,
  TEAM_WAIT_REPORTS_TOOL,
  WORKER_PROVIDER_TOOLS,
} from './team-tools';
import {
  TEAM_ASSIGN_TASKS_MAX,
  TEAM_ASSIGN_TASKS_MAX_BYTES,
  TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE,
  TEAM_BRIDGE_MAX_REQUEST_BYTES,
} from '../runtime-host/team-mcp-tool-contract';
import type { ToolBroker } from './tool-broker';
import type { TeamCoordinator } from './team-coordinator';
import type { WorkspaceWriteLimits } from './workspace-write-limits';

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
    workspaceWriteLimits: null,
    ...overrides,
  } as unknown as TeamCoordinator;
}

describe('executeTeamTool routing', () => {
  it('awaits the completed direct dispatch before returning the Leader tool result', async () => {
    const delivered = await fakeCoordinator().sendToWorker({
      taskId: 'task-1',
      targetAgentId: 'worker-1',
      content: 'fixture',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendToWorker = vi.fn(async () => {
      await gate;
      return delivered;
    });
    const coordinator = fakeCoordinator({ sendToWorker });
    let returned = false;
    const result = executeTeamTool(coordinator, 'task-1', 'team_send_to_worker', {
      workerId: 'worker-1',
      content: 'fixture',
    }).then((value) => {
      returned = true;
      return value;
    });
    await vi.waitFor(() => expect(sendToWorker).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    release();
    await expect(result).resolves.toMatchObject({ ok: true, messageId: delivered.id });
  });
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

describe('executeTeamTool team_assign_tasks (issue #864)', () => {
  const item = (workerId: string, access?: 'read-only' | 'workspace-write') => ({
    workerId,
    objective: `work for ${workerId}`,
    doneCriteria: ['done'],
    ...(access === undefined ? {} : { access }),
  });

  it('passes every element to one coordinator batch and reports each element on its own', async () => {
    const assignTasks = vi.fn(async () => [
      { ok: true, submission: { executionId: 'execution-a', state: 'queued' } },
      { ok: false, error: new Error('Worker is not ready') },
    ]);
    const coordinator = fakeCoordinator({ assignTasks } as never);
    const result = (await executeTeamTool(
      coordinator,
      'task-1',
      'team_assign_tasks',
      { assignments: [item('worker-a'), item('worker-b', 'workspace-write')] },
      { contextOwner: { type: 'turn', id: 'turn-1' } },
    )) as Record<string, unknown>;
    expect(assignTasks).toHaveBeenCalledTimes(1);
    expect(assignTasks).toHaveBeenCalledWith(
      'task-1',
      [
        {
          targetAgentId: 'worker-a',
          content: 'work for worker-a',
          doneCriteria: ['done'],
          accessMode: 'read-only',
        },
        {
          targetAgentId: 'worker-b',
          content: 'work for worker-b',
          doneCriteria: ['done'],
          accessMode: 'workspace-write',
        },
      ],
      null,
      { type: 'turn', id: 'turn-1' },
    );
    expect(result).toMatchObject({
      ok: true,
      assigned: 1,
      failed: 1,
      results: [
        {
          index: 0,
          workerId: 'worker-a',
          ok: true,
          executionId: 'execution-a',
          state: 'queued',
          writeScope: 'read-only',
        },
        {
          index: 1,
          workerId: 'worker-b',
          ok: false,
          message: 'Worker is not ready',
          writeScope: 'workspace-write',
        },
      ],
    });
    // No write element was assigned, so the result carries the read-only note.
    expect(result['workspaceWriteLimit']).toBeUndefined();
  });

  it('refuses only the write elements of a read-only Manager and still assigns the rest', async () => {
    const assignTasks = vi.fn(async () => [
      { ok: true, submission: { executionId: 'execution-a', state: 'queued' } },
    ]);
    const coordinator = fakeCoordinator({ assignTasks } as never);
    const result = (await executeTeamTool(
      coordinator,
      'task-1',
      'team_assign_tasks',
      { assignments: [item('worker-w', 'workspace-write'), item('worker-r')] },
      {
        requesterAgentId: 'manager-1',
        accessCeiling: 'read-only',
        contextOwner: { type: 'team_execution', id: 'parent-1' },
      },
    )) as { results: Array<Record<string, unknown>> };
    expect(assignTasks).toHaveBeenCalledWith(
      'task-1',
      [expect.objectContaining({ targetAgentId: 'worker-r' })],
      'manager-1',
      { type: 'team_execution', id: 'parent-1' },
    );
    expect(result.results).toMatchObject([
      { index: 0, workerId: 'worker-w', ok: false, message: expect.stringContaining('read-only') },
      { index: 1, workerId: 'worker-r', ok: true, executionId: 'execution-a' },
    ]);
  });

  it('adds the write notes when a write element was assigned', async () => {
    const assignTasks = vi.fn(async () => [
      { ok: true, submission: { executionId: 'execution-a', state: 'queued' } },
    ]);
    const coordinator = fakeCoordinator({
      assignTasks,
      workspaceWriteLimits: { editExisting: false, createDirectory: false },
    } as never);
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_tasks', {
      assignments: [item('worker-w', 'workspace-write')],
    })) as Record<string, unknown>;
    expect(result['workspaceWriteLimit']).toEqual(expect.any(String));
  });

  it('maps a coordinator failure of the whole batch to an {ok:false} result', async () => {
    const coordinator = fakeCoordinator({
      assignTasks: vi.fn(async () => {
        throw new Error('Team not found');
      }),
    } as never);
    await expect(
      executeTeamTool(coordinator, 'task-1', 'team_assign_tasks', {
        assignments: [item('worker-a')],
      }),
    ).resolves.toMatchObject({ ok: false, message: 'Team not found' });
  });

  it('rejects an empty, oversized, or forged batch before the coordinator sees it', async () => {
    const assignTasks = vi.fn();
    const coordinator = fakeCoordinator({ assignTasks } as never);
    const call = (args: unknown) =>
      executeTeamTool(coordinator, 'task-1', 'team_assign_tasks', args);
    await expect(call({ assignments: [] })).rejects.toThrow();
    await expect(
      call({
        assignments: Array.from({ length: TEAM_ASSIGN_TASKS_MAX + 1 }, (_, index) =>
          item(`worker-${index}`),
        ),
      }),
    ).rejects.toThrow();
    await expect(
      call({ assignments: [{ ...item('worker-a'), requesterAgentId: 'x' }] }),
    ).rejects.toThrow();
    await expect(call({ assignments: [item('worker-a')], taskId: 'task-2' })).rejects.toThrow();
    await expect(
      call({ assignments: [{ ...item('worker-a'), doneCriteria: [] }] }),
    ).rejects.toThrow();
    expect(assignTasks).not.toHaveBeenCalled();
  });

  describe('the byte limit that keeps a batch within the CLI bridge', () => {
    /** Valid arguments whose JSON is exactly `target` bytes of UTF-8, mostly 3-byte characters. */
    const argsOfBytes = (target: number) => {
      const assignments = Array.from({ length: 19 }, (_, index) => ({
        workerId: `worker-${index}`,
        objective: 'あ'.repeat(9_180),
        doneCriteria: ['done'],
      }));
      const last = assignments.at(-1)!;
      last.objective = `${'あ'.repeat(9_000)}a`;
      const pad = target - Buffer.byteLength(JSON.stringify({ assignments }), 'utf8');
      expect(pad).toBeGreaterThanOrEqual(0);
      last.objective += 'a'.repeat(pad);
      expect(last.objective.length).toBeLessThanOrEqual(10_000);
      const args = { assignments };
      expect(Buffer.byteLength(JSON.stringify(args), 'utf8')).toBe(target);
      return args;
    };
    const batchCoordinator = () =>
      fakeCoordinator({
        assignTasks: vi.fn(async (_taskId: string, assignments: readonly unknown[]) =>
          assignments.map((_, index) => ({
            ok: true,
            submission: { executionId: `execution-${index}`, state: 'queued' },
          })),
        ),
      } as never);

    it('stays well inside the bridge buffer', () => {
      expect(TEAM_ASSIGN_TASKS_MAX_BYTES).toBeLessThanOrEqual(TEAM_BRIDGE_MAX_REQUEST_BYTES / 2);
    });

    it('accepts a batch of exactly the limit', async () => {
      const coordinator = batchCoordinator();
      const result = await executeTeamTool(
        coordinator,
        'task-1',
        'team_assign_tasks',
        argsOfBytes(TEAM_ASSIGN_TASKS_MAX_BYTES),
      );
      expect(result).toMatchObject({ ok: true, assigned: 19 });
      expect(coordinator.assignTasks).toHaveBeenCalledTimes(1);
    });

    it('refuses the whole batch one byte over the limit, saying to split it', async () => {
      const coordinator = batchCoordinator();
      const result = await executeTeamTool(
        coordinator,
        'task-1',
        'team_assign_tasks',
        argsOfBytes(TEAM_ASSIGN_TASKS_MAX_BYTES + 1),
      );
      expect(result).toEqual({
        ok: false,
        error: 'RequestTooLarge',
        code: 'request_too_large',
        message: TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE,
      });
      expect(TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE).toContain('Split');
      expect(TEAM_ASSIGN_TASKS_TOO_LARGE_MESSAGE).not.toMatch(/[0-9]/);
      expect(coordinator.assignTasks).not.toHaveBeenCalled();
    });

    it('counts 3-byte characters by their UTF-8 bytes, not their length', async () => {
      const coordinator = batchCoordinator();
      // 350,000 characters, within the per-element limits, but 1,050,000 bytes of UTF-8.
      const result = await executeTeamTool(coordinator, 'task-1', 'team_assign_tasks', {
        assignments: Array.from({ length: 50 }, (_, index) => ({
          workerId: `worker-${index}`,
          objective: '日'.repeat(7_000),
          doneCriteria: ['done'],
        })),
      });
      expect(result).toMatchObject({ ok: false, code: 'request_too_large' });
      expect(coordinator.assignTasks).not.toHaveBeenCalled();
    });

    it('counts characters by their escaped JSON form, not their length', async () => {
      const coordinator = batchCoordinator();
      // 100,000 characters, but each control character escapes to six bytes (\u0001) and each
      // quote to two, so the JSON the bridge receives is over 500,000 bytes.
      const args = {
        assignments: Array.from({ length: 50 }, (_, index) => ({
          workerId: `worker-${index}`,
          objective: '\u0001'.repeat(1_800) + '"'.repeat(200),
          doneCriteria: ['done'],
        })),
      };
      expect(Buffer.byteLength(JSON.stringify(args), 'utf8')).toBeGreaterThan(
        TEAM_ASSIGN_TASKS_MAX_BYTES,
      );
      const result = await executeTeamTool(coordinator, 'task-1', 'team_assign_tasks', args);
      expect(result).toMatchObject({ ok: false, code: 'request_too_large' });
      expect(coordinator.assignTasks).not.toHaveBeenCalled();
    });
  });

  it('accepts exactly the maximum batch, the default Team concurrency', async () => {
    expect(TEAM_ASSIGN_TASKS_MAX).toBe(TEAM_DEFAULT_CONCURRENT_EXECUTIONS);
    const assignTasks = vi.fn(async (_taskId: string, assignments: readonly unknown[]) =>
      assignments.map((_, index) => ({
        ok: true,
        submission: { executionId: `execution-${index}`, state: 'queued' },
      })),
    );
    const coordinator = fakeCoordinator({ assignTasks } as never);
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_tasks', {
      assignments: Array.from({ length: TEAM_ASSIGN_TASKS_MAX }, (_, index) =>
        item(`worker-${index}`),
      ),
    })) as { assigned: number };
    expect(result.assigned).toBe(TEAM_ASSIGN_TASKS_MAX);
  });

  it('is registered on the mock ToolBroker with the Turn as the context owner', async () => {
    const implementations = new Map<string, (input: unknown, context: unknown) => unknown>();
    const broker = {
      registerImplementation: ({
        toolId,
        execute,
      }: {
        toolId: string;
        execute: (input: unknown, context: unknown) => unknown;
      }) => implementations.set(toolId, execute),
    } as unknown as ToolBroker;
    const assignTasks = vi.fn(async () => [
      { ok: true, submission: { executionId: 'execution-a', state: 'queued' } },
    ]);
    registerTeamTools(broker, fakeCoordinator({ assignTasks } as never));
    await implementations.get(TEAM_ASSIGN_TASKS_TOOL.toolId)!(
      { assignments: [item('worker-a')] },
      { taskId: 'task-1', turnId: 'turn-1' },
    );
    expect(assignTasks).toHaveBeenCalledWith('task-1', expect.any(Array), null, {
      type: 'turn',
      id: 'turn-1',
    });
  });

  it('is offered to Leaders and Managers but not Workers, with the bounded schema', () => {
    const leaderTool = LEADER_PROVIDER_TOOLS.find(({ name }) => name === 'team_assign_tasks');
    expect(leaderTool?.inputSchema).toMatchObject({
      required: ['assignments'],
      additionalProperties: false,
      properties: {
        assignments: {
          minItems: 1,
          maxItems: TEAM_ASSIGN_TASKS_MAX,
          items: {
            required: ['workerId', 'objective', 'doneCriteria'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(MANAGER_PROVIDER_TOOLS.map(({ name }) => name)).toContain('team_assign_tasks');
    expect(WORKER_PROVIDER_TOOLS.map(({ name }) => name)).not.toContain('team_assign_tasks');
  });
});

describe('executeTeamTool workspaceWriteLimit in assignment results', () => {
  const limited: WorkspaceWriteLimits = { editExisting: false, createDirectory: false };
  const unlimited: WorkspaceWriteLimits = { editExisting: true, createDirectory: true };

  it('adds workspaceWriteLimit to a workspace-write team_assign_task result when the coordinator has a limit', async () => {
    const coordinator = fakeCoordinator({ workspaceWriteLimits: limited });
    const result = await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
      workerId: 'worker-1',
      objective: '実装する',
      doneCriteria: ['done'],
      access: 'workspace-write',
    });
    expect(result).toMatchObject({
      ok: true,
      workspaceWriteLimit: expect.stringContaining(
        '既存ファイルの編集・削除とフォルダの作成ができません',
      ),
    });
  });

  it('omits workspaceWriteLimit for a read-only team_assign_task even with a limited coordinator', async () => {
    const coordinator = fakeCoordinator({ workspaceWriteLimits: limited });
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
      workerId: 'worker-1',
      objective: '調べる',
      doneCriteria: ['done'],
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('workspaceWriteLimit');
  });

  it('omits workspaceWriteLimit for a workspace-write team_assign_task when the coordinator has no limit', async () => {
    for (const workspaceWriteLimits of [null, unlimited]) {
      const coordinator = fakeCoordinator({ workspaceWriteLimits });
      const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
        workerId: 'worker-1',
        objective: '実装する',
        doneCriteria: ['done'],
        access: 'workspace-write',
      })) as Record<string, unknown>;
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('workspaceWriteLimit');
    }
  });

  it('adds workspaceWriteLimit to team_assign_mission when any step is workspace-write', async () => {
    const coordinator = fakeCoordinator({ workspaceWriteLimits: limited });
    const result = await executeTeamTool(coordinator, 'task-1', 'team_assign_mission', {
      objective: 'mission',
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
    });
    expect(result).toMatchObject({
      ok: true,
      workspaceWriteLimit: expect.stringContaining(
        '既存ファイルの編集・削除とフォルダの作成ができません',
      ),
    });
  });

  it('omits workspaceWriteLimit from team_assign_mission when every step is read-only', async () => {
    const coordinator = fakeCoordinator({ workspaceWriteLimits: limited });
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_mission', {
      objective: 'mission',
      doneCriteria: ['done'],
      steps: [
        { workerId: 'worker-1', objective: 'one', doneCriteria: ['one'], access: 'read-only' },
        { workerId: 'worker-2', objective: 'two', doneCriteria: ['two'], access: 'read-only' },
      ],
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('workspaceWriteLimit');
  });

  it('omits workspaceWriteLimit from a workspace-write team_assign_mission when the coordinator has no limit', async () => {
    const coordinator = fakeCoordinator({ workspaceWriteLimits: null });
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_mission', {
      objective: 'mission',
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
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('workspaceWriteLimit');
  });
});

describe('executeTeamTool writeScope/writeScopeNote in assignment results (issue #551)', () => {
  it('reports a read-only team_assign_task with the read-only note', async () => {
    const coordinator = fakeCoordinator();
    const result = await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
      workerId: 'worker-1',
      objective: '調べる',
      doneCriteria: ['done'],
      access: 'read-only',
    });
    expect(result).toMatchObject({
      ok: true,
      writeScope: 'read-only',
      writeScopeNote: expect.stringContaining('読み取り専用'),
    });
  });

  it('adds the ask/auto/full confirmation wording to a workspace-write team_assign_task', async () => {
    for (const [preset, expected] of [
      ['ask', '承認カード'],
      ['auto', '作成・編集は自動で許可'],
      ['full', '確認なしで反映'],
    ] as const) {
      const coordinator = fakeCoordinator({ taskAccessPreset: vi.fn(() => preset) as never });
      const result = await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
        workerId: 'worker-1',
        objective: '実装する',
        doneCriteria: ['done'],
        access: 'workspace-write',
      });
      expect(result).toMatchObject({
        ok: true,
        writeScope: 'workspace-write',
        writeScopeNote: expect.stringContaining(expected),
      });
    }
  });

  it('omits the confirmation wording for a workspace-write team_assign_task when the preset is not readable', async () => {
    const coordinator = fakeCoordinator();
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_task', {
      workerId: 'worker-1',
      objective: '実装する',
      doneCriteria: ['done'],
      access: 'workspace-write',
    })) as { writeScopeNote: string };
    expect(result.writeScopeNote).toContain('隔離worktree');
    expect(result.writeScopeNote).not.toMatch(/承認カード|自動で許可|自動レビュー|確認なしで反映/);
  });

  it('reports a per-step writeScope and a workspace-write note for team_assign_mission', async () => {
    const coordinator = fakeCoordinator({
      taskAccessPreset: vi.fn(() => 'ask') as never,
      assignMission: vi.fn(
        async () =>
          ({
            id: 'mission-1',
            state: 'running',
            currentStepOrdinal: 0,
            steps: [
              { ordinal: 0, executionId: 'execution-step-0' },
              { ordinal: 1, executionId: 'execution-step-1' },
            ],
          }) as never,
      ),
    });
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_mission', {
      objective: 'mission',
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
    })) as { executions: { ordinal: number; writeScope: string }[]; writeScopeNote: string };
    expect(result.executions).toEqual([
      { ordinal: 0, executionId: 'execution-step-0', writeScope: 'read-only' },
      { ordinal: 1, executionId: 'execution-step-1', writeScope: 'workspace-write' },
    ]);
    expect(result.writeScopeNote).toContain('承認カード');
  });

  it('reports the read-only note for team_assign_mission when every step is read-only', async () => {
    const coordinator = fakeCoordinator();
    const result = (await executeTeamTool(coordinator, 'task-1', 'team_assign_mission', {
      objective: 'mission',
      doneCriteria: ['done'],
      steps: [
        { workerId: 'worker-1', objective: 'one', doneCriteria: ['one'], access: 'read-only' },
        { workerId: 'worker-2', objective: 'two', doneCriteria: ['two'], access: 'read-only' },
      ],
    })) as { writeScopeNote: string };
    expect(result.writeScopeNote).toContain('読み取り専用');
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

describe('registerTeamTools managed wait path (Issue #753)', () => {
  const context = { taskId: 'task-1', turnId: 'turn-1', workspaceId: null, policyEpoch: 0 };
  const control = (signal?: AbortSignal) => ({
    callId: 'call-1',
    ...(signal === undefined ? {} : { signal }),
  });
  const report = (seq: number) => ({
    sourceAgentId: 'worker-1',
    seq,
    content: '{"status":"succeeded"}',
    executionId: 'execution-1',
    attemptId: 'attempt-1',
  });

  function captureImplementations(
    coordinator: TeamCoordinator,
    modelSelectionRequired?: (context: unknown) => boolean,
  ) {
    const implementations = new Map<
      string,
      (input: unknown, context: never, control: never) => unknown
    >();
    const broker = {
      registerImplementation: (implementation: {
        toolId: string;
        execute: (input: unknown, context: never, control: never) => unknown;
      }) => implementations.set(implementation.toolId, implementation.execute),
    } as unknown as ToolBroker;
    registerTeamTools(broker, coordinator, {
      ...(modelSelectionRequired === undefined ? {} : { modelSelectionRequired }),
    });
    return (toolId: string) => implementations.get(toolId)!;
  }

  it('keeps waiting for the real deadline while a Worker is busy, instead of returning after ~1s', async () => {
    vi.useFakeTimers();
    try {
      let reportReady = false;
      const coordinator = fakeCoordinator({
        hasBusyWorkers: vi.fn(() => !reportReady),
        listWorkerReports: vi.fn(() =>
          reportReady
            ? [
                {
                  sourceAgentId: 'worker-1',
                  seq: 4,
                  content: '{"status":"succeeded"}',
                  executionId: 'execution-1',
                  attemptId: 'attempt-1',
                },
              ]
            : [],
        ) as never,
      });
      const implementation = captureImplementations(coordinator, () => true);
      const waitReports = implementation(TEAM_WAIT_REPORTS_TOOL.toolId);
      let settled = false;
      const pending = Promise.resolve(waitReports({}, context as never, control() as never)).then(
        (value) => {
          settled = true;
          return value;
        },
      );
      await vi.advanceTimersByTimeAsync(40_000);
      expect(settled).toBe(false);
      reportReady = true;
      await vi.advanceTimersByTimeAsync(600);
      expect(await pending).toEqual({
        ok: true,
        reports: [
          {
            workerId: 'worker-1',
            seq: 4,
            content: '{"status":"succeeded"}',
            executionId: 'execution-1',
            attemptId: 'attempt-1',
          },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns empty only at the 60s deadline for a busy Worker', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = fakeCoordinator({ hasBusyWorkers: vi.fn(() => true) });
      const waitEvents = captureImplementations(
        coordinator,
        () => true,
      )(TEAM_WAIT_EVENTS_TOOL.toolId);
      let settled = false;
      const pending = Promise.resolve(waitEvents({}, context as never, control() as never)).then(
        (value) => {
          settled = true;
          return value;
        },
      );
      await vi.advanceTimersByTimeAsync(59_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toEqual({ ok: true, reports: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the synchronous replay semantics for the mock fixture (and when the Turn is not classified)', async () => {
    const coordinator = fakeCoordinator({ hasBusyWorkers: vi.fn(() => true) });
    for (const classify of [() => false, undefined]) {
      const waitReports = captureImplementations(
        coordinator,
        classify,
      )(TEAM_WAIT_REPORTS_TOOL.toolId);
      expect(await waitReports({}, context as never, control() as never)).toEqual({
        ok: true,
        reports: [],
      });
    }
  });

  it('stops waiting immediately when the call is aborted, without waiting for the 60s deadline', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = fakeCoordinator({ hasBusyWorkers: vi.fn(() => true) });
      const waitReports = captureImplementations(
        coordinator,
        () => true,
      )(TEAM_WAIT_REPORTS_TOOL.toolId);
      const abort = new AbortController();
      let settled = false;
      const pending = Promise.resolve(
        waitReports({}, context as never, control(abort.signal) as never),
      ).finally(() => {
        settled = true;
      });
      const outcome = pending.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await outcome).toBe(abort.signal.reason);
      // No timer is left behind to keep the process (or the sleep) alive after the abort.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers a report once to concurrent waits sharing one Turn cursor, and not again afterwards', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      let drained = false;
      const coordinator = fakeCoordinator({
        hasBusyWorkers: vi.fn(() => !ready && !drained),
        listWorkerReports: vi.fn((_task: string, after: number) =>
          ready ? [report(1), report(2)].filter((item) => item.seq > after) : [],
        ) as never,
      });
      const waitReports = captureImplementations(
        coordinator,
        () => true,
      )(TEAM_WAIT_REPORTS_TOOL.toolId);
      const first = Promise.resolve(waitReports({}, context as never, control() as never));
      const second = Promise.resolve(waitReports({}, context as never, control() as never));
      await vi.advanceTimersByTimeAsync(5_000);
      ready = true;
      await vi.advanceTimersByTimeAsync(600);
      const results = (await Promise.all([first, second])) as { reports: { seq: number }[] }[];
      expect(results.flatMap((result) => result.reports.map((item) => item.seq))).toEqual([1, 2]);
      // The cursor moved forward: a later wait on the same Turn re-delivers nothing.
      ready = false;
      drained = true;
      const third = (await waitReports({}, context as never, control() as never)) as {
        reports: unknown[];
      };
      expect(third.reports).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
