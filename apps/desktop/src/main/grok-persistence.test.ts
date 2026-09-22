import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient } from './persistence';
import { modelSelectionForRuntime } from './connection-identity';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'grok-persistence-'));
  directories.push(directory);
  return join(directory, 'test.db');
}

function legacyFixture(): { path: string; taskId: string; turnId: string } {
  const path = databasePath();
  const persistence = new SqlitePersistenceClient(path);
  persistence.setRuntime('codex');
  const task = persistence.createTask('legacy task');
  const turn = persistence.startTurn(task.id, 'fixture request');
  persistence.recordRuntimeFailureDiagnostic(task.id, turn.turnId, {
    version: 1,
    diagnosticId: randomUUID(),
    runtimeKind: 'codex',
    failureStage: 'protocol_error',
    elapsedMs: 12,
    appVersion: 'test',
    cliVersion: null,
    teamMcp: { enabled: false, status: 'not_configured' },
    lastRecognizedNotification: null,
    lastReceivedNotification: null,
    unsupportedNotificationCount: 0,
    stderrObserved: false,
    stderrTruncated: false,
    recordedAt: '2026-09-22T00:00:00.000Z',
  });
  persistence.close();
  const db = new Database(path);
  db.pragma('foreign_keys = OFF');
  db.prepare('UPDATE agent_threads SET active_turn_id = ?, revision = 7 WHERE task_id = ?').run(
    turn.turnId,
    task.id,
  );
  // Reconstruct the v93 CHECKs without dropping child tables or changing migration history.
  for (const table of ['turns', 'agent_threads', 'runtime_failure_diagnostics']) {
    const { sql } = db
      .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', table) as { sql: string };
    const indexes = db
      .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND tbl_name = ? AND sql IS NOT NULL')
      .all('index', table) as { sql: string }[];
    db.exec(
      sql
        .replace(/^CREATE TABLE "?\w+"?/u, `CREATE TABLE ${table}_legacy`)
        .replaceAll(", 'grok'", ''),
    );
    db.exec(
      `INSERT INTO ${table}_legacy SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_legacy RENAME TO ${table};`,
    );
    for (const index of indexes) db.exec(index.sql);
  }
  db.exec(`DELETE FROM schema_migrations WHERE version = 94;
    DELETE FROM provider_connections WHERE id = 'builtin:grok-cli';
    UPDATE turns SET resolved_provider = 'openai', resolved_model = 'fixture-resolved',
      provider_usage_json = '{"fixture":1}', resolution_json = '{"fixture":2}', auto_skill_candidates_pinned = 1;`);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(() => db.prepare("UPDATE turns SET runtime_kind = 'grok'").run()).toThrow(/CHECK/u);
  expect(() => db.prepare("UPDATE agent_threads SET runtime_kind = 'grok'").run()).toThrow(
    /CHECK/u,
  );
  expect(() =>
    db.prepare("UPDATE runtime_failure_diagnostics SET runtime_kind = 'grok'").run(),
  ).toThrow(/CHECK/u);
  db.close();
  return { path, taskId: task.id, turnId: turn.turnId };
}

function snapshot(db: Database.Database) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return {
    rows: Object.fromEntries(
      tables
        .filter(({ name }) => name !== 'provider_connections' && name !== 'schema_migrations')
        .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
    ),
    foreignKeys: Object.fromEntries(
      tables.map(({ name }) => [name, db.pragma(`foreign_key_list("${name}")`)]),
    ),
    columns: Object.fromEntries(
      tables.map(({ name }) => [name, db.pragma(`table_xinfo("${name}")`)]),
    ),
    indexes: db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all(),
    checksums: db
      .prepare('SELECT * FROM schema_migrations WHERE version <= 93 ORDER BY version')
      .all(),
  };
}

