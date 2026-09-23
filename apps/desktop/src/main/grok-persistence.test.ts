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
import { buildProviderFailureDiagnostic } from './provider-failure-diagnostic';

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
  db.exec(`DELETE FROM schema_migrations WHERE version IN (94, 95);
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

type DiagnosticRow = {
  id: string;
  task_id: string;
  turn_id: string;
  runtime_kind: string;
  failure_stage: string;
  diagnostic_json: string;
  created_at: string;
};

function diagnosticRows(db: Database.Database): DiagnosticRow[] {
  return db
    .prepare(
      `SELECT id, task_id, turn_id, runtime_kind, failure_stage, diagnostic_json, created_at
       FROM runtime_failure_diagnostics ORDER BY runtime_kind, id`,
    )
    .all() as DiagnosticRow[];
}

function cliDiagnostic(
  runtimeKind: 'codex' | 'claude' | 'grok',
  failureStage: 'protocol_error' | 'startup_error' | 'spawn_error' | 'billing_error' | 'rate_limit',
  httpStatus?: number,
) {
  return {
    version: 1 as const,
    diagnosticId: randomUUID(),
    runtimeKind,
    failureStage,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    elapsedMs: 12,
    appVersion: 'test',
    cliVersion: null,
    teamMcp: { enabled: false as const, status: 'not_configured' as const },
    lastRecognizedNotification: null,
    lastReceivedNotification: null,
    unsupportedNotificationCount: 0,
    stderrObserved: false,
    stderrTruncated: false,
    recordedAt: '2026-09-22T00:00:00.000Z',
  };
}

function seedTurn(persistence: SqlitePersistenceClient, title: string) {
  const task = persistence.createTask(title);
  const turn = persistence.startTurn(task.id, 'fixture request');
  return { taskId: task.id, turnId: turn.turnId };
}

function restoreV94DiagnosticCheck(db: Database.Database): void {
  db.exec(`
    ALTER TABLE runtime_failure_diagnostics RENAME TO runtime_failure_diagnostics_v95_current;
    DROP INDEX runtime_failure_diagnostics_task_created_idx;
    CREATE TABLE runtime_failure_diagnostics (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
      runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('codex', 'claude', 'grok', 'provider')),
      failure_stage TEXT NOT NULL CHECK (
        (runtime_kind IN ('codex', 'claude', 'grok') AND failure_stage IN (
          'first_event_timeout', 'idle_timeout', 'total_timeout', 'protocol_error',
          'startup_error', 'spawn_error', 'abnormal_exit'
        )) OR
        (runtime_kind = 'provider' AND failure_stage IN (
          'model_preparation', 'first_event_timeout', 'idle_timeout', 'provider_error',
          'network', 'stream_error'
        ))
      ),
      diagnostic_json TEXT NOT NULL CHECK (length(CAST(diagnostic_json AS BLOB)) <= 16384),
      created_at TEXT NOT NULL
    );
    INSERT INTO runtime_failure_diagnostics(
      id, task_id, turn_id, runtime_kind, failure_stage, diagnostic_json, created_at
    )
    SELECT id, task_id, turn_id, runtime_kind, failure_stage, diagnostic_json, created_at
    FROM runtime_failure_diagnostics_v95_current;
    DROP TABLE runtime_failure_diagnostics_v95_current;
    CREATE INDEX runtime_failure_diagnostics_task_created_idx
      ON runtime_failure_diagnostics(task_id, created_at DESC, id DESC);
    DELETE FROM schema_migrations WHERE version = 95;
  `);
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
      expect(
        reopened
          .prepare('SELECT count(*) AS count FROM schema_migrations WHERE version = 95')
          .get(),
      ).toEqual({ count: 1 });
      expect(
        (
          reopened
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_failure_diagnostics'",
            )
            .get() as { sql: string }
        ).sql,
      ).toContain("'billing_error'");
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
        failed.prepare('SELECT version FROM schema_migrations WHERE version = 95').get(),
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

  describe('Grok persistence v95', () => {
    it('promotes a v94 diagnostic table to v95 and keeps codex, claude, grok, and provider rows', () => {
      const path = databasePath();
      const persistence = new SqlitePersistenceClient(path);
      persistence.setRuntime('grok');
      for (const [runtimeKind, failureStage] of [
        ['codex', 'protocol_error'],
        ['claude', 'startup_error'],
        ['grok', 'spawn_error'],
      ] as const) {
        const turn = seedTurn(persistence, `${runtimeKind} diagnostic`);
        persistence.recordRuntimeFailureDiagnostic(
          turn.taskId,
          turn.turnId,
          cliDiagnostic(runtimeKind, failureStage),
        );
      }
      const providerTurn = seedTurn(persistence, 'provider diagnostic');
      persistence.recordRuntimeFailureDiagnostic(
        providerTurn.taskId,
        providerTurn.turnId,
        buildProviderFailureDiagnostic({
          cause: {
            failureStage: 'provider_error',
            category: 'provider_unavailable',
            retryable: true,
            providerCode: 'http_503',
            modelPreparation: 'completed',
          },
          providerId: 'ollama',
          profileId: 'ollama',
          elapsedMs: 45,
          appVersion: 'test',
          recordedAt: '2026-09-22T00:00:00.000Z',
        }),
      );
      persistence.close();

      const legacy = new Database(path);
      const before = diagnosticRows(legacy);
      expect(before.map((row) => row.runtime_kind).sort()).toEqual([
        'claude',
        'codex',
        'grok',
        'provider',
      ]);
      restoreV94DiagnosticCheck(legacy);
      expect(() =>
        legacy
          .prepare(
            "UPDATE runtime_failure_diagnostics SET failure_stage = 'billing_error' WHERE runtime_kind = 'grok'",
          )
          .run(),
      ).toThrow(/CHECK/u);
      expect(diagnosticRows(legacy)).toEqual(before);
      expect(
        legacy.prepare('SELECT version FROM schema_migrations WHERE version = 95').get(),
      ).toBeUndefined();
      legacy.close();

      const migrated = new SqlitePersistenceClient(path);
      migrated.close();
      const upgraded = new Database(path);
      expect(diagnosticRows(upgraded)).toEqual(before);
      expect(
        upgraded.prepare('SELECT checksum FROM schema_migrations WHERE version = 94').get(),
      ).toEqual({ checksum: 'runtime-v94-grok-cli' });
      expect(
        upgraded.prepare('SELECT checksum FROM schema_migrations WHERE version = 95').get(),
      ).toEqual({ checksum: 'runtime-failure-diagnostics-v95-grok-billing' });
      const tableSql = (
        upgraded
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runtime_failure_diagnostics'",
          )
          .get() as { sql: string }
      ).sql;
      expect(tableSql).toContain("runtime_kind = 'grok'");
      expect(tableSql).toContain("'billing_error'");
      expect(tableSql).toContain("'rate_limit'");
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runtime_failure_diagnostics_task_created_idx'",
          )
          .get(),
      ).toEqual({ name: 'runtime_failure_diagnostics_task_created_idx' });
      expect(upgraded.pragma('foreign_key_check')).toEqual([]);
      expect(upgraded.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      upgraded.close();
    });

    it('stores Grok billing_error with httpStatus 402 and keeps the v95 constraints idempotent', () => {
      const path = databasePath();
      const persistence = new SqlitePersistenceClient(path);
      persistence.setRuntime('grok');
      const billingTurn = seedTurn(persistence, 'grok billing');
      const billing = cliDiagnostic('grok', 'billing_error', 402);
      const stored = persistence.recordRuntimeFailureDiagnostic(
        billingTurn.taskId,
        billingTurn.turnId,
        billing,
      );
      expect(stored).toMatchObject({
        diagnosticId: billing.diagnosticId,
        runtimeKind: 'grok',
        failureStage: 'billing_error',
        httpStatus: 402,
        taskId: billingTurn.taskId,
        turnId: billingTurn.turnId,
      });
      expect(
        persistence.recordRuntimeFailureDiagnostic(
          billingTurn.taskId,
          billingTurn.turnId,
          cliDiagnostic('grok', 'rate_limit', 429),
        ),
      ).toEqual(stored);
      const limitTurn = seedTurn(persistence, 'grok rate limit');
      expect(
        persistence.recordRuntimeFailureDiagnostic(
          limitTurn.taskId,
          limitTurn.turnId,
          cliDiagnostic('grok', 'rate_limit', 429),
        ),
      ).toMatchObject({ failureStage: 'rate_limit', httpStatus: 429 });
      const codexTurn = seedTurn(persistence, 'codex rejected stage');
      expect(() =>
        persistence.recordRuntimeFailureDiagnostic(
          codexTurn.taskId,
          codexTurn.turnId,
          cliDiagnostic('codex', 'billing_error'),
        ),
      ).toThrow('Invalid Runtime diagnostic');
      persistence.close();

      const raw = new Database(path);
      const saved = raw
        .prepare(
          'SELECT failure_stage, diagnostic_json FROM runtime_failure_diagnostics WHERE id = ?',
        )
        .get(billing.diagnosticId) as { failure_stage: string; diagnostic_json: string };
      expect(saved.failure_stage).toBe('billing_error');
      expect(JSON.parse(saved.diagnostic_json)).toMatchObject({
        failureStage: 'billing_error',
        httpStatus: 402,
      });
      expect(
        raw
          .prepare('SELECT count(*) AS count FROM runtime_failure_diagnostics WHERE turn_id = ?')
          .get(billingTurn.turnId),
      ).toEqual({ count: 1 });
      const rejectStage = (stage: 'billing_error' | 'rate_limit') =>
        raw
          .prepare(
            `INSERT INTO runtime_failure_diagnostics(
               id, task_id, turn_id, runtime_kind, failure_stage, diagnostic_json, created_at
             ) VALUES (?, ?, ?, 'codex', ?, '{}', ?)`,
          )
          .run(randomUUID(), codexTurn.taskId, codexTurn.turnId, stage, '2026-09-23T00:00:00.000Z');
      expect(() => rejectStage('billing_error')).toThrow(/CHECK/u);
      expect(() => rejectStage('rate_limit')).toThrow(/CHECK/u);
      expect(() =>
        raw
          .prepare('UPDATE runtime_failure_diagnostics SET diagnostic_json = ? WHERE id = ?')
          .run('x'.repeat(16 * 1024 + 1), billing.diagnosticId),
      ).toThrow(/CHECK/u);
      expect(
        (
          raw
            .prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runtime_failure_diagnostics_task_created_idx'",
            )
            .get() as { sql: string }
        ).sql.replace(/\s+/g, ' '),
      ).toBe(
        'CREATE INDEX runtime_failure_diagnostics_task_created_idx ON runtime_failure_diagnostics(task_id, created_at DESC, id DESC)',
      );
      const migration = raw
        .prepare('SELECT version, checksum, applied_at FROM schema_migrations WHERE version = 95')
        .get();
      raw.close();

      const reopened = new SqlitePersistenceClient(path);
      const loaded = reopened.getRuntimeFailureDiagnostic({ diagnosticId: billing.diagnosticId });
      expect(loaded).toMatchObject({
        runtimeKind: 'grok',
        failureStage: 'billing_error',
        httpStatus: 402,
        taskId: billingTurn.taskId,
        turnId: billingTurn.turnId,
      });
      expect(JSON.parse(JSON.stringify(loaded, null, 2))).toMatchObject({
        failureStage: 'billing_error',
        httpStatus: 402,
      });
      reopened.close();

      const after = new Database(path);
      expect(
        after
          .prepare('SELECT version, checksum, applied_at FROM schema_migrations WHERE version = 95')
          .get(),
      ).toEqual(migration);
      expect(
        after.prepare('SELECT count(*) AS count FROM schema_migrations WHERE version = 95').get(),
      ).toEqual({ count: 1 });
      after.pragma('foreign_keys = ON');
      after.prepare('DELETE FROM tasks WHERE id = ?').run(billingTurn.taskId);
      expect(
        after
          .prepare('SELECT count(*) AS count FROM runtime_failure_diagnostics WHERE task_id = ?')
          .get(billingTurn.taskId),
      ).toEqual({ count: 0 });
      expect(
        after
          .prepare('SELECT count(*) AS count FROM runtime_failure_diagnostics WHERE task_id = ?')
          .get(limitTurn.taskId),
      ).toEqual({ count: 1 });
      expect(after.pragma('foreign_key_check')).toEqual([]);
      after.close();
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
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  }, 125_000);
}
