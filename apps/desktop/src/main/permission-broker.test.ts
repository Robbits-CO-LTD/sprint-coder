import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  expandAccessPreset,
  type CapabilityCeiling,
  type PermissionEvaluation,
  type PermissionRequest,
  type Capability,
} from '@sprint-coder/domain';
import {
  PermissionBroker,
  protectedWorkspaceRootDenialReason,
  protectedWorkspaceRootMessage,
} from './permission-broker';
import type { PermissionPolicyRecord } from './persistence';
import {
  createPathGuard,
  workspacePermissionResourceFromGuard,
  type PathGuard,
} from './path-guard';

const NOW = '2026-07-22T12:00:00.000Z';
const EXECUTION_DIGEST = 'b'.repeat(64);
let testRoot: string;
let selectedWorkspacePath: string;
let pathGuard: PathGuard;
let request: PermissionRequest & {
  resource: Extract<PermissionRequest['resource'], { kind: 'workspace-path' }>;
};
let ceiling: CapabilityCeiling;

beforeAll(async () => {
  const fixtureBase = process.platform === 'win32' ? process.cwd() : tmpdir();
  testRoot = await mkdtemp(join(fixtureBase, '.sprint-coder-main-permission-'));
  selectedWorkspacePath = join(testRoot, 'workspace');
  await mkdir(join(selectedWorkspacePath, 'src'), { recursive: true });
  await writeFile(join(selectedWorkspacePath, 'src', 'app.ts'), 'safe');
  pathGuard = await createPathGuard({
    workspacePath: selectedWorkspacePath,
    targetPath: 'src/app.ts',
    operation: 'read',
  });
  selectedWorkspacePath = pathGuard.workspacePath;
  request = {
    taskId: 'task-1',
    subjectId: 'leader',
    capability: 'workspace.read',
    resource: workspacePermissionResourceFromGuard(pathGuard),
    operation: 'read',
    providerEgress: 'none',
    sandboxProfile: 'read-only',
    executionSpecDigest: EXECUTION_DIGEST,
    reviewerInputDigest: 'c'.repeat(64),
    risk: 'high',
  };
  ceiling = {
    entries: [
      {
        capability: 'workspace.read',
        resourceSet: { kind: 'workspace', workspaceId: request.resource.workspaceId },
        operations: ['read'],
        expiresAt: '2026-07-22T13:00:00.000Z',
        providerEgress: ['none'],
        sandboxProfiles: ['read-only'],
      },
    ],
    maxWorkerDepth: 0,
    maxConcurrentWorkers: 0,
  };
});

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

