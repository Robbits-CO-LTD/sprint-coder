import Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
import {
  DatabaseRecoveryError,
  SqlitePersistenceClient,
  __persistenceRecoveryTestables,
} from './persistence';

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

const recoveryCrashFixturePath = process.env.SPRINT_CODER_RECOVERY_CRASH_FIXTURE_PATH;
const recoveryCrashFixtureCheckpoint = process.env.SPRINT_CODER_RECOVERY_CRASH_CHECKPOINT as
  | 'after_main_retired_before_sidecar_cleanup'
  | 'after_corrupt_wal_bundled'
  | 'after_main_retired'
  | 'after_staging_validated'
  | 'before_publish'
  | undefined;

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprint-coder-recovery-'));
  tempDirs.push(dir);
  return join(dir, 'sprint-coder.db');
}

afterEach(() => {
  __persistenceRecoveryTestables.setCrashCheckpointForTesting(null);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

if (runsWithElectronAbi)
  describe('database corruption recovery (backup/restore)', () => {
    it('uses parent-directory fsync only on platforms that support it', () => {
      expect(__persistenceRecoveryTestables.supportsDirectorySync('win32')).toBe(false);
      expect(__persistenceRecoveryTestables.supportsDirectorySync('darwin')).toBe(true);
      expect(__persistenceRecoveryTestables.supportsDirectorySync('linux')).toBe(true);
    });

    it('__recovery_crash_fixture_child__', () => {
      if (recoveryCrashFixturePath === undefined || recoveryCrashFixtureCheckpoint === undefined)
        return;
      __persistenceRecoveryTestables.setCrashCheckpointForTesting((checkpoint) => {
        if (checkpoint === recoveryCrashFixtureCheckpoint) {
          writeFileSync(`${recoveryCrashFixturePath}.checkpoint`, checkpoint);
          process.kill(process.pid, 'SIGKILL');
        }
      });
      new SqlitePersistenceClient(recoveryCrashFixturePath);
      throw new Error(`Recovery did not stop at ${recoveryCrashFixtureCheckpoint}`);
    });

    const crashCheckpoints = [
      'after_main_retired_before_sidecar_cleanup',
      'after_corrupt_wal_bundled',
      'after_main_retired',
      'after_staging_validated',
      'before_publish',
    ] as const;

    for (const checkpoint of crashCheckpoints)
      it(`resumes recovery after a process exit at ${checkpoint}`, async () => {
        const path = tempDatabasePath();
        const seeded = new SqlitePersistenceClient(path);
        const task = seeded.createTask(`survives ${checkpoint}`);
        seeded.close();
        copyFileSync(path, `${path}.pre-migration.bak`);
        writeFileSync(path, 'not a sqlite database — simulated corruption');
        if (
          checkpoint === 'after_main_retired_before_sidecar_cleanup' ||
          checkpoint === 'after_corrupt_wal_bundled'
        ) {
          writeFileSync(`${path}-wal`, 'stale WAL from corrupt main');
          writeFileSync(`${path}-shm`, 'stale SHM from corrupt main');
        }

        let childFailure: unknown;
        try {
          await execFileAsync(
            electronTestExecutablePath(),
            [
              join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
              'run',
              'src/main/persistence-recovery.test.ts',
              '-t',
              '__recovery_crash_fixture_child__',
            ],
            {
              cwd: process.cwd(),
              encoding: 'utf8',
              env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                SPRINT_CODER_ELECTRON_DB_TEST: '1',
                SPRINT_CODER_RECOVERY_CRASH_FIXTURE_PATH: path,
                SPRINT_CODER_RECOVERY_CRASH_CHECKPOINT: checkpoint,
              },
              timeout: recoveryBridgeTimeoutMs,
            },
          );
        } catch (error) {
          childFailure = error;
        }
        expect(childFailure).toBeDefined();
        expect(readFileSync(`${path}.checkpoint`, 'utf8')).toBe(checkpoint);

        let checkedBeforePublish = false;
        if (checkpoint === 'after_main_retired_before_sidecar_cleanup') {
          expect(existsSync(`${path}-wal`)).toBe(true);
          expect(existsSync(`${path}-shm`)).toBe(true);
        }
        if (checkpoint === 'after_corrupt_wal_bundled') {
          expect(existsSync(`${path}-wal`)).toBe(false);
          expect(existsSync(`${path}-shm`)).toBe(true);
          const partialBundle = readdirSync(join(path, '..')).find((name) =>
            name.startsWith('sprint-coder.db.corrupt-'),
          );
          expect(partialBundle).toBeDefined();
          expect(existsSync(join(path, '..', partialBundle ?? '', 'wal'))).toBe(true);
          expect(existsSync(join(path, '..', partialBundle ?? '', 'manifest.json'))).toBe(false);
        }
        if (
          checkpoint === 'after_main_retired_before_sidecar_cleanup' ||
          checkpoint === 'after_corrupt_wal_bundled'
        ) {
          __persistenceRecoveryTestables.setCrashCheckpointForTesting((current) => {
            if (current !== 'before_publish') return;
            checkedBeforePublish = true;
            expect(existsSync(`${path}-wal`)).toBe(false);
            expect(existsSync(`${path}-shm`)).toBe(false);
          });
          expect(checkedBeforePublish).toBe(false);
        }

        const recovered = new SqlitePersistenceClient(path);
        expect(recovered.getTask(task.id).title).toBe(`survives ${checkpoint}`);
        expect(recovered.recoveryReport.restoredFromBackup).toBe(true);
        expect(recovered.recoveryReport.resumedRecovery).toBe(true);
        expect(recovered.recoveryReport.recoveryFailure).toBeNull();
        recovered.close();
        if (
          checkpoint === 'after_main_retired_before_sidecar_cleanup' ||
          checkpoint === 'after_corrupt_wal_bundled'
        )
          expect(checkedBeforePublish).toBe(true);

        expect(
          readdirSync(join(path, '..')).filter(
            (name) =>
              name.startsWith('sprint-coder.db.recovery-') ||
              name.startsWith('sprint-coder.db.recovery-stage-'),
          ),
        ).toEqual([]);
      });

    it('resumes from a valid backup when main is absent and no marker survived', () => {
      const path = tempDatabasePath();
      const seeded = new SqlitePersistenceClient(path);
      const task = seeded.createTask('backup-only restart');
      seeded.close();
      copyFileSync(path, `${path}.pre-migration.bak`);
      rmSync(path);

      const recovered = new SqlitePersistenceClient(path);
      expect(recovered.getTask(task.id).title).toBe('backup-only restart');
      expect(recovered.recoveryReport.resumedRecovery).toBe(true);
      expect(recovered.recoveryReport.restoredFromBackup).toBe(true);
      recovered.close();
    });

    it('fails closed when main is absent and the remaining backup is invalid', () => {
      const path = tempDatabasePath();
      writeFileSync(`${path}.pre-migration.bak`, 'not a sqlite database');

      let failure: unknown;
      try {
        new SqlitePersistenceClient(path);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DatabaseRecoveryError);
      expect((failure as DatabaseRecoveryError).recoveryReport).toMatchObject({
        corruptionDetected: true,
        resumedRecovery: true,
        recoveryFailure: 'Database recovery failed: no valid backup candidate',
      });
      expect(existsSync(path)).toBe(false);
    });

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

    it('preserves a corrupt database generation with WAL-only committed pages without replaying it', () => {
      const path = tempDatabasePath();
      const seeded = new SqlitePersistenceClient(path);
      const task = seeded.createTask('checkpointed backup value');
      seeded.close();
      copyFileSync(path, `${path}.pre-migration.bak`);

      const writer = new Database(path);
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer
        .prepare('UPDATE tasks SET title = ? WHERE id = ?')
        .run('committed only in WAL', task.id);
      const mainBytes = readFileSync(path);
      const walBytes = readFileSync(`${path}-wal`);
      const shmBytes = readFileSync(`${path}-shm`);
      expect(walBytes.byteLength).toBeGreaterThan(0);
      writer.close();

      // Recreate the exact live generation after close() checkpoints it, then damage only main's
      // header so the recovery probe takes the corrupt path while the real committed WAL survives.
      const corruptMainBytes = Buffer.from(mainBytes);
      corruptMainBytes.fill(0, 0, 32);
      writeFileSync(path, corruptMainBytes);
      writeFileSync(`${path}-wal`, walBytes);
      writeFileSync(`${path}-shm`, shmBytes);

      const recovered = new SqlitePersistenceClient(path);
      expect(recovered.getTask(task.id).title).toBe('checkpointed backup value');
      expect(recovered.recoveryReport.restoredFromBackup).toBe(true);
      expect(recovered.recoveryReport.possibleCommittedDataLoss).toBe(true);
      const bundlePath = recovered.recoveryReport.corruptBundlePath;
      expect(bundlePath).not.toBeNull();
      expect(recovered.getStartupRecovery()).toMatchObject({
        restoredFromBackup: true,
        corruptBundlePath: bundlePath,
        possibleCommittedDataLoss: true,
      });
      expect(readFileSync(join(bundlePath ?? '', 'wal'))).toEqual(walBytes);
      expect(readFileSync(join(bundlePath ?? '', 'shm')).byteLength).toBe(shmBytes.byteLength);
      const manifest = JSON.parse(
        readFileSync(join(bundlePath ?? '', 'manifest.json'), 'utf8'),
      ) as {
        possibleCommittedDataLoss: boolean;
        automaticReplay: boolean;
        sourceDatabaseBasename: string;
        files: Record<'main' | 'wal' | 'shm', { present: boolean; size: number | null }>;
      };
      expect(manifest).toMatchObject({
        possibleCommittedDataLoss: true,
        automaticReplay: false,
        sourceDatabaseBasename: 'sprint-coder.db',
        files: {
          main: { present: true, size: corruptMainBytes.byteLength },
          wal: { present: true, size: walBytes.byteLength },
          shm: { present: true, size: shmBytes.byteLength },
        },
      });
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
      expect(recovered.recoveryReport.corruptBundlePath).not.toBeNull();
      expect(recovered.recoveryReport.possibleCommittedDataLoss).toBe(false);
      expect(
        existsSync(join(recovered.recoveryReport.corruptBundlePath ?? '', 'manifest.json')),
      ).toBe(true);
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

    it('starts fresh when initial corruption recovery finds only invalid backups', () => {
      const path = tempDatabasePath();
      writeFileSync(path, 'corrupt main database');
      writeFileSync(`${path}-wal`, 'possibly committed WAL');
      writeFileSync(`${path}-shm`, 'matching SHM');
      writeFileSync(`${path}.pre-migration.bak`, 'corrupt backup database');

      const recovered = new SqlitePersistenceClient(path);
      expect(recovered.recoveryReport).toMatchObject({
        corruptionDetected: true,
        restoredFromBackup: false,
        freshStart: true,
        resumedRecovery: false,
        recoveryFailure: null,
      });
      expect(recovered.recoveryReport.corruptFileMovedTo).not.toBeNull();
      expect(existsSync(recovered.recoveryReport.corruptFileMovedTo ?? '')).toBe(true);
      expect(recovered.recoveryReport.possibleCommittedDataLoss).toBe(true);
      expect(
        readFileSync(join(recovered.recoveryReport.corruptBundlePath ?? '', 'wal'), 'utf8'),
      ).toBe('possibly committed WAL');
      expect(existsSync(join(recovered.recoveryReport.corruptBundlePath ?? '', 'shm'))).toBe(true);
      expect(existsSync(`${path}.pre-migration.bak`)).toBe(true);
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
        corruptBundlePath: null,
        possibleCommittedDataLoss: false,
        resumedRecovery: false,
        recoveryFailure: null,
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
      const otherDatabase = join(directory, `other.db.pre-migration.bak.tmp-${orphanId}`);
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
  const runElectronAbiTests = async (testNamePattern: string) => {
    if (runsWithElectronAbi) return ''; // already inside the bridge run
    const result = await execFileAsync(
      electronTestExecutablePath(),
      [
        join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/persistence-recovery.test.ts',
        '-t',
        testNamePattern,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
        timeout: recoveryBridgeTimeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return result.stdout ?? '';
  };

  // Vitest 3's worker RPC has a fixed 60s response deadline. A single bridge test containing all
  // recovery cases can exceed it on Windows CI even though the Electron child is still healthy.
  // Keep each bridge invocation below that control-plane limit while preserving the same coverage.
  it(
    'runs the first crash-recovery group with the Electron Node ABI',
    async () => {
      await runElectronAbiTests(
        'resumes recovery after a process exit at (after_main_retired_before_sidecar_cleanup|after_corrupt_wal_bundled)',
      );
    },
    recoveryBridgeTimeoutMs + 30_000,
  );

  it(
    'runs the remaining crash-recovery group with the Electron Node ABI',
    async () => {
      await runElectronAbiTests(
        'resumes recovery after a process exit at (after_main_retired|after_staging_validated|before_publish)$',
      );
    },
    recoveryBridgeTimeoutMs + 30_000,
  );

  it(
    'runs the non-crash corruption-recovery group with the Electron Node ABI',
    async () => {
      await runElectronAbiTests(
        'database corruption recovery \\(backup/restore\\) > (?!resumes recovery after a process exit)',
      );
    },
    recoveryBridgeTimeoutMs + 30_000,
  );

  it(
    'runs the projection-perf suite with the Electron Node ABI',
    async () => {
      const stdout = await runElectronAbiTests('10k-event projection restore');
      const perfLine = /\[perf\] 10k-event reopen\+projection: \d+ms/.exec(stdout);
      // Surface the measured projection time in the outer run's output for the gate record.
      if (perfLine) console.info(perfLine[0]);
    },
    recoveryBridgeTimeoutMs + 30_000,
  );
});
