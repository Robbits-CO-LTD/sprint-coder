import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  OperationConflictError,
  ProjectArchivedError,
  ProjectConflictError,
  SqlitePersistenceClient,
  TaskAssignmentBlockedError,
  TurnActiveError,
} from './persistence';
import { electronTestExecutablePath } from './electron-test-runtime';

const directories: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const bridgeTimeoutMs = process.platform === 'win32' ? 60_000 : 30_000;

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function createPersistence(): { persistence: SqlitePersistenceClient; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-projects-'));
  directories.push(directory);
  const path = join(directory, 'sprint-coder.sqlite3');
  return { persistence: new SqlitePersistenceClient(path), path };
}

if (runsWithElectronAbi)
  describe('Project persistence', () => {
    it('migrates v57 databases through explicit memory and provenance schemas', () => {
      const { persistence, path } = createPersistence();
      persistence.createProject('pre-memory');
      persistence.close();
      const legacy = new Database(path);
      legacy.exec(`
        DROP INDEX project_memories_project_order_idx;
        DROP TABLE project_memories;
        DELETE FROM schema_migrations WHERE version IN (58, 59);
      `);
      legacy.close();
      const migrated = new SqlitePersistenceClient(path);
      const inspection = new Database(path, { readonly: true });
      expect(
        inspection.prepare('SELECT checksum FROM schema_migrations WHERE version = 58').get(),
      ).toEqual({ checksum: 'project-context-hub-v58-explicit-memory' });
      expect(
        inspection.prepare('SELECT checksum FROM schema_migrations WHERE version = 59').get(),
      ).toEqual({ checksum: 'project-context-hub-v59-memory-provenance' });
      expect(inspection.prepare("PRAGMA table_info('project_memories')").all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'created_by' })]),
      );
      inspection.close();
      migrated.close();
    });

    it('migrates v56 databases to the v57 Project reference schema', () => {
      const { persistence, path } = createPersistence();
      persistence.createProject('pre-reference');
      persistence.close();
      const legacy = new Database(path);
      legacy.exec(`
        DROP INDEX project_references_source_task_idx;
        DROP INDEX project_references_project_order_idx;
        DROP TABLE project_references;
        DELETE FROM schema_migrations WHERE version = 57;
      `);
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      const inspection = new Database(path, { readonly: true });
      expect(
        inspection.prepare('SELECT checksum FROM schema_migrations WHERE version = 57').get(),
      ).toEqual({ checksum: 'project-context-hub-v57-reference-files' });
      expect(
        inspection
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_references'",
          )
          .get(),
      ).toEqual({ name: 'project_references' });
      inspection.close();
      migrated.close();
    });

    it('migrates a v54 Task to an unassigned v55 Task', () => {
      const { persistence, path } = createPersistence();
      const legacyTask = persistence.createTask('v54 task');
      persistence.close();

      const legacy = new Database(path);
      legacy.pragma('foreign_keys = OFF');
      legacy.exec(`
      DROP INDEX tasks_project_activity_idx;
      ALTER TABLE tasks DROP COLUMN project_id;
      DROP TABLE projects;
      DELETE FROM schema_migrations WHERE version = 55;
    `);
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      expect(migrated.getTask(legacyTask.id).projectId).toBeNull();
      const versions = new Database(path, { readonly: true });
      expect(
        versions.prepare('SELECT checksum FROM schema_migrations WHERE version = 55').get(),
      ).toEqual({ checksum: 'project-context-hub-v55-project-core' });
      expect(versions.pragma('foreign_key_check')).toEqual([]);
      versions.close();
      migrated.close();
    });

    it('creates, updates, archives, and restores Projects with revision CAS', () => {
      const { persistence } = createPersistence();
      const created = persistence.createProject('  同名 Project  ');
      const duplicate = persistence.createProject('同名 Project');

      expect(created).toMatchObject({
        name: '同名 Project',
        archived: false,
        revision: 1,
        taskCount: 0,
      });
      expect(duplicate.id).not.toBe(created.id);

      const renamed = persistence.updateProject({
        projectId: created.id,
        expectedRevision: 1,
        name: '更新後',
      });
      expect(renamed).toMatchObject({ name: '更新後', revision: 2 });
      expect(
        persistence.updateProject({
          projectId: created.id,
          expectedRevision: 2,
          name: '更新後',
        }),
      ).toMatchObject({ revision: 2 });
      expect(() =>
        persistence.updateProject({
          projectId: created.id,
          expectedRevision: 1,
          archived: true,
        }),
      ).toThrow(ProjectConflictError);

      const archived = persistence.updateProject({
        projectId: created.id,
        expectedRevision: 2,
        archived: true,
      });
      expect(archived).toMatchObject({ archived: true, revision: 3 });
      const existingTask = persistence.createTask('existing before archive');
      persistence.assignTaskToProject({
        projectId: duplicate.id,
        taskId: existingTask.id,
        expectedProjectId: null,
      });
      const archivedDuplicate = persistence.updateProject({
        projectId: duplicate.id,
        expectedRevision: duplicate.revision,
        archived: true,
      });
      expect(
        persistence.assignTaskToProject({
          projectId: archivedDuplicate.id,
          taskId: existingTask.id,
          expectedProjectId: archivedDuplicate.id,
        }).projectId,
      ).toBe(archivedDuplicate.id);
      expect(
        persistence.updateProject({
          projectId: created.id,
          expectedRevision: 3,
          archived: false,
        }),
      ).toMatchObject({ archived: false, revision: 4 });
      persistence.close();
    });

    it('saves only explicit completed-Turn memory to its sealed Project and seals it next Turn', () => {
      const { persistence } = createPersistence();
      const projectA = persistence.createProject('A');
      const projectB = persistence.createProject('B');
      const task = persistence.createTask('source', true, projectA.id);
      const source = persistence.startTurn(task.id, 'request text');
      for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
        persistence.changeStage(task.id, source.turnId, stage);
      persistence.appendDelta(task.id, source.turnId, randomUUID(), 'answer text');
      persistence.completeTurn(task.id, source.turnId, 'completed');

      persistence.assignTaskToProject({
        projectId: projectB.id,
        taskId: task.id,
        expectedProjectId: projectA.id,
      });
      const memory = persistence.createProjectMemoryFromTurn({
        projectId: projectA.id,
        sourceTurnId: source.turnId,
        content: '  Preserve the verified API decision.  ',
      });
      expect(memory).toMatchObject({
        projectId: projectA.id,
        sourceTaskId: task.id,
        sourceTurnId: source.turnId,
        content: 'Preserve the verified API decision.',
        createdBy: 'user',
        status: 'active',
        localOnly: true,
      });
      expect(() =>
        persistence.createProjectMemoryFromTurn({
          projectId: projectB.id,
          sourceTurnId: source.turnId,
          content: 'wrong project',
        }),
      ).toThrow();

      persistence.assignTaskToProject({
        projectId: projectA.id,
        taskId: task.id,
        expectedProjectId: projectB.id,
      });
      const next = persistence.startTurn(task.id, 'next turn');
      expect(persistence.prepareContext(task.id, next.turnId).projectItems).toEqual([
        expect.objectContaining({
          kind: 'memory',
          authority: 'user',
          localOnly: true,
          content: 'Preserve the verified API decision.',
        }),
      ]);
      persistence.cancelTurn(task.id, next.turnId);

      expect(
        persistence.updateProjectMemory({
          memoryId: memory.id,
          expectedRevision: memory.revision,
          status: 'disabled',
        }),
      ).toMatchObject({ status: 'disabled', revision: 2 });
      const afterDisable = persistence.startTurn(task.id, 'after disable');
      expect(persistence.prepareContext(task.id, afterDisable.turnId).projectItems).toEqual([]);
      persistence.close();
    });

    it('stores agent-selected memory with non-user authority on the next Turn', () => {
      const { persistence } = createPersistence();
      const project = persistence.createProject('Agent memory');
      const task = persistence.createTask('source', false, project.id);
      const source = persistence.startTurn(task.id, 'verify the stable command');
      for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
        persistence.changeStage(task.id, source.turnId, stage);
      persistence.appendDelta(task.id, source.turnId, randomUUID(), 'npm run check is verified');
      persistence.completeTurn(task.id, source.turnId, 'completed');

      const memory = persistence.createAgentProjectMemoryFromTurn({
        projectId: project.id,
        sourceTurnId: source.turnId,
        content: 'The verified project check command is npm run check.',
      });
      expect(memory.createdBy).toBe('assistant');

      const next = persistence.startTurn(task.id, 'continue');
      expect(persistence.prepareContext(task.id, next.turnId).projectItems).toEqual([
        expect.objectContaining({
          kind: 'memory',
          authority: 'none',
          content: 'The verified project check command is npm run check.',
        }),
      ]);
      persistence.close();
    });

    it('rejects memory from unfinished or answer-less Turns', () => {
      const { persistence } = createPersistence();
      const project = persistence.createProject('A');
      const task = persistence.createTask('source', false, project.id);
      const turn = persistence.startTurn(task.id, 'unfinished');
      expect(() =>
        persistence.createProjectMemoryFromTurn({
          projectId: project.id,
          sourceTurnId: turn.turnId,
          content: 'must not save',
        }),
      ).toThrow();
      persistence.close();
    });

    it('creates a Project Task atomically and keeps membership and identities across restart', () => {
      const { persistence, path } = createPersistence();
      const project = persistence.createProject('A1');
      const task = persistence.createTask('Project Task', true, project.id);
      const leaderId = persistence.getTaskLeader(task.id).id;

      expect(task).toMatchObject({ projectId: project.id, localOnly: true });
      expect(persistence.listProjects()[0]).toMatchObject({ id: project.id, taskCount: 1 });
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getTask(task.id)).toMatchObject({ projectId: project.id });
      expect(reopened.getTaskLeader(task.id).id).toBe(leaderId);
      expect(reopened.listProjects()[0]).toMatchObject({ id: project.id, taskCount: 1 });
      reopened.close();
    });

    it('lists archived Tasks and counts only non-archived Tasks in a Project', () => {
      const { persistence, path } = createPersistence();
      const project = persistence.createProject('Archive restoration');
      const active = persistence.createTask('Active', false, project.id);
      const archived = persistence.createTask('Archived', false, project.id);
      persistence.setArchived(archived.id, true);

      expect(persistence.listTasks().map(({ id }) => id)).toEqual(
        expect.arrayContaining([active.id, archived.id]),
      );
      expect(persistence.listProjects()[0]?.taskCount).toBe(1);
      persistence.close();

      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.listTasks().find(({ id }) => id === archived.id)?.archived).toBe(true);
      reopened.close();
    });

    it('uses stable Project and Task ordering when activity timestamps tie', () => {
      const { persistence, path } = createPersistence();
      const projectA = persistence.createProject('A');
      const projectB = persistence.createProject('B');
      const taskA = persistence.createTask('A');
      const taskB = persistence.createTask('B');
      const tiedAt = '2026-07-31T00:00:00.000Z';
      const database = new Database(path);
      database.prepare('UPDATE projects SET updated_at = ?').run(tiedAt);
      database.prepare('UPDATE tasks SET updated_at = ?, pinned = 0').run(tiedAt);
      database.close();

      expect(persistence.listProjects().map(({ id }) => id)).toEqual(
        [projectA.id, projectB.id].sort(),
      );
      expect(persistence.listTasks().map(({ id }) => id)).toEqual([taskA.id, taskB.id].sort());

      persistence.setPinned(taskB.id, true);
      expect(persistence.listTasks()[0]?.id).toBe(taskB.id);
      persistence.close();
    });

    it('moves and unassigns by expected membership without changing the Task leader', () => {
      const { persistence } = createPersistence();
      const projectA = persistence.createProject('A');
      const projectB = persistence.createProject('B');
      const task = persistence.createTask('Movable', false, projectA.id);
      const leaderId = persistence.getTaskLeader(task.id).id;

      expect(
        persistence.assignTaskToProject({
          projectId: projectB.id,
          taskId: task.id,
          expectedProjectId: projectA.id,
        }).projectId,
      ).toBe(projectB.id);
      expect(() =>
        persistence.unassignTaskFromProject({ taskId: task.id, expectedProjectId: projectA.id }),
      ).toThrow(ProjectConflictError);
      expect(
        persistence.unassignTaskFromProject({ taskId: task.id, expectedProjectId: projectB.id })
          .projectId,
      ).toBeNull();
      expect(persistence.getTaskLeader(task.id).id).toBe(leaderId);
      persistence.close();
    });

    it('rejects new membership in archived Projects without leaving an orphan Task', () => {
      const { persistence } = createPersistence();
      const project = persistence.createProject('Archived');
      persistence.updateProject({
        projectId: project.id,
        expectedRevision: project.revision,
        archived: true,
      });

      expect(() => persistence.createTask('Rejected', false, project.id)).toThrow(
        ProjectArchivedError,
      );
      expect(persistence.listTasks()).toHaveLength(0);
      persistence.close();
    });

    it('rejects an effective move while a Turn is active, but permits an exact no-op', () => {
      const { persistence } = createPersistence();
      const projectA = persistence.createProject('A');
      const projectB = persistence.createProject('B');
      const task = persistence.createTask('Busy', false, projectA.id);
      persistence.startTurn(task.id, 'working');

      expect(
        persistence.assignTaskToProject({
          projectId: projectA.id,
          taskId: task.id,
          expectedProjectId: projectA.id,
        }).projectId,
      ).toBe(projectA.id);
      expect(() =>
        persistence.assignTaskToProject({
          projectId: projectB.id,
          taskId: task.id,
          expectedProjectId: projectA.id,
        }),
      ).toThrow(TurnActiveError);
      persistence.close();
    });

    it('rejects a move while a Team execution or Mission is non-terminal', () => {
      const { persistence, path } = createPersistence();
      const projectA = persistence.createProject('A');
      const projectB = persistence.createProject('B');
      const task = persistence.createTask('Team busy', false, projectA.id);
      const team = persistence.promoteTaskToTeam(task.id);
      persistence.transitionTeamState(team.id, 'forming');
      const execution = persistence.createTeamExecution({
        teamId: team.id,
        assigneeAgentId: team.leaderAgentId,
        createdByAgentId: team.leaderAgentId,
        instruction: 'work',
        now: new Date().toISOString(),
      });

      expect(() =>
        persistence.assignTaskToProject({
          projectId: projectB.id,
          taskId: task.id,
          expectedProjectId: projectA.id,
        }),
      ).toThrow(TaskAssignmentBlockedError);

      persistence.transitionTeamExecution({
        executionId: execution.id,
        to: 'canceled',
        now: new Date().toISOString(),
      });
      const now = new Date().toISOString();
      const database = new Database(path);
      database
        .prepare(
          `INSERT INTO team_missions(
           id, team_id, created_by_agent_id, state, objective, done_criteria_json,
           current_step_ordinal, revision, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'queued', ?, '[]', 1, 1, ?, ?, NULL)`,
        )
        .run(randomUUID(), team.id, team.leaderAgentId, 'queued mission', now, now);
      database.close();
      expect(() =>
        persistence.assignTaskToProject({
          projectId: projectB.id,
          taskId: task.id,
          expectedProjectId: projectA.id,
        }),
      ).toThrow(TaskAssignmentBlockedError);
      persistence.close();
    });

    it('replays Project mutations by operation identity', () => {
      const { persistence } = createPersistence();
      let calls = 0;
      const action = () => {
        calls += 1;
        return persistence.createProject('Replay');
      };
      const first = persistence.executeOperation(
        'renderer',
        'projects',
        'projects.create',
        'op',
        'a',
        action,
      );
      const replay = persistence.executeOperation(
        'renderer',
        'projects',
        'projects.create',
        'op',
        'a',
        action,
      );

      expect(replay).toEqual(first);
      expect(calls).toBe(1);
      expect(() =>
        persistence.executeOperation('renderer', 'projects', 'projects.create', 'op', 'b', action),
      ).toThrow(OperationConflictError);
      persistence.close();
    });
  });
else
  describe('Project persistence Electron ABI bridge', () => {
    it(
      'runs the Project persistence suite with the bundled Electron Node ABI',
      () => {
        const result = spawnSync(
          electronTestExecutablePath(),
          [
            join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
            'run',
            'src/main/project-persistence.test.ts',
          ],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
            timeout: bridgeTimeoutMs,
          },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      },
      bridgeTimeoutMs + 5_000,
    );
  });