function fixture(
  notify?: (taskId: string, epoch: number) => void | Promise<void>,
  revokedCapabilities: Capability[] = [],
) {
  const events: string[] = [];
  let policy: PermissionPolicyRecord = {
    preset: 'auto',
    policyEpoch: 2,
    expandedPolicy: expandAccessPreset('auto'),
    revokedCapabilities,
  };
  const audits: PermissionEvaluation[] = [];
  const pending: { id: string; taskId: string; policyEpoch: number }[] = [];
  const oneTimeTokens = new Set<string>();
  const persistence = {
    getPermissionPolicy: () => policy,
    setAccessPreset: (
      _taskId: string,
      preset: 'ask' | 'auto' | 'full',
      expectedPolicyEpoch?: number,
    ) => {
      if (expectedPolicyEpoch !== undefined && expectedPolicyEpoch !== policy.policyEpoch)
        throw new Error('Permission policy epoch changed');
      events.push('committed');
      policy = {
        preset,
        policyEpoch: policy.policyEpoch + 1,
        expandedPolicy: expandAccessPreset(preset),
        revokedCapabilities: policy.revokedCapabilities,
      };
      pending.push({
        id: `epoch-${policy.policyEpoch}`,
        taskId: 'task-1',
        policyEpoch: policy.policyEpoch,
      });
      return policy;
    },
    listPermissionGrants: () => [],
    revokePermissionCapability: () => 0,
    getEffectiveWorkspaceSet: () => ({
      source: 'task' as const,
      projectId: null,
      primaryRootId: 'legacy-primary',
      roots: [
        {
          rootId: 'legacy-primary',
          path: selectedWorkspacePath,
          label: 'Workspace',
          role: 'primary' as const,
          status: 'available' as const,
        },
      ],
      digest: 'a'.repeat(64),
    }),
    readTurnWorkspaceSetForTask: (taskId: string, turnId: string) => {
      if (taskId !== 'task-1' || turnId !== 'turn-1') throw new Error('Turn not found for Task');
      return {
        source: 'project' as const,
        projectId: 'project-1',
        primaryRootId: 'root-a',
        roots: [
          {
            rootId: 'root-a',
            path: selectedWorkspacePath,
            label: 'Workspace at Turn start',
            role: 'primary' as const,
            status: 'available' as const,
          },
        ],
        digest: 'd'.repeat(64),
      };
    },
    registerPermissionOneTimeToken: (_taskId: string, token: string) => {
      oneTimeTokens.add(token);
    },
    consumePermissionOneTimeToken: (_taskId: string, token: string) => oneTimeTokens.delete(token),
    listPendingPermissionPolicyEpochs: () => [...pending],
    markPermissionPolicyEpochDelivered: (id: string) => {
      const index = pending.findIndex((item) => item.id === id);
      if (index >= 0) pending.splice(index, 1);
    },
    recordPermissionAudit: (
      _taskId: string,
      _request: PermissionRequest,
      evaluation: PermissionEvaluation,
    ) => audits.push(evaluation),
    commitPermissionEvaluation: (
      _taskId: string,
      _request: PermissionRequest,
      evaluation: PermissionEvaluation,
    ) => {
      if (evaluation.permit?.oneTimeToken !== undefined)
        oneTimeTokens.add(evaluation.permit.oneTimeToken);
      audits.push(evaluation);
      return undefined;
    },
  };
  const broker = new PermissionBroker(persistence, {
    policyEpochChanged: async (taskId, epoch) => {
      await notify?.(taskId, epoch);
      events.push('subjects-stopped');
    },
  });
  return { broker, events, audits, pending };
}

