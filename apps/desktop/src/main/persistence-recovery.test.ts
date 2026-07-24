import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePersistenceClient } from './persistence';

// Phase 7 blocking subset: "DB migration、backup/restore、1万event projection復元".
// Migration coverage lives in persistence.test.ts (legacy v1→latest chain); this file proves the
// corruption→restore path and the 10k-event projection budget (NFR-PERF-04).

// Same dual-run pattern as persistence.test.ts: DB-touching suites need the Electron Node ABI
// (better-sqlite3 is rebuilt for Electron), so under plain vitest they are skipped and a bridge
// test re-runs this file inside Electron with ELECTRON_RUN_AS_NODE.
const runsWithElectronAbi = process.env.SPRINT_CODER_ELECTRON_DB_TEST === '1';

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
});

if (runsWithElectronAbi)
  describe('10k-event projection restore (NFR-PERF-04)', () => {
  it('reopens and projects a 10,000-delta task within budget', () => {
    const path = tempDatabasePath();
    const seeded = new SqlitePersistenceClient(path);
    const task = seeded.createTask('projection perf fixture');
    const started = seeded.startTurn(task.id, '大量イベントの復元計測');
    for (const stage of ['understanding', 'planning', 'executing', 'synthesizing'] as const)
      seeded.changeStage(task.id, started.turnId, stage);
    const messageId = randomUUID();
    for (let index = 0; index < 10_000; index += 1) {
      seeded.appendDelta(task.id, started.turnId, messageId, `chunk-${index} `);
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
  });
});

describe('recovery suite Electron ABI bridge', () => {
  it('runs the corruption-recovery and projection-perf suites with the Electron Node ABI', () => {
    if (runsWithElectronAbi) return; // already inside the bridge run
    const result = spawnSync(
      join(process.cwd(), '../../node_modules/.bin/electron'),
      [
        join(process.cwd(), '../../node_modules/vitest/vitest.mjs'),
        'run',
        'src/main/persistence-recovery.test.ts',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SPRINT_CODER_ELECTRON_DB_TEST: '1' },
        timeout: 90_000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const perfLine = /\[perf\] 10k-event reopen\+projection: \d+ms/.exec(result.stdout ?? '');
    // Surface the measured projection time in the outer run's output for the gate record.
    if (perfLine) console.info(perfLine[0]);
  }, 120_000);
});
