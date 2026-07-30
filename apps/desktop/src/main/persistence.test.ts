import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ToolRegistry,
  createExecutionSpec,
  createSessionGrant,
  createToolDefinition,
  createToolId,
} from '@sprint-coder/domain';
import { createHash, randomUUID } from 'node:crypto';
import { ApprovalCoordinator } from './approval-coordinator';
import { createDefaultToolBroker, startMockTurnCatalog } from './default-tools';
import { electronTestExecutablePath } from './electron-test-runtime';
import { ToolBroker } from './tool-broker';
import {
  AcceptanceEvidenceMissingError,
  CanvasViewConflictError,
  InvalidCanvasViewError,
  NotFoundError,
  OperationConflictError,
  SqliteEditSagaLeaseGuard,
  SqlitePersistenceClient,
  SteerStaleError,
  TurnActiveError,
  validateCanvasCamera,
  validateCanvasNodePositions,
} from './persistence';
import { structuredPatchDigest, type PreparedStructuredPatch } from './structured-patch';
import {
  EditSagaCrashError,
  EditSagaExecutor,
  PersistenceEditSagaStore,
  journaledPatchDigest,
  stageEditSagaRequest,
  type EditArtifactRepository,
  type EditEffectBoundary,
  type EditSagaStep,
  type OperationObservation,
} from './edit-saga';
import {
  EditArtifactStore,
  createEditArtifactReference,
  type EditArtifactOwner,
  type EditArtifactRef,
} from './edit-artifact-store';
import {
  MutationClockRollbackError,
  MutationLeaseBusyError,
  MutationLeaseStaleError,
  MutationQuarantinedError,
  mutationWorkspaceKey,
  type MutationLeaseToken,
} from './mutation-lease';
import {
  createNativeMutationIntentSeed,
  type NativeMutationIntentSeed,
  type NativeMutationRevision,
} from './native-mutation-intent';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const artifactIt = it.skipIf(process.platform === 'win32');
const commandExecutionIt = it.skipIf(process.platform === 'win32');
const windowsCommandGateIt = it.runIf(process.platform === 'win32');

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createPersistence(
  options: {
    verifyNativeSession?: typeof verifyTestNativeSession;
    invalidateNativeWorkspace?: (workspaceKey: string, minimumFence: string) => void;
  } = {},
): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-persistence-'));
  cleanup.push(directory);
  const path = join(directory, 'test.sqlite3');
  return {
    persistence: new SqlitePersistenceClient(
      path,
      options.verifyNativeSession ?? verifyTestNativeSession,
      options.invalidateNativeWorkspace,
    ),
    path,
  };
}

function verifyTestNativeSession(binding: {
  id: string;
  workspaceKey: string;
  fence: string;
}): void {
  if (
    !['6'.repeat(32), 'b'.repeat(32)].includes(binding.id) ||
    !/^[a-f0-9]{64}$/.test(binding.workspaceKey) ||
    !/^[1-9][0-9]*$/.test(binding.fence)
  )
    throw new MutationLeaseStaleError();
}

function bindMutationWorkspace(
  persistence: SqlitePersistenceClient,
  taskId: string,
  path: string,
  rootIdentityDigest: string,
): string {
  const workspaceKey = mutationWorkspaceKey(path, rootIdentityDigest);
  persistence.setWorkspaceBinding(taskId, { path, workspaceKey, rootIdentityDigest });
  return workspaceKey;
}

if (runsWithElectronAbi)
  describe('provider connections', () => {
    it('seeds stable built-in CLI connections and restores them from SQLite', () => {
      const { persistence, path } = createPersistence();

      expect(persistence.listProviderConnections()).toEqual([
        expect.objectContaining({
          id: 'builtin:claude-cli',
          providerId: 'anthropic',
          runtimeKind: 'builtin_cli',
          displayName: 'Claude CLI',
          enabled: true,
        }),
        expect.objectContaining({
          id: 'builtin:codex-cli',
          providerId: 'openai',
          runtimeKind: 'builtin_cli',
          displayName: 'Codex CLI',
          enabled: true,
        }),
      ]);
      expect(persistence.getProviderConnection('builtin:codex-cli')).toEqual(
        expect.objectContaining({
          id: 'builtin:codex-cli',
          providerId: 'openai',
        }),
      );
      expect(() => persistence.getProviderConnection('missing:connection')).toThrow(NotFoundError);
      const secretReference = 'provider-secret:123e4567-e89b-42d3-a456-426614174000';
      expect(
        persistence.setProviderConnectionSecretReference('builtin:codex-cli', secretReference),
      ).toMatchObject({ id: 'builtin:codex-cli', secretReference });

      persistence.close();
      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listProviderConnections().map(({ id }) => id)).toEqual([
        'builtin:claude-cli',
        'builtin:codex-cli',
      ]);
      expect(reopened.getProviderConnection('builtin:codex-cli').secretReference).toBe(
        secretReference,
      );
      reopened.close();
    });

    it('backfills legacy built-in identity without inferring resolved model', () => {
      const { persistence, path } = createPersistence();
      persistence.setRuntime('codex');
      persistence.setModel('gpt-5.6-sol');
      const task = persistence.createTask('legacy codex task');
      const turn = persistence.startTurn(task.id, 'legacy identity');
      persistence.close();

      const legacy = new Database(path);
      legacy.exec(`
      UPDATE tasks
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL;
      UPDATE turns
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL,
          resolved_provider = NULL, resolved_model = NULL;
      UPDATE agent_threads
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL;
      UPDATE agents
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL;
      DELETE FROM schema_migrations WHERE version = 42;
    `);
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      const selection = {
        connectionId: 'builtin:codex-cli',
        requestedProvider: 'openai',
        requestedModel: 'gpt-5.6-sol',
      };
      expect(migrated.getTaskModelSelection(task.id)).toEqual(selection);
      expect(migrated.getTaskLeader(task.id).modelSelection).toEqual(selection);
      expect(migrated.getTurnModelIdentity(task.id, turn.turnId)).toEqual({
        selection,
        resolution: { resolvedProvider: null, resolvedModel: null },
      });
      migrated.close();
    });

    it('migrates mixed Claude, Codex, and unknown-model history idempotently', () => {
      const { persistence, path } = createPersistence();
      persistence.setRuntime('claude');
      persistence.setModel('claude-opus-history');
      const claudeTask = persistence.createTask('legacy Claude');
      const claudeTurn = persistence.startTurn(claudeTask.id, 'Claude history');
      persistence.promoteTaskToTeam(claudeTask.id);

      persistence.setRuntime('codex');
      persistence.setModel('gpt-codex-history');
      const codexTask = persistence.createTask('legacy Codex');
      const codexTurn = persistence.startTurn(codexTask.id, 'Codex history');
      persistence.promoteTaskToTeam(codexTask.id);

      persistence.setRuntime('claude');
      persistence.setModel('legacy-model-id-that-is-not-in-any-catalog');
      const unknownTask = persistence.createTask('legacy unknown model');
      const unknownTurn = persistence.startTurn(unknownTask.id, 'Unknown model history');
      persistence.promoteTaskToTeam(unknownTask.id);
      persistence.close();

      const legacy = new Database(path);
      legacy.exec(`
      UPDATE tasks
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL;
      UPDATE turns
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL,
          resolved_provider = NULL, resolved_model = NULL;
      UPDATE agent_threads
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL;
      UPDATE agents
      SET connection_id = NULL, requested_provider = NULL, requested_model = NULL;
      DELETE FROM schema_migrations WHERE version = 42;
    `);
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      expect(migrated.getTurnModelIdentity(claudeTask.id, claudeTurn.turnId).selection).toEqual({
        connectionId: 'builtin:claude-cli',
        requestedProvider: 'anthropic',
        requestedModel: 'claude-opus-history',
      });
      expect(migrated.getTurnModelIdentity(codexTask.id, codexTurn.turnId).selection).toEqual({
        connectionId: 'builtin:codex-cli',
        requestedProvider: 'openai',
        requestedModel: 'gpt-codex-history',
      });
      expect(migrated.getTurnModelIdentity(unknownTask.id, unknownTurn.turnId).selection).toEqual({
        connectionId: 'builtin:claude-cli',
        requestedProvider: 'anthropic',
        requestedModel: 'legacy-model-id-that-is-not-in-any-catalog',
      });
      expect(migrated.getTaskLeader(claudeTask.id).modelSelection.connectionId).toBe(
        'builtin:claude-cli',
      );
      expect(migrated.getTaskLeader(codexTask.id).modelSelection.connectionId).toBe(
        'builtin:codex-cli',
      );
      migrated.close();

      // Reopening after every migration row is present is the idempotency fixture: it must preserve
      // the exact unknown value rather than trying to curate or replace it on a second pass.
      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTaskModelSelection(unknownTask.id)?.requestedModel).toBe(
        'legacy-model-id-that-is-not-in-any-catalog',
      );
      expect(reopened.getTeamByTask(claudeTask.id)).not.toBeNull();
      expect(reopened.getTeamByTask(codexTask.id)).not.toBeNull();
      reopened.close();
    });

    it('allows only external Provider rate limits to be lowered', () => {
      const { persistence } = createPersistence();
      const now = new Date().toISOString();
      const external = persistence.createProviderConnection({
        id: 'connection:rate-limit-test',
        providerId: 'openai',
        runtimeKind: 'official_api',
        displayName: 'Rate limit test',
        enabled: true,
        secretReference: null,
        verification: {
          status: 'unverified',
          verifiedAt: null,
          expiresAt: null,
          message: null,
        },
        rateLimit: {
          mode: 'auto',
          maxConcurrentRequests: 2,
          requestsPerMinute: null,
          tokensPerMinute: null,
          lastObservedRateLimitHeaders: null,
        },
        createdAt: now,
        updatedAt: now,
      });

      expect(
        persistence.lowerProviderConnectionRateLimits(external.id, {
          maxConcurrentRequests: 1,
          requestsPerMinute: 30,
        }),
      ).toMatchObject({
        rateLimit: {
          mode: 'manual',
          maxConcurrentRequests: 1,
          requestsPerMinute: 30,
        },
      });
      expect(() =>
        persistence.lowerProviderConnectionRateLimits(external.id, {
          maxConcurrentRequests: 2,
        }),
      ).toThrow('can only be lowered');
      expect(() =>
        persistence.lowerProviderConnectionRateLimits('builtin:codex-cli', {
          maxConcurrentRequests: 1,
        }),
      ).toThrow('Built-in CLI concurrency');
      persistence.close();
    });
  });

class PersistenceTestArtifacts implements EditArtifactRepository {
  readonly values = new Map<string, Buffer>();
  async put(input: { owner: EditArtifactOwner; bytes: Buffer }): Promise<EditArtifactRef> {
    const reference = createEditArtifactReference(input.owner, input.bytes);
    this.values.set(reference.artifactId, Buffer.from(input.bytes));
    return reference;
  }
  async read(reference: EditArtifactRef): Promise<Buffer> {
    const bytes = this.values.get(reference.artifactId);
    if (bytes === undefined) throw new Error('artifact missing');
    return Buffer.from(bytes);
  }
  async release(reference: EditArtifactRef): Promise<void> {
    this.values.delete(reference.artifactId);
  }
}