describe('Main PermissionBroker', () => {
  it('loads expanded policy, records the audit, and returns an execution-bound permit', () => {
    const { broker, audits } = fixture();
    const result = broker.evaluate({
      taskId: 'task-1',
      request,
      now: NOW,
      basePolicy: {
        managedDeny: [],
        projectDeny: [],
        parentCeiling: ceiling,
        modeCeiling: ceiling,
        sandbox: { feasible: true, profile: 'read-only' },
        allowRules: [
          {
            capability: 'workspace.read',
            resourceSet: { kind: 'path-exact', canonicalPath: request.resource.canonicalPath },
            operations: ['read'],
          },
        ],
      },
      pathGuard,
    });

    expect(result).toMatchObject({
      decision: 'allow',
      reason: 'narrow_allow',
      permit: { executionSpecDigest: EXECUTION_DIGEST, policyEpoch: 2 },
    });
    expect(audits).toEqual([result]);
    expect(
      broker.revalidate({
        taskId: 'task-1',
        permit: result.permit!,
        request,
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
          allowRules: [
            {
              capability: 'workspace.read',
              resourceSet: { kind: 'path-exact', canonicalPath: request.resource.canonicalPath },
              operations: ['read'],
            },
          ],
        },
        pathGuard,
      }),
    ).toEqual({ valid: true });
    expect(audits.at(-1)?.evaluationTrace.at(-1)).toBe('execution-revalidation');
  });

  it('commits a policy epoch before notifying child/background coordinators', async () => {
    const { broker, events } = fixture();

    await broker.setAccessPreset('task-1', 'ask', 2);

    expect(events).toEqual(['committed', 'subjects-stopped']);
  });

  it('rejects a guard whose rootId is not in the effective Workspace set', async () => {
    const unknownRootGuard = await createPathGuard({
      rootId: 'root-b',
      workspacePath: selectedWorkspacePath,
      targetPath: 'src/app.ts',
      operation: 'read',
    });
    const unknownRootRequest = {
      ...request,
      resource: workspacePermissionResourceFromGuard(unknownRootGuard),
    };
    const { broker } = fixture();
    expect(() =>
      broker.evaluate({
        taskId: 'task-1',
        request: unknownRootRequest,
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
        pathGuard: unknownRootGuard,
      }),
    ).toThrow('effective Workspace root');
  });

  it('authorizes a guard against a sealed Team Worker isolation Workspace', async () => {
    const workerWorkspacePath = join(testRoot, 'AppData', 'team-worker');
    await mkdir(join(workerWorkspacePath, 'src'), { recursive: true });
    await writeFile(join(workerWorkspacePath, 'src', 'app.ts'), 'safe');
    const workerGuard = await createPathGuard({
      rootId: 'worker-root',
      workspacePath: workerWorkspacePath,
      targetPath: 'src/app.ts',
      operation: 'read',
    });
    const protectedResource = workspacePermissionResourceFromGuard(workerGuard);
    expect(protectedResource.classification).toBe('app-private');
    const isolatedResource = workspacePermissionResourceFromGuard(
      workerGuard,
      'sealed-team-isolation',
    );
    await mkdir(join(workerWorkspacePath, '.ssh'), { recursive: true });
    await writeFile(join(workerWorkspacePath, '.ssh', 'id_rsa'), 'not-a-real-key');
    const credentialGuard = await createPathGuard({
      rootId: 'worker-root',
      workspacePath: workerWorkspacePath,
      targetPath: '.ssh/id_rsa',
      operation: 'read',
    });
    expect(
      workspacePermissionResourceFromGuard(credentialGuard, 'sealed-team-isolation').classification,
    ).toBe('credential');
    const workerRequest: PermissionRequest & {
      resource: Extract<PermissionRequest['resource'], { kind: 'workspace-path' }>;
    } = {
      ...request,
      resource: isolatedResource,
    };
    const workerCeiling: CapabilityCeiling = {
      entries: [
        {
          capability: 'workspace.read',
          resourceSet: { kind: 'workspace', workspaceId: workerRequest.resource.workspaceId },
          operations: ['read'],
          expiresAt: '2026-07-22T13:00:00.000Z',
          providerEgress: ['none'],
          sandboxProfiles: ['read-only'],
        },
      ],
      maxWorkerDepth: 0,
      maxConcurrentWorkers: 0,
    };
    const workspace = {
      source: 'task' as const,
      projectId: null,
      primaryRootId: 'worker-root',
      roots: [
        {
          rootId: 'worker-root',
          path: workerGuard.workspacePath,
          label: 'Worker isolation',
          role: 'primary' as const,
          status: 'available' as const,
        },
      ],
      digest: 'e'.repeat(64),
    };
    const { broker } = fixture();
    const basePolicy = {
      managedDeny: [],
      projectDeny: [],
      parentCeiling: workerCeiling,
      modeCeiling: workerCeiling,
      sandbox: { feasible: true as const, profile: 'read-only' as const },
      allowRules: [
        {
          capability: 'workspace.read' as const,
          resourceSet: {
            kind: 'path-exact' as const,
            canonicalPath: workerRequest.resource.canonicalPath,
          },
          operations: ['read' as const],
        },
      ],
    };

    expect(() =>
      broker.evaluate({
        taskId: 'task-1',
        turnId: 'turn-1',
        request: workerRequest,
        now: NOW,
        basePolicy,
        pathGuard: workerGuard,
        workspace,
      }),
    ).toThrow('Permission path facts are not derived');

    expect(
      broker.evaluate({
        taskId: 'task-1',
        turnId: 'turn-1',
        request: workerRequest,
        now: NOW,
        basePolicy,
        pathGuard: workerGuard,
        workspace,
        workspaceAuthority: 'sealed-team-isolation',
      }),
    ).toMatchObject({ decision: 'allow' });
  });

  // Issue #830: the refusal only said "Unclassified or protected paths must be treated as high risk".
  it('explains a refusal in a Workspace that sits in a protected location', async () => {
    const appDataWorkspace = join(testRoot, 'AppData', 'Local', 'Temp', 'my-app');
    await mkdir(join(appDataWorkspace, 'src'), { recursive: true });
    await writeFile(join(appDataWorkspace, 'src', 'app.ts'), 'safe');
    const guard = await createPathGuard({
      rootId: 'root-a',
      workspacePath: appDataWorkspace,
      targetPath: 'src/app.ts',
      operation: 'read',
    });
    const { broker } = fixture();
    expect(() =>
      broker.evaluate({
        taskId: 'task-1',
        turnId: 'turn-1',
        request: { ...request, resource: workspacePermissionResourceFromGuard(guard), risk: 'low' },
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
        pathGuard: guard,
        workspace: {
          source: 'project',
          projectId: 'project-1',
          primaryRootId: 'root-a',
          roots: [
            {
              rootId: 'root-a',
              path: guard.workspacePath,
              label: 'my-app',
              role: 'primary',
              status: 'available',
            },
          ],
          digest: 'f'.repeat(64),
        },
      }),
    ).toThrow(
      'このWorkspaceは保護された場所（アプリの内部データの場所（AppData など））にあるため、AIはここでファイルの読み書きができません（コマンドの実行はほかの場所と同じ扱いで、承認の要否は権限の設定に従います）。',
    );
  });

  // Issue #836: a high-risk request passes the trusted-facts check and is refused by the policy;
  // the decision stays a deny, and the protected-root reason is what the call is told.
  it('keeps a high-risk write in a protected Workspace denied and names the protected root', async () => {
    const appDataWorkspace = join(testRoot, 'AppData', 'Local', 'Temp', 'high-risk-app');
    await mkdir(appDataWorkspace, { recursive: true });
    const guard = await createPathGuard({
      rootId: 'root-a',
      workspacePath: appDataWorkspace,
      targetPath: 'fresh.txt',
      operation: 'write',
    });
    const writeCeiling: CapabilityCeiling = {
      entries: [
        {
          capability: 'workspace.write',
          resourceSet: { kind: 'all' },
          operations: ['write'],
          expiresAt: '2026-07-22T13:00:00.000Z',
          providerEgress: ['none'],
          sandboxProfiles: ['workspace-write'],
        },
      ],
      maxWorkerDepth: 0,
      maxConcurrentWorkers: 0,
    };
    const { broker } = fixture();
    expect(
      broker.preview({
        taskId: 'task-1',
        turnId: 'turn-1',
        request: {
          ...request,
          capability: 'workspace.write',
          operation: 'write',
          sandboxProfile: 'workspace-write',
          resource: workspacePermissionResourceFromGuard(guard),
          risk: 'high',
        },
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: writeCeiling,
          modeCeiling: writeCeiling,
          sandbox: { feasible: true, profile: 'workspace-write' },
        },
        pathGuard: guard,
        workspace: {
          source: 'project',
          projectId: 'project-1',
          primaryRootId: 'root-a',
          roots: [
            {
              rootId: 'root-a',
              path: guard.workspacePath,
              label: 'high-risk-app',
              role: 'primary',
              status: 'available',
            },
          ],
          digest: 'f'.repeat(64),
        },
      }),
    ).toMatchObject({ decision: 'deny', reason: 'immutable_protected_resource' });
    expect(protectedWorkspaceRootDenialReason(guard)).toBe(
      'このWorkspaceは保護された場所（アプリの内部データの場所（AppData など））にあるため、AIはここでファイルの読み書きができません（コマンドの実行はほかの場所と同じ扱いで、承認の要否は権限の設定に従います）。ドキュメントなど通常のフォルダへ移動してから、Projectのフォルダに設定し直してください。',
    );
    expect(protectedWorkspaceRootDenialReason(pathGuard)).toBeUndefined();
    expect(protectedWorkspaceRootDenialReason(undefined)).toBeUndefined();
  });

  // Issue #838: a Workspace protected only by the name of a protected folder that could not be
  // located is told so, instead of being told it is in that folder.
  it('says when the protected folder itself could not be located', () => {
    expect(protectedWorkspaceRootMessage('credential', true)).toBe(
      'このWorkspaceは保護された場所（認証情報を置くフォルダ）にある可能性があるため（保護フォルダの実際の場所を特定できず、同じ名前のフォルダを保護しています）、AIはここでファイルの読み書きができません（コマンドの実行はほかの場所と同じ扱いで、承認の要否は権限の設定に従います）。ドキュメントなど通常のフォルダへ移動してから、Projectのフォルダに設定し直してください。',
    );
    expect(protectedWorkspaceRootMessage('credential')).toContain(
      '保護された場所（認証情報を置くフォルダ）にあるため、',
    );
  });

  it('authorizes a command guard against its sealed Turn roots', async () => {
    const sealedGuard = await createPathGuard({
      rootId: 'root-a',
      workspacePath: selectedWorkspacePath,
      targetPath: '.',
      operation: 'read',
    });
    const sealedRequest: PermissionRequest = {
      ...request,
      capability: 'shell.execute',
      operation: 'execute',
      resource: workspacePermissionResourceFromGuard(sealedGuard),
    };
    const { broker } = fixture();

    expect(() =>
      broker.previewExecutionSpec({
        taskId: 'task-1',
        turnId: 'turn-1',
        request: sealedRequest,
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
        pathGuard: sealedGuard,
      }),
    ).not.toThrow();
  });

  it('rejects a Turn snapshot that belongs to another Task', async () => {
    const sealedGuard = await createPathGuard({
      rootId: 'root-a',
      workspacePath: selectedWorkspacePath,
      targetPath: '.',
      operation: 'read',
    });
    const sealedRequest: PermissionRequest = {
      ...request,
      capability: 'shell.execute',
      operation: 'execute',
      resource: workspacePermissionResourceFromGuard(sealedGuard),
    };
    const { broker } = fixture();

    expect(() =>
      broker.previewExecutionSpec({
        taskId: 'task-other',
        turnId: 'turn-1',
        request: { ...sealedRequest, taskId: 'task-other' },
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
        pathGuard: sealedGuard,
      }),
    ).toThrow('Turn not found for Task');
  });

  it('rejects cross-Task requests before policy lookup or audit authority is issued', () => {
    const { broker, audits } = fixture();
    expect(() =>
      broker.evaluate({
        taskId: 'task-a',
        request: { ...request, taskId: 'task-b' },
        now: NOW,
        pathGuard,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
      }),
    ).toThrow('Permission Task binding mismatch');
    expect(audits).toEqual([]);
  });

  it('rejects caller-fabricated Workspace path facts that do not match PathGuard', () => {
    const { broker, audits } = fixture();
    expect(() =>
      broker.evaluate({
        taskId: 'task-1',
        request: {
          ...request,
          resource: { ...request.resource, canonicalPath: '/workspace/../outside/secret' },
        },
        now: NOW,
        pathGuard,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: ceiling,
          modeCeiling: ceiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
      }),
    ).toThrow('not derived from the supplied guard');
    expect(audits).toEqual([]);
  });

  it('makes a persisted capability revocation stronger than preset Auto allow', () => {
    const { broker } = fixture(undefined, ['workspace.read']);
    const result = broker.evaluate({
      taskId: 'task-1',
      request,
      now: NOW,
      pathGuard,
      basePolicy: {
        managedDeny: [],
        projectDeny: [],
        parentCeiling: ceiling,
        modeCeiling: ceiling,
        sandbox: { feasible: true, profile: 'read-only' },
      },
    });

    expect(result).toMatchObject({ decision: 'deny', reason: 'capability_revoked' });
  });

  it.each([
    ['computer.observe', 'observe'],
    ['computer.control', 'control'],
  ] as const)('maps a revoked %s capability to its exact operation', (capability, operation) => {
    const { broker } = fixture(undefined, [capability]);
    const computerRequest: PermissionRequest = {
      taskId: 'task-1',
      subjectId: 'computer-use:session-1',
      capability,
      resource: {
        kind: 'computer-session',
        platform: 'darwin',
        appIdentityDigest: 'a'.repeat(64),
        windowIdentityDigest: 'b'.repeat(64),
        sessionId: 'session-1',
        taskId: 'task-1',
      },
      operation,
      providerEgress: 'none',
      sandboxProfile: 'read-only',
      executionSpecDigest: EXECUTION_DIGEST,
      reviewerInputDigest: 'c'.repeat(64),
      risk: capability === 'computer.control' ? 'high' : 'low',
    };
    const computerCeiling: CapabilityCeiling = {
      entries: [
        {
          capability,
          resourceSet: { kind: 'all' },
          operations: [operation],
          expiresAt: '2026-07-22T13:00:00.000Z',
          providerEgress: ['none'],
          sandboxProfiles: ['read-only'],
        },
      ],
      maxWorkerDepth: 0,
      maxConcurrentWorkers: 0,
    };
    const result = broker.preview({
      taskId: 'task-1',
      request: computerRequest,
      now: NOW,
      basePolicy: {
        managedDeny: [],
        projectDeny: [],
        parentCeiling: computerCeiling,
        modeCeiling: computerCeiling,
        sandbox: { feasible: true, profile: 'read-only' },
        allowRules: [
          {
            capability,
            resourceSet: { kind: 'all' },
            operations: [operation],
          },
        ],
      },
    });

    expect(result).toMatchObject({ decision: 'deny', reason: 'capability_revoked' });
  });

  it.each([
    ['project.memory.write', 'project-memory:project-1'],
    ['skill.draft.write', 'skill-draft:task-1'],
  ] as const)(
    'refuses a revoked %s before anyone is asked about it (Issue #546)',
    (capability, target) => {
      const { broker } = fixture(undefined, [capability]);
      const perCallRequest: PermissionRequest = {
        taskId: 'task-1',
        subjectId: `tool:${capability}`,
        capability,
        resource: { kind: 'external', target },
        operation: 'write',
        providerEgress: 'none',
        sandboxProfile: 'read-only',
        executionSpecDigest: EXECUTION_DIGEST,
        reviewerInputDigest: 'c'.repeat(64),
        risk: 'medium',
      };
      const perCallCeiling: CapabilityCeiling = {
        entries: [
          {
            capability,
            resourceSet: { kind: 'external-exact', target },
            operations: ['write'],
            expiresAt: '2026-07-22T13:00:00.000Z',
            providerEgress: ['none'],
            sandboxProfiles: ['read-only'],
          },
        ],
        maxWorkerDepth: 0,
        maxConcurrentWorkers: 0,
      };
      const result = broker.preview({
        taskId: 'task-1',
        request: perCallRequest,
        now: NOW,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: perCallCeiling,
          modeCeiling: perCallCeiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
      });

      expect(result).toMatchObject({ decision: 'deny', reason: 'capability_revoked' });
    },
  );

  it('keeps a committed permission change pending until command cleanup is confirmed', async () => {
    let confirm = (): void => undefined;
    const cleanup = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const { broker, pending, events } = fixture(() => cleanup);
    let returned = false;
    const change = broker.setAccessPreset('task-1', 'ask', 2).then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(broker.getPolicy('task-1')).toMatchObject({ preset: 'ask', policyEpoch: 3 });
    expect(pending).toHaveLength(1);
    expect(events).toEqual(['committed']);
    expect(returned).toBe(false);
    confirm();
    await change;
    expect(pending).toHaveLength(0);
    expect(events).toEqual(['committed', 'subjects-stopped']);
  });

  it('drains an epoch committed while a previous cleanup is still running', async () => {
    let confirmFirst = (): void => undefined;
    let confirmSecond = (): void => undefined;
    const firstCleanup = new Promise<void>((resolve) => {
      confirmFirst = resolve;
    });
    const secondCleanup = new Promise<void>((resolve) => {
      confirmSecond = resolve;
    });
    const notify = vi
      .fn()
      .mockImplementationOnce(() => firstCleanup)
      .mockImplementationOnce(() => secondCleanup);
    const { broker, pending } = fixture(notify);
    const first = broker.setAccessPreset('task-1', 'ask', 2);
    let secondReturned = false;
    const second = broker.setAccessPreset('task-1', 'auto', 3).then(() => {
      secondReturned = true;
    });
    expect(pending).toHaveLength(2);
    confirmFirst();
    await first;
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    expect(secondReturned).toBe(false);
    expect(pending).toHaveLength(1);
    confirmSecond();
    await second;
    expect(pending).toHaveLength(0);
  });

  it('delivers other Tasks after one Task fails and scopes retries to the caller', async () => {
    const notify = vi.fn(async (taskId: string) => {
      if (taskId === 'failed-task') throw new Error('unconfirmed');
    });
    const { broker, pending } = fixture(notify);
    pending.push(
      { id: 'failed', taskId: 'failed-task', policyEpoch: 1 },
      { id: 'good', taskId: 'good-task', policyEpoch: 2 },
    );
    await expect(broker.drainPolicyEpochOutbox()).rejects.toThrow('Permission cleanup incomplete');
    expect(pending.map((entry) => entry.id)).toEqual(['failed']);
    expect(notify).toHaveBeenCalledWith('good-task', 2);
    notify.mockClear();
    await expect(broker.drainPolicyEpochOutbox('good-task')).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it('coalesces old pending rows at the current policy epoch', async () => {
    const notify = vi.fn();
    const { broker, pending } = fixture(notify);
    pending.push({ id: 'old', taskId: 'task-1', policyEpoch: 1 });
    await broker.setAccessPreset('task-1', 'ask', 2);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('task-1', 3);
    expect(pending).toHaveLength(0);
  });

  it('keeps an epoch notification durable when delivery fails and retries it later', async () => {
    let fail = true;
    const { broker, pending } = fixture(() => {
      if (fail) throw new Error('coordinator unavailable');
    });

    await expect(broker.setAccessPreset('task-1', 'full', 2)).resolves.toMatchObject({
      preset: 'full',
    });
    expect(pending).toHaveLength(1);
    fail = false;
    await broker.drainPolicyEpochOutbox();
    expect(pending).toHaveLength(0);
  });

  it('rejects raw shell requests and authorizes every parsed segment through the broker', () => {
    const { broker, audits } = fixture();
    const shellRequest = {
      ...request,
      capability: 'shell.execute',
      operation: 'execute',
    } as const;
    const shellCeiling: CapabilityCeiling = {
      ...ceiling,
      entries: [
        ...ceiling.entries,
        {
          capability: 'shell.execute',
          resourceSet: { kind: 'workspace', workspaceId: request.resource.workspaceId },
          operations: ['execute'],
          expiresAt: '2026-07-22T13:00:00.000Z',
          providerEgress: ['none'],
          sandboxProfiles: ['read-only'],
        },
      ],
    };
    expect(() =>
      broker.evaluate({
        taskId: 'task-1',
        request: shellRequest,
        now: NOW,
        pathGuard,
        basePolicy: {
          managedDeny: [],
          projectDeny: [],
          parentCeiling: shellCeiling,
          modeCeiling: shellCeiling,
          sandbox: { feasible: true, profile: 'read-only' },
        },
      }),
    ).toThrow('Shell requests must use evaluateShell');

    const structured = broker.evaluateExecutionSpec({
      taskId: 'task-1',
      request: shellRequest,
      now: NOW,
      pathGuard,
      basePolicy: {
        managedDeny: [],
        projectDeny: [],
        parentCeiling: shellCeiling,
        modeCeiling: shellCeiling,
        sandbox: { feasible: true, profile: 'read-only' },
        allowRules: [
          { capability: 'shell.execute', resourceSet: { kind: 'all' }, operations: ['execute'] },
        ],
      },
    });
    expect(structured.decision).toBe('allow');

    const result = broker.evaluateShell({
      taskId: 'task-1',
      command: '/bin/echo one && /usr/bin/printf two',
      requestForSegment: () => shellRequest,
      now: NOW,
      pathGuard,
      basePolicy: {
        managedDeny: [],
        projectDeny: [],
        parentCeiling: shellCeiling,
        modeCeiling: shellCeiling,
        sandbox: { feasible: true, profile: 'read-only' },
        allowRules: [
          { capability: 'shell.execute', resourceSet: { kind: 'all' }, operations: ['execute'] },
        ],
      },
    });
    expect(result).toMatchObject({
      decision: 'deny',
      reason: 'shell_execution_boundary_unavailable',
    });
    expect(audits).toHaveLength(3);
  });
});
