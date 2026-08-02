import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expandAccessPreset,
  type CapabilityCeiling,
  type PermissionEvaluation,
  type PermissionRequest,
  type Capability,
} from '@sprint-coder/domain';
import { PermissionBroker } from './permission-broker';
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

function fixture(notify?: () => void, revokedCapabilities: Capability[] = []) {
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
    policyEpochChanged: () => {
      notify?.();
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