/** Walks a freshly-started Turn through the stage machine to a clean completion. */
function finishTurn(persistence: SqlitePersistenceClient, taskId: string, turnId: string) {
  for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
    persistence.changeStage(taskId, turnId, stage);
  persistence.completeTurn(taskId, turnId, 'completed');
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
  describe('SqlitePersistenceClient v27', () => {
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

    it('stores Codex work updates separately from the final user-facing conclusion', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, '作業して');
      const messageId = randomUUID();
      for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
        persistence.changeStage(task.id, turn.turnId, stage);
      persistence.appendDelta(
        task.id,
        turn.turnId,
        messageId,
        '調査を開始します。\n\n原因を確認しました。\n\n修正完了です。',
      );

      const event = persistence.completeTurn(task.id, turn.turnId, 'completed', '修正完了です。');

      expect(event).toMatchObject({
        type: 'turn.completed',
        message: {
          content: '修正完了です。',
          workContent: '調査を開始します。\n\n原因を確認しました。',
        },
      });
      expect(persistence.listMessages(task.id).at(-1)).toMatchObject({
        content: '修正完了です。',
        workContent: '調査を開始します。\n\n原因を確認しました。',
      });
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

    it('rejects queued input that cannot be read back', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      expect(() => persistence.queueInput(task.id, '   ', 'blank')).toThrow(
        'Queued input text is invalid',
      );
      expect(() => persistence.queueInput(task.id, 'x'.repeat(100_001), 'too-long')).toThrow(
        'Queued input text is invalid',
      );
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

    it('pins Skill revisions for drafts, Turns, queued input, and restart recovery', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask('skills');
      const selection = {
        kind: 'chat' as const,
        ref: {
          source: 'agents' as const,
          skillId: 'reviewer',
          digest: 'a'.repeat(64),
        },
      };
      const resolved = {
        selection,
        name: 'Reviewer',
        description: 'Review code',
        content: '---\nname: reviewer\ndescription: Review code\n---\n\nReview carefully.',
        packagePath: '/tmp/sprint-coder-skill-revisions/agents/reviewer/a',
      };
      persistence.setDraftSkillSelections(task.id, [selection]);
      expect(persistence.getDraftSkillSelections(task.id)).toEqual([selection]);

      const active = persistence.startTurn(task.id, 'review now', [resolved]);
      expect(active.skills).toEqual([resolved]);
      expect(persistence.getTurnSkills(task.id, active.turnId)).toEqual([resolved]);
      persistence.cancelTurn(task.id, active.turnId);
      persistence.queueInput(task.id, 'review later', 'q-skills', [resolved]);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getDraftSkillSelections(task.id)).toEqual([selection]);
      expect(reopened.snapshot(task.id).queued).toEqual([
        { ordinal: 1, text: 'review later', skills: [selection] },
      ]);
      const queued = reopened.startNextQueued(task.id)?.started;
      expect(queued?.skills).toEqual([resolved]);
      expect(reopened.getTurnSkills(task.id, queued!.turnId)).toEqual([resolved]);
      reopened.close();
    });

    it('takes custody of a generated image and announces it on the Turn event stream', () => {
      // issue #11. The bytes come from a directory the Codex CLI owns, so their *contents* are the
      // only thing worth trusting — hence the magic-byte gate rather than a filename check.
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('payload'),
      ]);
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const started = persistence.startTurn(task.id, '画像を生成して');

      const recorded = persistence.recordGeneratedImage({
        taskId: task.id,
        turnId: started.turnId,
        bytes: png,
      });
      expect(recorded).not.toBeNull();
      expect(recorded?.event.type).toBe('image.generated');
      expect(recorded?.image.mimeType).toBe('image/png');
      expect(recorded?.image.byteLength).toBe(png.byteLength);

      expect(persistence.listGeneratedImages(task.id)).toHaveLength(1);
      const read = persistence.readGeneratedImage(recorded!.image.id);
      expect(read?.bytes.equals(png)).toBe(true);
      persistence.close();
    });

    it('stores the same image once, so a re-run cannot pile up copies or events', () => {
      // The id is a content digest, which is what makes this free rather than a lookup.
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('same'),
      ]);
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const started = persistence.startTurn(task.id, '画像を生成して');
      const input = { taskId: task.id, turnId: started.turnId, bytes: png };

      expect(persistence.recordGeneratedImage(input)).not.toBeNull();
      expect(persistence.recordGeneratedImage(input)).toBeNull();
      expect(persistence.listGeneratedImages(task.id)).toHaveLength(1);
      persistence.close();
    });

    it('refuses anything that is not a PNG by its magic bytes', () => {
      // A file extension is a filter, never evidence — and these bytes end up in a `data:` URL in
      // the renderer, so "display a generated image" must not become "render whatever landed there".
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const started = persistence.startTurn(task.id, '画像を生成して');
      for (const bytes of [
        Buffer.from('<svg onload=alert(1)></svg>'),
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), // JPEG
        Buffer.from([0x89, 0x50, 0x4e, 0x47]), // truncated signature
        Buffer.alloc(0),
      ]) {
        expect(
          persistence.recordGeneratedImage({ taskId: task.id, turnId: started.turnId, bytes }),
        ).toBeNull();
      }
      expect(persistence.listGeneratedImages(task.id)).toEqual([]);
      persistence.close();
    });

    it('returns null for an unknown image id rather than throwing', () => {
      const { persistence } = createPersistence();
      expect(persistence.readGeneratedImage('a'.repeat(64))).toBeNull();
      persistence.close();
    });

    it('names a new Task from its first message without implicitly setting its Goal', () => {
      // issue #4: the only path that ever set a Task title was the header's inline rename, so the
      // sidebar filled up with rows all reading "新しいタスク".
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      expect(task.title).toBe('新しいタスク');
      expect(task.hasConversation).toBe(false);
      expect(persistence.listTasks()[0]?.hasConversation).toBe(false);

      const started = persistence.startTurn(task.id, 'ログイン画面のバグを直して');
      expect(started.renamedTask?.title).toBe('ログイン画面のバグを直して');
      expect(started.renamedTask?.goal).toBeNull();
      expect(started.renamedTask?.hasConversation).toBe(true);
      expect(persistence.getTask(task.id).title).toBe('ログイン画面のバグを直して');
      expect(persistence.getTask(task.id).goal).toBeNull();
      expect(persistence.listTasks()[0]?.hasConversation).toBe(true);
      persistence.close();
    });

    it('never renames again after the first message', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const first = persistence.startTurn(task.id, '最初の依頼');
      finishTurn(persistence, task.id, first.turnId);

      const second = persistence.startTurn(task.id, '全く違う二通目の内容');
      expect(second.renamedTask).toBeUndefined();
      expect(persistence.getTask(task.id).title).toBe('最初の依頼');
      expect(persistence.getTask(task.id).goal).toBeNull();
      persistence.close();
    });

    it('preserves an explicit Goal when the first message starts the Task', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      persistence.setGoal(task.id, '先に決めたGoal');

      persistence.startTurn(task.id, '最初の依頼');

      expect(persistence.getTask(task.id).goal).toBe('先に決めたGoal');
      persistence.close();
    });

    it('does not derive a Goal from normal messages', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const first = persistence.startTurn(task.id, '最初の依頼');
      finishTurn(persistence, task.id, first.turnId);
      persistence.setGoal(task.id, '');

      persistence.startTurn(task.id, '後続メッセージ');

      expect(persistence.getTask(task.id).goal).toBe('');
      persistence.close();
    });

    it('never overwrites a title the user set by hand', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      persistence.renameTask(task.id, '自分で付けた名前');

      const started = persistence.startTurn(task.id, 'この内容では上書きされないはず');
      expect(started.renamedTask).toBeUndefined();
      expect(persistence.getTask(task.id).title).toBe('自分で付けた名前');
      persistence.close();
    });

    it('respects a manual rename that happens to match the placeholder', () => {
      // Guarded by title_source rather than by comparing against the placeholder string: a user who
      // renames a Task to literally "新しいタスク" still owns that name.
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      persistence.renameTask(task.id, '新しいタスク');

      expect(persistence.startTurn(task.id, '上書きされないはず').renamedTask).toBeUndefined();
      expect(persistence.getTask(task.id).title).toBe('新しいタスク');
      persistence.close();
    });

    it('keeps an explicit createTask title out of auto-naming', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask('呼び出し側が決めた名前');

      expect(persistence.startTurn(task.id, '上書きされないはず').renamedTask).toBeUndefined();
      expect(persistence.getTask(task.id).title).toBe('呼び出し側が決めた名前');
      persistence.close();
    });

    it('leaves the placeholder and stays eligible when a message yields no usable title', () => {
      // "命名に失敗しても会話自体は継続する": the Turn starts normally, the title is untouched, and
      // the *next* message still gets a chance to name the Task.
      const { persistence } = createPersistence();
      const task = persistence.createTask();

      const first = persistence.startTurn(task.id, '```\njust code\n```');
      expect(first.turnId).toBeTruthy();
      expect(first.renamedTask).toBeUndefined();
      expect(persistence.getTask(task.id).title).toBe('新しいタスク');
      finishTurn(persistence, task.id, first.turnId);

      const second = persistence.startTurn(task.id, '今度は名前になる依頼');
      expect(second.renamedTask?.title).toBe('今度は名前になる依頼');
      persistence.close();
    });

    it('tells "never chose" apart from "chose mock", so a real CLI can be adopted once', () => {
      // Issue #50: the app used to start on Mock even with a real CLI installed, and Mock emits
      // plausible-looking code instantly — which reads as the app working rather than as a
      // stand-in. Main adopts an installed CLI on first run, and the only thing that makes that
      // safe is this distinction: a user who deliberately picked Mock must not have it replaced on
      // every launch.
      const { persistence, path } = createPersistence();
      expect(persistence.getStoredRuntime()).toBeNull();
      expect(persistence.getRuntime()).toBe('mock');

      persistence.setRuntime('mock');
      expect(persistence.getStoredRuntime()).toBe('mock');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getStoredRuntime()).toBe('mock');
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

    it('remaps a retired Claude model id so an old preference does not pin an older model', () => {
      // issue #7: `opus` was the catalog id for the top Claude tier, but on CLI 2.1.218 that
      // alias resolves to claude-opus-4-8, so the catalog pins claude-opus-5 explicitly. A
      // preference stored before that change has to follow — ipc.ts's unknown-model fallback only
      // fixes what the picker displays, while startTurn reads getModel() straight through.
      const { persistence, path } = createPersistence();
      persistence.setRuntime('claude');
      persistence.setModel('opus');
      expect(persistence.getModel()).toBe('claude-opus-5');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getModel()).toBe('claude-opus-5');
      const task = reopened.createTask();
      expect(reopened.startTurn(task.id, 'run on the top tier')).toMatchObject({
        runtimeKind: 'claude',
        model: 'claude-opus-5',
      });
      reopened.close();
    });

    it('leaves a Codex model named like a retired Claude id alone', () => {
      // The settings row is shared between Codex and mock, so the remap has to be kind-scoped.
      const { persistence } = createPersistence();
      persistence.setRuntime('codex');
      persistence.setModel('opus');
      expect(persistence.getModel()).toBe('opus');
      persistence.close();
    });

    it('defaults to medium and persists the selected Claude effort across restart', () => {
      const { persistence, path } = createPersistence();
      expect(persistence.getEffort()).toBe('medium');
      persistence.setEffort('high');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getEffort()).toBe('high');
      reopened.close();
    });

    it('keeps the Codex effort under its own key so the two providers do not clobber each other', () => {
      // issue #6: Claude's effort is a fixed enum, Codex's is per-model and includes values Claude
      // has never heard of (and vice versa: `ultracode`). Sharing one key would mean switching
      // Runtime silently rewrote the other provider's preference into a value it cannot use.
      const { persistence, path } = createPersistence();
      expect(persistence.getCodexEffort()).toBe('');
      persistence.setEffort('xhigh');
      persistence.setCodexEffort('ultra');
      expect(persistence.getEffort()).toBe('xhigh');
      expect(persistence.getCodexEffort()).toBe('ultra');
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getEffort()).toBe('xhigh');
      expect(reopened.getCodexEffort()).toBe('ultra');
      // Deliberately not validated against a fixed enum here — the authority is the CLI's
      // per-model cache, and the settings read clamps. But a value that could not be a level id at
      // all is treated as absent rather than handed to the CLI.
      reopened.setCodexEffort('not a level');
      expect(reopened.getCodexEffort()).toBe('');
      reopened.close();
    });

    it('keeps the Claude effort setting independent of the active Runtime kind (unlike model)', () => {
      const { persistence } = createPersistence();
      persistence.setEffort('xhigh');
      persistence.setRuntime('codex');
      expect(persistence.getEffort()).toBe('xhigh');
      persistence.setRuntime('claude');
      expect(persistence.getEffort()).toBe('xhigh');
      persistence.close();
    });

    it('defaults Team model Web research off and persists an explicit choice across restart', () => {
      const { persistence, path } = createPersistence();
      expect(persistence.getTeamModelResearchBeforeHiring()).toBe(false);
      persistence.setTeamModelResearchBeforeHiring(true);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamModelResearchBeforeHiring()).toBe(true);
      reopened.setTeamModelResearchBeforeHiring(false);
      expect(reopened.getTeamModelResearchBeforeHiring()).toBe(false);
      reopened.close();
    });

    it('defaults Team models to all and persists a selected-model restriction across restart', () => {
      const { persistence, path } = createPersistence();
      expect(persistence.getTeamModelRestriction()).toEqual({
        mode: 'all',
        allowedModels: [],
      });
      persistence.setTeamModelRestriction({
        mode: 'selected',
        allowedModels: [
          {
            connectionId: 'builtin:codex-cli',
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
          },
        ],
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTeamModelRestriction()).toEqual({
        mode: 'selected',
        allowedModels: [
          {
            connectionId: 'builtin:codex-cli',
            providerId: 'openai',
            modelId: 'gpt-5.6-sol',
          },
        ],
      });
      reopened.close();
    });

    it('applies default Team policy only when a new Team is promoted', () => {
      const { persistence, path } = createPersistence();
      expect(persistence.getDefaultTeamPolicy()).toEqual({
        maxAgentDepth: 4,
        maxConcurrentExecutions: 8,
        allowWorkerDirectMessages: true,
        budgetMode: 'bounded',
      });
      persistence.setDefaultTeamPolicy({
        maxAgentDepth: 3,
        maxConcurrentExecutions: 6,
        allowWorkerDirectMessages: false,
        budgetMode: 'unlimited',
      });
      const firstTask = persistence.createTask('first');
      const firstTeam = persistence.promoteTaskToTeam(firstTask.id);
      expect(firstTeam.policy).toEqual({
        maxAgentDepth: 3,
        maxConcurrentExecutions: 6,
        allowWorkerDirectMessages: false,
        budgetMode: 'unlimited',
      });
      persistence.setDefaultTeamPolicy({
        maxAgentDepth: 2,
        maxConcurrentExecutions: 4,
        allowWorkerDirectMessages: true,
        budgetMode: 'bounded',
      });
      expect(persistence.getTeam(firstTeam.id).policy.maxAgentDepth).toBe(3);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getDefaultTeamPolicy().maxAgentDepth).toBe(2);
      const secondTask = reopened.createTask('second');
      expect(reopened.promoteTaskToTeam(secondTask.id).policy.maxAgentDepth).toBe(2);
      reopened.close();
    });

    it('pins the selected runtime and model when a Turn is accepted', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      persistence.setRuntime('codex');
      persistence.setModel('gpt-5.6-terra');

      const started = persistence.startTurn(task.id, 'use the selected model');
      persistence.setRuntime('mock');
      persistence.setModel('auto');

      expect(started).toMatchObject({
        runtimeKind: 'codex',
        model: 'gpt-5.6-terra',
      });
      persistence.close();
    });

    it('durably journals Edit Saga state before effects and restores it after restart', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'edit safely');
      const applyRequest = {
        id: 'saga-1',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'edit-operation-1',
        plan: persistedEditPlan('SENSITIVE_PRE_SENTINEL_7F31', 'SENSITIVE_POST_SENTINEL_9A42'),
        createdAt: '2026-07-23T00:00:00.000Z',
      } as const;
      const request = await stageEditSagaRequest(applyRequest, new PersistenceTestArtifacts());
      const prepared = persistence.prepareEditSaga(request);
      const inspection = new Database(path, { readonly: true });
      const stored = inspection
        .prepare('SELECT snapshot_json FROM edit_sagas WHERE id = ?')
        .pluck()
        .get('saga-1') as string;
      inspection.close();
      expect(stored).not.toContain('SENSITIVE_PRE_SENTINEL_7F31');
      expect(stored).not.toContain('SENSITIVE_POST_SENTINEL_9A42');
      expect(stored).not.toContain('preImage');
      expect(stored).not.toContain('postImage');
      for (const databaseFile of [path, `${path}-wal`, `${path}-shm`]) {
        if (!existsSync(databaseFile)) continue;
        const bytes = readFileSync(databaseFile).toString('utf8');
        expect(bytes).not.toContain('SENSITIVE_PRE_SENTINEL_7F31');
        expect(bytes).not.toContain('SENSITIVE_POST_SENTINEL_9A42');
      }
      const applying = persistence.updateEditSaga(prepared.id, prepared.revision, (current) => {
        const { revision: _revision, ...snapshot } = current;
        return {
          ...snapshot,
          state: 'applying',
          steps: current.steps.map((step) => ({ ...step, state: 'effect_pending' as const })),
          updatedAt: '2026-07-23T00:00:01.000Z',
        };
      });
      expect(applying.revision).toBe(1);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listRecoverableEditSagas()).toEqual([
        expect.objectContaining({ id: 'saga-1', state: 'applying', revision: 1 }),
      ]);
      expect(reopened.prepareEditSaga(request)).toMatchObject({ id: 'saga-1', revision: 1 });
      expect(() =>
        reopened.prepareEditSaga({
          ...request,
          planDigest: 'f'.repeat(64),
        }),
      ).toThrow(OperationConflictError);
      reopened.close();
    });

    it('persists the Acceptance Contract and refuses completion before edit evidence exists', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'edit with evidence');
      expect(persistence.getAcceptanceContract(task.id, turn.turnId)).toMatchObject({
        revision: 1,
        taskKind: 'answer',
        profile: 'quick',
        criteria: [],
      });

      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'acceptance-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'acceptance-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );

      expect(persistence.getAcceptanceContract(task.id, turn.turnId)).toMatchObject({
        revision: 2,
        taskKind: 'edit',
        profile: 'standard',
        criteria: expect.arrayContaining([
          expect.objectContaining({
            id: `edit-saga:${saga.id}`,
            evidenceKind: 'edit_saga_committed',
            subjectDigest: saga.planDigest,
          }),
          expect.objectContaining({
            id: `verification:${saga.id}`,
            evidenceKind: 'verification_passed',
            subjectDigest: saga.planDigest,
          }),
        ]),
      });
      expect(persistence.listEvidenceRecords(task.id, turn.turnId)).toEqual([]);
      expect(() => persistence.completeTurn(task.id, turn.turnId, 'completed')).toThrow(
        AcceptanceEvidenceMissingError,
      );
      persistence.close();

      const legacy = new Database(path);
      const row = legacy
        .prepare(
          'SELECT snapshot_json FROM acceptance_contracts WHERE turn_id = ? AND revision = 2',
        )
        .get(turn.turnId) as { snapshot_json: string };
      const snapshot = JSON.parse(row.snapshot_json) as {
        digest: string;
        criteria: { id: string }[];
        [key: string]: unknown;
      };
      const { digest: _digest, ...facts } = snapshot;
      facts.criteria = snapshot.criteria.filter(
        (criterion) => criterion.id !== `verification:${saga.id}`,
      );
      const digest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
      legacy
        .prepare(
          `UPDATE acceptance_contracts SET digest = ?, snapshot_json = ?
           WHERE turn_id = ? AND revision = 2`,
        )
        .run(digest, JSON.stringify({ ...facts, digest }), turn.turnId);
      legacy.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getAcceptanceContract(task.id, turn.turnId)).toMatchObject({
        revision: 3,
        criteria: expect.arrayContaining([
          expect.objectContaining({ id: `verification:${saga.id}` }),
        ]),
      });
      reopened.close();
    });

    it('rejects a persisted Edit plan whose sealed operation payload was modified', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'tamper test');
      persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'tamper-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'tamper-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      persistence.close();
      const raw = new Database(path);
      const row = raw
        .prepare('SELECT snapshot_json FROM edit_sagas WHERE id = ?')
        .get('tamper-saga') as {
        snapshot_json: string;
      };
      const snapshot = JSON.parse(row.snapshot_json) as {
        steps: { operation: { canonicalPath: string } }[];
      };
      snapshot.steps[0]!.operation.canonicalPath = '/outside/modified.ts';
      raw
        .prepare('UPDATE edit_sagas SET snapshot_json = ? WHERE id = ?')
        .run(JSON.stringify(snapshot), 'tamper-saga');
      raw.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(() => reopened.getEditSaga('tamper-saga')).toThrow('journal digest mismatch');
      reopened.close();
    });

    it('reconciles a crash-unknown Edit effect from the durable journal without replay', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'edit then crash');
      let content = 'before';
      let applyCount = 0;
      const boundary: EditEffectBoundary = {
        async apply() {
          applyCount += 1;
          content = 'after';
          return persistedObservation('after', 'post-identity');
        },
        async observe() {
          return content === 'before'
            ? {
                state: 'pre' as const,
                observation: persistedObservation('before', 'pre-identity'),
              }
            : content === 'after'
              ? {
                  state: 'post' as const,
                  observation: persistedObservation('after', 'post-identity'),
                }
              : {
                  state: 'drift' as const,
                  observation: persistedObservation(content, 'drift-identity'),
                };
        },
        async restore() {
          content = 'before';
          return persistedObservation('before', 'restored-identity');
        },
      };
      const request = {
        id: 'crash-saga',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'crash-operation',
        plan: persistedEditPlan(),
        createdAt: '2026-07-23T00:00:00.000Z',
      } as const;
      const artifacts = new PersistenceTestArtifacts();
      await expect(
        new EditSagaExecutor(new PersistenceEditSagaStore(persistence), boundary, artifacts, {
          hit(point) {
            if (point.kind === 'afterEffectBeforeJournal') throw new EditSagaCrashError('crash');
          },
        }).apply(request),
      ).rejects.toBeInstanceOf(EditSagaCrashError);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      const recovered = await new EditSagaExecutor(
        new PersistenceEditSagaStore(reopened),
        boundary,
        artifacts,
      ).recover('crash-saga');
      expect(recovered.state).toBe('recovery_required');
      expect(content).toBe('after');
      expect(applyCount).toBe(1);
      reopened.close();
    });

    artifactIt('reopens real artifacts and a real file before compensating a restart', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'durable artifact restart');
      const workspaceFile = join(dirname(path), 'workspace.txt');
      const artifactRoot = join(dirname(path), 'edit-artifacts');
      writeFileSync(workspaceFile, 'before');
      const artifacts = await EditArtifactStore.open({
        rootPath: artifactRoot,
        quotaBytes: 4096,
      });
      const boundary = fileBoundary(workspaceFile, artifacts);
      const request = {
        id: 'disk-saga',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'disk-operation',
        plan: persistedEditPlan(),
        createdAt: '2026-07-23T00:00:00.000Z',
      } as const;
      await expect(
        new EditSagaExecutor(new PersistenceEditSagaStore(persistence), boundary, artifacts, {
          hit(point) {
            if (point.kind === 'beforeFinalize') throw new EditSagaCrashError('restart');
          },
        }).apply(request),
      ).rejects.toBeInstanceOf(EditSagaCrashError);
      expect(readFileSync(workspaceFile, 'utf8')).toBe('after');
      persistence.close();

      const reopenedPersistence = new SqlitePersistenceClient(path);
      const reopenedArtifacts = await EditArtifactStore.open({
        rootPath: artifactRoot,
        quotaBytes: 4096,
      });
      const recovered = await new EditSagaExecutor(
        new PersistenceEditSagaStore(reopenedPersistence),
        fileBoundary(workspaceFile, reopenedArtifacts),
        reopenedArtifacts,
      ).reconcileAll();
      expect(recovered).toEqual([expect.objectContaining({ id: 'disk-saga', state: 'restored' })]);
      expect(readFileSync(workspaceFile, 'utf8')).toBe('before');
      expect(
        await new EditSagaExecutor(
          new PersistenceEditSagaStore(reopenedPersistence),
          fileBoundary(workspaceFile, reopenedArtifacts),
          reopenedArtifacts,
        ).reconcileAll(),
      ).toEqual([]);
      reopenedPersistence.close();
    });

    artifactIt('retries durable terminal artifact cleanup after restart', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const turn = persistence.startTurn(task.id, 'terminal cleanup restart');
      const workspaceFile = join(dirname(path), 'cleanup-workspace.txt');
      const artifactRoot = join(dirname(path), 'cleanup-artifacts');
      writeFileSync(workspaceFile, 'before');
      const artifacts = await EditArtifactStore.open({
        rootPath: artifactRoot,
        quotaBytes: 4096,
      });
      await expect(
        new EditSagaExecutor(
          new PersistenceEditSagaStore(persistence),
          fileBoundary(workspaceFile, artifacts),
          artifacts,
          {
            hit(point) {
              if (point.kind === 'afterTerminalBeforeCleanup')
                throw new EditSagaCrashError('terminal cleanup crash');
            },
          },
        ).apply({
          id: 'cleanup-saga',
          taskId: task.id,
          turnId: turn.turnId,
          operationId: 'cleanup-operation',
          plan: persistedEditPlan(),
          createdAt: '2026-07-23T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(EditSagaCrashError);
      expect(persistence.getEditSaga('cleanup-saga')).toMatchObject({
        state: 'committed',
        artifactCleanupPending: true,
      });
      expect(persistence.listEvidenceRecords(task.id, turn.turnId)).toEqual([
        expect.objectContaining({
          criterionId: 'edit-saga:cleanup-saga',
          kind: 'edit_saga_committed',
          trust: 'main-observed',
        }),
      ]);
      expect(
        persistence.recordAssuranceVerification({
          taskId: task.id,
          turnId: turn.turnId,
          sagaId: 'cleanup-saga',
          outcome: 'failed',
          failureClass: 'infrastructure',
          createdAt: '2026-07-23T00:00:03.000Z',
        }),
      ).toMatchObject({ decision: 'retry_verification', repairRoundsUsed: 0 });
      expect(
        persistence.recordAssuranceVerification({
          taskId: task.id,
          turnId: turn.turnId,
          sagaId: 'cleanup-saga',
          outcome: 'failed',
          failureClass: 'verification',
          createdAt: '2026-07-23T00:00:04.000Z',
        }),
      ).toMatchObject({ decision: 'repair', repairRoundsUsed: 1 });
      expect(
        persistence.recordAssuranceVerification({
          taskId: task.id,
          turnId: turn.turnId,
          sagaId: 'cleanup-saga',
          outcome: 'passed',
          failureClass: null,
          createdAt: '2026-07-23T00:00:05.000Z',
        }),
      ).toMatchObject({ decision: 'complete', repairRoundsUsed: 1 });
      expect(persistence.listAssuranceRounds(task.id, turn.turnId, 'cleanup-saga')).toHaveLength(3);
      expect(persistence.listEvidenceRecords(task.id, turn.turnId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            criterionId: 'verification:cleanup-saga',
            kind: 'verification_passed',
            producer: 'assurance-controller',
          }),
        ]),
      );
      persistence.changeStage(task.id, turn.turnId, 'understanding');
      persistence.changeStage(task.id, turn.turnId, 'planning');
      persistence.changeStage(task.id, turn.turnId, 'executing');
      persistence.changeStage(task.id, turn.turnId, 'synthesizing');
      expect(() => persistence.completeTurn(task.id, turn.turnId, 'completed')).not.toThrow();
      persistence.close();

      const reopenedPersistence = new SqlitePersistenceClient(path);
      const reopenedArtifacts = await EditArtifactStore.open({
        rootPath: artifactRoot,
        quotaBytes: 4096,
      });
      const reconciled = await new EditSagaExecutor(
        new PersistenceEditSagaStore(reopenedPersistence),
        fileBoundary(workspaceFile, reopenedArtifacts),
        reopenedArtifacts,
      ).reconcileAll();
      expect(reconciled).toEqual([
        expect.objectContaining({ state: 'committed', artifactCleanupPending: false }),
      ]);
      expect(readFileSync(workspaceFile, 'utf8')).toBe('after');
      expect(await import('node:fs/promises').then(({ readdir }) => readdir(artifactRoot))).toEqual(
        [],
      );
      reopenedPersistence.close();
    });

    it('fences concurrent workspace mutation leases across SQLite clients', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/shared',
        'a'.repeat(64),
      );
      const turn = persistence.startTurn(task.id, 'lease test');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'lease-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'lease-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const base = {
        workspaceKey,
        rootIdentityDigest: 'a'.repeat(64),
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward' as const,
        policyEpoch: 0,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T00:01:01.000Z',
      };
      const first = persistence.acquireMutationLease({ ...base, holderInstanceId: 'instance-a' });
      const secondClient = new SqlitePersistenceClient(path);
      expect(() =>
        secondClient.acquireMutationLease({ ...base, holderInstanceId: 'instance-b' }),
      ).toThrow(MutationLeaseBusyError);
      persistence.releaseMutationLease(first, '2026-07-23T00:00:02.000Z');

      const second = secondClient.acquireMutationLease({
        ...base,
        holderInstanceId: 'instance-b',
        now: '2026-07-23T00:00:03.000Z',
        expiresAt: '2026-07-23T00:01:03.000Z',
      });
      expect(second.fence).toBeGreaterThan(first.fence);
      expect(() => persistence.releaseMutationLease(first, '2026-07-23T00:00:04.000Z')).toThrow(
        MutationLeaseStaleError,
      );
      secondClient.releaseMutationLease(second, '2026-07-23T00:00:05.000Z');
      secondClient.close();
      persistence.close();
    });

    it('allows only one concurrent Edit Saga executor to reach the effect boundary', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '9'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/executor',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'executor fence');
      const request = {
        id: 'executor-fence-saga',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'executor-fence-operation',
        plan: persistedEditPlan(),
        mutationBinding: { workspaceKey, rootIdentityDigest },
        createdAt: '2026-07-23T00:00:00.000Z',
      } as const;
      const artifacts = new PersistenceTestArtifacts();
      persistence.prepareEditSaga(await stageEditSagaRequest(request, artifacts));
      const secondClient = new SqlitePersistenceClient(path);
      let effectCount = 0;
      let releaseEffect!: () => void;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const effectGate = new Promise<void>((resolve) => {
        releaseEffect = resolve;
      });
      const post = persistedObservation('after', `file:${editHash('after')}`);
      const boundary: EditEffectBoundary = {
        async apply(_step, lease) {
          expect(lease).not.toBeNull();
          effectCount += 1;
          signalStarted();
          await effectGate;
          return post;
        },
        async observe(_step, lease) {
          expect(lease).not.toBeNull();
          return { state: 'post', observation: post };
        },
        async restore(_step, _expected, lease) {
          expect(lease).not.toBeNull();
          return persistedObservation('before', `file:${editHash('before')}`);
        },
      };
      const now = () => new Date('2026-07-23T00:00:01.000Z');
      const firstExecutor = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'executor-a', now),
      );
      const secondExecutor = new EditSagaExecutor(
        new PersistenceEditSagaStore(secondClient),
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(secondClient, 'executor-b', now),
      );
      const first = firstExecutor.apply(request);
      await started;
      await expect(secondExecutor.apply(request)).rejects.toBeInstanceOf(MutationLeaseBusyError);
      expect(effectCount).toBe(1);
      releaseEffect();
      await expect(first).resolves.toMatchObject({ state: 'committed' });
      expect(effectCount).toBe(1);
      secondClient.close();
      persistence.close();
    });

    it('does not publish an effect result after its lease is fenced', async () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '8'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/fenced-result',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'fenced result');
      const request = {
        id: 'fenced-result-saga',
        taskId: task.id,
        turnId: turn.turnId,
        operationId: 'fenced-result-operation',
        plan: persistedEditPlan(),
        mutationBinding: { workspaceKey, rootIdentityDigest },
        createdAt: new Date().toISOString(),
      } as const;
      let releaseEffect!: () => void;
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseEffect = resolve;
      });
      const post = persistedObservation('after', `file:${editHash('after')}`);
      const boundary: EditEffectBoundary = {
        async apply() {
          signalStarted();
          await gate;
          return post;
        },
        async observe() {
          return { state: 'post', observation: post };
        },
        async restore() {
          return persistedObservation('before', `file:${editHash('before')}`);
        },
      };
      const artifacts = new PersistenceTestArtifacts();
      const executor = new EditSagaExecutor(
        new PersistenceEditSagaStore(persistence),
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'fenced-result-instance'),
      );
      const applying = executor.apply(request);
      await started;
      persistence.setAccessPreset(task.id, 'auto');
      releaseEffect();
      await expect(applying).rejects.toBeInstanceOf(MutationLeaseStaleError);
      expect(persistence.getEditSaga(request.id)).toMatchObject({
        state: 'applying',
        steps: [expect.objectContaining({ state: 'effect_pending', postObservation: null })],
      });
      persistence.close();
    });

    it('keeps lease bindings isolated for parallel Sagas sharing one persistence store', async () => {
      const { persistence } = createPersistence();
      const taskA = persistence.createTask();
      const taskB = persistence.createTask();
      const rootA = 'a'.repeat(64);
      const rootB = 'b'.repeat(64);
      const workspaceA = bindMutationWorkspace(persistence, taskA.id, '/parallel/a', rootA);
      const workspaceB = bindMutationWorkspace(persistence, taskB.id, '/parallel/b', rootB);
      const turnA = persistence.startTurn(taskA.id, 'parallel a');
      const turnB = persistence.startTurn(taskB.id, 'parallel b');
      const requestA = {
        id: 'parallel-saga-a',
        taskId: taskA.id,
        turnId: turnA.turnId,
        operationId: 'parallel-operation-a',
        plan: persistedEditPlan('before-a', 'after-a'),
        mutationBinding: { workspaceKey: workspaceA, rootIdentityDigest: rootA },
        createdAt: new Date().toISOString(),
      } as const;
      const requestB = {
        id: 'parallel-saga-b',
        taskId: taskB.id,
        turnId: turnB.turnId,
        operationId: 'parallel-operation-b',
        plan: persistedEditPlan('before-b', 'after-b'),
        mutationBinding: { workspaceKey: workspaceB, rootIdentityDigest: rootB },
        createdAt: new Date().toISOString(),
      } as const;
      const releases = new Map<string, () => void>();
      const started = new Set<string>();
      let signalBoth!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        signalBoth = resolve;
      });
      const boundary: EditEffectBoundary = {
        async apply(step) {
          const id = step.operation.postHash!;
          started.add(id);
          if (started.size === 2) signalBoth();
          await new Promise<void>((resolve) => releases.set(id, resolve));
          const value = id === editHash('after-a') ? 'after-a' : 'after-b';
          return persistedObservation(value, `file:${editHash(value)}`);
        },
        async observe(step) {
          const value = step.operation.postHash === editHash('after-a') ? 'after-a' : 'after-b';
          return {
            state: 'post',
            observation: persistedObservation(value, `file:${editHash(value)}`),
          };
        },
        async restore(step) {
          const value = step.operation.preHash === editHash('before-a') ? 'before-a' : 'before-b';
          return persistedObservation(value, `file:${editHash(value)}`);
        },
      };
      const store = new PersistenceEditSagaStore(persistence);
      const artifacts = new PersistenceTestArtifacts();
      const first = new EditSagaExecutor(
        store,
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'parallel-instance-a'),
      ).apply(requestA);
      const second = new EditSagaExecutor(
        store,
        boundary,
        artifacts,
        undefined,
        new SqliteEditSagaLeaseGuard(persistence, 'parallel-instance-b'),
      ).apply(requestB);
      await bothStarted;
      releases.get(editHash('after-a'))!();
      await expect(first).resolves.toMatchObject({ state: 'committed' });
      releases.get(editHash('after-b'))!();
      await expect(second).resolves.toMatchObject({ state: 'committed' });
      persistence.close();
    });

    it('durably stages a lease-bound Native mutation intent before the Saga effect', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '8'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'journal native mutation');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'native-intent-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'native-intent-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const token = persistence.acquireMutationLease({
        workspaceKey,
        rootIdentityDigest,
        holderInstanceId: 'native-intent-instance',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward',
        policyEpoch: saga.policyEpoch,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T00:01:01.000Z',
      });
      const seed = persistedNativeIntentSeed(saga, token);
      const untrustedPersistence = new SqlitePersistenceClient(path);
      expect(() =>
        untrustedPersistence.prepareNativeMutationIntent(seed, token, '2026-07-23T00:00:01.000Z'),
      ).toThrow(MutationLeaseStaleError);
      untrustedPersistence.close();
      const { version: _version, seedDigest: _seedDigest, ...seedInput } = seed;
      expect(() =>
        persistence.prepareNativeMutationIntent(
          createNativeMutationIntentSeed({
            ...seedInput,
            sourceSegments: ['src', 'other.ts'],
          }),
          token,
          '2026-07-23T00:00:01.000Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      expect(() =>
        persistence.prepareNativeMutationIntent(
          createNativeMutationIntentSeed({
            ...seedInput,
            artifact: { ...seed.artifact!, contentHash: '0'.repeat(64) },
          }),
          token,
          '2026-07-23T00:00:01.000Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      let intent = persistence.prepareNativeMutationIntent(seed, token, '2026-07-23T00:00:01.000Z');
      expect(
        persistence.prepareNativeMutationIntent(seed, token, '2026-07-23T00:00:01.000Z'),
      ).toEqual(intent);
      const concurrent = new SqlitePersistenceClient(path, verifyTestNativeSession);
      expect(
        concurrent.prepareNativeMutationIntent(seed, token, '2026-07-23T00:00:01.000Z'),
      ).toEqual(intent);
      expect(() =>
        concurrent.prepareNativeMutationIntent(
          createNativeMutationIntentSeed({
            ...seedInput,
            expectedSource: {
              ...seed.expectedSource,
              identityDigest: 'f'.repeat(64),
            } as NativeMutationRevision,
          }),
          token,
          '2026-07-23T00:00:01.000Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      expect(intent).toMatchObject({
        state: 'planned',
        leaseFence: String(token.fence),
        temp: { role: 'post_temp' },
      });
      const inspection = new Database(path, { readonly: true });
      expect(
        inspection
          .prepare('SELECT state, snapshot_json FROM native_mutation_intents WHERE id = ?')
          .get(intent.id),
      ).toMatchObject({ state: 'planned', snapshot_json: expect.not.stringContaining('before') });
      inspection.close();

      intent = persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        token,
        '2026-07-23T00:00:01.100Z',
        seed.nativeSessionId,
        { state: 'aux_pending' },
      );
      expect(
        concurrent.updateNativeMutationIntent(
          intent.id,
          0,
          token,
          '2026-07-23T00:00:01.100Z',
          seed.nativeSessionId,
          { state: 'aux_pending' },
        ),
      ).toEqual(intent);
      expect(() =>
        concurrent.updateNativeMutationIntent(
          intent.id,
          0,
          token,
          '2026-07-23T00:00:01.100Z',
          seed.nativeSessionId,
          { state: 'effect_pending' },
        ),
      ).toThrow(OperationConflictError);
      const renewed = persistence.renewMutationLease(
        token,
        '2026-07-23T00:00:01.500Z',
        '2026-07-23T00:01:01.500Z',
      );
      const staged: NativeMutationRevision = {
        state: 'present',
        identityDigest: '9'.repeat(64),
        contentHash: intent.temp!.expectedContentHash,
        size: intent.temp!.expectedSize,
        mode: 0o100600,
        nlink: 1,
      };
      expect(() =>
        persistence.updateNativeMutationIntent(
          intent.id,
          intent.revision,
          token,
          '2026-07-23T00:00:01.600Z',
          seed.nativeSessionId,
          { state: 'aux_observed', auxObservation: staged },
        ),
      ).toThrow(MutationLeaseStaleError);
      intent = persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        renewed,
        '2026-07-23T00:00:01.600Z',
        seed.nativeSessionId,
        { state: 'aux_observed', auxObservation: staged },
      );
      intent = persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        renewed,
        '2026-07-23T00:00:01.700Z',
        seed.nativeSessionId,
        { state: 'effect_pending' },
      );
      expect(persistence.getEditSaga(saga.id)).toMatchObject({
        state: 'applying',
        steps: [expect.objectContaining({ state: 'effect_pending' })],
      });
      expect(persistence.listRecoverableNativeMutationIntents()).toEqual([intent]);

      intent = persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        renewed,
        '2026-07-23T00:00:01.800Z',
        seed.nativeSessionId,
        {
          state: 'effect_observed',
          effectObservation: {
            source: staged,
            destination: { state: 'absent' },
            auxiliary: seed.expectedSource,
          },
        },
      );
      expect(persistence.getEditSaga(saga.id)).toMatchObject({
        state: 'applying',
        steps: [expect.objectContaining({ state: 'effect_observed' })],
      });
      const originalStep = saga.steps[0]!;
      let compensation = persistence.prepareNativeMutationIntent(
        createNativeMutationIntentSeed({
          ...seedInput,
          id: 'native-intent-compensation-1',
          direction: 'compensation',
          artifact: {
            artifactId: originalStep.operation.preArtifact!.artifactId,
            contentHash: originalStep.operation.preArtifact!.contentHash,
            size: originalStep.operation.preArtifact!.size,
            expectedMode: originalStep.operation.preRevision!.mode,
          },
          expectedSource: staged,
          createdAt: '2026-07-23T00:00:02.000Z',
        }),
        renewed,
        '2026-07-23T00:00:02.000Z',
      );
      compensation = persistence.updateNativeMutationIntent(
        compensation.id,
        compensation.revision,
        renewed,
        '2026-07-23T00:00:02.100Z',
        compensation.nativeSessionId,
        { state: 'aux_pending' },
      );
      compensation = persistence.updateNativeMutationIntent(
        compensation.id,
        compensation.revision,
        renewed,
        '2026-07-23T00:00:02.200Z',
        compensation.nativeSessionId,
        {
          state: 'aux_observed',
          auxObservation: {
            ...staged,
            identityDigest: 'a'.repeat(64),
            contentHash: compensation.temp!.expectedContentHash,
            size: compensation.temp!.expectedSize,
          },
        },
      );
      compensation = persistence.updateNativeMutationIntent(
        compensation.id,
        compensation.revision,
        renewed,
        '2026-07-23T00:00:02.300Z',
        compensation.nativeSessionId,
        { state: 'effect_pending' },
      );
      expect(persistence.getEditSaga(saga.id)).toMatchObject({
        state: 'compensating',
        steps: [expect.objectContaining({ state: 'compensation_pending' })],
      });
      expect(persistence.listRecoverableNativeMutationIntents()).toEqual([intent, compensation]);
      concurrent.close();
      persistence.close();

      const reopened = new SqlitePersistenceClient(path, verifyTestNativeSession);
      expect(reopened.getNativeMutationIntent(intent.id)).toEqual(intent);
      expect(reopened.getNativeMutationIntent(compensation.id)).toEqual(compensation);
      expect(
        reopened.initializeMutationRecovery('replacement-instance', '2026-07-23T00:00:02.000Z'),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId: task.id,
            workspaceKey,
          }),
        ]),
      );
      const recoveryLease = reopened.acquireMutationLease({
        workspaceKey,
        rootIdentityDigest,
        holderInstanceId: 'replacement-instance',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'recovery',
        policyEpoch: saga.policyEpoch,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:02.100Z',
        expiresAt: '2026-07-23T00:01:02.100Z',
      });
      const recoverySessionId = 'b'.repeat(32);
      expect(
        reopened.bindNativeMutationIntentRecovery(
          intent.id,
          intent.revision,
          recoveryLease,
          recoverySessionId,
          '2026-07-23T00:00:02.200Z',
        ),
      ).toMatchObject({ attempt: 1, leaseFence: String(recoveryLease.fence) });
      reopened.bindNativeMutationIntentRecovery(
        compensation.id,
        compensation.revision,
        recoveryLease,
        recoverySessionId,
        '2026-07-23T00:00:02.200Z',
      );
      intent = reopened.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        recoveryLease,
        '2026-07-23T00:00:02.300Z',
        recoverySessionId,
        { state: 'cleanup_pending' },
      );
      intent = reopened.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        recoveryLease,
        '2026-07-23T00:00:02.400Z',
        recoverySessionId,
        { state: 'completed', cleanupObservation: { state: 'absent' } },
      );
      compensation = reopened.updateNativeMutationIntent(
        compensation.id,
        compensation.revision,
        recoveryLease,
        '2026-07-23T00:00:02.500Z',
        recoverySessionId,
        {
          state: 'effect_observed',
          effectObservation: {
            source: compensation.auxObservation!,
            destination: { state: 'absent' },
            auxiliary: compensation.expectedSource,
          },
        },
      );
      compensation = reopened.updateNativeMutationIntent(
        compensation.id,
        compensation.revision,
        recoveryLease,
        '2026-07-23T00:00:02.600Z',
        recoverySessionId,
        { state: 'cleanup_pending' },
      );
      reopened.updateNativeMutationIntent(
        compensation.id,
        compensation.revision,
        recoveryLease,
        '2026-07-23T00:00:02.700Z',
        recoverySessionId,
        { state: 'completed', cleanupObservation: { state: 'absent' } },
      );
      const compensatingSaga = reopened.getEditSaga(saga.id);
      reopened.updateEditSagaUnderLease(
        saga.id,
        compensatingSaga.revision,
        recoveryLease,
        (current) => ({
          ...withoutEditRevision(current),
          state: 'restored',
          updatedAt: '2026-07-23T00:00:02.800Z',
        }),
      );
      expect(reopened.listRecoverableNativeMutationIntents()).toEqual([]);
      reopened.releaseMutationLease(recoveryLease, '2026-07-23T00:00:02.900Z');
      reopened.clearMutationQuarantine(
        workspaceKey,
        recoveryLease.fence,
        '2026-07-23T00:00:03.000Z',
      );
      reopened.close();

      const scalarTamper = new Database(path);
      scalarTamper
        .prepare("UPDATE native_mutation_intents SET state = 'aux_pending' WHERE id = ?")
        .run(intent.id);
      scalarTamper.close();
      const scalarTampered = new SqlitePersistenceClient(path);
      expect(() => scalarTampered.getNativeMutationIntent(intent.id)).toThrow('sealed snapshot');
      expect(() =>
        scalarTampered.initializeMutationRecovery('tamper-instance', '2026-07-23T00:00:03.100Z'),
      ).toThrow('sealed snapshot');
      scalarTampered.close();

      const sealedTamper = new Database(path);
      const validShapeSnapshot = JSON.parse(
        sealedTamper
          .prepare('SELECT snapshot_json FROM native_mutation_intents WHERE id = ?')
          .pluck()
          .get(intent.id) as string,
      ) as Record<string, unknown>;
      const effect = validShapeSnapshot['effectObservation'] as Record<string, unknown>;
      effect['source'] = {
        ...(effect['source'] as Record<string, unknown>),
        identityDigest: 'c'.repeat(64),
      };
      sealedTamper
        .prepare('UPDATE native_mutation_intents SET state = ?, snapshot_json = ? WHERE id = ?')
        .run(intent.state, JSON.stringify(validShapeSnapshot), intent.id);
      sealedTamper.close();
      const sealRejected = new SqlitePersistenceClient(path);
      expect(() => sealRejected.getNativeMutationIntent(intent.id)).toThrow(
        'Invalid persisted Native mutation intent',
      );
      sealRejected.close();

      const jsonTamper = new Database(path);
      const rawSnapshot = JSON.parse(
        jsonTamper
          .prepare('SELECT snapshot_json FROM native_mutation_intents WHERE id = ?')
          .pluck()
          .get(intent.id) as string,
      ) as Record<string, unknown>;
      rawSnapshot['expectedSource'] = {
        ...(rawSnapshot['expectedSource'] as Record<string, unknown>),
        rawContent: 'must-not-be-persisted',
      };
      jsonTamper
        .prepare('UPDATE native_mutation_intents SET state = ?, snapshot_json = ? WHERE id = ?')
        .run(intent.state, JSON.stringify(rawSnapshot), intent.id);
      jsonTamper.close();
      const jsonTampered = new SqlitePersistenceClient(path);
      expect(() => jsonTampered.getNativeMutationIntent(intent.id)).toThrow('unknown or missing');
      expect(() =>
        jsonTampered.initializeMutationRecovery('tamper-instance', '2026-07-23T00:00:03.200Z'),
      ).toThrow('unknown or missing');
      jsonTampered.close();
    });

    it('refuses to create a first intent after the Saga already reached effect-pending', async () => {
      const fixture = await nativeIntentFixture('missing-intent');
      const current = fixture.persistence.getEditSaga(fixture.saga.id);
      fixture.persistence.updateEditSagaUnderLease(
        current.id,
        current.revision,
        fixture.token,
        (snapshot) => ({
          ...withoutEditRevision(snapshot),
          state: 'applying',
          steps: snapshot.steps.map((step) => ({ ...step, state: 'effect_pending' as const })),
          updatedAt: '2026-07-23T00:00:01.100Z',
        }),
      );
      expect(() =>
        fixture.persistence.prepareNativeMutationIntent(
          persistedNativeIntentSeed(fixture.saga, fixture.token),
          fixture.token,
          '2026-07-23T00:00:01.200Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      const inspection = new Database(fixture.path, { readonly: true });
      expect(inspection.prepare('SELECT COUNT(*) FROM native_mutation_intents').pluck().get()).toBe(
        0,
      );
      inspection.close();
      fixture.persistence.close();
    });

    it('persists quarantine and disables native authority when expiry invalidation fails', async () => {
      let nativeSessionLive = true;
      const invalidations: Array<{ workspaceKey: string; minimumFence: string }> = [];
      const fixture = await nativeIntentFixture(
        'expired-intent',
        '2026-07-23T00:00:02.000Z',
        'before',
        'after',
        {
          verifyNativeSession(binding) {
            verifyTestNativeSession(binding);
            if (!nativeSessionLive) throw new MutationLeaseStaleError();
          },
          invalidateNativeWorkspace(workspaceKey, minimumFence) {
            invalidations.push({ workspaceKey, minimumFence });
            nativeSessionLive = false;
            throw new Error('simulated native invalidation failure');
          },
        },
      );
      const seed = persistedNativeIntentSeed(fixture.saga, fixture.token);
      let intent = fixture.persistence.prepareNativeMutationIntent(
        seed,
        fixture.token,
        '2026-07-23T00:00:01.100Z',
      );
      intent = fixture.persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        fixture.token,
        '2026-07-23T00:00:01.200Z',
        seed.nativeSessionId,
        { state: 'aux_pending' },
      );
      const staged: NativeMutationRevision = {
        state: 'present',
        identityDigest: 'e'.repeat(64),
        contentHash: intent.temp!.expectedContentHash,
        size: intent.temp!.expectedSize,
        mode: intent.temp!.expectedMode,
        nlink: 1,
      };
      intent = fixture.persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        fixture.token,
        '2026-07-23T00:00:01.300Z',
        seed.nativeSessionId,
        { state: 'aux_observed', auxObservation: staged },
      );
      intent = fixture.persistence.updateNativeMutationIntent(
        intent.id,
        intent.revision,
        fixture.token,
        '2026-07-23T00:00:01.400Z',
        seed.nativeSessionId,
        { state: 'effect_pending' },
      );
      expect(() =>
        fixture.persistence.updateNativeMutationIntent(
          intent.id,
          intent.revision,
          fixture.token,
          '2026-07-23T00:00:02.000Z',
          seed.nativeSessionId,
          {
            state: 'effect_observed',
            effectObservation: {
              source: staged,
              destination: { state: 'absent' },
              auxiliary: seed.expectedSource,
            },
          },
        ),
      ).toThrow(MutationQuarantinedError);
      expect(invalidations).toEqual([
        {
          workspaceKey: fixture.token.workspaceKey,
          minimumFence: String(fixture.token.fence + 1),
        },
      ]);
      expect(fixture.persistence.isNativeMutationAuthorityAvailable()).toBe(false);
      expect(() =>
        fixture.persistence.updateNativeMutationIntent(
          intent.id,
          intent.revision,
          fixture.token,
          '2026-07-23T00:00:02.001Z',
          seed.nativeSessionId,
          {
            state: 'effect_observed',
            effectObservation: {
              source: staged,
              destination: { state: 'absent' },
              auxiliary: seed.expectedSource,
            },
          },
        ),
      ).toThrow(MutationLeaseStaleError);
      expect(() => fixture.persistence.startTurn(fixture.taskId, 'blocked')).toThrow(
        MutationQuarantinedError,
      );
      fixture.persistence.close();
      const reopened = new SqlitePersistenceClient(fixture.path, verifyTestNativeSession);
      expect(() => reopened.startTurn(fixture.taskId, 'still blocked after reopen')).toThrow(
        MutationQuarantinedError,
      );
      reopened.close();
    });

    it('never stores preimage or postimage bytes in SQLite intent records or sidecars', async () => {
      const preimage = `PRE-${randomUUID()}-${randomUUID()}`;
      const postimage = `POST-${randomUUID()}-${randomUUID()}`;
      const fixture = await nativeIntentFixture(
        'opaque-intent',
        '2026-07-23T00:01:01.000Z',
        preimage,
        postimage,
      );
      fixture.persistence.prepareNativeMutationIntent(
        persistedNativeIntentSeed(fixture.saga, fixture.token),
        fixture.token,
        '2026-07-23T00:00:01.100Z',
      );
      fixture.persistence.close();
      for (const file of [fixture.path, `${fixture.path}-wal`, `${fixture.path}-shm`]) {
        if (!existsSync(file)) continue;
        const bytes = readFileSync(file);
        expect(bytes.includes(Buffer.from(preimage))).toBe(false);
        expect(bytes.includes(Buffer.from(postimage))).toBe(false);
      }
    });

    it('quarantines expiry and blocks every Task sharing the workspace until recovery', async () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const sibling = persistence.createTask();
      const unrelated = persistence.createTask();
      const lateBinding = persistence.createTask();
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/shared',
        'b'.repeat(64),
      );
      bindMutationWorkspace(persistence, sibling.id, '/workspace/shared', 'b'.repeat(64));
      bindMutationWorkspace(persistence, unrelated.id, '/workspace/other', 'c'.repeat(64));
      const turn = persistence.startTurn(task.id, 'expire lease');
      const staged = await stageEditSagaRequest(
        {
          id: 'expired-saga',
          taskId: task.id,
          turnId: turn.turnId,
          operationId: 'expired-operation',
          plan: persistedEditPlan(),
          createdAt: '2026-07-23T00:00:00.000Z',
        },
        new PersistenceTestArtifacts(),
      );
      const saga = persistence.prepareEditSaga(staged);
      const input = {
        workspaceKey,
        rootIdentityDigest: 'b'.repeat(64),
        holderInstanceId: 'instance-a',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward' as const,
        policyEpoch: 0,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T00:00:02.000Z',
      };
      const expired = persistence.acquireMutationLease(input);
      expect(() =>
        persistence.acquireMutationLease({
          ...input,
          holderInstanceId: 'instance-b',
          now: '2026-07-23T00:00:03.000Z',
          expiresAt: '2026-07-23T00:01:03.000Z',
        }),
      ).toThrow(MutationQuarantinedError);
      expect(() =>
        persistence.renewMutationLease(
          expired,
          '2026-07-23T00:00:04.000Z',
          '2026-07-23T00:01:04.000Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      expect(() => persistence.startTurn(sibling.id, 'must wait')).toThrow(
        MutationQuarantinedError,
      );
      persistence.queueInput(sibling.id, 'queued while recovering', 'queued-recovery-operation');
      expect(() => persistence.startNextQueued(sibling.id)).toThrow(MutationQuarantinedError);
      expect(persistence.startTurn(unrelated.id, 'can proceed')).toBeDefined();

      const recovery = persistence.acquireMutationLease({
        ...input,
        holderInstanceId: 'recovery-instance',
        purpose: 'recovery',
        now: '2026-07-23T00:00:05.000Z',
        expiresAt: '2026-07-23T00:01:05.000Z',
      });
      expect(recovery.fence).toBeGreaterThan(expired.fence);
      persistence.releaseMutationLease(recovery, '2026-07-23T00:00:06.000Z');
      expect(() =>
        persistence.setWorkspaceBinding(lateBinding.id, {
          path: '/workspace/shared',
          workspaceKey,
          rootIdentityDigest: 'b'.repeat(64),
        }),
      ).toThrow(MutationQuarantinedError);
      persistence.updateEditSaga(saga.id, saga.revision, (current) => ({
        ...withoutEditRevision(current),
        state: 'restored',
        updatedAt: '2026-07-23T00:00:07.000Z',
      }));
      persistence.clearMutationQuarantine(workspaceKey, recovery.fence, '2026-07-23T00:00:08.000Z');
      expect(persistence.startNextQueued(sibling.id)).toMatchObject({
        started: { text: 'queued while recovering' },
      });
      persistence.close();
    });

    it('fails closed on clock rollback and persists startup quarantine', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/clock',
        'd'.repeat(64),
      );
      const turn = persistence.startTurn(task.id, 'clock lease');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'clock-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'clock-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const token = persistence.acquireMutationLease({
        workspaceKey,
        rootIdentityDigest: 'd'.repeat(64),
        holderInstanceId: 'old-instance',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward',
        policyEpoch: 0,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:10.000Z',
        expiresAt: '2026-07-23T00:01:10.000Z',
      });
      expect(() =>
        persistence.renewMutationLease(
          token,
          '2026-07-23T00:00:09.000Z',
          '2026-07-23T00:01:09.000Z',
        ),
      ).toThrow(MutationClockRollbackError);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      const quarantines = reopened.initializeMutationRecovery(
        'new-instance',
        '2026-07-23T00:00:11.000Z',
      );
      expect(quarantines).toEqual([
        expect.objectContaining({ taskId: task.id, reason: 'clock_rollback' }),
      ]);
      expect(() => reopened.startTurn(task.id, 'still blocked')).toThrow(MutationQuarantinedError);
      reopened.close();
    });

    it('advances multi-step Native intents forward and compensates them in strict reverse order', async () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '4'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'multi-step native journal');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'multi-native-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'multi-native-operation',
            plan: persistedTwoStepEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const token = persistence.acquireMutationLease({
        workspaceKey,
        rootIdentityDigest,
        holderInstanceId: 'multi-native-instance',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward',
        policyEpoch: saga.policyEpoch,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T00:01:01.000Z',
      });

      const forwardOne = observeNativeUpdateIntent(
        persistence,
        persistedNativeUpdateSeed(saga, token, 1, 'forward', 'multi-forward-1'),
        token,
        'a',
      );
      const forwardTwo = observeNativeUpdateIntent(
        persistence,
        persistedNativeUpdateSeed(
          persistence.getEditSaga(saga.id),
          token,
          2,
          'forward',
          'multi-forward-2',
        ),
        token,
        'b',
      );
      expect(persistence.getEditSaga(saga.id).steps.map(({ state }) => state)).toEqual([
        'effect_observed',
        'effect_observed',
      ]);

      expect(() =>
        persistence.prepareNativeMutationIntent(
          persistedNativeUpdateSeed(
            persistence.getEditSaga(saga.id),
            token,
            1,
            'compensation',
            'out-of-order-compensation-1',
            forwardOne.staged,
          ),
          token,
          '2026-07-23T00:00:02.000Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      observeNativeUpdateIntent(
        persistence,
        persistedNativeUpdateSeed(
          persistence.getEditSaga(saga.id),
          token,
          2,
          'compensation',
          'multi-compensation-2',
          forwardTwo.staged,
        ),
        token,
        'c',
      );
      observeNativeUpdateIntent(
        persistence,
        persistedNativeUpdateSeed(
          persistence.getEditSaga(saga.id),
          token,
          1,
          'compensation',
          'multi-compensation-1',
          forwardOne.staged,
        ),
        token,
        'd',
      );
      expect(persistence.getEditSaga(saga.id)).toMatchObject({
        state: 'compensating',
        steps: [{ state: 'restored' }, { state: 'restored' }],
      });
      persistence.close();
    });

    it.each(['add', 'delete', 'rename'] as const)(
      'pairs a %s intent effect with the matching SQLite Saga step',
      async (kind) => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        const rootIdentityDigest = editHash(`root:${kind}`);
        const workspaceKey = bindMutationWorkspace(
          persistence,
          task.id,
          '/workspace',
          rootIdentityDigest,
        );
        const turn = persistence.startTurn(task.id, `${kind} native journal`);
        const saga = persistence.prepareEditSaga(
          await stageEditSagaRequest(
            {
              id: `${kind}-native-saga`,
              taskId: task.id,
              turnId: turn.turnId,
              operationId: `${kind}-native-operation`,
              plan: persistedEditPlanForKind(kind),
              createdAt: '2026-07-23T00:00:00.000Z',
            },
            new PersistenceTestArtifacts(),
          ),
        );
        const token = persistence.acquireMutationLease({
          workspaceKey,
          rootIdentityDigest,
          holderInstanceId: `${kind}-native-instance`,
          taskId: task.id,
          turnId: turn.turnId,
          sagaId: saga.id,
          purpose: 'forward',
          policyEpoch: saga.policyEpoch,
          intentDigest: saga.planDigest,
          now: '2026-07-23T00:00:01.000Z',
          expiresAt: '2026-07-23T00:01:01.000Z',
        });
        const step = saga.steps[0]!;
        const expectedSource =
          kind === 'add'
            ? ({ state: 'absent' } as const)
            : ({ state: 'present' as const, ...step.operation.preRevision! } as const);
        const seed = createNativeMutationIntentSeed({
          id: `${kind}-native-intent`,
          sagaId: saga.id,
          ordinal: 1,
          direction: 'forward',
          kind,
          operationDigest: editHash(JSON.stringify(step.operation)),
          workspaceKey,
          rootIdentityDigest,
          policyEpoch: saga.policyEpoch,
          leaseFence: String(token.fence),
          nativeSessionId: '6'.repeat(32),
          sourceSegments: ['src', `${kind}.ts`],
          destinationSegments: kind === 'rename' ? ['src', 'renamed.ts'] : null,
          expectedSource,
          expectedDestination: { state: 'absent' },
          artifact:
            kind === 'add'
              ? {
                  artifactId: step.operation.postArtifact!.artifactId,
                  contentHash: step.operation.postArtifact!.contentHash,
                  size: step.operation.postArtifact!.size,
                  expectedMode: 0o100600,
                }
              : null,
          createdAt: '2026-07-23T00:00:02.000Z',
        });
        let intent = persistence.prepareNativeMutationIntent(seed, token, seed.createdAt);
        let staged: NativeMutationRevision | null = null;
        if (intent.temp !== null) {
          intent = persistence.updateNativeMutationIntent(
            intent.id,
            intent.revision,
            token,
            seed.createdAt,
            seed.nativeSessionId,
            { state: 'aux_pending' },
          );
          staged = {
            state: 'present',
            identityDigest: 'f'.repeat(64),
            contentHash: intent.temp!.expectedContentHash,
            size: intent.temp!.expectedSize,
            mode: intent.temp!.expectedMode,
            nlink: 1,
          };
          intent = persistence.updateNativeMutationIntent(
            intent.id,
            intent.revision,
            token,
            seed.createdAt,
            seed.nativeSessionId,
            { state: 'aux_observed', auxObservation: staged },
          );
        }
        intent = persistence.updateNativeMutationIntent(
          intent.id,
          intent.revision,
          token,
          seed.createdAt,
          seed.nativeSessionId,
          { state: 'effect_pending' },
        );
        expect(persistence.getEditSaga(saga.id).steps[0]!.state).toBe('effect_pending');
        const effectObservation =
          kind === 'add'
            ? {
                source: staged!,
                destination: { state: 'absent' as const },
                auxiliary: { state: 'absent' as const },
              }
            : kind === 'delete'
              ? {
                  source: { state: 'absent' as const },
                  destination: { state: 'absent' as const },
                  auxiliary: expectedSource,
                }
              : {
                  source: { state: 'absent' as const },
                  destination: expectedSource,
                  auxiliary: { state: 'absent' as const },
                };
        persistence.updateNativeMutationIntent(
          intent.id,
          intent.revision,
          token,
          seed.createdAt,
          seed.nativeSessionId,
          { state: 'effect_observed', effectObservation },
        );
        expect(persistence.getEditSaga(saga.id).steps[0]!.state).toBe('effect_observed');

        const compensationKind =
          kind === 'add' ? ('delete' as const) : kind === 'delete' ? ('add' as const) : kind;
        const compensationExpectedSource =
          compensationKind === 'add'
            ? ({ state: 'absent' } as const)
            : kind === 'add'
              ? staged!
              : expectedSource;
        const compensationSeed = createNativeMutationIntentSeed({
          id: `${kind}-native-compensation`,
          sagaId: saga.id,
          ordinal: 1,
          direction: 'compensation',
          kind: compensationKind,
          operationDigest: editHash(JSON.stringify(step.operation)),
          workspaceKey,
          rootIdentityDigest,
          policyEpoch: saga.policyEpoch,
          leaseFence: String(token.fence),
          nativeSessionId: '6'.repeat(32),
          sourceSegments: kind === 'rename' ? ['src', 'renamed.ts'] : ['src', `${kind}.ts`],
          destinationSegments: kind === 'rename' ? ['src', 'rename.ts'] : null,
          expectedSource: compensationExpectedSource,
          expectedDestination: { state: 'absent' },
          artifact:
            compensationKind === 'add'
              ? {
                  artifactId: step.operation.preArtifact!.artifactId,
                  contentHash: step.operation.preArtifact!.contentHash,
                  size: step.operation.preArtifact!.size,
                  expectedMode: step.operation.preRevision!.mode,
                }
              : null,
          createdAt: '2026-07-23T00:00:03.000Z',
        });
        let compensation = persistence.prepareNativeMutationIntent(
          compensationSeed,
          token,
          compensationSeed.createdAt,
        );
        let restored: NativeMutationRevision | null = null;
        if (compensation.temp !== null) {
          const temp = compensation.temp;
          compensation = persistence.updateNativeMutationIntent(
            compensation.id,
            compensation.revision,
            token,
            compensationSeed.createdAt,
            compensationSeed.nativeSessionId,
            { state: 'aux_pending' },
          );
          restored = {
            state: 'present',
            identityDigest: 'e'.repeat(64),
            contentHash: temp.expectedContentHash,
            size: temp.expectedSize,
            mode: temp.expectedMode,
            nlink: 1,
          };
          compensation = persistence.updateNativeMutationIntent(
            compensation.id,
            compensation.revision,
            token,
            compensationSeed.createdAt,
            compensationSeed.nativeSessionId,
            { state: 'aux_observed', auxObservation: restored },
          );
        }
        compensation = persistence.updateNativeMutationIntent(
          compensation.id,
          compensation.revision,
          token,
          compensationSeed.createdAt,
          compensationSeed.nativeSessionId,
          { state: 'effect_pending' },
        );
        expect(persistence.getEditSaga(saga.id).steps[0]!.state).toBe('compensation_pending');
        const compensationObservation =
          compensationKind === 'add'
            ? {
                source: restored!,
                destination: { state: 'absent' as const },
                auxiliary: { state: 'absent' as const },
              }
            : compensationKind === 'delete'
              ? {
                  source: { state: 'absent' as const },
                  destination: { state: 'absent' as const },
                  auxiliary: compensationExpectedSource,
                }
              : {
                  source: { state: 'absent' as const },
                  destination: compensationExpectedSource,
                  auxiliary: { state: 'absent' as const },
                };
        persistence.updateNativeMutationIntent(
          compensation.id,
          compensation.revision,
          token,
          compensationSeed.createdAt,
          compensationSeed.nativeSessionId,
          { state: 'effect_observed', effectObservation: compensationObservation },
        );
        expect(persistence.getEditSaga(saga.id).steps[0]!.state).toBe('restored');
        persistence.close();
      },
    );

    it('rechecks the exact lease inside the immediate intent transaction', async () => {
      const fixture = await nativeIntentFixture('native-prepare-race');
      const concurrent = new SqlitePersistenceClient(fixture.path, verifyTestNativeSession);
      const seed = persistedNativeIntentSeed(fixture.saga, fixture.token);
      const originalAssert = fixture.persistence.assertMutationLease.bind(fixture.persistence);
      let interleaved = false;
      fixture.persistence.assertMutationLease = (token, now) => {
        originalAssert(token, now);
        if (interleaved) return;
        interleaved = true;
        concurrent.renewMutationLease(
          token,
          '2026-07-23T00:00:01.050Z',
          '2026-07-23T00:01:01.050Z',
        );
      };
      expect(() =>
        fixture.persistence.prepareNativeMutationIntent(
          seed,
          fixture.token,
          '2026-07-23T00:00:01.000Z',
        ),
      ).toThrow(MutationLeaseStaleError);
      expect(fixture.persistence.listRecoverableNativeMutationIntents()).toEqual([]);
      concurrent.close();
      fixture.persistence.close();
    });

    it('fences a held lease when policy changes before release', async () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/policy-fence',
        'e'.repeat(64),
      );
      const turn = persistence.startTurn(task.id, 'policy lease');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'policy-fence-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'policy-fence-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const token = persistence.acquireMutationLease({
        workspaceKey,
        rootIdentityDigest: 'e'.repeat(64),
        holderInstanceId: 'policy-instance',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward',
        policyEpoch: 0,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T00:01:01.000Z',
      });
      persistence.setAccessPreset(task.id, 'auto');
      expect(() => persistence.releaseMutationLease(token, '2026-07-23T00:00:02.000Z')).toThrow(
        MutationLeaseStaleError,
      );
      expect(() => persistence.startTurn(task.id, 'blocked after policy change')).toThrow(
        MutationQuarantinedError,
      );
      persistence.close();
    });

    it('quarantines a previous-instance holder and interrupts its Turn at startup', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const sibling = persistence.createTask();
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/restart',
        'f'.repeat(64),
      );
      bindMutationWorkspace(persistence, sibling.id, '/workspace/restart', 'f'.repeat(64));
      const turn = persistence.startTurn(task.id, 'restart lease');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'restart-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'restart-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const oldToken = persistence.acquireMutationLease({
        workspaceKey,
        rootIdentityDigest: 'f'.repeat(64),
        holderInstanceId: 'previous-instance',
        taskId: task.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward',
        policyEpoch: 0,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T01:00:01.000Z',
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(
        reopened.initializeMutationRecovery('current-instance', '2026-07-23T00:00:02.000Z'),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: task.id, reason: 'unclean_shutdown' }),
          expect.objectContaining({ taskId: sibling.id, reason: 'unclean_shutdown' }),
        ]),
      );
      expect(reopened.snapshot(task.id).activeTurn).toBeNull();
      expect(() => reopened.releaseMutationLease(oldToken, '2026-07-23T00:00:03.000Z')).toThrow(
        MutationLeaseStaleError,
      );
      expect(() => reopened.startTurn(sibling.id, 'same workspace blocked')).toThrow(
        MutationQuarantinedError,
      );
      reopened.close();
    });

    it('recovers multiple unresolved Sagas in one workspace quarantine session', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '0'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/multi-recovery',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'multiple recovery');
      const first = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'multi-recovery-a',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'multi-recovery-operation-a',
            plan: persistedEditPlan('before-a', 'after-a'),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const second = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'multi-recovery-b',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'multi-recovery-operation-b',
            plan: persistedEditPlan('before-b', 'after-b'),
            createdAt: '2026-07-23T00:00:01.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      reopened.initializeMutationRecovery('multi-recovery-instance', '2026-07-23T00:00:02.000Z');
      const recover = (saga: typeof first, ordinal: number) => {
        const token = reopened.acquireMutationLease({
          workspaceKey,
          rootIdentityDigest,
          holderInstanceId: `multi-recovery-${ordinal}`,
          taskId: task.id,
          turnId: turn.turnId,
          sagaId: saga.id,
          purpose: 'recovery',
          policyEpoch: saga.policyEpoch,
          intentDigest: saga.planDigest,
          now: `2026-07-23T00:00:0${ordinal + 2}.000Z`,
          expiresAt: `2026-07-23T00:01:0${ordinal + 2}.000Z`,
        });
        reopened.releaseMutationLease(token, `2026-07-23T00:00:0${ordinal + 3}.000Z`);
        reopened.updateEditSaga(saga.id, saga.revision, (current) => ({
          ...withoutEditRevision(current),
          state: 'restored',
          updatedAt: `2026-07-23T00:00:1${ordinal}.000Z`,
        }));
        return token;
      };
      recover(first, 1);
      const finalToken = recover(second, 3);
      reopened.clearMutationQuarantine(workspaceKey, finalToken.fence, '2026-07-23T00:00:20.000Z');
      expect(reopened.startTurn(task.id, 'recovery complete')).toBeDefined();
      reopened.close();
    });

    it('rejects rebinding into quarantine and cannot move an existing Saga to another workspace', async () => {
      const { persistence } = createPersistence();
      const owner = persistence.createTask();
      const newcomer = persistence.createTask();
      const rootA = '1'.repeat(64);
      const rootB = '2'.repeat(64);
      const workspaceA = bindMutationWorkspace(persistence, owner.id, '/workspace/a', rootA);
      const turn = persistence.startTurn(owner.id, 'bound saga');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'binding-saga',
            taskId: owner.id,
            turnId: turn.turnId,
            operationId: 'binding-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const workspaceB = mutationWorkspaceKey('/workspace/b', rootB);
      persistence.setWorkspaceBinding(owner.id, {
        path: '/workspace/b',
        workspaceKey: workspaceB,
        rootIdentityDigest: rootB,
      });
      expect(() =>
        persistence.acquireMutationLease({
          workspaceKey: workspaceB,
          rootIdentityDigest: rootB,
          holderInstanceId: 'wrong-workspace-instance',
          taskId: owner.id,
          turnId: turn.turnId,
          sagaId: saga.id,
          purpose: 'forward',
          policyEpoch: saga.policyEpoch,
          intentDigest: saga.planDigest,
          now: '2026-07-23T00:00:01.000Z',
          expiresAt: '2026-07-23T00:01:01.000Z',
        }),
      ).toThrow(MutationLeaseStaleError);
      persistence.setWorkspaceBinding(owner.id, {
        path: '/workspace/a',
        workspaceKey: workspaceA,
        rootIdentityDigest: rootA,
      });
      const token = persistence.acquireMutationLease({
        workspaceKey: workspaceA,
        rootIdentityDigest: rootA,
        holderInstanceId: 'binding-instance',
        taskId: owner.id,
        turnId: turn.turnId,
        sagaId: saga.id,
        purpose: 'forward',
        policyEpoch: saga.policyEpoch,
        intentDigest: saga.planDigest,
        now: '2026-07-23T00:00:10.000Z',
        expiresAt: '2026-07-23T00:01:10.000Z',
      });
      expect(() => persistence.assertMutationLease(token, '2026-07-23T00:00:09.000Z')).toThrow(
        MutationClockRollbackError,
      );
      expect(() =>
        persistence.setWorkspaceBinding(newcomer.id, {
          path: '/workspace/a',
          workspaceKey: workspaceA,
          rootIdentityDigest: rootA,
        }),
      ).toThrow(MutationQuarantinedError);

      expect(() =>
        persistence.setWorkspaceBinding(owner.id, {
          path: '/workspace/b',
          workspaceKey: workspaceB,
          rootIdentityDigest: rootB,
        }),
      ).toThrow(MutationQuarantinedError);
      persistence.close();
    });

    it('uses the immutable Saga workspace for startup quarantine after Task rebinding', async () => {
      const { persistence, path } = createPersistence();
      const owner = persistence.createTask();
      const siblingA = persistence.createTask();
      const unrelatedB = persistence.createTask();
      const rootA = '3'.repeat(64);
      const rootB = '4'.repeat(64);
      const workspaceA = bindMutationWorkspace(persistence, owner.id, '/workspace/a', rootA);
      bindMutationWorkspace(persistence, siblingA.id, '/workspace/a', rootA);
      const workspaceB = bindMutationWorkspace(persistence, unrelatedB.id, '/workspace/b', rootB);
      const turn = persistence.startTurn(owner.id, 'immutable startup scope');
      persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'immutable-startup-saga',
            taskId: owner.id,
            turnId: turn.turnId,
            operationId: 'immutable-startup-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      persistence.setWorkspaceBinding(owner.id, {
        path: '/workspace/b',
        workspaceKey: workspaceB,
        rootIdentityDigest: rootB,
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      const quarantines = reopened.initializeMutationRecovery(
        'immutable-startup-instance',
        '2026-07-23T00:00:01.000Z',
      );
      expect(quarantines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: owner.id, workspaceKey: workspaceA }),
          expect.objectContaining({ taskId: siblingA.id, workspaceKey: workspaceA }),
        ]),
      );
      expect(() => reopened.startTurn(owner.id, 'owner blocked')).toThrow(MutationQuarantinedError);
      expect(() => reopened.startTurn(siblingA.id, 'sibling blocked')).toThrow(
        MutationQuarantinedError,
      );
      expect(reopened.startTurn(unrelatedB.id, 'unrelated proceeds')).toBeDefined();
      reopened.close();
    });

    it('re-arms a cleared moved-owner quarantine row during startup recovery', async () => {
      const { persistence, path } = createPersistence();
      const owner = persistence.createTask();
      const rootA = '5'.repeat(64);
      const rootB = '7'.repeat(64);
      const workspaceA = bindMutationWorkspace(persistence, owner.id, '/workspace/a', rootA);
      const turn = persistence.startTurn(owner.id, 'quarantine history');
      const firstSaga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'cleared-history-saga',
            taskId: owner.id,
            turnId: turn.turnId,
            operationId: 'cleared-history-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const expired = persistence.acquireMutationLease({
        workspaceKey: workspaceA,
        rootIdentityDigest: rootA,
        holderInstanceId: 'cleared-owner',
        taskId: owner.id,
        turnId: turn.turnId,
        sagaId: firstSaga.id,
        purpose: 'forward',
        policyEpoch: firstSaga.policyEpoch,
        intentDigest: firstSaga.planDigest,
        now: '2026-07-23T00:00:01.000Z',
        expiresAt: '2026-07-23T00:00:02.000Z',
      });
      expect(() => persistence.assertMutationLease(expired, '2026-07-23T00:00:03.000Z')).toThrow(
        MutationQuarantinedError,
      );
      const recovery = persistence.acquireMutationLease({
        workspaceKey: workspaceA,
        rootIdentityDigest: rootA,
        holderInstanceId: 'cleared-recovery',
        taskId: owner.id,
        turnId: turn.turnId,
        sagaId: firstSaga.id,
        purpose: 'recovery',
        policyEpoch: firstSaga.policyEpoch,
        intentDigest: firstSaga.planDigest,
        now: '2026-07-23T00:00:04.000Z',
        expiresAt: '2026-07-23T00:01:04.000Z',
      });
      persistence.releaseMutationLease(recovery, '2026-07-23T00:00:05.000Z');
      persistence.updateEditSaga(firstSaga.id, firstSaga.revision, (current) => ({
        ...withoutEditRevision(current),
        state: 'restored',
        updatedAt: '2026-07-23T00:00:06.000Z',
      }));
      persistence.clearMutationQuarantine(workspaceA, recovery.fence, '2026-07-23T00:00:07.000Z');

      persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'rearmed-history-saga',
            taskId: owner.id,
            turnId: turn.turnId,
            operationId: 'rearmed-history-operation',
            plan: persistedEditPlan('before-2', 'after-2'),
            createdAt: '2026-07-23T00:00:08.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      const workspaceB = mutationWorkspaceKey('/workspace/b', rootB);
      persistence.setWorkspaceBinding(owner.id, {
        path: '/workspace/b',
        workspaceKey: workspaceB,
        rootIdentityDigest: rootB,
      });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(
        reopened.initializeMutationRecovery('rearmed-startup-instance', '2026-07-23T00:00:09.000Z'),
      ).toContainEqual(
        expect.objectContaining({
          taskId: owner.id,
          workspaceKey: workspaceA,
          sourceSagaId: 'rearmed-history-saga',
        }),
      );
      expect(() => reopened.startTurn(owner.id, 'must remain blocked')).toThrow(
        MutationQuarantinedError,
      );
      reopened.close();
    });

    it('fails closed instead of granting a legacy path-only workspace identity', async () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      persistence.setWorkspace(task.id, '/workspace/legacy');
      const turn = persistence.startTurn(task.id, 'legacy binding');
      const saga = persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'legacy-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'legacy-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      expect(() =>
        persistence.acquireMutationLease({
          workspaceKey: saga.workspaceKey!,
          rootIdentityDigest: saga.rootIdentityDigest!,
          holderInstanceId: 'legacy-instance',
          taskId: task.id,
          turnId: turn.turnId,
          sagaId: saga.id,
          purpose: 'forward',
          policyEpoch: saga.policyEpoch,
          intentDigest: saga.planDigest,
          now: '2026-07-23T00:00:01.000Z',
          expiresAt: '2026-07-23T00:01:01.000Z',
        }),
      ).toThrow(MutationQuarantinedError);
      persistence.close();
    });

    it('migrates an unsealed legacy Saga as unbound and quarantines it for recovery', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '6'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/legacy-saga',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'legacy saga');
      persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'legacy-unsealed-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'legacy-unsealed-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      persistence.close();
      const raw = new Database(path);
      raw
        .prepare(
          `UPDATE edit_sagas SET binding_version = 0,
           workspace_key = NULL, root_identity_digest = NULL WHERE id = ?`,
        )
        .run('legacy-unsealed-saga');
      raw.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getEditSaga('legacy-unsealed-saga')).toMatchObject({
        workspaceKey: null,
        rootIdentityDigest: null,
      });
      expect(
        reopened.initializeMutationRecovery('legacy-recovery-instance', '2026-07-23T00:00:01.000Z'),
      ).toContainEqual(
        expect.objectContaining({
          taskId: task.id,
          workspaceKey,
          reason: 'legacy_unbound_edit_saga',
        }),
      );
      expect(() => reopened.startTurn(task.id, 'blocked legacy')).toThrow(MutationQuarantinedError);
      reopened.close();
    });

    it('backfills v22 Saga operations with fail-closed native identity receipts', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const rootIdentityDigest = '7'.repeat(64);
      const workspaceKey = bindMutationWorkspace(
        persistence,
        task.id,
        '/workspace/v22-saga',
        rootIdentityDigest,
      );
      const turn = persistence.startTurn(task.id, 'v22 saga');
      persistence.prepareEditSaga(
        await stageEditSagaRequest(
          {
            id: 'v22-native-binding-saga',
            taskId: task.id,
            turnId: turn.turnId,
            operationId: 'v22-native-binding-operation',
            plan: persistedEditPlan(),
            createdAt: '2026-07-23T00:00:00.000Z',
          },
          new PersistenceTestArtifacts(),
        ),
      );
      persistence.close();

      const raw = new Database(path);
      const row = raw
        .prepare('SELECT snapshot_json FROM edit_sagas WHERE id = ?')
        .get('v22-native-binding-saga') as { snapshot_json: string };
      const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
      const steps = snapshot['steps'] as Array<{ operation: Record<string, unknown> }>;
      delete steps[0]!.operation['preRevision'];
      snapshot['journalDigest'] = journaledPatchDigest({
        version: 2,
        policyEpoch: snapshot['policyEpoch'] as number,
        workspaceKey: snapshot['workspaceKey'] as string,
        rootIdentityDigest: snapshot['rootIdentityDigest'] as string,
        operations: steps.map(({ operation }) => operation as never),
      });
      raw
        .prepare('UPDATE edit_sagas SET snapshot_json = ? WHERE id = ?')
        .run(JSON.stringify(snapshot), 'v22-native-binding-saga');
      raw.exec(`
        DROP TABLE native_mutation_recovery_bindings;
        DROP TABLE native_mutation_intents;
        ALTER TABLE edit_sagas DROP COLUMN native_binding_version;
        DELETE FROM schema_migrations WHERE version = 23;
      `);
      raw.close();

      const reopened = new SqlitePersistenceClient(path, verifyTestNativeSession);
      expect(reopened.getEditSaga('v22-native-binding-saga')).toMatchObject({
        steps: [
          {
            operation: {
              preRevision: {
                identityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
                contentHash: editHash('before'),
                size: Buffer.byteLength('before'),
                mode: 0o100000,
                nlink: 1,
              },
            },
          },
        ],
      });
      expect(
        reopened.initializeMutationRecovery('v22-recovery-instance', '2026-07-23T00:00:01.000Z'),
      ).toContainEqual(expect.objectContaining({ taskId: task.id, workspaceKey }));
      expect(() => reopened.startTurn(task.id, 'blocked v22 saga')).toThrow(
        MutationQuarantinedError,
      );
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

    it('delivers a restart-durable background completion exactly once at a safe Turn boundary', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const owner = startExecutingTurn(persistence, task.id);
      persistence.createBackgroundActivity({
        id: 'activity-durable',
        taskId: task.id,
        ownerThreadId: task.id,
        ownerTurnId: owner.turnId,
        kind: 'command',
        wakePolicy: 'nextSafePoint',
        requiredCapabilities: ['shell.execute'],
        volumeQuotaBytes: 64_000,
        createdAt: '2026-07-23T00:00:00.000Z',
      });
      persistence.transitionBackgroundActivity(
        'activity-durable',
        'running',
        '2026-07-23T00:00:01.000Z',
      );
      persistence.changeStage(task.id, owner.turnId, 'synthesizing');
      persistence.completeTurn(task.id, owner.turnId, 'completed');
      const completion = persistence.completeBackgroundActivity({
        activityId: 'activity-durable',
        completionId: 'completion-durable',
        outcome: 'completed',
        payload: 'background \u001b[31mresult\u001b[0m password=hunter2',
        outputCursor: 42,
        completedAt: '2026-07-23T00:00:02.000Z',
      });
      expect(completion.state).toBe('persisted');
      expect(completion).toMatchObject({
        outputCursor: 42,
        payload: 'background result password=[REDACTED]',
      });
      expect(
        persistence.completeBackgroundActivity({
          activityId: 'activity-durable',
          completionId: 'completion-durable',
          outcome: 'completed',
          payload: 'background \u001b[31mresult\u001b[0m password=hunter2',
          outputCursor: 42,
          completedAt: '2026-07-23T00:00:02.000Z',
        }),
      ).toEqual(completion);
      expect(() =>
        persistence.completeBackgroundActivity({
          activityId: 'activity-durable',
          completionId: 'completion-durable',
          outcome: 'completed',
          payload: 'conflicting replay',
          outputCursor: 42,
          completedAt: '2026-07-23T00:00:02.000Z',
        }),
      ).toThrow(OperationConflictError);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      const interruptedTarget = reopened.startTurn(task.id, 'crash before runtime acknowledgement');
      expect(reopened.listBackgroundCompletions(task.id)[0]).toMatchObject({
        state: 'attached',
        targetTurnId: interruptedTarget.turnId,
        fragmentId: 'completion-durable',
      });
      expect(reopened.interruptActiveTurns()).toBe(1);
      expect(reopened.listBackgroundCompletions(task.id)[0]).toMatchObject({
        state: 'persisted',
        targetTurnId: null,
      });
      const target = reopened.startTurn(task.id, 'consume completion');
      const prepared = reopened.prepareContext(task.id, target.turnId);
      expect(prepared.fragments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'completion-durable',
            source: 'background',
            trust: 'assistant',
            content: expect.stringContaining('background result'),
          }),
        ]),
      );
      expect(prepared.fragments.map((fragment) => fragment.content).join('\n')).not.toContain(
        'hunter2',
      );
      expect(reopened.listBackgroundCompletions(task.id)[0]?.state).toBe('attached');
      const acknowledged = reopened.acknowledgeBackgroundFragments(task.id, target.turnId, [
        'completion-durable',
      ]);
      expect(acknowledged).toEqual([
        expect.objectContaining({
          type: 'delivery.acknowledged',
          completionId: 'completion-durable',
        }),
      ]);
      expect(reopened.listBackgroundCompletions(task.id)[0]?.state).toBe('runtimeAcked');
      const repeated = reopened.prepareContext(task.id, target.turnId);
      expect(repeated.fragments.some((fragment) => fragment.id === 'completion-durable')).toBe(
        false,
      );
      expect(
        reopened
          .listEventsAfter(task.id, 0)
          .filter((event) => event.type === 'delivery.acknowledged'),
      ).toHaveLength(1);
      reopened.close();
    });

    it('rolls back completion attachment when TurnAccepted cannot commit', () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const owner = startExecutingTurn(persistence, task.id);
      persistence.createBackgroundActivity({
        id: 'activity-atomic',
        taskId: task.id,
        ownerThreadId: task.id,
        ownerTurnId: owner.turnId,
        kind: 'monitor',
        wakePolicy: 'immediate',
        requiredCapabilities: ['workspace.read'],
        volumeQuotaBytes: 10_000,
        createdAt: '2026-07-23T00:00:00.000Z',
      });
      persistence.transitionBackgroundActivity(
        'activity-atomic',
        'running',
        '2026-07-23T00:00:01.000Z',
      );
      persistence.changeStage(task.id, owner.turnId, 'synthesizing');
      persistence.completeTurn(task.id, owner.turnId, 'completed');
      persistence.completeBackgroundActivity({
        activityId: 'activity-atomic',
        completionId: 'completion-atomic',
        outcome: 'completed',
        payload: 'atomic result',
        outputCursor: 1,
        completedAt: '2026-07-23T00:00:02.000Z',
      });
      persistence.close();

      const db = new Database(path);
      db.exec(`CREATE TRIGGER reject_turn_accepted BEFORE INSERT ON turn_events
        WHEN NEW.type = 'turn.accepted' BEGIN SELECT RAISE(ABORT, 'forced turn failure'); END;`);
      db.close();
      const reopened = new SqlitePersistenceClient(path);
      expect(() => reopened.startTurn(task.id, 'must roll back')).toThrow('forced turn failure');
      expect(reopened.listBackgroundCompletions(task.id)[0]).toMatchObject({
        state: 'persisted',
        targetTurnId: null,
      });
      expect(reopened.listMessages(task.id)).toHaveLength(1);
      reopened.close();
    });

    it('keeps manual completions pending and quarantines stale context epochs', () => {
      const { persistence } = createPersistence();
      const task = persistence.createTask();
      const owner = startExecutingTurn(persistence, task.id);
      persistence.createBackgroundActivity({
        id: 'activity-manual',
        taskId: task.id,
        ownerThreadId: task.id,
        ownerTurnId: owner.turnId,
        kind: 'scheduler',
        wakePolicy: 'manual',
        requiredCapabilities: [],
        volumeQuotaBytes: 10_000,
        createdAt: '2026-07-23T00:00:00.000Z',
      });
      persistence.transitionBackgroundActivity(
        'activity-manual',
        'running',
        '2026-07-23T00:00:01.000Z',
      );
      persistence.changeStage(task.id, owner.turnId, 'synthesizing');
      persistence.completeTurn(task.id, owner.turnId, 'completed');
      persistence.completeBackgroundActivity({
        activityId: 'activity-manual',
        completionId: 'completion-manual',
        outcome: 'completed',
        payload: 'manual result',
        outputCursor: 1,
        completedAt: '2026-07-23T00:00:02.000Z',
      });
      const first = persistence.startTurn(task.id, 'manual stays pending');
      expect(persistence.listBackgroundCompletions(task.id)[0]?.state).toBe('persisted');
      persistence.changeStage(task.id, first.turnId, 'understanding');
      persistence.changeStage(task.id, first.turnId, 'planning');
      persistence.changeStage(task.id, first.turnId, 'executing');
      persistence.changeStage(task.id, first.turnId, 'synthesizing');
      persistence.completeTurn(task.id, first.turnId, 'completed');
      persistence.releaseBackgroundCompletion('completion-manual');
      persistence.setGoal(task.id, 'new context epoch');
      expect(persistence.listBackgroundCompletions(task.id)[0]).toMatchObject({
        state: 'quarantined',
        quarantineReason: 'context_epoch_changed',
      });
      const target = persistence.startTurn(task.id, 'stale completion is excluded');
      expect(
        persistence
          .prepareContext(task.id, target.turnId)
          .fragments.some((fragment) => fragment.id === 'completion-manual'),
      ).toBe(false);
      persistence.close();
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

    commandExecutionIt(
      'seals the exact command before authorization and commits output before publishing it',
      async () => {
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
        const executable = '/usr/bin/printf';
        const argv = ['command-ok\\n'];
        let result: { exitCode: number; outputBytes: number };
        try {
          result = (await broker.dispatch({
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
        } catch (error) {
          persistence.close();
          throw error;
        }

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
      },
    );

    windowsCommandGateIt('runs the command tool inside an owned Windows Job Object', async () => {
      const { persistence, path } = createPersistence();
      const task = persistence.createTask();
      const workspacePath = join(path, '..');
      persistence.setWorkspace(task.id, workspacePath);
      const started = startExecutingTurn(persistence, task.id);
      const published: string[] = [];
      const broker = createDefaultToolBroker(
        () => persistence.getPermissionPolicy(task.id).policyEpoch,
        () => ({ decision: 'allow', reason: 'integration_test' }),
        {
          persistence,
          publish: (event) => published.push(event.type),
        },
      );
      startMockTurnCatalog(broker, {
        taskId: task.id,
        turnId: started.turnId,
        workspaceId: 'workspace-1',
        policyEpoch: 0,
      });

      const result = (await broker.dispatch({
        taskId: task.id,
        turnId: started.turnId,
        callId: 'command-windows-gate',
        providerName: 'run_command',
        input: {
          executable: 'C:\\Windows\\System32\\where.exe',
          argv: ['cmd.exe'],
          cwd: '.',
          purpose: 'Windows gate test',
        },
      })) as { exitCode: number; outputBytes: number };
      expect(result).toMatchObject({ exitCode: 0 });
      expect(persistence.listCommands(task.id)).toEqual([
        expect.objectContaining({
          callId: 'command-windows-gate',
          state: 'exited',
          pid: expect.any(Number),
        }),
      ]);
      expect(published).toEqual(['command.started', 'command.output', 'command.completed']);
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
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-migration-'));
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
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
        { version: 25 },
        { version: 26 },
        { version: 27 },
        { version: 28 },
        { version: 29 },
        { version: 30 },
        { version: 31 },
        { version: 32 },
        { version: 33 },
        { version: 34 },
        { version: 35 },
        { version: 36 },
        { version: 37 },
        { version: 38 },
        { version: 39 },
        { version: 40 },
        { version: 41 },
        { version: 42 },
        { version: 43 },
        { version: 44 },
        { version: 45 },
        { version: 46 },
        { version: 47 },
        { version: 48 },
        { version: 49 },
        { version: 50 },
        { version: 51 },
      ]);
      for (const [table, columns] of [
        [
          'turns',
          [
            'connection_id',
            'requested_provider',
            'requested_model',
            'resolved_provider',
            'resolved_model',
          ],
        ],
        ['agent_threads', ['connection_id', 'requested_provider', 'requested_model']],
        [
          'agents',
          [
            'connection_id',
            'requested_provider',
            'requested_model',
            'parent_agent_id',
            'depth',
            'can_delegate',
            'manager_policy_json',
          ],
        ],
        ['tasks', ['connection_id', 'requested_provider', 'requested_model']],
        ['messages', ['work_content']],
        ['teams', ['policy_json']],
        ['team_messages', ['execution_id', 'attempt_id']],
      ] as const) {
        const actual = new Set(
          (
            migrated.prepare(`PRAGMA table_info(${table})`).all() as {
              name: string;
            }[]
          ).map(({ name }) => name),
        );
        for (const column of columns) expect(actual.has(column)).toBe(true);
      }
      const migratedTables = new Set(
        (
          migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      );
      for (const table of [
        'team_global_limits',
        'team_budget_reservations',
        'team_message_deliveries',
        'team_delivery_events',
        'worker_worktrees',
        'canvas_views',
        'team_executions',
        'team_execution_instructions',
        'team_attempts',
        'team_v2_activity_events',
        'provider_connections',
      ])
        expect(migratedTables.has(table)).toBe(true);
      expect(
        (
          migrated.prepare('SELECT limits_json FROM team_global_limits WHERE id = 1').get() as {
            limits_json: string;
          }
        ).limits_json,
      ).toContain('spawnSlots');
      expect(
        migrated
          .prepare('PRAGMA table_info(agents)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(expect.arrayContaining(['write_capable', 'current_activity']));
      expect(
        (
          migrated.prepare("SELECT write_capable FROM agents WHERE id = 'task-1:leader'").get() as {
            write_capable: number;
          }
        ).write_capable,
      ).toBe(0);
      const backfilledTeamIdentity = migrated
        .prepare(
          `SELECT tasks.primary_thread_id, agents.id AS leader_id
           FROM tasks JOIN agents
             ON agents.thread_id = tasks.primary_thread_id AND agents.kind = 'leader'
           WHERE tasks.id = 'task-1'`,
        )
        .get() as { primary_thread_id: string; leader_id: string };
      expect(backfilledTeamIdentity).toEqual({
        primary_thread_id: 'task-1',
        leader_id: 'task-1:leader',
      });
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

    describe('canvas view persistence (Slice 6.1)', () => {
      it('validates camera bounds', () => {
        expect(() => validateCanvasCamera({ x: 0, y: 0, scale: 1 })).not.toThrow();
        expect(() => validateCanvasCamera({ x: Number.NaN, y: 0, scale: 1 })).toThrow(
          InvalidCanvasViewError,
        );
        expect(() => validateCanvasCamera({ x: 0, y: 0, scale: 0.1 })).toThrow(
          InvalidCanvasViewError,
        );
        expect(() => validateCanvasCamera({ x: 0, y: 0, scale: 2 })).toThrow(
          InvalidCanvasViewError,
        );
        expect(() => validateCanvasCamera({ x: 100_000, y: 0, scale: 1 })).toThrow(
          InvalidCanvasViewError,
        );
      });

      it('validates node position bounds', () => {
        expect(() => validateCanvasNodePositions({ a: { x: 10, y: -20 } })).not.toThrow();
        expect(() =>
          validateCanvasNodePositions({ a: { x: Number.POSITIVE_INFINITY, y: 0 } }),
        ).toThrow(InvalidCanvasViewError);
        expect(() => validateCanvasNodePositions({ a: { x: 0, y: 100_000 } })).toThrow(
          InvalidCanvasViewError,
        );
      });

      it('caps node positions at 32 entries', () => {
        const fourEntries: Record<string, { x: number; y: number }> = {};
        for (let i = 0; i < 4; i++) fourEntries[`agent-${i}`] = { x: i, y: i };
        expect(() => validateCanvasNodePositions(fourEntries)).not.toThrow();

        const thirtyThreeEntries: Record<string, { x: number; y: number }> = {};
        for (let i = 0; i < 33; i++) thirtyThreeEntries[`agent-${i}`] = { x: i, y: i };
        expect(() => validateCanvasNodePositions(thirtyThreeEntries)).toThrow(
          InvalidCanvasViewError,
        );
      });

      it('creates then updates a canvas view, bumping revision each save', () => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        expect(persistence.getCanvasView(task.id)).toBeNull();

        const created = persistence.saveCanvasView({
          taskId: task.id,
          camera: { x: 10, y: 20, scale: 0.8 },
          nodePositions: {},
          revision: 0,
        });
        expect(created.revision).toBe(1);
        expect(created.camera).toEqual({ x: 10, y: 20, scale: 0.8 });

        const updated = persistence.saveCanvasView({
          taskId: task.id,
          camera: { x: 30, y: 40, scale: 1.1 },
          nodePositions: {},
          revision: created.revision,
        });
        expect(updated.revision).toBe(2);
        expect(persistence.getCanvasView(task.id)).toMatchObject({
          camera: { x: 30, y: 40, scale: 1.1 },
          revision: 2,
        });
        persistence.close();
      });

      it('rejects a save with a stale expected revision', () => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        persistence.saveCanvasView({
          taskId: task.id,
          camera: { x: 0, y: 0, scale: 1 },
          nodePositions: {},
          revision: 0,
        });
        // A second "create" (revision 0) is now stale — a row already exists at revision 1.
        expect(() =>
          persistence.saveCanvasView({
            taskId: task.id,
            camera: { x: 1, y: 1, scale: 1 },
            nodePositions: {},
            revision: 0,
          }),
        ).toThrow(CanvasViewConflictError);
        // A stale revision on an existing row is rejected the same way.
        persistence.saveCanvasView({
          taskId: task.id,
          camera: { x: 5, y: 5, scale: 1 },
          nodePositions: {},
          revision: 1,
        });
        expect(() =>
          persistence.saveCanvasView({
            taskId: task.id,
            camera: { x: 9, y: 9, scale: 1 },
            nodePositions: {},
            revision: 1, // now stale — current revision is 2
          }),
        ).toThrow(CanvasViewConflictError);
        expect(persistence.getCanvasView(task.id)?.revision).toBe(2);
        persistence.close();
      });

      it('drops node positions for agent ids that no longer exist for the Task on load', () => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        const leader = persistence.getTaskLeader(task.id);
        persistence.saveCanvasView({
          taskId: task.id,
          camera: { x: 0, y: 0, scale: 1 },
          nodePositions: {
            [leader.id]: { x: 11, y: 22 },
            'agent-that-no-longer-exists': { x: 99, y: 99 },
          },
          revision: 0,
        });
        expect(persistence.getCanvasView(task.id)?.nodePositions).toEqual({
          [leader.id]: { x: 11, y: 22 },
        });
        persistence.close();
      });

      it('rejects invalid camera/positions and unknown Tasks', () => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        expect(() =>
          persistence.saveCanvasView({
            taskId: task.id,
            camera: { x: 0, y: 0, scale: 5 },
            nodePositions: {},
            revision: 0,
          }),
        ).toThrow(InvalidCanvasViewError);
        expect(() =>
          persistence.saveCanvasView({
            taskId: 'missing-task',
            camera: { x: 0, y: 0, scale: 1 },
            nodePositions: {},
            revision: 0,
          }),
        ).toThrow(NotFoundError);
        expect(() => persistence.getCanvasView('missing-task')).toThrow(NotFoundError);
        persistence.close();
      });

      it('rejects a save with more than 32 node position entries', () => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        const tooMany: Record<string, { x: number; y: number }> = {};
        for (let i = 0; i < 33; i++) tooMany[`agent-${i}`] = { x: i, y: i };
        expect(() =>
          persistence.saveCanvasView({
            taskId: task.id,
            camera: { x: 0, y: 0, scale: 1 },
            nodePositions: tooMany,
            revision: 0,
          }),
        ).toThrow(InvalidCanvasViewError);
        persistence.close();
      });

      it('rejects a save whose serialized node positions exceed the size cap', () => {
        const { persistence } = createPersistence();
        const task = persistence.createTask();
        // Stay under the entry-count cap; blow the byte cap via long agent ids instead.
        const bloated: Record<string, { x: number; y: number }> = {};
        for (let i = 0; i < 4; i++) bloated[`agent-${i}-${'x'.repeat(5_000)}`] = { x: i, y: i };
        expect(() =>
          persistence.saveCanvasView({
            taskId: task.id,
            camera: { x: 0, y: 0, scale: 1 },
            nodePositions: bloated,
            revision: 0,
          }),
        ).toThrow(InvalidCanvasViewError);
        persistence.close();
      });

      it('persists the canvas view across a restart', () => {
        const { persistence, path } = createPersistence();
        const task = persistence.createTask();
        persistence.saveCanvasView({
          taskId: task.id,
          camera: { x: 3, y: 4, scale: 0.9 },
          nodePositions: {},
          revision: 0,
        });
        persistence.close();

        const reopened = new SqlitePersistenceClient(path);
        expect(reopened.getCanvasView(task.id)).toMatchObject({
          camera: { x: 3, y: 4, scale: 0.9 },
          revision: 1,
        });
        reopened.close();
      });
    });
  });
else
  describe('SqlitePersistenceClient v27 Electron ABI bridge', () => {
    it('runs the SQLite integration suite with the bundled Electron Node ABI', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/persistence.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
          timeout: 30_000,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    }, 35_000);
  });

