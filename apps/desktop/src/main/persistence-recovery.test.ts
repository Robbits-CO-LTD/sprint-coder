import Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { electronTestExecutablePath } from './electron-test-runtime';
import { SqlitePersistenceClient } from './persistence';

// Phase 7 blocking subset: "DB migration、backup/restore、1万event projection復元".
// Migration coverage lives in persistence.test.ts (legacy v1→latest chain); this file proves the
// corruption→restore path and the 10k-event projection budget (NFR-PERF-04).

// Same dual-run pattern as persistence.test.ts: DB-touching suites need the Electron Node ABI
// (better-sqlite3 is rebuilt for Electron), so under plain vitest they are skipped and a bridge
// test re-runs this file inside Electron with ELECTRON_RUN_AS_NODE.
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';
// Windows CI spends most of this time creating the 10k-row fixture. The measured reopen/projection
// budget below remains 1.5s; this timeout only keeps fixture setup from masking that assertion.
const projectionFixtureTimeoutMs = process.platform === 'win32' ? 120_000 : 60_000;
const recoveryBridgeTimeoutMs = process.platform === 'win32' ? 150_000 : 90_000;
const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-coder-recovery-'));
  tempDirs.push(dir);
  return join(dir, 'sprint-coder.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

if (runsWithElectronAbi)
  describe('database corruption recovery (backup/restore)', () => {
    it('includes committed WAL-only pages in a pre-migration backup on every OS', () => {
      const path = tempDatabasePath();
      const seeded = new SqlitePersistenceClient(path);
      const task = seeded.createTask('before WAL update');
      seeded.close();

      const writer = new Database(path);
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec(`
        DROP TABLE runtime_failure_diagnostics;
        DELETE FROM schema_migrations WHERE version = 69;
      `);
      writer.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('committed in WAL', task.id);
      expect(existsSync(`${path}-wal`)).toBe(true);

      const migrated = new SqlitePersistenceClient(path);
      migrated.close();
      writer.close();
      expect(existsSync(`${path}.pre-migration.bak`)).toBe(true);
      expect(
        readdirSync(join(path, '..')).filter((name) =>
          name.startsWith('sprint-coder.db.pre-migration.bak.tmp-'),
        ),
      ).toEqual([]);

      writeFileSync(path, 'not a sqlite database — simulated post-migration corruption');
      const recovered = new SqlitePersistenceClient(path);
      expect(recovered.recoveryReport.restoredFromBackup).toBe(true);
      expect(recovered.getTask(task.id).title).toBe('committed in WAL');
      recovered.close();
    });

    it('restores from the pre-migration backup when the database file is corrupt', () => {
      const path = tempDatabasePath();
      const seeded = new SqlitePersistenceClient(path);
      const task = seeded.createTask('復元対象タスク');
      seeded.close();
      copyFileSync(path, `${path}.pre-migration.bak`);
      writeFileSync(path, 'not a sqlite database — simulated corruption');

      const recovered = new SqlitePersistenceClient(path);
      expect(recovered.recoveryReport.corruptionDetected).toBe(true);
      expect(recovered.recoveryReport.restoredFromBackup).toBe(true);
      expect(recovered.recoveryReport.freshStart).toBe(false);
      expect(recovered.recoveryReport.corruptFileMovedTo).not.toBeNull();
      expect(existsSync(recovered.recoveryReport.corruptFileMovedTo ?? '')).toBe(true);
      expect(recovered.listTasks().some((row) => row.id === task.id)).toBe(true);
      recovered.close();
    });

    it('starts fresh when the database is corrupt and no usable backup exists', () => {
      const path = tempDatabasePath();
      writeFileSync(path, 'garbage bytes without any backup');

      const recovered = new SqlitePersistenceClient(path);
      expect(recovered.recoveryReport.corruptionDetected).toBe(true);
      expect(recovered.recoveryReport.restoredFromBackup).toBe(false);
      expect(recovered.recoveryReport.freshStart).toBe(true);
      const task = recovered.createTask('fresh start after corruption');
      expect(recovered.listTasks().some((row) => row.id === task.id)).toBe(true);
      recovered.close();
    });

    it('reports a clean open for a healthy database', () => {
      const path = tempDatabasePath();
      const client = new SqlitePersistenceClient(path);
      expect(client.recoveryReport).toEqual({
        corruptionDetected: false,
        restoredFromBackup: false,
        freshStart: false,
        corruptFileMovedTo: null,
      });
      client.close();
    });

    it('recovers only regular orphan validation files owned by this database path', () => {
      const path = tempDatabasePath();
      const directory = join(path, '..');
      const orphanId = 'bb30b928-2838-4af9-ba36-42fe2cda9d0d';
      const orphan = `${path}.pre-migration.bak.tmp-${orphanId}`;
      const orphanWal = `${orphan}-wal`;
      const orphanShm = `${orphan}-shm`;
      const similar = `${path}.pre-migration.bak.tmp-not-a-uuid`;
      const otherDatabase = join(
        directory,
        `other.db.pre-migration.bak.tmp-${orphanId}`,
      );
      const symlink = `${path}.pre-migration.bak.tmp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      const symlinkTarget = join(directory, 'must-survive');
      for (const file of [orphan, orphanWal, orphanShm, similar, otherDatabase, symlinkTarget])
        writeFileSync(file, file);
      symlinkSync(symlinkTarget, symlink);

      const client = new SqlitePersistenceClient(path);
      client.close();

      for (const file of [orphan, orphanWal, orphanShm]) expect(existsSync(file)).toBe(false);
      for (const file of [similar, otherDatabase, symlink, symlinkTarget])
        expect(existsSync(file)).toBe(true);
    });

    it('removes the validation database and sidecars when backup rotation fails', () => {
      const path = tempDatabasePath();
      const seeded = new SqlitePersistenceClient(path);
      seeded.close();
      const pending = new Database(path);
      pending.exec(`
        DROP TABLE runtime_failure_diagnostics;
        DELETE FROM schema_migrations WHERE version = 69;
      `);
      pending.close();
      // A directory cannot be removed by the file-only rotation operation, forcing the failure
      // after the validation snapshot has been opened and checked.
      mkdirSync(`${path}.pre-migration.bak.previous`);

      expect(() => new SqlitePersistenceClient(path)).toThrow();
      expect(
        readdirSync(join(path, '..')).filter((name) =>
          name.startsWith('sprint-coder.db.pre-migration.bak.tmp-'),
        ),
      ).toEqual([]);
    });
  });

if (runsWithElectronAbi)
  describe('10k-event projection restore (NFR-PERF-04)', () => {
    it(
      'reopens and projects a 10,000-delta task within budget',
      async () => {
        const path = tempDatabasePath();
        const seeded = new SqlitePersistenceClient(path);
        const task = seeded.createTask('projection perf fixture');
        const started = seeded.startTurn(task.id, '大量イベントの復元計測');
        for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
          seeded.changeStage(task.id, started.turnId, stage);
        const messageId = randomUUID();
        for (let index = 0; index < 10_000; index += 1) {
          seeded.appendDelta(task.id, started.turnId, messageId, `chunk-${index} `);
          // Windows can spend over a minute building this fixture. Yield periodically so Vitest's
          // worker can service its control-plane RPC while keeping setup outside the measurement.
          if (index % 250 === 249) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        seeded.close();

        const openStart = performance.now();
        const reopened = new SqlitePersistenceClient(path);
        const messages = reopened.listMessages(task.id);
        const elapsedMs = performance.now() - openStart;
        reopened.close();

        expect(messages.some((message) => message.content.includes('chunk-9999'))).toBe(true);
        // NFR-PERF-04 targets 500ms first render; the DB open + projection share of that budget is
        // asserted with headroom for slow CI machines. The measured value is printed for the gate
        // record.
        console.info(`[perf] 10k-event reopen+projection: ${Math.round(elapsedMs)}ms`);
        expect(elapsedMs).toBeLessThan(1500);
      },
      projectionFixtureTimeoutMs,
    );
  });

describe('recovery suite Electron ABI bridge', () => {
  it(
    'runs the corruption-recovery and projection-perf suites with the Electron Node ABI',
    async () => {
      if (runsWithElectronAbi) return; // already inside the bridge run
      const result = await execFileAsync(
        electronTestExecutablePath(),
        [
          join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
          'run',
          'src/main/persistence-recovery.test.ts',
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
          timeout: recoveryBridgeTimeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      const perfLine = /\[perf\] 10k-event reopen\+projection: \d+ms/.exec(result.stdout ?? '');
      // Surface the measured projection time in the outer run's output for the gate record.
      if (perfLine) console.info(perfLine[0]);
    },
    recoveryBridgeTimeoutMs + 30_000,
  );
});
