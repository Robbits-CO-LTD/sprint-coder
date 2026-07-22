import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createExecutionSpec,
  createSessionGrant,
  createToolDefinition,
  createToolId,
} from '@vibe/domain';
import { randomUUID } from 'node:crypto';
import { ApprovalCoordinator } from './approval-coordinator';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';
import { ToolBroker } from './tool-broker';
import {
  OperationConflictError,
  SqlitePersistenceClient,
  SteerStaleError,
  TurnActiveError,
} from './persistence';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.VIBE_ELECTRON_DB_TEST === '1';

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-persistence-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  return { persistence: new SqlitePersistenceClient(path), path };
}

function startExecutingTurn(persistence: SqlitePersistenceClient, taskId: string) {
  const started = persistence.startTurn(taskId, 'approval test');
  persistence.changeStage(taskId, started.turnId, 'understanding');
  persistence.changeStage(taskId, started.turnId, 'planning');
  persistence.changeStage(taskId, started.turnId, 'executing');
  return started;
}

function approvalRequest(taskId: string, turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    taskId,
    turnId,
    itemId: 'item-1',
    callId: 'call-1',
    runtimeInstanceId: 'runtime-1',
    subjectId: 'leader',
    providerName: 'write_file',
    toolId: 'builtin:workspace.write:file@1',
    toolCatalogDigest: 'a'.repeat(64),
    schemaDigest: 'b'.repeat(64),
    specDigest: 'c'.repeat(64),
    policyEpoch: 0,
    capability: 'workspace.write' as const,
    resource: { kind: 'path-prefix' as const, canonicalPath: '/workspace' },
    operation: 'write' as const,
    providerEgress: 'none' as const,
    sandboxProfile: 'workspace-write' as const,
    risk: 'medium' as const,
    reasonUntrusted: 'The requested edit needs workspace write access.',
    display: {
      target: '/workspace/file.txt',
      impact: 'Writes one workspace file',
      execution: 'Write /workspace/file.txt',
    },
    challenge: 'challenge-1',
    expiresAt: '2026-07-22T12:05:00.000Z',
    requestedAt: '2026-07-22T12:00:00.000Z',
    ...overrides,
  };
}

