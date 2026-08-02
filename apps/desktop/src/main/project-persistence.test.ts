import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  ProjectFolderMutationBlockedError,
  ProjectWorkspaceRuntimeUnavailableError,
  ReferenceInUseError,
  SqlitePersistenceClient,
  TaskAssignmentBlockedError,
  TurnActiveError,
} from './persistence';
import { electronTestExecutablePath } from './electron-test-runtime';
import { workspaceMutationBinding } from './path-guard';

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

function folderBinding(path: string, role: 'primary' | 'secondary', identity: string, id?: string) {
  return {
    ...(id === undefined ? {} : { id }),
    path,
    canonicalPath: path,
    label: path.split('/').at(-1) ?? path,
    role,
    workspaceKey: identity.repeat(64),
    rootIdentityDigest: identity.repeat(64),
  };
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

    it('migrates a v59 Project without inferring roots and preserves its legacy Task Workspace', () => {
      const { persistence, path } = createPersistence();
      const project = persistence.createProject('v59 Project');
      const task = persistence.createTask('legacy Workspace', false, project.id);
      const turn = persistence.startTurn(task.id, 'legacy history');
      persistence.cancelTurn(task.id, turn.turnId);
      const team = persistence.promoteTaskToTeam(task.id);
      persistence.close();

      const legacy = new Database(path);
      legacy.pragma('foreign_keys = OFF');
      legacy
        .prepare(
          `UPDATE tasks SET workspace_path = ?, mutation_scope_key = ?,
             mutation_root_identity_digest = ? WHERE id = ?`,
        )
        .run('/tmp/legacy-project-workspace', 'a'.repeat(64), 'b'.repeat(64), task.id);
      legacy.exec(`
        DROP TABLE turn_workspace_roots;
        DROP TABLE turn_workspace_sets;
        DROP INDEX project_references_project_root_idx;
        DROP INDEX project_references_source_task_idx;
        DROP INDEX project_references_project_order_idx;
        DROP INDEX project_references_root_path_idx;
        DROP INDEX project_references_task_path_idx;
        ALTER TABLE project_references RENAME TO project_references_v60;
        CREATE TABLE project_references (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          relative_path TEXT NOT NULL CHECK (length(relative_path) >= 1 AND length(relative_path) <= 1024),
          registered_root_identity TEXT NOT NULL CHECK (length(registered_root_identity) = 64),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
          last_sealed_digest TEXT CHECK (last_sealed_digest IS NULL OR length(last_sealed_digest) = 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(project_id, source_task_id, relative_path)
        );
        INSERT INTO project_references(
          id, project_id, source_task_id, relative_path, registered_root_identity,
          enabled, revision, last_sealed_digest, created_at, updated_at
        ) SELECT id, project_id, source_task_id, relative_path, registered_root_identity,
            enabled, revision, last_sealed_digest, created_at, updated_at
          FROM project_references_v60 WHERE source_task_id IS NOT NULL;
        DROP TABLE project_references_v60;
        CREATE INDEX project_references_project_order_idx
          ON project_references(project_id, created_at, id);
        CREATE INDEX project_references_source_task_idx
          ON project_references(source_task_id, id);
        DROP INDEX project_workspace_roots_project_order_idx;
        DROP INDEX project_workspace_roots_primary_idx;
        DROP TABLE project_workspace_roots;
        ALTER TABLE tasks DROP COLUMN legacy_project_workspace_fallback;
        ALTER TABLE projects DROP COLUMN workspace_roots_configured;
        DELETE FROM schema_migrations WHERE version = 60;
      `);
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      expect(migrated.listProjects()).toContainEqual(
        expect.objectContaining({ id: project.id, folderCount: 0, primaryFolder: null }),
      );
      expect(migrated.listProjectFolders(project.id)).toEqual([]);
      expect(migrated.getEffectiveWorkspaceSet(task.id)).toMatchObject({
        source: 'task',
        projectId: project.id,
        primaryRootId: task.id,
        roots: [expect.objectContaining({ path: '/tmp/legacy-project-workspace' })],
      });
      expect(migrated.getWorkspace(task.id)).toBe('/tmp/legacy-project-workspace');
      expect(migrated.getTaskLeader(task.id).teamId).toBe(team.id);
      expect(migrated.listMessages(task.id)).toEqual(
        expect.arrayContaining([expect.objectContaining({ turnId: turn.turnId })]),
      );
      const explicitlyEmpty = migrated.replaceProjectFolders({
        projectId: project.id,
        expectedRevision: project.revision,
        folders: [],
      });
      expect(explicitlyEmpty).toMatchObject({ folderCount: 0, primaryFolder: null });
      expect(migrated.getEffectiveWorkspaceSet(task.id)).toMatchObject({
        source: 'none',
        roots: [],
      });
      expect(migrated.getWorkspace(task.id)).toBeNull();
      const inspection = new Database(path, { readonly: true });
      expect(
        inspection.prepare('SELECT checksum FROM schema_migrations WHERE version = 60').get(),
      ).toEqual({ checksum: 'project-multi-folder-v60-foundation' });
      expect(inspection.pragma('foreign_key_check')).toEqual([]);
      inspection.close();
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

    it('stores up to sixteen ordered folders with one Primary and resolves them for Project Tasks', () => {
      const { persistence } = createPersistence();
      const primaryId = randomUUID();
      const secondaryId = randomUUID();
      const project = persistence.createProject({
        name: 'Multi-root',
        folders: [
          folderBinding('/tmp/project-root-a', 'primary', 'a', primaryId),
          folderBinding('/tmp/project-root-b', 'secondary', 'b', secondaryId),
        ],
      });
      const task = persistence.createTask('Project Task', false, project.id);

      expect(() =>
        persistence.setWorkspaceBinding(task.id, {
          path: '/tmp/hidden-legacy-root',
          workspaceKey: 'c'.repeat(64),
          rootIdentityDigest: 'd'.repeat(64),
        }),
      ).toThrow('Project Tasks use the Project Workspace');
      expect(persistence.getWorkspace(task.id)).toBeNull();

      expect(project).toMatchObject({
        folderCount: 2,
        primaryFolder: { id: primaryId, path: '/tmp/project-root-a' },
      });
      expect(persistence.listProjectFolders(project.id)).toEqual([
        expect.objectContaining({ id: primaryId, role: 'primary', ordinal: 0 }),
        expect.objectContaining({ id: secondaryId, role: 'secondary', ordinal: 1 }),
      ]);
      expect(persistence.getEffectiveWorkspaceSet(task.id)).toMatchObject({
        source: 'project',
        projectId: project.id,
        primaryRootId: primaryId,
        roots: [
          expect.objectContaining({ rootId: primaryId, path: '/tmp/project-root-a' }),
          expect.objectContaining({ rootId: secondaryId, path: '/tmp/project-root-b' }),
        ],
      });
      expect(() => persistence.startTurn(task.id, 'must not use the legacy runtime')).toThrow(
        ProjectWorkspaceRuntimeUnavailableError,
      );
      expect(persistence.listMessages(task.id)).toEqual([]);
      persistence.close();
    });

    it('keeps name-only Project creation on the legacy Workspace flow', async () => {
      const { persistence } = createPersistence();
      const rootPath = mkdtempSync(join(tmpdir(), 'sprint-coder-legacy-project-root-'));
      directories.push(rootPath);
      const project = persistence.createProject('Legacy UI Project');
      const task = persistence.createTask('Legacy Workspace Task', false, project.id);
      const binding = await workspaceMutationBinding(rootPath);

      expect(() =>
        persistence.setWorkspaceBinding(task.id, {
          path: binding.canonicalPath,
          workspaceKey: binding.workspaceKey,
          rootIdentityDigest: binding.rootIdentityDigest,
        }),
      ).not.toThrow();
      expect(persistence.getWorkspace(task.id)).toBe(binding.canonicalPath);
      expect(persistence.getEffectiveWorkspaceSet(task.id)).toMatchObject({
        source: 'task',
        roots: [expect.objectContaining({ path: binding.canonicalPath })],
      });
      persistence.close();
    });

    it('replaces folders with revision CAS, preserves IDs by physical identity, and fixes Turn snapshots', () => {
      const { persistence } = createPersistence();
      const rootA = randomUUID();
      const rootB = randomUUID();
      const project = persistence.createProject('Mutable roots');
      const task = persistence.createTask('Snapshot', false, project.id);
      const turn = persistence.startTurn(task.id, 'snapshot roots');
      persistence.cancelTurn(task.id, turn.turnId);
      const configured = persistence.replaceProjectFolders({
        projectId: project.id,
        expectedRevision: project.revision,
        folders: [
          folderBinding('/tmp/root-a', 'primary', 'a', rootA),
          folderBinding('/tmp/root-b', 'secondary', 'b', rootB),
        ],
      });
      const sealed = persistence.sealTurnWorkspaceSet(task.id, turn.turnId);
      const [configuredRootA, configuredRootB] = persistence.listProjectFolders(project.id);

      const replaced = persistence.replaceProjectFolders({
        projectId: project.id,
        expectedRevision: configured.revision,
        folders: [
          folderBinding('/tmp/root-b-relocated', 'primary', 'b'),
          folderBinding('/tmp/root-a', 'secondary', 'a'),
        ],
      });

      expect(replaced).toMatchObject({
        revision: configured.revision + 1,
        primaryFolder: { id: configuredRootB!.id, path: '/tmp/root-b-relocated' },
      });
      expect(persistence.listProjectFolders(project.id).map(({ id }) => id)).toEqual([
        configuredRootB!.id,
        configuredRootA!.id,
      ]);
      expect(persistence.readTurnWorkspaceSet(turn.turnId)).toEqual(sealed);
      expect(() =>
        persistence.replaceProjectFolders({
          projectId: project.id,
          expectedRevision: project.revision,
          folders: [],
        }),
      ).toThrow(ProjectConflictError);
      persistence.close();
    });

    it('rejects duplicate, nested, and active-work Project folder mutations', () => {
      const { persistence } = createPersistence();
      expect(() =>
        persistence.createProject({
          name: 'Duplicate',
          folders: [
            folderBinding('/tmp/duplicate-a', 'primary', 'a'),
            folderBinding('/tmp/duplicate-b', 'secondary', 'a'),
          ],
        }),
      ).toThrow('distinct directories');
      expect(() =>
        persistence.createProject({
          name: 'Nested',
          folders: [
            folderBinding('/tmp/parent', 'primary', 'a'),
            folderBinding('/tmp/parent/child', 'secondary', 'b'),
          ],
        }),
      ).toThrow('Nested Project folders');

      const project = persistence.createProject({
        name: 'Busy',
        folders: [],
      });
      const task = persistence.createTask('Busy task', false, project.id);
      persistence.startTurn(task.id, 'working');
      expect(() =>
        persistence.replaceProjectFolders({
          projectId: project.id,
          expectedRevision: project.revision,
          folders: [folderBinding('/tmp/busy', 'primary', 'c')],
        }),
      ).toThrow(ProjectFolderMutationBlockedError);
      persistence.close();
    });

    it('binds new references to a Project root and refuses to remove a referenced root', async () => {
      const { persistence } = createPersistence();
      const rootPath = mkdtempSync(join(tmpdir(), 'sprint-coder-project-root-'));
      directories.push(rootPath);
      writeFileSync(join(rootPath, 'README.md'), '# Project root');
      const binding = await workspaceMutationBinding(rootPath);
      const project = persistence.createProject({
        name: 'Root reference',
        folders: [
          {
            path: binding.canonicalPath,
            canonicalPath: binding.canonicalPath,
            label: 'root',
            role: 'primary',
            workspaceKey: binding.workspaceKey,
            rootIdentityDigest: binding.rootIdentityDigest,
          },
        ],
      });
      const root = persistence.listProjectFolders(project.id)[0]!;
      expect(
        persistence.addProjectReference({
          projectId: project.id,
          projectRootId: root.id,
          relativePath: 'README.md',
          registeredRootIdentity: binding.rootIdentityDigest,
        }),
      ).toMatchObject({ sourceTaskId: null, projectRootId: root.id, status: 'healthy' });
      const otherRootPath = mkdtempSync(join(tmpdir(), 'sprint-coder-project-root-'));
      directories.push(otherRootPath);
      const otherBinding = await workspaceMutationBinding(otherRootPath);
      const reprioritized = persistence.replaceProjectFolders({
        projectId: project.id,
        expectedRevision: project.revision + 1,
        folders: [
          {
            path: otherBinding.canonicalPath,
            canonicalPath: otherBinding.canonicalPath,
            label: 'other',
            role: 'primary',
            workspaceKey: otherBinding.workspaceKey,
            rootIdentityDigest: otherBinding.rootIdentityDigest,
          },
          {
            id: root.id,
            path: binding.canonicalPath,
            canonicalPath: binding.canonicalPath,
            label: 'root',
            role: 'secondary',
            workspaceKey: binding.workspaceKey,
            rootIdentityDigest: binding.rootIdentityDigest,
          },
        ],
      });
      expect(persistence.listProjectReferences(project.id)[0]).toMatchObject({
        projectRootId: root.id,
        status: 'healthy',
      });
      expect(() =>
        persistence.replaceProjectFolders({
          projectId: project.id,
          expectedRevision: reprioritized.revision,
          folders: [],
        }),
      ).toThrow(ReferenceInUseError);
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