function persistedEditPlan(preImage = 'before', postImage = 'after'): PreparedStructuredPatch {
  const facts = {
    version: 1,
    policyEpoch: 0,
    operations: Object.freeze([
      Object.freeze({
        kind: 'update' as const,
        path: 'src/a.ts',
        canonicalPath: '/workspace/src/a.ts',
        destination: null,
        canonicalDestination: null,
        revisionTokenId: 'token-1',
        preRevision: Object.freeze({
          identityDigest: '8'.repeat(64),
          contentHash: editHash(preImage),
          size: Buffer.byteLength(preImage),
          mode: 0o100600,
          nlink: 1 as const,
        }),
        preImage,
        postImage,
        preHash: editHash(preImage),
        postHash: editHash(postImage),
      }),
    ]),
  } as const;
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

function persistedTwoStepEditPlan(): PreparedStructuredPatch {
  const operation = (leaf: string, token: string, before: string, after: string) =>
    Object.freeze({
      kind: 'update' as const,
      path: `src/${leaf}`,
      canonicalPath: `/workspace/src/${leaf}`,
      destination: null,
      canonicalDestination: null,
      revisionTokenId: token,
      preRevision: Object.freeze({
        identityDigest: editHash(`identity:${leaf}`),
        contentHash: editHash(before),
        size: Buffer.byteLength(before),
        mode: 0o100600,
        nlink: 1 as const,
      }),
      preImage: before,
      postImage: after,
      preHash: editHash(before),
      postHash: editHash(after),
    });
  const facts = {
    version: 1 as const,
    policyEpoch: 0,
    operations: Object.freeze([
      operation('a.ts', 'token-a', 'before-a', 'after-a'),
      operation('b.ts', 'token-b', 'before-b', 'after-b'),
    ]),
  };
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

function persistedEditPlanForKind(kind: 'add' | 'delete' | 'rename'): PreparedStructuredPatch {
  const content = kind === 'add' ? 'added' : 'before';
  const preRevision =
    kind === 'add'
      ? null
      : Object.freeze({
          identityDigest: editHash(`identity:${kind}`),
          contentHash: editHash(content),
          size: Buffer.byteLength(content),
          mode: 0o100640,
          nlink: 1 as const,
        });
  const operation = Object.freeze({
    kind,
    path: `src/${kind}.ts`,
    canonicalPath: `/workspace/src/${kind}.ts`,
    destination: kind === 'rename' ? 'src/renamed.ts' : null,
    canonicalDestination: kind === 'rename' ? '/workspace/src/renamed.ts' : null,
    revisionTokenId: kind === 'add' ? null : `token-${kind}`,
    preRevision,
    preImage: kind === 'add' ? null : content,
    postImage: kind === 'delete' ? null : content,
    preHash: kind === 'add' ? null : editHash(content),
    postHash: kind === 'delete' ? null : editHash(content),
  });
  const facts = {
    version: 1 as const,
    policyEpoch: 0,
    operations: Object.freeze([operation]),
  };
  return Object.freeze({ ...facts, digest: structuredPatchDigest(facts) });
}

function editHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function persistedNativeIntentSeed(
  saga: ReturnType<SqlitePersistenceClient['getEditSaga']>,
  token: MutationLeaseToken,
): NativeMutationIntentSeed {
  const step = saga.steps[0]!;
  return createNativeMutationIntentSeed({
    id: 'native-intent-1',
    sagaId: saga.id,
    ordinal: step.ordinal,
    direction: 'forward',
    kind: step.operation.kind,
    operationDigest: editHash(JSON.stringify(step.operation)),
    workspaceKey: token.workspaceKey,
    rootIdentityDigest: token.rootIdentityDigest,
    policyEpoch: token.policyEpoch,
    leaseFence: String(token.fence),
    nativeSessionId: '6'.repeat(32),
    sourceSegments: ['src', 'a.ts'],
    destinationSegments: null,
    expectedSource: {
      state: 'present',
      ...step.operation.preRevision!,
    },
    expectedDestination: { state: 'absent' },
    artifact: {
      artifactId: step.operation.postArtifact!.artifactId,
      contentHash: step.operation.postArtifact!.contentHash,
      size: step.operation.postArtifact!.size,
      expectedMode: step.operation.preRevision!.mode,
    },
    createdAt: '2026-07-23T00:00:01.000Z',
  });
}

function persistedNativeUpdateSeed(
  saga: ReturnType<SqlitePersistenceClient['getEditSaga']>,
  token: MutationLeaseToken,
  ordinal: number,
  direction: 'forward' | 'compensation',
  id: string,
  expectedSource?: NativeMutationRevision,
): NativeMutationIntentSeed {
  const step = saga.steps[ordinal - 1]!;
  const reference =
    direction === 'forward' ? step.operation.postArtifact : step.operation.preArtifact;
  if (reference === null || step.operation.preRevision === null)
    throw new Error('test update operation is missing its artifact binding');
  return createNativeMutationIntentSeed({
    id,
    sagaId: saga.id,
    ordinal,
    direction,
    kind: 'update',
    operationDigest: editHash(JSON.stringify(step.operation)),
    workspaceKey: token.workspaceKey,
    rootIdentityDigest: token.rootIdentityDigest,
    policyEpoch: token.policyEpoch,
    leaseFence: String(token.fence),
    nativeSessionId: '6'.repeat(32),
    sourceSegments: ['src', ordinal === 1 ? 'a.ts' : 'b.ts'],
    destinationSegments: null,
    expectedSource: expectedSource ?? { state: 'present', ...step.operation.preRevision },
    expectedDestination: { state: 'absent' },
    artifact: {
      artifactId: reference.artifactId,
      contentHash: reference.contentHash,
      size: reference.size,
      expectedMode: step.operation.preRevision.mode,
    },
    createdAt: '2026-07-23T00:00:02.000Z',
  });
}

function observeNativeUpdateIntent(
  persistence: SqlitePersistenceClient,
  seed: NativeMutationIntentSeed,
  token: MutationLeaseToken,
  identityDigit: string,
) {
  let intent = persistence.prepareNativeMutationIntent(seed, token, seed.createdAt);
  intent = persistence.updateNativeMutationIntent(
    intent.id,
    intent.revision,
    token,
    seed.createdAt,
    seed.nativeSessionId,
    { state: 'aux_pending' },
  );
  const staged: NativeMutationRevision = {
    state: 'present',
    identityDigest: identityDigit.repeat(64),
    contentHash: intent.temp!.expectedContentHash,
    size: intent.temp!.expectedSize,
    mode: intent.temp!.expectedMode,
    nlink: 1,
  };
  intent = persistence.updateNativeMutationIntent(
    intent.id,
    intent.revision,
    token,
    seed.createdAt,
    seed.nativeSessionId,
    { state: 'aux_observed', auxObservation: staged },
  );
  intent = persistence.updateNativeMutationIntent(
    intent.id,
    intent.revision,
    token,
    seed.createdAt,
    seed.nativeSessionId,
    { state: 'effect_pending' },
  );
  intent = persistence.updateNativeMutationIntent(
    intent.id,
    intent.revision,
    token,
    seed.createdAt,
    seed.nativeSessionId,
    {
      state: 'effect_observed',
      effectObservation: {
        source: staged,
        destination: { state: 'absent' },
        auxiliary: seed.expectedSource,
      },
    },
  );
  return { intent, staged };
}

async function nativeIntentFixture(
  id: string,
  expiresAt = '2026-07-23T00:01:01.000Z',
  preimage = 'before',
  postimage = 'after',
  options: Parameters<typeof createPersistence>[0] = {},
) {
  const { persistence, path } = createPersistence(options);
  const task = persistence.createTask();
  const rootIdentityDigest = '8'.repeat(64);
  const workspaceKey = bindMutationWorkspace(
    persistence,
    task.id,
    '/workspace',
    rootIdentityDigest,
  );
  const turn = persistence.startTurn(task.id, id);
  const saga = persistence.prepareEditSaga(
    await stageEditSagaRequest(
      {
        id: `${id}-saga`,
        taskId: task.id,
        turnId: turn.turnId,
        operationId: `${id}-operation`,
        plan: persistedEditPlan(preimage, postimage),
        createdAt: '2026-07-23T00:00:00.000Z',
      },
      new PersistenceTestArtifacts(),
    ),
  );
  const token = persistence.acquireMutationLease({
    workspaceKey,
    rootIdentityDigest,
    holderInstanceId: `${id}-instance`,
    taskId: task.id,
    turnId: turn.turnId,
    sagaId: saga.id,
    purpose: 'forward',
    policyEpoch: saga.policyEpoch,
    intentDigest: saga.planDigest,
    now: '2026-07-23T00:00:01.000Z',
    expiresAt,
  });
  return { persistence, path, taskId: task.id, saga, token };
}

function persistedObservation(value: string, identityDigest: string): OperationObservation {
  return {
    source: {
      state: 'present',
      revision: { identityDigest, contentHash: editHash(value), size: Buffer.byteLength(value) },
    },
    destination: { state: 'absent' },
  };
}

function fileBoundary(filePath: string, artifacts: EditArtifactStore): EditEffectBoundary {
  const observeValue = (value: string) => persistedObservation(value, `file:${editHash(value)}`);
  return {
    async apply(step: EditSagaStep) {
      if (readFileSync(filePath, 'utf8') !== 'before') throw new Error('unexpected pre-image');
      const reference = step.operation.postArtifact;
      if (reference === null) throw new Error('missing post artifact');
      const value = (await artifacts.read(reference)).toString('utf8');
      writeFileSync(filePath, value);
      return observeValue(value);
    },
    async observe() {
      const value = readFileSync(filePath, 'utf8');
      return value === 'before'
        ? { state: 'pre' as const, observation: observeValue(value) }
        : value === 'after'
          ? { state: 'post' as const, observation: observeValue(value) }
          : { state: 'drift' as const, observation: observeValue(value) };
    },
    async restore(step: EditSagaStep) {
      const reference = step.operation.preArtifact;
      if (reference === null) throw new Error('missing pre artifact');
      const value = (await artifacts.read(reference)).toString('utf8');
      writeFileSync(filePath, value);
      return observeValue(value);
    },
  };
}

function withoutEditRevision<T extends { revision: number }>(value: T): Omit<T, 'revision'> {
  const { revision: _revision, ...rest } = value;
  return rest;
}

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
