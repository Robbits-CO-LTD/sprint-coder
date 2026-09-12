import { describe, expect, it } from 'vitest';
import type { GraphMissionRecord } from './graph-mission-record';
import { graphResourceKeys } from './graph-resource';

function record(owner: string, rootIds: string[], identity = 'a'.repeat(64)): GraphMissionRecord {
  return {
    missionId: owner,
    taskId: owner,
    graphId: owner,
    renderRevision: 1,
    semanticRevision: 1,
    semanticDigest: 'b'.repeat(64),
    policyEpoch: 0,
    workspaceDigest: 'c'.repeat(64),
    contextDigest: 'd'.repeat(64),
    consentId: owner,
    approvedAt: '2026-09-11T00:00:00.000Z',
    contextJson: JSON.stringify({
      workspace: {
        source: 'project',
        projectId: owner,
        primaryRootId: rootIds[0],
        digest: 'c'.repeat(64),
        roots: rootIds.map((rootId, index) => ({
          rootId,
          path: `/workspace/${rootId}`,
          label: rootId,
          role: index === 0 ? 'primary' : 'secondary',
          status: 'available',
        })),
      },
      roots: rootIds.map((id) => [id, identity]),
      policyEpoch: 0,
      team: { id: owner, taskId: owner, leaderAgentId: `${owner}-leader`, state: 'active' },
      workers: [
        {
          id: `${owner}-worker`,
          taskId: owner,
          teamId: owner,
          kind: 'worker',
          state: 'ready',
          writeCapable: false,
          authorityDigest: 'e'.repeat(64),
        },
      ],
      busyWorkerIds: [],
    }),
    plan: {
      mode: 'graph',
      objective: 'test',
      doneCriteria: ['done'],
      steps: ['a', 'b'].map((key) => ({
        key,
        nodeId: key,
        workerId: `${owner}-worker`,
        objective: key,
        doneCriteria: ['done'],
        access: 'read-only',
        dependsOn: [],
        writeClaims: [],
        resourceClaims: [
          ...rootIds.map((rootId) => ({ scope: 'workspace' as const, rootId, key: 'database' })),
          { scope: 'machine', key: 'database', rootId: null },
        ],
      })),
    },
    steps: [],
  };
}
describe('graph resource namespaces', () => {
  it('coalesces root aliases and shares physical Workspace identity across Team/root IDs', () => {
    const first = graphResourceKeys(record('first', ['root-a', 'alias-a']), 'a');
    const second = graphResourceKeys(record('second', ['root-b']), 'a');
    expect(first).toHaveLength(3);
    expect(first.find((key) => key.scope === 'workspace')?.key).toBe(
      second.find((key) => key.scope === 'workspace')?.key,
    );
    expect(first.find((key) => key.scope === 'machine')?.key).toBe(
      second.find((key) => key.scope === 'machine')?.key,
    );
    expect(first.find((key) => key.scope === 'worker')?.key).not.toBe(
      second.find((key) => key.scope === 'worker')?.key,
    );
    expect(first.find((key) => key.scope === 'workspace')?.key).not.toBe(
      first.find((key) => key.scope === 'machine')?.key,
    );
  });
  it('separates distinct Workspace identities and rejects an unbound resource root', () => {
    const first = graphResourceKeys(record('same', ['root']), 'a');
    const second = graphResourceKeys(record('same', ['root'], 'f'.repeat(64)), 'a');
    expect(first.find((key) => key.scope === 'workspace')?.key).not.toBe(
      second.find((key) => key.scope === 'workspace')?.key,
    );
    const bad = record('same', ['root']);
    bad.plan.steps[0]!.resourceClaims[0]!.rootId = 'missing';
    expect(() => graphResourceKeys(bad, 'a')).toThrow('not bound');
  });
});