if (process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1') {
  describe('Grok persistence v94', () => {
    it('preserves all legacy rows, FKs, indexes and checksums, seeds Grok and reopens idempotently', () => {
      const { path } = legacyFixture();
      const legacy = new Database(path);
      const before = snapshot(legacy);
      const connections = legacy.prepare('SELECT * FROM provider_connections ORDER BY id').all();
      legacy.close();
      const migrated = new SqlitePersistenceClient(path);
      expect(migrated.getProviderConnection('builtin:grok-cli')).toMatchObject({
        providerId: 'xai',
        runtimeKind: 'builtin_cli',
        displayName: 'Grok CLI',
        enabled: true,
        verification: { status: 'not_required' },
        rateLimit: {
          mode: 'bypass',
          maxConcurrentRequests: null,
          requestsPerMinute: null,
          tokensPerMinute: null,
        },
      });
      migrated.close();
      const db = new Database(path);
      const builtinPolicies = db
        .prepare(
          `SELECT verification_status, rate_limit_mode,
        max_concurrent_requests, requests_per_minute, tokens_per_minute
        FROM provider_connections WHERE runtime_kind = 'builtin_cli' ORDER BY id`,
        )
        .all();
      expect(builtinPolicies).toHaveLength(3);
      expect(builtinPolicies).toEqual(
        Array.from({ length: 3 }, () => ({
          verification_status: 'not_required',
          rate_limit_mode: 'bypass',
          max_concurrent_requests: null,
          requests_per_minute: null,
          tokens_per_minute: null,
        })),
      );
      expect(snapshot(db)).toEqual(before);
      expect(
        db
          .prepare("SELECT * FROM provider_connections WHERE id != 'builtin:grok-cli' ORDER BY id")
          .all(),
      ).toEqual(connections);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      db.pragma('foreign_keys = ON');
      db.exec(
        "UPDATE turns SET runtime_kind = 'grok'; UPDATE agent_threads SET runtime_kind = 'grok'; UPDATE runtime_failure_diagnostics SET runtime_kind = 'grok';",
      );
      expect(() =>
        db.exec("UPDATE runtime_failure_diagnostics SET failure_stage = 'network'"),
      ).toThrow(/CHECK/u);
      expect(() => db.exec("UPDATE turns SET task_id = 'missing'")).toThrow(/FOREIGN KEY/u);
      const seed = db
        .prepare("SELECT * FROM provider_connections WHERE id = 'builtin:grok-cli'")
        .get();
      db.close();
      new SqlitePersistenceClient(path).close();
      const reopened = new Database(path);
      expect(
        reopened.prepare("SELECT * FROM provider_connections WHERE id = 'builtin:grok-cli'").get(),
      ).toEqual(seed);
      expect(
        reopened
          .prepare('SELECT count(*) AS count FROM schema_migrations WHERE version = 94')
          .get(),
      ).toEqual({ count: 1 });
      reopened.close();
    });

    it('rolls back the entire migration and seed if an incoming FK is invalid', () => {
      const { path, turnId } = legacyFixture();
      const legacy = new Database(path);
      legacy.pragma('foreign_keys = OFF');
      legacy
        .prepare("UPDATE agent_threads SET active_turn_id = 'missing' WHERE active_turn_id = ?")
        .run(turnId);
      expect(legacy.pragma('foreign_key_check')).not.toEqual([]);
      const before = snapshot(legacy);
      legacy.close();
      expect(() => new SqlitePersistenceClient(path)).toThrow(/CHECK/u);
      const failed = new Database(path);
      expect(snapshot(failed)).toEqual(before);
      expect(
        failed.prepare('SELECT version FROM schema_migrations WHERE version = 94').get(),
      ).toBeUndefined();
      expect(
        failed.prepare("SELECT id FROM provider_connections WHERE id = 'builtin:grok-cli'").get(),
      ).toBeUndefined();
      failed.close();
    });

    it('persists Grok model preferences, turn/thread identity and runtime diagnostics independently', () => {
      const path = databasePath();
      const persistence = new SqlitePersistenceClient(path);
      persistence.setRuntime('codex');
      persistence.setModel('codex-fixture');
      persistence.setRuntime('claude');
      persistence.setModel('claude-fixture');
      persistence.setRuntime('grok');
      persistence.setModel('grok-fixture');
      const skillRuntimes: string[] = [];
      persistence.setAutoSkillProvider((kind) => {
        skillRuntimes.push(kind);
        return [];
      });
      const task = persistence.createTask('Grok task');
      const turn = persistence.startTurn(task.id, 'fixture request');
      expect(skillRuntimes).toEqual(['grok']);
      expect(persistence.getTurnModelIdentity(task.id, turn.turnId).selection).toEqual(
        modelSelectionForRuntime('grok', 'grok-fixture'),
      );
      persistence.recordRuntimeFailureDiagnostic(task.id, turn.turnId, {
        version: 1,
        diagnosticId: randomUUID(),
        runtimeKind: 'grok',
        failureStage: 'spawn_error',
        elapsedMs: 0,
        appVersion: 'test',
        cliVersion: null,
        teamMcp: { enabled: false, status: 'not_configured' },
        lastRecognizedNotification: null,
        lastReceivedNotification: null,
        unsupportedNotificationCount: 0,
        stderrObserved: false,
        stderrTruncated: false,
        recordedAt: '2026-09-22T00:00:00.000Z',
      });
      persistence.close();
      const reopened = new SqlitePersistenceClient(path);
      expect(reopened.getStoredRuntime()).toBe('grok');
      expect(reopened.getModel()).toBe('grok-fixture');
      expect(reopened.getRuntimeFailureDiagnostic({ taskId: task.id })).toMatchObject({
        runtimeKind: 'grok',
        failureStage: 'spawn_error',
      });
      reopened.setRuntime('codex');
      expect(reopened.getModel()).toBe('codex-fixture');
      reopened.setRuntime('claude');
      expect(reopened.getModel()).toBe('claude-fixture');
      reopened.close();
      const db = new Database(path);
      expect(
        db.prepare("SELECT value FROM settings WHERE key = 'runtime.grok.model'").get(),
      ).toEqual({ value: 'grok-fixture' });
      expect(
        db
          .prepare(
            'SELECT runtime_kind, connection_id, requested_provider, requested_model FROM agent_threads WHERE task_id = ?',
          )
          .get(task.id),
      ).toEqual({
        runtime_kind: 'grok',
        connection_id: 'builtin:grok-cli',
        requested_provider: 'xai',
        requested_model: 'grok-fixture',
      });
      db.close();
    });

    it('reconciles the Grok catalog without changing other runtime models', () => {
      const path = databasePath();
      const persistence = new SqlitePersistenceClient(path);
      persistence.setRuntime('codex');
      persistence.setModel('codex-fixture');
      persistence.setRuntime('grok');
      persistence.setModel('retired-grok');
      const task = persistence.createTask('Grok catalog');
      persistence.setTaskModelSelection(task.id, modelSelectionForRuntime('grok', 'retired-grok'));
      persistence.reconcileBuiltinModelCatalog('grok', ['auto', 'grok-fixture']);
      expect(persistence.getModel()).toBe('auto');
      expect(persistence.getTaskModelSelection(task.id)).toEqual(
        modelSelectionForRuntime('grok', 'auto'),
      );
      persistence.setRuntime('codex');
      expect(persistence.getModel()).toBe('codex-fixture');
      persistence.close();
    });
  });
} else {
  it('runs Grok SQLite migration integration tests with the bundled Electron ABI', async () => {
    await promisify(execFile)(
      electronTestExecutablePath(),
      [
        join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/grok-persistence.test.ts',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  }, 65_000);
}
