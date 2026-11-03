import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openWindowsLedgerStore,
  windowsLedgerInstanceId,
  windowsLedgerStorePath,
} from './computer-use-windows-ledger-store';
import type { WindowsDispatchLedgerStorage } from './computer-use-native-host';
import type {
  WindowsLedgerRow,
  WindowsTargetQuarantine,
} from './computer-use-windows-stop-outcome';

const row: WindowsLedgerRow = {
  helperGeneration: 1,
  sessionId: 'synthetic-session',
  requestId: 'synthetic-request',
  identity: { pid: 41, creationTime: 'synthetic-time' },
  kind: 'semantic',
  inputPath: 'normal',
  state: 'awaiting_response',
};
const quarantine: WindowsTargetQuarantine = { identity: row.identity, reason: 'exit_suspect' };
type Store = Omit<WindowsDispatchLedgerStorage, 'read'> & {
  read(): { rows: readonly unknown[]; quarantines: readonly unknown[] };
  close(): void;
};
type Fixture = {
  open(instance?: string): Store;
  failDelete(enabled: boolean): void;
};

// Every implementation runs the same observable contract; SQL fault injection stays in the factory.
function ledgerStorageContract(name: string, fixture: () => Fixture) {
  describe(name, () => {
    it('round trips rows and quarantines across Main restart, keeping composite keys', async () => {
      const f = fixture();
      let store = f.open();
      const other = { ...row, sessionId: 'synthetic-other' };
      await store.write(row);
      await store.write(other);
      await store.update({ ...row, state: 'effect_unconfirmed' });
      await store.restoreQuarantines([quarantine]);
      store.close();
      store = f.open();
      expect(store.read()).toEqual({
        rows: [{ ...row, state: 'effect_unconfirmed' }, other],
        quarantines: [quarantine],
      });
      await store.delete(row);
      expect(store.read().rows).toEqual([other]);
      expect(store.read().quarantines).toEqual([quarantine]);
    });

    it('rolls back both halves of a failed transfer and retries idempotently', async () => {
      const f = fixture();
      const store = f.open();
      await store.write(row);
      f.failDelete(true);
      await expect(
        Promise.resolve().then(() => store.transferReceipt!([row], [quarantine])),
      ).rejects.toThrow();
      expect(store.read()).toEqual({ rows: [row], quarantines: [] });
      f.failDelete(false);
      expect(await store.transferReceipt!([row], [quarantine])).toBe(true);
      expect(await store.transferReceipt!([row], [quarantine])).toBe(true);
      store.close();
      expect(f.open().read()).toEqual({ rows: [], quarantines: [quarantine] });
    });

    it.each([false, true])(
      'keeps first committed reason across connections (receipt first: %s)',
      async (receiptFirst) => {
        const f = fixture();
        const a = f.open('a');
        const b = f.open('b');
        await Promise.all([a.write(row), b.write(row)]);
        const receipt = { ...quarantine, reason: 'response_lost' as const };
        const transfers = receiptFirst
          ? [
              () => b.transferReceipt!([row], [receipt]),
              () => a.transferReceipt!([row], [quarantine]),
            ]
          : [
              () => a.transferReceipt!([row], [quarantine]),
              () => b.transferReceipt!([row], [receipt]),
            ];
        await Promise.all(transfers.map((transfer) => Promise.resolve().then(transfer)));
        const first = receiptFirst ? receipt : quarantine;
        await a.restoreQuarantines([quarantine]);
        await b.restoreQuarantines([receipt]);
        await a.transferReceipt!([], []);
        expect(a.read()).toEqual({ rows: [], quarantines: [first] });
        expect(b.read()).toEqual(a.read());
      },
    );

    it('shares quarantines but reads and deletes only its own instance rows', async () => {
      const f = fixture();
      const a = f.open('a');
      const b = f.open('b');
      await a.write(row);
      expect(b.read().rows).toEqual([]);
      await b.write(row);
      await a.transferReceipt!([row], [quarantine]);
      expect(a.read().rows).toEqual([]);
      expect(b.read()).toEqual({ rows: [row], quarantines: [quarantine] });
    });

    it('reports read and write errors rather than success', async () => {
      const store = fixture().open();
      store.close();
      expect(() => store.read()).toThrow();
      await expect(Promise.resolve().then(() => store.write(row))).rejects.toThrow();
    });
    it('releases only the exact terminated identity across connections and survives restart', async () => {
      const f = fixture();
      const a = f.open('a');
      const b = f.open('b');
      const reused = {
        ...quarantine,
        identity: { ...row.identity, creationTime: 'synthetic-new' },
      };
      await a.restoreQuarantines([quarantine, reused]);
      await a.write(row);
      expect(await b.releaseQuarantine!(row.identity)).toBe(true);
      expect(await b.releaseQuarantine!(row.identity)).toBe(true);
      expect(a.read()).toEqual({ rows: [row], quarantines: [reused] });
      a.close();
      expect(f.open('a').read()).toEqual({ rows: [row], quarantines: [reused] });
    });
  });
}