if (runsWithElectronAbi)
  describe('SqlitePersistenceClient v16', () => {
    it('deduplicates operations and rejects operation id hash conflicts', () => {
      const { persistence } = createPersistence();
      let calls = 0;
      const first = persistence.executeOperation(
        'renderer:1',
        '',
        'tasks.create',
        'op-1',
        'hash-a',
        () => {
          calls += 1;
          return persistence.createTask('deduplicated');
        },
      );
      const replayed = persistence.executeOperation(
        'renderer:1',
        '',
        'tasks.create',
        'op-1',
        'hash-a',
        () => {
          calls += 1;
          return persistence.createTask('should not run');
        },
      );

      expect(replayed).toEqual(first);
      expect(calls).toBe(1);
      expect(persistence.listTasks()).toHaveLength(1);
      expect(() =>
        persistence.executeOperation(
          'renderer:1',
          '',
          'tasks.create',
          'op-1',
          'hash-b',
          () => null,
        ),
      ).toThrow(OperationConflictError);
      persistence.close();
    });

    it('uses one monotonic sequence for all task events and replays strictly after afterSeq', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const first = persistence.startTurn(task.id, 'first');
      const queued = persistence.queueInput(task.id, 'second', 'queue-op');
      const stage = persistence.changeStage(task.id, first.turnId, 'understanding');
      const canceled = persistence.cancelTurn(task.id, first.turnId);
      const all = persistence.listEventsAfter(task.id, 0);

      expect([first.event.seq, queued.event.seq, stage.seq, canceled?.seq]).toEqual([1, 2, 3, 4]);
      expect(all.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(persistence.listEventsAfter(task.id, 2).map((event) => event.seq)).toEqual([3, 4]);
      persistence.close();
    });

    it('rejects a second active turn and dequeues queued input in ordinal order', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const active = persistence.startTurn(task.id, 'active');
      expect(() => persistence.startTurn(task.id, 'parallel')).toThrow(TurnActiveError);
      expect(persistence.queueInput(task.id, 'queued one', 'q1').ordinal).toBe(1);
      expect(persistence.queueInput(task.id, 'queued two', 'q2').ordinal).toBe(2);

      persistence.cancelTurn(task.id, active.turnId);
      const transition = persistence.startNextQueued(task.id);
      expect(transition?.started.text).toBe('queued one');
      expect(transition?.queueEvent).toMatchObject({
        type: 'queue.changed',
        queued: [{ ordinal: 2, text: 'queued two' }],
      });
      expect(persistence.snapshot(task.id).queued).toEqual([{ ordinal: 2, text: 'queued two' }]);
      persistence.close();
    });

    it('persists valid steering as a user message and rejects stale expectedTurnId', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const active = persistence.startTurn(task.id, 'original');

      expect(() => persistence.steerTurn(task.id, 'stale', 'wrong-turn')).toThrow(SteerStaleError);
      persistence.steerTurn(task.id, '追加条件', active.turnId);
      expect(
        persistence.listMessages(task.id).map((message) => [message.author, message.content]),
      ).toEqual([
        ['user', 'original'],
        ['user', '追加条件'],
      ]);
      persistence.close();
    });

    it('keeps queued input across restart and exposes task attributes and snapshots', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask('attributes');
      persistence.setPinned(task.id, true);
      persistence.setGoal(task.id, 'goal');
      persistence.setDraft(task.id, 'draft');
      persistence.setWorkspace(task.id, '/tmp/workspace');
      persistence.queueInput(task.id, 'resume me', 'q1');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listTasks()[0]).toMatchObject({
        pinned: true,
        goal: 'goal',
        workspacePath: '/tmp/workspace',
      });
      expect(reopened.getDraft(task.id)).toBe('draft');
      expect(reopened.snapshot(task.id)).toMatchObject({
        activeTurn: null,
        queued: [{ ordinal: 1, text: 'resume me' }],
      });
      expect(reopened.startNextQueued(task.id)?.started.text).toBe('resume me');
      reopened.close();
    });

    it('defaults to mock and persists the selected runtime across restart', () => {
      const { persistence, path } = createPersistence();
      expect(persistence.getRuntime()).toBe('mock');
      expect(persistence.getModel()).toBe('auto');
      persistence.setRuntime('codex');
      persistence.setModel('gpt-5.6-terra');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getRuntime()).toBe('codex');
      expect(reopened.getModel()).toBe('gpt-5.6-terra');
      reopened.close();
    });

    it('persists expanded access policy rules and revokes task-scoped grants by epoch', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      expect(persistence.getPermissionPolicy(task.id)).toMatchObject({
        preset: 'ask',
        policyEpoch: 0,
        expandedPolicy: { approvalPolicy: 'ask', allowRules: [] },
      });
      const selected = persistence.setAccessPreset(task.id, 'auto');
      expect(selected).toMatchObject({
        preset: 'auto',
        policyEpoch: 1,
        expandedPolicy: { approvalPolicy: 'auto' },
      });
      expect(selected.expandedPolicy.allowRules).toContainEqual(
        expect.objectContaining({ capability: 'workspace.read' }),
      );
      expect(persistence.listPendingPermissionPolicyEpochs()).toEqual([
        expect.objectContaining({ taskId: task.id, policyEpoch: 1 }),
      ]);
      const firstOutbox = persistence.listPendingPermissionPolicyEpochs()[0]!;
      persistence.markPermissionPolicyEpochDelivered(firstOutbox.id, '2026-07-22T12:00:00.000Z');
      expect(persistence.listPendingPermissionPolicyEpochs()).toEqual([]);
      const grant = createSessionGrant({
        id: 'grant-1',
        subjectId: 'leader',
        capability: 'workspace.read',
        resourceSet: { kind: 'path-prefix', canonicalPath: '/workspace' },
        operations: ['read'],
        scope: 'task',
        expiresAt: '2026-07-22T13:00:00.000Z',
        policyEpoch: 1,
        providerEgress: ['none'],
        sandboxProfiles: ['read-only'],
      });
      expect(() =>
        persistence.savePermissionGrant(task.id, {
          ...grant,
          id: 'future-grant',
          policyEpoch: 2,
        }),
      ).toThrow('Grant policy epoch must match');
      persistence.savePermissionGrant(task.id, grant);
      expect(
        persistence.listPermissionGrants(task.id, 'leader', '2026-07-22T12:00:00.000Z'),
      ).toEqual([grant]);
      expect(
        persistence.revokePermissionCapability(
          task.id,
          'workspace.read',
          '2026-07-22T12:01:00.000Z',
        ),
      ).toBe(1);
      expect(
        persistence.listPermissionGrants(task.id, 'leader', '2026-07-22T12:02:00.000Z'),
      ).toEqual([]);
      expect(persistence.getPermissionPolicy(task.id)).toMatchObject({
        policyEpoch: 2,
        revokedCapabilities: ['workspace.read'],
      });
      expect(persistence.setAccessPreset(task.id, 'full', 2)).toMatchObject({
        policyEpoch: 3,
        revokedCapabilities: ['workspace.read'],
      });
      expect(() => persistence.setAccessPreset(task.id, 'ask', 2)).toThrow(
        'Permission policy epoch changed',
      );
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getPermissionPolicy(task.id)).toMatchObject({
        preset: 'full',
        policyEpoch: 3,
        expandedPolicy: { approvalPolicy: 'ask' },
        revokedCapabilities: ['workspace.read'],
      });
      reopened.close();
    });

    it('fails closed when stored preset rows are syntactically valid but non-canonical', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      persistence.setAccessPreset(task.id, 'auto');
      const tamper = new Database(path);
      tamper
        .prepare(
          `UPDATE permission_rules SET capability = 'shell.execute',
          resource_json = '{"kind":"all"}', operations_json = '["execute"]'
          WHERE task_id = ? AND effect = 'allow'`,
        )
        .run(task.id);
      tamper.close();

      expect(persistence.getPermissionPolicy(task.id)).toMatchObject({
        preset: 'ask',
        policyEpoch: 1,
        expandedPolicy: { approvalPolicy: 'ask', allowRules: [] },
      });
      expect(persistence.setAccessPreset(task.id, 'full')).toMatchObject({
        preset: 'full',
        policyEpoch: 2,
      });
      persistence.close();
    });

    it('atomically consumes a reviewer one-time token exactly once', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      persistence.registerPermissionOneTimeToken(
        task.id,
        'reviewer-token',
        3,
        '2026-07-22T12:05:00.000Z',
      );

      expect(
        persistence.consumePermissionOneTimeToken(
          task.id,
          'reviewer-token',
          3,
          '2026-07-22T12:00:00.000Z',
        ),
      ).toBe(true);
      expect(
        persistence.consumePermissionOneTimeToken(
          task.id,
          'reviewer-token',
          3,
          '2026-07-22T12:00:01.000Z',
        ),
      ).toBe(false);
      persistence.close();
    });

    it('commits a pending approval, waiting state, and requested event atomically', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);

      const requested = persistence.requestApproval(approvalRequest(task.id, turn.turnId));

      expect(requested.approval).toMatchObject({
        id: 'approval-1',
        taskId: task.id,
        turnId: turn.turnId,
        state: 'pending',
        decision: null,
        revision: 0,
        policyEpoch: 0,
        specDigest: 'c'.repeat(64),
      });
      expect(requested.event).toMatchObject({
        type: 'approval.requested',
        taskId: task.id,
        turnId: turn.turnId,
        approvalId: 'approval-1',
        seq: 5,
      });
      expect(persistence.snapshot(task.id).activeTurn).toMatchObject({
        turnId: turn.turnId,
        stage: 'waiting_approval',
      });

      const inspection = new Database(path, { readonly: true });
      expect(
        inspection
          .prepare('SELECT state, revision, decision FROM approvals WHERE id = ?')
          .get('approval-1'),
      ).toEqual({ state: 'pending', revision: 0, decision: null });
      expect(inspection.prepare('SELECT state FROM turns WHERE id = ?').get(turn.turnId)).toEqual({
        state: 'waiting_approval',
      });
      expect(
        inspection
          .prepare('SELECT type FROM turn_events WHERE task_id = ? AND seq = 5')
          .get(task.id),
      ).toEqual({ type: 'approval.requested' });
      inspection.close();
      persistence.close();
    });

    it('deduplicates an at-least-once approval request after the Turn starts waiting', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      const first = persistence.requestApproval(approvalRequest(task.id, turn.turnId));
      const retried = persistence.requestApproval(
        approvalRequest(task.id, turn.turnId, {
          id: 'approval-retry-id',
          itemId: 'item-retry-id',
          challenge: 'challenge-retry',
          requestedAt: '2026-07-22T12:00:01.000Z',
          expiresAt: '2026-07-22T12:10:00.000Z',
        }),
      );

      expect(retried).toEqual(first);
      expect(persistence.listPendingApprovals(task.id)).toHaveLength(1);
      expect(
        persistence.listEventsAfter(task.id, 0).filter(({ type }) => type === 'approval.requested'),
      ).toHaveLength(1);
      persistence.close();
    });

    it('coordinates multiple capability approvals and shared retries against real SQLite', async () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      const published: ReturnType<SqlitePersistenceClient['getApproval']>[] = [];
      const coordinator = new ApprovalCoordinator({
        persistence,
        now: () => '2026-07-22T12:00:00.000Z',
        expiresAt: () => '2026-07-22T13:00:00.000Z',
        getCurrentPolicyEpoch: () => 0,
        isTurnActive: (_taskId, turnId) => persistence.getActiveTurnId(task.id) === turnId,
        evaluatePermission: () => 'approval_required',
        publish: (approval) => published.push(persistence.getApproval(task.id, approval.id)),
      });
      const registry = new ToolRegistry();
      const definition = createToolDefinition({
        toolId: createToolId({
          provider: 'builtin',
          namespace: 'approval',
          name: 'multi',
          version: '1',
        }),
        providerName: 'approval_multi',
        kind: 'network',
        schemaVersion: 1,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'string' },
        sideEffect: 'network',
        risk: 'medium',
        requiredCapabilities: ['network.fetch', 'provider.egress'],
        executionTarget: 'main',
        implementationKind: 'built-in',
        priority: 1,
        workspaceBinding: { kind: 'none' },
        providerCompatibility: ['mock'],
      });
      registry.register(definition);
      const broker = new ToolBroker(registry, () => 0, coordinator.authorizeTool.bind(coordinator));
      let executions = 0;
      broker.registerImplementation({
        toolId: definition.toolId,
        implementationKind: 'built-in',
        execute: () => {
          executions += 1;
          return 'ok';
        },
      });
      const context = { taskId: task.id, turnId: turn.turnId, workspaceId: null, policyEpoch: 0 };
      const snapshot = broker.startTurn(context, 'mock');
      const request = {
        context,
        callId: 'call-retry-shared',
        entry: snapshot.entries[0]!,
        input: {},
      };
      const retryOne = coordinator.authorizeTool(request);
      const retryTwo = coordinator.authorizeTool(request);
      await expect.poll(() => published.length).toBe(1);
      const shared = published[0]!;
      coordinator.resolve({
        taskId: task.id,
        turnId: turn.turnId,
        approvalId: shared.id,
        decision: 'allow_once',
        expectedRevision: 0,
        challenge: shared.challenge,
        operationId: randomUUID(),
      });
      await expect.poll(() => published.length).toBe(2);
      const sharedSecond = published[1]!;
      coordinator.resolve({
        taskId: task.id,
        turnId: turn.turnId,
        approvalId: sharedSecond.id,
        decision: 'allow_once',
        expectedRevision: 0,
        challenge: sharedSecond.challenge,
        operationId: randomUUID(),
      });
      await expect(Promise.all([retryOne, retryTwo])).resolves.toHaveLength(2);

      const dispatch = broker.dispatch({
        taskId: task.id,
        turnId: turn.turnId,
        callId: 'call-multi',
        providerName: 'approval_multi',
        input: {},
      });
      await expect.poll(() => published.length).toBe(3);
      const first = published.at(-1)!;
      coordinator.resolve({
        taskId: task.id,
        turnId: turn.turnId,
        approvalId: first.id,
        decision: 'allow_once',
        expectedRevision: 0,
        challenge: first.challenge,
        operationId: randomUUID(),
      });
      await expect.poll(() => published.length).toBe(4);
      expect(executions).toBe(0);
      const second = published.at(-1)!;
      expect(second.capability).toBe('provider.egress');
      coordinator.resolve({
        taskId: task.id,
        turnId: turn.turnId,
        approvalId: second.id,
        decision: 'allow_once',
        expectedRevision: 0,
        challenge: second.challenge,
        operationId: randomUUID(),
      });
      await expect(dispatch).resolves.toBe('ok');
      expect(executions).toBe(1);
      persistence.close();
    });

    it('lists pending approvals after restart without losing their immutable binding', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      persistence.requestApproval(approvalRequest(task.id, turn.turnId));
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listPendingApprovals(task.id)).toEqual([
        expect.objectContaining({
          id: 'approval-1',
          turnId: turn.turnId,
          callId: 'call-1',
          runtimeInstanceId: 'runtime-1',
          toolCatalogDigest: 'a'.repeat(64),
          schemaDigest: 'b'.repeat(64),
          specDigest: 'c'.repeat(64),
          state: 'pending',
          revision: 0,
        }),
      ]);
      expect(reopened.snapshot(task.id).activeTurn).toMatchObject({
        turnId: turn.turnId,
        stage: 'waiting_approval',
      });
      reopened.close();
    });

    it('persists the complete security-critical execution display without truncation', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      const execution = JSON.stringify({ executable: '/usr/bin/tool', argv: ['x'.repeat(8_000)] });

      persistence.requestApproval(
        approvalRequest(task.id, turn.turnId, {
          display: { target: '/usr/bin/tool', impact: 'process', execution },
        }),
      );

      expect(persistence.getApproval(task.id, 'approval-1').execution).toBe(execution);
      persistence.close();
    });

    it('resolves allow-once, task grant, and deny without failing the Turn', () => {
      const decisions = ['allow_once', 'allow_task', 'deny'] as const;
      for (const [index, decision] of decisions.entries()) {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        const turn = startExecutingTurn(persistence, task.id);
        const approvalId = `approval-${index + 1}`;
        const challenge = `challenge-${index + 1}`;
        persistence.requestApproval(
          approvalRequest(task.id, turn.turnId, { id: approvalId, challenge }),
        );

        const resolved = persistence.resolveApproval({
          taskId: task.id,
          approvalId,
          expectedTurnId: turn.turnId,
          expectedRevision: 0,
          challenge,
          decision,
          operationId: `resolve-${decision}`,
          decidedAt: '2026-07-22T12:01:00.000Z',
          grantExpiresAt: '2026-07-22T13:00:00.000Z',
        });

        expect(resolved.approval).toMatchObject({
          id: approvalId,
          state: 'resolved',
          decision,
          revision: 1,
        });
        expect(resolved.event).toMatchObject({
          type: 'approval.resolved',
          approvalId,
          decision,
          seq: 6,
        });
        expect(persistence.snapshot(task.id).activeTurn).toMatchObject({
          turnId: turn.turnId,
          stage: 'executing',
        });

        if (decision === 'allow_once') {
          expect(resolved.oneTimePermitToken).toEqual(expect.any(String));
          expect(() =>
            persistence.consumePermissionOneTimeToken(
              task.id,
              resolved.oneTimePermitToken!,
              0,
              '2026-07-22T12:01:01.000Z',
              {
                approvalId,
                turnId: turn.turnId,
                callId: 'forged-call',
                subjectId: 'leader',
                specDigest: 'c'.repeat(64),
              },
            ),
          ).toThrow('One-time permit binding mismatch');
          expect(
            persistence.consumePermissionOneTimeToken(
              task.id,
              resolved.oneTimePermitToken!,
              0,
              '2026-07-22T12:01:01.000Z',
              {
                approvalId,
                turnId: turn.turnId,
                callId: 'call-1',
                subjectId: 'leader',
                specDigest: 'c'.repeat(64),
              },
            ),
          ).toBe(true);
          expect(
            persistence.listPermissionGrants(task.id, 'leader', '2026-07-22T12:01:01.000Z'),
          ).toEqual([]);
        } else if (decision === 'allow_task') {
          expect(resolved.oneTimePermitToken).toBeUndefined();
          expect(
            persistence.listPermissionGrants(task.id, 'leader', '2026-07-22T12:01:01.000Z'),
          ).toEqual([
            expect.objectContaining({
              scope: 'task',
              capability: 'workspace.write',
              executionSpecDigest: 'c'.repeat(64),
              policyEpoch: 0,
            }),
          ]);
        } else {
          expect(resolved.oneTimePermitToken).toBeUndefined();
          expect(
            persistence.listPermissionGrants(task.id, 'leader', '2026-07-22T12:01:01.000Z'),
          ).toEqual([]);
        }
        persistence.close();
      }
    });

    it('binds resolution to task, turn, revision, and a single-use challenge', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const otherTask = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      persistence.requestApproval(approvalRequest(task.id, turn.turnId));
      const base = {
        taskId: task.id,
        approvalId: 'approval-1',
        expectedTurnId: turn.turnId,
        expectedRevision: 0,
        challenge: 'challenge-1',
        decision: 'deny' as const,
        operationId: 'resolve-1',
        decidedAt: '2026-07-22T12:01:00.000Z',
      };

      expect(() => persistence.resolveApproval({ ...base, taskId: otherTask.id })).toThrow(
        'Approval does not belong to this Task',
      );
      expect(() => persistence.resolveApproval({ ...base, expectedTurnId: 'stale-turn' })).toThrow(
        'Approval Turn changed',
      );
      expect(() => persistence.resolveApproval({ ...base, expectedRevision: 1 })).toThrow(
        'Approval revision changed',
      );
      expect(() => persistence.resolveApproval({ ...base, challenge: 'wrong-challenge' })).toThrow(
        'Approval challenge mismatch',
      );
      expect(persistence.listPendingApprovals(task.id)).toHaveLength(1);

      const first = persistence.resolveApproval(base);
      expect(persistence.resolveApproval(base)).toEqual(first);
      expect(() =>
        persistence.resolveApproval({ ...base, operationId: 'resolve-2', decision: 'allow_once' }),
      ).toThrow('Approval is already resolved');
      expect(
        persistence.listEventsAfter(task.id, 0).filter(({ type }) => type === 'approval.resolved'),
      ).toHaveLength(1);
      persistence.close();
    });

    it('expires stale responses and invalidates pending approval after a policy epoch change', () => {
      const { persistence } = createPersistence();
      const expiredTask = persistence.createTask();
      const expiredTurn = startExecutingTurn(persistence, expiredTask.id);
      persistence.requestApproval(approvalRequest(expiredTask.id, expiredTurn.turnId));
      const expired = persistence.resolveApproval({
        taskId: expiredTask.id,
        approvalId: 'approval-1',
        expectedTurnId: expiredTurn.turnId,
        expectedRevision: 0,
        challenge: 'challenge-1',
        decision: 'allow_once',
        operationId: 'resolve-expired',
        decidedAt: '2026-07-22T12:06:00.000Z',
      });
      expect(expired.approval).toMatchObject({ state: 'expired', decision: null, revision: 1 });
      expect(expired.event).toMatchObject({ type: 'approval.expired' });
      expect(expired.oneTimePermitToken).toBeUndefined();

      const staleTask = persistence.createTask();
      const staleTurn = startExecutingTurn(persistence, staleTask.id);
      persistence.requestApproval(
        approvalRequest(staleTask.id, staleTurn.turnId, {
          id: 'approval-stale',
          challenge: 'challenge-stale',
        }),
      );
      persistence.setAccessPreset(staleTask.id, 'auto', 0);
      const stale = persistence.resolveApproval({
        taskId: staleTask.id,
        approvalId: 'approval-stale',
        expectedTurnId: staleTurn.turnId,
        expectedRevision: 0,
        challenge: 'challenge-stale',
        decision: 'allow_task',
        operationId: 'resolve-stale',
        decidedAt: '2026-07-22T12:01:00.000Z',
      });
      expect(stale.approval).toMatchObject({ state: 'stale', decision: null, revision: 1 });
      expect(stale.event).toMatchObject({ type: 'approval.stale' });
      expect(
        persistence.listPermissionGrants(staleTask.id, 'leader', '2026-07-22T12:01:01.000Z'),
      ).toEqual([]);
      expect(persistence.listPendingApprovals(staleTask.id)).toEqual([]);

      const pushedTask = persistence.createTask();
      const pushedTurn = startExecutingTurn(persistence, pushedTask.id);
      persistence.requestApproval(
        approvalRequest(pushedTask.id, pushedTurn.turnId, {
          id: 'approval-pushed-stale',
          challenge: 'challenge-pushed-stale',
        }),
      );
      persistence.setAccessPreset(pushedTask.id, 'auto', 0);
      const pushed = persistence.invalidatePendingApprovalsForTask(
        pushedTask.id,
        1,
        '2026-07-22T12:01:00.000Z',
      );
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).toMatchObject({
        approval: { state: 'stale', decision: null, revision: 1 },
        event: { type: 'approval.stale' },
      });
      expect(persistence.snapshot(pushedTask.id).activeTurn).toMatchObject({
        stage: 'executing',
      });
      persistence.close();
    });

    it('cancels every pending approval before publishing Turn cancellation', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      persistence.requestApproval(approvalRequest(task.id, turn.turnId));

      const canceled = persistence.cancelTurn(task.id, turn.turnId);

      expect(canceled).toMatchObject({ type: 'turn.completed', state: 'canceled', seq: 7 });
      expect(persistence.getApproval(task.id, 'approval-1')).toMatchObject({
        state: 'canceled',
        decision: null,
        revision: 1,
      });
      expect(persistence.listPendingApprovals(task.id)).toEqual([]);
      expect(
        persistence.listEventsAfter(task.id, 4).map((event) => [event.type, event.seq]),
      ).toEqual([
        ['approval.requested', 5],
        ['approval.canceled', 6],
        ['turn.completed', 7],
      ]);
      expect(() =>
        persistence.resolveApproval({
          taskId: task.id,
          approvalId: 'approval-1',
          expectedTurnId: turn.turnId,
          expectedRevision: 0,
          challenge: 'challenge-1',
          decision: 'allow_once',
          operationId: 'late-response',
          decidedAt: '2026-07-22T12:01:00.000Z',
        }),
      ).toThrow('Approval is no longer pending');
      persistence.close();
    });

    it('replays approval lifecycle events in the task sequence after restart', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      persistence.requestApproval(approvalRequest(task.id, turn.turnId));
      persistence.resolveApproval({
        taskId: task.id,
        approvalId: 'approval-1',
        expectedTurnId: turn.turnId,
        expectedRevision: 0,
        challenge: 'challenge-1',
        decision: 'deny',
        operationId: 'resolve-deny',
        decidedAt: '2026-07-22T12:01:00.000Z',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(
        reopened.listEventsAfter(task.id, 4).map((event) => ({
          type: event.type,
          seq: event.seq,
          approvalId: 'approvalId' in event ? event.approvalId : undefined,
        })),
      ).toEqual([
        { type: 'approval.requested', seq: 5, approvalId: 'approval-1' },
        { type: 'approval.resolved', seq: 6, approvalId: 'approval-1' },
      ]);
      expect(reopened.getApproval(task.id, 'approval-1')).toMatchObject({
        state: 'resolved',
        decision: 'deny',
        revision: 1,
      });
      reopened.close();
    });

    it('persists permission audit trace and reviewer evidence', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      persistence.recordPermissionAudit(
        task.id,
        {
          taskId: task.id,
          subjectId: 'leader',
          capability: 'network.fetch',
          resource: { kind: 'network', origin: 'https://example.test' },
          operation: 'fetch',
          providerEgress: 'none',
          sandboxProfile: 'read-only',
          executionSpecDigest: 'a'.repeat(64),
          reviewerInputDigest: 'b'.repeat(64),
          risk: 'medium',
        },
        {
          decision: 'deny',
          reason: 'reviewer_timeout',
          policyEpoch: 2,
          evaluationTrace: ['managed-deny', 'reviewer', 'execution-revalidation'],
          reviewerAudit: {
            reviewRequestId: 'review-audit-1',
            turnId: 'turn-audit-1',
            callId: 'call-audit-1',
            requestFingerprint: 'c'.repeat(64),
            executionSpecDigest: 'a'.repeat(64),
            policyEpoch: 2,
            model: 'reviewer-v1',
            templateVersion: '1',
            inputDigest: 'b'.repeat(64),
            decision: 'timeout',
          },
        },
      );
      const inspection = new Database(path, { readonly: true });
      const row = inspection.prepare('SELECT * FROM permission_audit').get() as {
        decision: string;
        reason: string;
        evaluation_trace_json: string;
        reviewer_json: string;
      };
      expect(row).toMatchObject({ decision: 'deny', reason: 'reviewer_timeout' });
      expect(JSON.parse(row.evaluation_trace_json)).toEqual([
        'managed-deny',
        'reviewer',
        'execution-revalidation',
      ]);
      expect(JSON.parse(row.reviewer_json)).toMatchObject({
        model: 'reviewer-v1',
        decision: 'timeout',
        requestFingerprint: 'c'.repeat(64),
      });
      expect(row.reviewer_json).not.toContain('https://example.test');
      inspection.close();
      persistence.close();
    });

    it('atomically commits reviewer authority, audit, bound permit, and UI event', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = startExecutingTurn(persistence, task.id);
      const request = {
        taskId: task.id,
        subjectId: 'tool:builtin:read',
        capability: 'workspace.read' as const,
        resource: { kind: 'external' as const, target: 'fixture' },
        operation: 'read' as const,
        providerEgress: 'none' as const,
        sandboxProfile: 'read-only' as const,
        executionSpecDigest: 'd'.repeat(64),
        reviewerInputDigest: 'e'.repeat(64),
        risk: 'low' as const,
      };
      const reviewRequestId = 'review-atomic-1';
      const token = 'reviewer-token-atomic-1';
      const evaluation = {
        decision: 'allow_once' as const,
        reason: 'safe_read_only',
        policyEpoch: 0,
        evaluationTrace: ['reviewer' as const],
        permit: {
          taskId: task.id,
          subjectId: request.subjectId,
          capability: request.capability,
          operation: request.operation,
          resourceIdentity: 'external:fixture',
          executionSpecDigest: request.executionSpecDigest,
          policyEpoch: 0,
          expiresAt: '2099-01-01T00:00:00.000Z',
          source: 'reviewer_allow_once' as const,
          oneTimeToken: token,
          reviewRequestId,
          turnId: turn.turnId,
          callId: 'call-atomic-1',
        },
        reviewerAudit: {
          reviewRequestId,
          turnId: turn.turnId,
          callId: 'call-atomic-1',
          requestFingerprint: 'f'.repeat(64),
          executionSpecDigest: request.executionSpecDigest,
          policyEpoch: 0,
          model: 'builtin-deterministic-risk-v1',
          templateVersion: '1',
          inputDigest: request.reviewerInputDigest,
          decision: 'allow_once' as const,
        },
      };
      const autoDecision = {
        id: 'auto-atomic-1',
        taskId: task.id,
        turnId: turn.turnId,
        callId: 'call-atomic-1',
        reviewRequestId,
        capability: request.capability,
        source: 'reviewer' as const,
        decision: 'allow_once' as const,
        outcome: 'allow_once',
        reason: 'safe_read_only',
        risk: 'low' as const,
        model: 'builtin-deterministic-risk-v1',
        templateVersion: '1',
        requestFingerprint: 'f'.repeat(64),
        executionSpecDigest: request.executionSpecDigest,
        inputDigest: request.reviewerInputDigest,
        policyEpoch: 0,
        createdAt: '2026-07-23T00:00:00.000Z',
      };

      expect(() =>
        persistence.commitPermissionEvaluation(task.id, request, evaluation, {
          ...autoDecision,
          capability: 'invalid-capability' as never,
        }),
      ).toThrow();
      const inspection = new Database(path, { readonly: true });
      expect(inspection.prepare('SELECT count(*) AS count FROM permission_audit').get()).toEqual({
        count: 0,
      });
      expect(
        inspection.prepare('SELECT count(*) AS count FROM permission_one_time_permits').get(),
      ).toEqual({ count: 0 });
      expect(
        inspection.prepare('SELECT count(*) AS count FROM auto_permission_decisions').get(),
      ).toEqual({ count: 0 });
      inspection.close();

      expect(
        persistence.commitPermissionEvaluation(task.id, request, evaluation, autoDecision),
      ).toMatchObject({ type: 'permission.auto_decided', autoDecision });
      expect(() =>
        persistence.consumePermissionOneTimeToken(task.id, token, 0, new Date().toISOString(), {
          reviewRequestId,
          turnId: 'wrong-turn',
          callId: 'call-atomic-1',
          subjectId: request.subjectId,
          specDigest: request.executionSpecDigest,
        }),
      ).toThrow('One-time permit binding mismatch');
      expect(
        persistence.consumePermissionOneTimeToken(task.id, token, 0, new Date().toISOString(), {
          reviewRequestId,
          turnId: turn.turnId,
          callId: 'call-atomic-1',
          subjectId: request.subjectId,
          specDigest: request.executionSpecDigest,
        }),
      ).toBe(true);
      persistence.close();
      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listAutoPermissionDecisions(task.id)).toEqual([autoDecision]);
      reopened.close();
    });

    it('publishes context usage around audit-only compaction without changing displayed history', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      persistence.setGoal(task.id, 'Keep the answer deterministic');
      const original = 'x'.repeat(76_803);
      const started = persistence.startTurn(task.id, original);
      const prepared = persistence.prepareContext(task.id, started.turnId);

      expect(prepared.compacted).toBe(true);
      expect(prepared.usageEvents.map((event) => [event.type, event.seq])).toEqual([
        ['context.usage', 2],
        ['context.usage', 4],
      ]);
      expect(persistence.listMessages(task.id)).toHaveLength(1);
      expect(persistence.listMessages(task.id)[0]?.content).toBe(original);
      expect(
        persistence.listEventsAfter(task.id, 0).map((event) => [event.type, event.seq]),
      ).toEqual([
        ['turn.accepted', 1],
        ['context.usage', 2],
        ['context.usage', 4],
      ]);
      expect(persistence.snapshot(task.id)).toMatchObject({
        lastSeq: 4,
        contextUsage:
          prepared.usageEvents[1]?.type === 'context.usage'
            ? prepared.usageEvents[1].usage
            : undefined,
      });
      persistence.close();

      const db = new Database(path, { readonly: true });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM turn_events WHERE type = 'context.compacted'")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM context_fragments WHERE superseded_by_compaction_id IS NOT NULL',
          )
          .get(),
      ).toEqual({ count: 1 });
      db.close();
    });

    it('persists immutable intelligence step snapshots in turn order', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'step snapshot');
      const first = persistence.createIntelligenceStep({
        taskId: task.id,
        turnId: turn.turnId,
        model: 'mock-v1',
        effort: 'low',
        contextDigest: 'a'.repeat(64),
        toolCatalogDigest: 'b'.repeat(64),
        policyEpoch: 0,
        workspaceRevision: 'workspace-v1',
        contractRevision: null,
      });
      persistence.transitionIntelligenceStep(first.stepId, 'sampling');
      persistence.transitionIntelligenceStep(first.stepId, 'sampled');
      persistence.transitionIntelligenceStep(first.stepId, 'completed');
      const second = persistence.createIntelligenceStep({
        taskId: task.id,
        turnId: turn.turnId,
        model: 'mock-v1',
        effort: 'low',
        contextDigest: 'c'.repeat(64),
        toolCatalogDigest: 'b'.repeat(64),
        policyEpoch: 1,
        workspaceRevision: 'workspace-v2',
        contractRevision: 2,
      });

      expect(persistence.listIntelligenceSteps(turn.turnId)).toEqual([
        first,
        { ...second, ordinal: 2 },
      ]);
      persistence.close();

      const db = new Database(path, { readonly: true });
      expect(
        db.prepare('SELECT ordinal, state FROM intelligence_steps ORDER BY ordinal').all(),
      ).toEqual([
        { ordinal: 1, state: 'completed' },
        { ordinal: 2, state: 'prepared' },
      ]);
      db.close();
    });

    it('persists command lifecycle and replays sanitized mixed-stream output in global order', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const started = startExecutingTurn(persistence, task.id);
      const spec = createExecutionSpec({
        absoluteExecutable: process.execPath,
        argv: ['--version'],
        cwdIdentity: { canonicalPath: process.cwd(), identityDigest: 'a'.repeat(64) },
        envDelta: {},
        stdinMode: 'closed',
        shell: 'none',
      });
      const commandInput = {
        id: 'command-1',
        taskId: task.id,
        turnId: started.turnId,
        callId: 'call-1',
        spec,
        purpose: '変更の整合性を確認します',
        risk: 'high' as const,
        createdAt: '2026-07-23T00:00:00.000Z',
      };
      const prepared = persistence.prepareCommand(commandInput);
      expect(prepared.state).toBe('prepared');
      expect(prepared).toMatchObject({
        purpose: '変更の整合性を確認します',
        risk: 'high',
      });
      expect(persistence.beginCommand(prepared.id).state).toBe('starting');
      expect(
        persistence.startCommand({
          commandId: prepared.id,
          pid: 123,
          processStartTime: 'lease-start-1',
          startedAt: '2026-07-23T00:00:01.000Z',
        }).event.type,
      ).toBe('command.started');
      const observed = [
        { seq: 1, stream: 'stdout' as const, text: 'one\n' },
        { seq: 2, stream: 'stderr' as const, text: 'two\n' },
        { seq: 3, stream: 'stdout' as const, text: 'three\n' },
      ];
      for (const chunk of observed)
        persistence.appendCommandOutput({
          commandId: prepared.id,
          ...chunk,
          byteLength: Buffer.byteLength(chunk.text),
          createdAt: '2026-07-23T00:00:02.000Z',
        });
      const completed = persistence.completeCommand({
        commandId: prepared.id,
        state: 'exited',
        exitCode: 0,
        signal: null,
        outputBytes: observed.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text), 0),
        truncated: false,
        finishedAt: '2026-07-23T00:00:03.000Z',
      });
      expect(completed.event.type).toBe('command.completed');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listCommands(task.id)).toMatchObject([
        {
          id: prepared.id,
          purpose: '変更の整合性を確認します',
          risk: 'high',
          state: 'exited',
        },
      ]);
      expect(reopened.listCommandOutput(prepared.id)).toEqual(
        observed.map((chunk) => ({ ...chunk, byteLength: Buffer.byteLength(chunk.text) })),
      );
      expect(
        reopened
          .listEventsAfter(task.id, 0)
          .filter(({ type }) => type.startsWith('command.'))
          .map(({ type }) => type),
      ).toEqual([
        'command.started',
        'command.output',
        'command.output',
        'command.output',
        'command.completed',
      ]);
      reopened.close();

      const tamper = new Database(path);
      tamper
        .prepare(
          'UPDATE command_output_chunks SET content_hash = ? WHERE command_id = ? AND seq = 1',
        )
        .run('0'.repeat(64), prepared.id);
      tamper.close();
      const compromised = new SqlitePersistenceClient(path);
      expect(() => compromised.listCommandOutput(prepared.id)).toThrow(
        'Command output integrity check failed',
      );
      compromised.close();
    });

    it('marks a running command interrupted on restart and never reconnects by PID', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const started = startExecutingTurn(persistence, task.id);
      const spec = createExecutionSpec({
        absoluteExecutable: process.execPath,
        argv: ['--version'],
        cwdIdentity: { canonicalPath: process.cwd(), identityDigest: 'b'.repeat(64) },
        envDelta: {},
        stdinMode: 'closed',
        shell: 'none',
      });
      persistence.prepareCommand({
        id: 'command-interrupted',
        taskId: task.id,
        turnId: started.turnId,
        callId: 'call-interrupted',
        spec,
        purpose: '再起動テスト',
        risk: 'high',
        createdAt: '2026-07-23T00:00:00.000Z',
      });
      persistence.beginCommand('command-interrupted');
      persistence.startCommand({
        commandId: 'command-interrupted',
        pid: 999_999,
        processStartTime: 'old-process',
        startedAt: '2026-07-23T00:00:01.000Z',
      });
      persistence.prepareCommand({
        id: 'command-never-dispatched',
        taskId: task.id,
        turnId: started.turnId,
        callId: 'call-never-dispatched',
        spec,
        purpose: '未開始コマンドテスト',
        risk: 'high',
        createdAt: '2026-07-23T00:00:02.000Z',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getCommand('command-interrupted').state).toBe('interrupted');
      expect(reopened.getCommand('command-never-dispatched').state).toBe('interrupted');
      expect(
        reopened.listEventsAfter(task.id, 0).filter((event) => event.type === 'command.completed'),
      ).toHaveLength(2);
      reopened.close();
    });

    it('seals the exact command before authorization and commits output before publishing it', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const workspacePath = join(path, '..');
      persistence.setWorkspace(task.id, workspacePath);
      const started = startExecutingTurn(persistence, task.id);
      const published: string[] = [];
      let authorizedInput: unknown;
      const broker = createDefaultToolBroker(
        () => persistence.getPermissionPolicy(task.id).policyEpoch,
        (request) => {
          authorizedInput = request.input;
          return { decision: 'allow', reason: 'integration_test' };
        },
        {
          persistence,
          publish: (event) => {
            if (event.type === 'command.output') {
              const replay = persistence.listCommandOutput(event.commandId);
              expect(replay.at(-1)?.seq).toBe(event.outputSeq);
            }
            published.push(event.type);
          },
        },
      );
      startMockTurnCatalog(broker, {
        taskId: task.id,
        turnId: started.turnId,
        workspaceId: 'workspace-1',
        policyEpoch: 0,
      });
      const executable =
        process.platform === 'win32' ? 'C:\\Windows\\System32\\where.exe' : '/usr/bin/printf';
      const argv = process.platform === 'win32' ? ['where'] : ['command-ok\\n'];
      const result = (await broker.dispatch({
        taskId: task.id,
        turnId: started.turnId,
        callId: 'command-call-1',
        providerName: 'run_command',
        input: {
          executable,
          argv,
          cwd: '.',
          purpose: '変更の整合性を確認します',
        },
      })) as { exitCode: number; outputBytes: number };

      expect(result.exitCode).toBe(0);
      expect(authorizedInput).toMatchObject({
        absoluteExecutable: executable,
        argv,
        cwdIdentity: { canonicalPath: expect.any(String), identityDigest: expect.any(String) },
        shell: 'none',
      });
      expect(published[0]).toBe('command.started');
      expect(published.at(-1)).toBe('command.completed');
      const commandEvent = persistence
        .listEventsAfter(task.id, 0)
        .find((event) => event.type === 'command.completed');
      expect(commandEvent).toMatchObject({
        type: 'command.completed',
        command: { state: 'exited' },
      });
      persistence.close();
    });

    it('terminalizes a prepared command when authorization is denied without failing the Turn', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      persistence.setWorkspace(task.id, join(path, '..'));
      const started = startExecutingTurn(persistence, task.id);
      const broker = createDefaultToolBroker(
        () => 0,
        () => ({ decision: 'deny', reason: 'integration_deny' }),
        { persistence, publish: () => undefined },
      );
      startMockTurnCatalog(broker, {
        taskId: task.id,
        turnId: started.turnId,
        workspaceId: 'workspace-1',
        policyEpoch: 0,
      });

      await expect(
        broker.dispatch({
          taskId: task.id,
          turnId: started.turnId,
          callId: 'command-denied',
          providerName: 'run_command',
          input: {
            executable:
              process.platform === 'win32' ? 'C:\\Windows\\System32\\where.exe' : '/usr/bin/printf',
            argv: ['denied'],
            cwd: '.',
            purpose: '拒否時の挙動を確認します',
          },
        }),
      ).rejects.toMatchObject({ name: 'ToolAuthorizationDeniedError' });
      const completed = persistence
        .listEventsAfter(task.id, 0)
        .find(
          (event) =>
            event.type === 'command.completed' && event.command.callId === 'command-denied',
        );
      expect(completed).toMatchObject({
        type: 'command.completed',
        command: { state: 'canceled', pid: null },
      });
      expect(persistence.getActiveTurnId(task.id)).toBe(started.turnId);
      persistence.close();
    });

    it('migrates a v1 database with duplicate active turns without crashing', () => {
      const directory = mkdtempSync(join(tmpdir(), 'vibe-migration-'));
      cleanup.push(directory);
      const path = join(directory, 'legacy.sqlite3');
      createLegacyV1Database(path);

      const persistence = new SqlitePersistenceClient(path);
      expect(persistence.interruptActiveTurns()).toBe(1);
      expect(persistence.listEventsAfter('task-1', 0).map((event) => event.seq)).toEqual([1, 2, 3]);
      persistence.close();

      const migrated = new Database(path, { readonly: true });
      expect(
        migrated.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
      ]);
      expect(
        migrated
          .prepare('PRAGMA table_info(context_fragments)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual([
        'id',
        'task_id',
        'source',
        'trust',
        'token_estimate',
        'created_at',
        'superseded_by_compaction_id',
        'message_id',
      ]);
      expect(
        migrated
          .prepare('PRAGMA table_info(intelligence_steps)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual([
        'id',
        'task_id',
        'turn_id',
        'ordinal',
        'state',
        'model',
        'effort',
        'context_digest',
        'tool_catalog_digest',
        'policy_epoch',
        'workspace_revision',
        'contract_revision',
        'created_at',
        'updated_at',
      ]);
      expect(
        migrated
          .prepare('PRAGMA table_info(approvals)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual([
        'id',
        'task_id',
        'turn_id',
        'item_id',
        'call_id',
        'runtime_instance_id',
        'subject_id',
        'provider_name',
        'tool_id',
        'tool_catalog_digest',
        'schema_digest',
        'spec_digest',
        'policy_epoch',
        'capability',
        'resource_json',
        'operation',
        'provider_egress',
        'sandbox_profile',
        'risk',
        'reason_untrusted',
        'display_json',
        'state',
        'decision',
        'challenge_digest',
        'revision',
        'expires_at',
        'requested_at',
        'resolved_at',
        'decision_operation_id',
        'runtime_call_id',
      ]);
      migrated.close();
    });
  });
