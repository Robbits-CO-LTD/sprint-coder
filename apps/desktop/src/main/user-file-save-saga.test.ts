import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';
import { electronTestExecutablePath } from './electron-test-runtime';
import { executeUserFileSave, reconcileUserFileSaves } from './user-file-save-saga';

const cleanup: string[] = [];
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

if (runsWithElectronAbi) {
  describe('user file save Saga', () => {
    it('publishes a new save after an external revert without replaying completed facts', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-revert-'));
      cleanup.push(directory);
      const workspacePath = join(directory, 'workspace');
      mkdirSync(workspacePath);
      const filePath = join(workspacePath, 'note.txt');
      writeFileSync(filePath, 'before');
      const persistence = new SqlitePersistenceClient(join(directory, 'state.sqlite3'));
      const task = persistence.createTask('independent save');
      persistence.setWorkspace(task.id, workspacePath);
      const request = {
        principal: 'renderer:1',
        taskId: task.id,
        kind: 'sprint-coder:files:save',
        operationId: 'first',
        requestHash: digest('same request'),
        root: { rootId: 'legacy-primary', label: 'workspace', path: workspacePath },
        path: 'note.txt',
        text: 'after',
        baseDigest: digest('before'),
      };
      try {
        expect((await executeUserFileSave(persistence, request)).outcome).toBe('saved');
        writeFileSync(filePath, 'before');
        expect(
          (await executeUserFileSave(persistence, { ...request, operationId: 'second' })).outcome,
        ).toBe('saved');
        expect(readFileSync(filePath, 'utf8')).toBe('after');
        expect(
          persistence.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
        ).toHaveLength(2);
        expect(
          persistence.getOperationResult(
            'renderer:1',
            task.id,
            request.kind,
            'second',
            request.requestHash,
          ).found,
        ).toBe(true);
      } finally {
        persistence.close();
      }
    });

    it('persists a joined operation identity across restart and external revert', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-alias-'));
      cleanup.push(directory);
      const workspacePath = join(directory, 'workspace');
      mkdirSync(workspacePath);
      const filePath = join(workspacePath, 'note.txt');
      const databasePath = join(directory, 'state.sqlite3');
      writeFileSync(filePath, 'before');
      let persistence = new SqlitePersistenceClient(databasePath);
      const task = persistence.createTask('joined save');
      persistence.setWorkspace(task.id, workspacePath);
      const request = {
        principal: 'renderer:1',
        taskId: task.id,
        kind: 'sprint-coder:files:save',
        operationId: 'canonical',
        requestHash: digest('same request'),
        root: { rootId: 'legacy-primary', label: 'workspace', path: workspacePath },
        path: 'note.txt',
        text: 'after',
        baseDigest: digest('before'),
      };
      try {
        await expect(
          executeUserFileSave(persistence, request, {
            afterPublish: () => Promise.reject(new Error('database outage')),
          }),
        ).rejects.toThrow('database outage');
        const joined = { ...request, operationId: 'joined' };
        expect((await executeUserFileSave(persistence, joined)).outcome).toBe('saved');
        persistence.close();
        persistence = new SqlitePersistenceClient(databasePath);
        writeFileSync(filePath, 'before');
        expect((await executeUserFileSave(persistence, joined)).outcome).toBe('saved');
        expect(readFileSync(filePath, 'utf8')).toBe('before');
        await expect(
          executeUserFileSave(persistence, { ...joined, requestHash: digest('different request') }),
        ).rejects.toThrow();
        expect(
          persistence.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
        ).toHaveLength(1);
      } finally {
        persistence.close();
      }
    });

    it.each(['refused', 'conflict'])(
      'allows a new operation after a completed %s result',
      async (outcome) => {
        const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-terminal-'));
        cleanup.push(directory);
        const workspacePath = join(directory, 'workspace');
        mkdirSync(workspacePath);
        const filePath = join(workspacePath, 'note.txt');
        if (outcome === 'conflict') writeFileSync(filePath, 'external');
        const persistence = new SqlitePersistenceClient(join(directory, 'state.sqlite3'));
        const task = persistence.createTask('terminal save');
        persistence.setWorkspace(task.id, workspacePath);
        const request = {
          principal: 'renderer:1',
          taskId: task.id,
          kind: 'save',
          operationId: 'failed',
          requestHash: digest('request'),
          root: { rootId: 'legacy-primary', label: 'workspace', path: workspacePath },
          path: 'note.txt',
          text: 'after',
          baseDigest: digest('before'),
        };
        try {
          expect((await executeUserFileSave(persistence, request)).outcome).toBe(outcome);
          writeFileSync(filePath, 'before');
          expect(
            (await executeUserFileSave(persistence, { ...request, operationId: 'fresh' })).outcome,
          ).toBe('saved');
          expect(readFileSync(filePath, 'utf8')).toBe('after');
          expect((await executeUserFileSave(persistence, request)).outcome).toBe(outcome);
          expect(
            persistence.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
          ).toHaveLength(1);
        } finally {
          persistence.close();
        }
      },
    );

    it('joins parallel saves with one publication and one audit event', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-parallel-'));
      cleanup.push(directory);
      const workspacePath = join(directory, 'workspace');
      mkdirSync(workspacePath);
      writeFileSync(join(workspacePath, 'note.txt'), 'before');
      const persistence = new SqlitePersistenceClient(join(directory, 'state.sqlite3'));
      const task = persistence.createTask('parallel save');
      persistence.setWorkspace(task.id, workspacePath);
      const request = {
        principal: 'renderer:1',
        taskId: task.id,
        kind: 'save',
        operationId: 'canonical',
        requestHash: digest('request'),
        root: { rootId: 'legacy-primary', label: 'workspace', path: workspacePath },
        path: 'note.txt',
        text: 'after',
        baseDigest: digest('before'),
      };
      let release = () => {};
      const checkpoint = new Promise<void>((resolve) => {
        release = resolve;
      });
      let publications = 0;
      try {
        const first = executeUserFileSave(persistence, request, {
          afterPublish: () => {
            publications++;
            return checkpoint;
          },
        });
        const second = await executeUserFileSave(
          persistence,
          { ...request, operationId: 'joined' },
          {
            afterPublish: () => {
              publications++;
            },
          },
        );
        release();
        expect((await first).outcome).toBe('saved');
        expect(second.outcome).toBe('saved');
        expect(publications).toBe(1);
        expect(
          persistence.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
        ).toHaveLength(1);
      } finally {
        release();
        persistence.close();
      }
    });

    it('treats the replacement digest as the same successful save on retry', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-retry-'));
      cleanup.push(directory);
      const workspacePath = join(directory, 'workspace');
      mkdirSync(workspacePath);
      writeFileSync(join(workspacePath, 'note.txt'), 'before\n');
      const persistence = new SqlitePersistenceClient(join(directory, 'state.sqlite3'));
      const task = persistence.createTask('save retry');
      persistence.setWorkspace(task.id, workspacePath);
      const request = {
        principal: 'renderer:1',
        taskId: task.id,
        kind: 'sprint-coder:files:save',
        operationId: 'save-1',
        requestHash: digest('request-1'),
        root: { rootId: 'legacy-primary', label: 'workspace', path: workspacePath },
        path: 'note.txt',
        text: 'after\n',
        baseDigest: digest('before\n'),
      };
      await expect(
        executeUserFileSave(persistence, request, {
          afterPublish: () => Promise.reject(new Error('simulated SQLite outage')),
        }),
      ).rejects.toThrow('simulated SQLite outage');

      await expect(
        executeUserFileSave(persistence, { ...request, operationId: 'save-retry-2' }),
      ).resolves.toMatchObject({
        outcome: 'saved',
        digest: digest('after\n'),
      });
      expect(
        persistence.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
      ).toHaveLength(1);
      expect(
        persistence.getOperationResult(
          'renderer:1',
          task.id,
          'sprint-coder:files:save',
          'save-retry-2',
          digest('request-1'),
        ).found,
      ).toBe(true);
      persistence.close();
    });

    it('finalizes a published save exactly once after SQLite restart', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-saga-'));
      cleanup.push(directory);
      const workspacePath = join(directory, 'workspace');
      const databasePath = join(directory, 'state.sqlite3');
      const filePath = join(workspacePath, 'note.txt');
      mkdirSync(workspacePath);
      writeFileSync(filePath, 'before\n');

      const persistence = new SqlitePersistenceClient(databasePath);
      const task = persistence.createTask('save recovery');
      persistence.setWorkspace(task.id, workspacePath);
      const root = {
        rootId: 'legacy-primary',
        label: 'workspace',
        path: workspacePath,
      };
      await expect(
        executeUserFileSave(
          persistence,
          {
            principal: 'renderer:1',
            taskId: task.id,
            kind: 'sprint-coder:files:save',
            operationId: 'save-1',
            requestHash: digest('request-1'),
            root,
            path: 'note.txt',
            text: 'after\n',
            baseDigest: digest('before\n'),
          },
          { afterPublish: () => Promise.reject(new Error('simulated SQLite outage')) },
        ),
      ).rejects.toThrow('simulated SQLite outage');
      expect(readFileSync(filePath, 'utf8')).toBe('after\n');
      expect(
        persistence.getOperationResult(
          'renderer:1',
          task.id,
          'sprint-coder:files:save',
          'save-1',
          digest('request-1'),
        ).found,
      ).toBe(false);
      persistence.close();

      const reopened = new SqlitePersistenceClient(databasePath);
      await reconcileUserFileSaves(reopened, (taskId, rootId) => {
        const workspace = reopened.getEffectiveWorkspaceSet(taskId);
        const resolvedId = rootId === 'legacy-primary' ? workspace.primaryRootId : rootId;
        return workspace.roots.find((candidate) => candidate.rootId === resolvedId) ?? null;
      });
      const completed = reopened.getOperationResult<{
        outcome: string;
        digest: string | null;
      }>('renderer:1', task.id, 'sprint-coder:files:save', 'save-1', digest('request-1'));
      expect(completed).toMatchObject({
        found: true,
        value: { outcome: 'saved', digest: digest('after\n') },
      });
      expect(
        reopened.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
      ).toHaveLength(1);

      await reconcileUserFileSaves(reopened, () => root);
      expect(
        reopened.listEventsAfter(task.id, 0).filter((event) => event.type === 'file.saved'),
      ).toHaveLength(1);
      reopened.close();
    });
  });
} else {
  describe('user file save Saga Electron ABI bridge', () => {
    it('runs the real SQLite recovery witness under Electron', () => {
      const result = spawnSync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/user-file-save-saga.test.ts',
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
}
