import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';
import { electronTestExecutablePath } from './electron-test-runtime';

const cleanup: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// A v97 database still used this v70 table-level UNIQUE. Restore that historical boundary while
// retaining all other real schema migrations, so the test exercises an upgrade rather than a mock.
function historicalDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'sprint-coder-user-save-migration-'));
  cleanup.push(directory);
  const path = join(directory, 'state.sqlite3');
  const persistence = new SqlitePersistenceClient(path);
  const task = persistence.createTask('migration witness');
  const seed = {
    principal: 'renderer:1',
    taskId: task.id,
    kind: 'save',
    operationId: 'completed',
    requestHash: hash('request'),
    rootId: 'root',
    rootLabel: 'workspace',
    path: 'note.txt',
    baseDigest: hash('before'),
    replacementDigest: hash('after'),
    byteLength: 5,
  };
  persistence.finalizeUserFileSaveIntent(persistence.prepareUserFileSaveIntent(seed), {
    outcome: 'saved',
    digest: seed.replacementDigest,
    reason: null,
    conflictPath: null,
  });
  persistence.prepareUserFileSaveIntent({
    ...seed,
    operationId: 'pending',
    requestHash: hash('pending'),
  });
  persistence.close();
  const db = new Database(path);
  const schema = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'user_file_save_intents'")
    .get() as { sql: string };
  const oldSchema = schema.sql
    .replace('"user_file_save_intents"', 'user_file_save_intents_old')
    .replace(
      /\)\s*$/,
      ', UNIQUE(principal, task_id, kind, request_hash, root_id, path, base_digest, replacement_digest))',
    );
  db.transaction(() => {
    db.exec('DROP TABLE user_file_save_operation_aliases');
    db.exec(oldSchema);
    db.exec('INSERT INTO user_file_save_intents_old SELECT * FROM user_file_save_intents');
    db.exec('DROP TABLE user_file_save_intents');
    db.exec('ALTER TABLE user_file_save_intents_old RENAME TO user_file_save_intents');
    db.exec(
      'CREATE INDEX user_file_save_intents_recovery_idx ON user_file_save_intents(state, created_at, operation_id)',
    );
    db.exec('DELETE FROM schema_migrations WHERE version = 98');
  })();
  const rows = db.prepare('SELECT * FROM user_file_save_intents ORDER BY operation_id').all();
  db.close();
  return { path, seed, task, rows };
}

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1') {
  describe('user save migration 98', () => {
    it('preserves v70 rows, results and constraints while allowing new completed facts', () => {
      const fixture = historicalDatabase();
      const persistence = new SqlitePersistenceClient(fixture.path);
      const db = new Database(fixture.path);
      db.pragma('foreign_keys = ON');
      try {
        expect(
          db.prepare('SELECT * FROM user_file_save_intents ORDER BY operation_id').all(),
        ).toEqual(fixture.rows);
        expect(
          persistence.getOperationResult(
            'renderer:1',
            fixture.task.id,
            'save',
            'completed',
            fixture.seed.requestHash,
          ),
        ).toMatchObject({ found: true, value: { outcome: 'saved' } });
        expect(
          persistence.prepareUserFileSaveIntent({ ...fixture.seed, operationId: 'fresh' })
            .operationId,
        ).toBe('fresh');
        expect(() =>
          db
            .prepare(
              "UPDATE user_file_save_intents SET base_digest = 'bad' WHERE operation_id = 'fresh'",
            )
            .run(),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              "UPDATE user_file_save_intents SET state = 'invalid' WHERE operation_id = 'fresh'",
            )
            .run(),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              "UPDATE user_file_save_intents SET byte_length = -1 WHERE operation_id = 'fresh'",
            )
            .run(),
        ).toThrow();
        const joined = persistence.prepareUserFileSaveIntent({
          ...fixture.seed,
          operationId: 'alias',
          requestHash: hash('pending'),
        });
        expect(joined.operationId).toBe('pending');
        expect(() =>
          persistence.prepareUserFileSaveIntent({
            ...fixture.seed,
            operationId: 'alias',
            requestHash: hash('changed'),
          }),
        ).toThrow();
        expect(() =>
          db
            .prepare(
              "INSERT INTO user_file_save_intents SELECT principal, task_id, kind, 'duplicate-active', request_hash, root_id, root_label, path, base_digest, replacement_digest, byte_length, state, created_at, updated_at FROM user_file_save_intents WHERE operation_id = 'pending'",
            )
            .run(),
        ).toThrow();
        expect(() =>
          persistence.prepareUserFileSaveIntent({
            ...fixture.seed,
            operationId: 'fresh',
            path: 'different.txt',
          }),
        ).toThrow();
        db.prepare(
          "UPDATE user_file_save_operation_aliases SET request_hash = ? WHERE operation_id = 'alias'",
        ).run(hash('corrupt alias'));
        expect(() =>
          persistence.prepareUserFileSaveIntent({
            ...fixture.seed,
            operationId: 'alias',
            requestHash: hash('pending'),
          }),
        ).toThrow();
        expect(() =>
          persistence.getOperationResult(
            'renderer:1',
            fixture.task.id,
            'save',
            'alias',
            hash('pending'),
          ),
        ).toThrow();
        expect(db.pragma('foreign_key_check')).toEqual([]);
        db.prepare('DELETE FROM tasks WHERE id = ?').run(fixture.task.id);
        expect(db.prepare('SELECT * FROM user_file_save_intents').all()).toEqual([]);
        expect(db.prepare('SELECT * FROM user_file_save_operation_aliases').all()).toEqual([]);
      } finally {
        db.close();
        persistence.close();
      }
    });

    it('rolls the entire rebuild back if recording migration 98 fails', () => {
      const fixture = historicalDatabase();
      const db = new Database(fixture.path);
      db.exec(
        "CREATE TRIGGER reject_save_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 98 BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END",
      );
      db.close();
      expect(() => new SqlitePersistenceClient(fixture.path)).toThrow('injected migration failure');
      const inspection = new Database(fixture.path);
      try {
        expect(
          inspection.prepare('SELECT * FROM user_file_save_intents ORDER BY operation_id').all(),
        ).toEqual(fixture.rows);
        expect(
          inspection.prepare('SELECT version FROM schema_migrations WHERE version = 98').get(),
        ).toBeUndefined();
        expect(
          inspection
            .prepare(
              "SELECT name FROM sqlite_master WHERE name IN ('user_file_save_operation_aliases', 'user_file_save_intents_v98')",
            )
            .all(),
        ).toEqual([]);
        expect(() =>
          inspection
            .prepare(
              "INSERT INTO user_file_save_intents SELECT principal, task_id, kind, 'duplicate', request_hash, root_id, root_label, path, base_digest, replacement_digest, byte_length, state, created_at, updated_at FROM user_file_save_intents WHERE operation_id = 'completed'",
            )
            .run(),
        ).toThrow();
      } finally {
        inspection.close();
      }
    });
  });
} else {
  it('runs user save migration witnesses under the Electron SQLite ABI', () => {
    const result = spawnSync(
      electronTestExecutablePath(),
      [
        join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/user-file-save-migration.test.ts',
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
}