else
  describe('SqlitePersistenceClient v16 Electron ABI bridge', () => {
    it('runs the SQLite integration suite with the bundled Electron Node ABI', () => {
      const result = spawnSync(
        join(process.cwd(), '../../node_modules/.bin/electron'),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/persistence.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VIBE_ELECTRON_DB_TEST: '1' },
          timeout: 30_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 35_000);
  });

function createLegacyV1Database(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (1, 'chat-alpha-v1-tasks-messages-turns-events', '2026-01-01T00:00:00.000Z');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT, author TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL REFERENCES messages(id), assistant_message_id TEXT REFERENCES messages(id),
      state TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE turn_events (id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, type TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(turn_id, seq));
    CREATE INDEX messages_task_created_idx ON messages(task_id, created_at, id);
    CREATE INDEX turns_task_state_idx ON turns(task_id, state);
    INSERT INTO tasks VALUES ('task-1', 'legacy', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('message-1', 'task-1', 'turn-1', 'user', 'one', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('message-2', 'task-1', 'turn-2', 'user', 'two', '2026-01-01T00:00:01.000Z');
    INSERT INTO turns VALUES ('turn-1', 'task-1', 'message-1', NULL, 'queued', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO turns VALUES ('turn-2', 'task-1', 'message-2', NULL, 'queued', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z');
    INSERT INTO turn_events VALUES (
      'event-1', 'turn-1', 1, 1, 'turn.accepted',
      '{"type":"turn.accepted","taskId":"task-1","turnId":"turn-1","seq":1,"userMessage":{"id":"message-1","taskId":"task-1","turnId":"turn-1","author":"user","content":"one","createdAt":"2026-01-01T00:00:00.000Z"}}',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO turn_events VALUES (
      'event-2', 'turn-2', 1, 1, 'turn.accepted',
      '{"type":"turn.accepted","taskId":"task-1","turnId":"turn-2","seq":1,"userMessage":{"id":"message-2","taskId":"task-1","turnId":"turn-2","author":"user","content":"two","createdAt":"2026-01-01T00:00:01.000Z"}}',
      '2026-01-01T00:00:01.000Z'
    );
  `);
  db.close();
}