const folders: string[] = [];
const connections: Database.Database[] = [];
const stores: Store[] = [];
function fixture(): Fixture & { path: string } {
  const folder = mkdtempSync(join(tmpdir(), 'windows-ledger-'));
  folders.push(folder);
  const path = join(folder, 'kill-stop.sqlite');
  return {
    path,
    open(instance = 'default') {
      const store = openWindowsLedgerStore({ path, userData: `C:\\synthetic\\${instance}` });
      stores.push(store);
      return store;
    },
    failDelete(enabled) {
      const db = new Database(path);
      connections.push(db);
      db.exec(
        enabled
          ? "CREATE TRIGGER fail_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END"
          : 'DROP TRIGGER fail_delete',
      );
    },
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of connections.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
ledgerStorageContract('SQLite Windows ledger contract', fixture);

it('PR9 release persists only the approved identity across connections and restart', async () => {
  const f = fixture();
  const a = f.open('a');
  const b = f.open('b');
  const other = {
    ...quarantine,
    identity: { ...row.identity, creationTime: 'synthetic-new-time' },
  };
  await a.restoreQuarantines([quarantine, other]);
  await a.write(row);
  expect(await a.releaseQuarantine!(quarantine.identity)).toBe(true);
  expect(b.read()).toEqual({ rows: [], quarantines: [other] });
  expect(a.read().rows).toEqual([row]);
  a.close();
  expect(f.open('a').read().quarantines).toEqual([other]);
  expect(await b.releaseQuarantine!(quarantine.identity)).toBe(true);
});

it('retains quarantine when its release fails and retries after the store recovers', async () => {
  const f = fixture();
  const store = f.open();
  await store.restoreQuarantines([quarantine]);
  const db = new Database(f.path);
  connections.push(db);
  db.exec(
    "CREATE TRIGGER fail_release BEFORE DELETE ON quarantines BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  await expect(
    Promise.resolve().then(() => store.releaseQuarantine!(row.identity)),
  ).rejects.toThrow();
  expect(store.read().quarantines).toEqual([quarantine]);
  db.exec('DROP TRIGGER fail_release');
  expect(await store.releaseQuarantine!(row.identity)).toBe(true);
  expect(store.read().quarantines).toEqual([]);
});

it('uses a fixed LocalAppData path and a normalized stable per-profile identity', () => {
  expect(windowsLedgerStorePath('C:\\synthetic-local')).toBe(
    'C:\\synthetic-local\\Sprint Coder\\computer-use\\kill-stop.sqlite',
  );
  expect(windowsLedgerInstanceId('C:\\Synthetic\\profile\\')).toBe(
    windowsLedgerInstanceId('c:/synthetic/other/../profile'),
  );
  expect(windowsLedgerInstanceId('C:\\synthetic\\a')).not.toBe(
    windowsLedgerInstanceId('C:\\synthetic\\b'),
  );
  expect(() => windowsLedgerStorePath('')).toThrow();
});

it('uses WAL and bounds lock contention below the Host two-second deadline', async () => {
  const f = fixture();
  const store = f.open();
  const db = new Database(f.path);
  connections.push(db);
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  db.exec('BEGIN IMMEDIATE');
  const started = performance.now();
  try {
    await expect(Promise.resolve().then(() => store.write(row))).rejects.toThrow(/locked/);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    db.exec('ROLLBACK');
  }
  expect(await store.write(row)).toBe(true);
});

it('serializes simultaneous writes from independent connections without losing either instance', async () => {
  const f = fixture();
  const a = f.open('a');
  const b = f.open('b');
  const gate = new SharedArrayBuffer(4);
  const workers = ['a', 'b'].map(
    (instance) =>
      new Worker(
        `
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const ts = require('typescript');
    require.extensions['.ts'] = (module, filename) => module._compile(
      ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
      }).outputText, filename);
    const { openWindowsLedgerStore } = require(workerData.modulePath);
    const store = openWindowsLedgerStore({ path: workerData.path, userData: 'C:/synthetic/' + workerData.instance });
    parentPort.postMessage('ready');
    Atomics.wait(new Int32Array(workerData.gate), 0, 0);
    try {
      for (let i = 0; i < 20; i++) store.write({ ...workerData.row, requestId: String(i) });
      store.restoreQuarantines([workerData.quarantine]);
    } finally { store.close(); }
  `,
        {
          eval: true,
          workerData: {
            path: f.path,
            instance,
            gate,
            row,
            quarantine,
            modulePath: fileURLToPath(
              new URL('./computer-use-windows-ledger-store.ts', import.meta.url),
            ),
          },
        },
      ),
  );
  const exits = workers.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
        );
      }),
  );
  // Install handlers before awaiting either worker so failures never become unhandled rejections.
  const completed = Promise.all(exits);
  void completed.catch(() => undefined);
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once('message', () => resolve());
            worker.once('error', reject);
          }),
      ),
    );
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    await completed;
    expect(a.read().rows).toHaveLength(20);
    expect(b.read().rows).toHaveLength(20);
    expect(a.read().quarantines).toEqual([quarantine]);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});
