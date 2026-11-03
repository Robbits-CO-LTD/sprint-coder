import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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

it.each([
  ['unknown reason', JSON.stringify({ ...quarantine, reason: 'future-reason' })],
  ['unknown shape', 'null'],
  ['malformed JSON', '{'],
  [
    'mismatched identity',
    JSON.stringify({ ...quarantine, identity: { ...row.identity, pid: 99 } }),
  ],
])(
  'rejects conflicting %s without losing ledger rows or partially restoring quarantines',
  async (_, payload) => {
    const f = fixture();
    const store = f.open();
    await store.write(row);
    const db = new Database(f.path);
    connections.push(db);
    db.prepare('INSERT INTO quarantines VALUES (?, ?, ?)').run(
      row.identity.pid,
      row.identity.creationTime,
      payload,
    );
    const other = { ...quarantine, identity: { ...row.identity, pid: 42 } };
    expect(await store.transferReceipt!([row], [other, quarantine])).toBe(false);
    expect(await store.restoreQuarantines([other, quarantine])).toBe(false);
    expect(store.read().rows).toEqual([row]);
    expect(db.prepare('SELECT payload FROM quarantines').all()).toEqual([{ payload }]);
    store.close();
    expect(f.open().read().rows).toEqual([row]);
  },
);

it('PR10 preserves unknown quarantine payloads for diagnostics and newer readers', () => {
  const f = fixture();
  const store = f.open();
  const db = new Database(f.path);
  connections.push(db);
  const values = [null, { ...quarantine, reason: 'future-reason' }];
  values.forEach((value, index) =>
    db
      .prepare('INSERT INTO quarantines VALUES (?, ?, ?)')
      .run(100 + index, 'synthetic', JSON.stringify(value)),
  );
  expect(store.read().quarantines).toEqual(values);
  expect(store.read().quarantines).toEqual(values);
  expect(db.prepare('SELECT count(*) AS count FROM quarantines').get()).toEqual({ count: 2 });
});

it('PR10 records the schema version and preserves unknown-version rows', () => {
  const f = fixture();
  const store = f.open();
  const db = new Database(f.path);
  connections.push(db);
  expect(db.pragma('user_version', { simple: true })).toBe(1);
  db.prepare('INSERT INTO ledger VALUES (?, ?, ?, ?, ?)').run(
    windowsLedgerInstanceId('C:/synthetic/default'),
    1,
    'future',
    'future',
    'null',
  );
  db.prepare('INSERT INTO quarantines VALUES (?, ?, ?)').run(100, 'synthetic', 'null');
  db.pragma('user_version = 99');
  expect(() => store.read()).toThrow('Unsupported Windows ledger version');
  expect(() => store.delete(row)).toThrow('Unsupported Windows ledger version');
  store.close();
  expect(() => f.open()).toThrow('Unsupported Windows ledger version');
  expect(db.pragma('user_version', { simple: true })).toBe(99);
  expect(db.prepare('SELECT count(*) AS count FROM ledger').get()).toEqual({ count: 1 });
  expect(db.prepare('SELECT count(*) AS count FROM quarantines').get()).toEqual({ count: 1 });
});

it('PR10 resolves profile junctions before hashing the instance identity', () => {
  const folder = mkdtempSync(join(tmpdir(), 'windows-ledger-'));
  folders.push(folder);
  const real = join(folder, 'real');
  const alias = join(folder, 'alias');
  mkdirSync(real);
  symlinkSync(real, alias, 'junction');
  expect(windowsLedgerInstanceId(alias)).toBe(windowsLedgerInstanceId(real));
});

it('PR10 upgrades an unversioned store without losing existing rows or quarantines', () => {
  const f = fixture();
  const store = f.open();
  store.write(row);
  store.restoreQuarantines([quarantine]);
  store.close();
  const db = new Database(f.path);
  connections.push(db);
  db.pragma('user_version = 0');
  const reopened = f.open();
  expect(db.pragma('user_version', { simple: true })).toBe(1);
  expect(reopened.read()).toEqual({ rows: [row], quarantines: [quarantine] });
});

it('PR10 discards only its own invalid ledger rows and preserves quarantine payloads', () => {
  const f = fixture();
  const store = f.open();
  store.write(row);
  const db = new Database(f.path);
  connections.push(db);
  const insert = db.prepare('INSERT INTO ledger VALUES (?, ?, ?, ?, ?)');
  insert.run(windowsLedgerInstanceId('C:/synthetic/default'), 1, 'invalid', 'invalid', 'null');
  insert.run(windowsLedgerInstanceId('C:/synthetic/other'), 1, 'invalid', 'invalid', 'null');
  expect(store.read().rows).toEqual([row, null]);
  expect(store.read().rows).toEqual([row]);
  expect(db.prepare('SELECT count(*) AS count FROM ledger').get()).toEqual({ count: 2 });
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

it.each([false, true])(
  'serializes simultaneous Worker writes and differing transfer reasons (transfer: %s)',
  async (transfer) => {
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
      // Host retries failed storage operations; only lock contention is retryable here.
      const retryBusy = (operation) => {
        for (let attempt = 0; ; attempt++) {
          try { return operation(); }
          catch (error) {
            if (error.code !== 'SQLITE_BUSY' || attempt >= 9) throw error;
          }
        }
      };
      const rows = Array.from({ length: 20 }, (_, i) => ({ ...workerData.row, requestId: String(i) }));
      for (const row of rows) retryBusy(() => store.write(row));
      if (workerData.transfer) {
        const quarantine = { ...workerData.quarantine, reason: workerData.instance === 'a' ? 'exit_suspect' : 'response_lost' };
        retryBusy(() => store.transferReceipt(rows, [quarantine]));
        parentPort.postMessage(store.read().quarantines);
      } else retryBusy(() => store.restoreQuarantines([workerData.quarantine]));
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
              transfer,
              modulePath: fileURLToPath(
                new URL('./computer-use-windows-ledger-store.ts', import.meta.url),
              ),
            },
          },
        ),
    );
    const observed: unknown[] = [];
    for (const worker of workers)
      worker.on('message', (value: unknown) => {
        if (Array.isArray(value)) observed.push(value);
      });
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
      expect(a.read().rows).toHaveLength(transfer ? 0 : 20);
      expect(b.read().rows).toHaveLength(transfer ? 0 : 20);
      if (transfer) {
        const persisted = a.read().quarantines;
        expect(persisted).toEqual([
          {
            identity: row.identity,
            reason: expect.stringMatching(/^(exit_suspect|response_lost)$/),
          },
        ]);
        expect(observed).toEqual([persisted, persisted]);
        await a.restoreQuarantines([quarantine]);
        await b.restoreQuarantines([{ ...quarantine, reason: 'response_lost' }]);
        expect(b.read().quarantines).toEqual(persisted);
      } else expect(a.read().quarantines).toEqual([quarantine]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  },
);
