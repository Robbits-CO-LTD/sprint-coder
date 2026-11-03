import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import Database from 'better-sqlite3';
import type { WindowsDispatchLedgerStorage } from './computer-use-native-host';
import {
  storedRowProblem,
  storedQuarantineProblem,
  type WindowsLedgerRow,
  type WindowsTargetQuarantine,
} from './computer-use-windows-stop-outcome';

export function windowsLedgerInstanceId(userData: string): string {
  if (!win32.isAbsolute(userData)) throw new Error('Absolute userData path required');
  const normalized = win32
    .normalize(userData)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

export function windowsLedgerStorePath(localAppData = process.env['LOCALAPPDATA'] ?? ''): string {
  if (!win32.isAbsolute(localAppData)) throw new Error('LocalAppData unavailable');
  return win32.join(localAppData, 'Sprint Coder', 'computer-use', 'kill-stop.sqlite');
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** The caller owns lifetime. This is deliberately not opened from the product index.ts yet. */
export function openWindowsLedgerStore(options: { userData: string; path?: string }) {
  const instanceId = windowsLedgerInstanceId(options.userData);
  const path = options.path ?? windowsLedgerStorePath();
  mkdirSync(dirname(path), { recursive: true });
  // Synchronous transactions serialize writes and their completions on each connection.
  // SQLite serializes other connections at commit; 250ms leaves room in Host's 2s deadline.
  const db = new Database(path, { timeout: 250 });
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS ledger (
        instance_id TEXT NOT NULL, helper_generation INTEGER NOT NULL,
        session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (instance_id, helper_generation, session_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS quarantines (
        pid INTEGER NOT NULL, creation_time TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (pid, creation_time)
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const key = (row: WindowsLedgerRow) => [
    instanceId,
    row.helperGeneration,
    row.sessionId,
    row.requestId,
  ];
  const put = db.prepare(
    'INSERT INTO ledger VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET payload = excluded.payload',
  );
  const remove = db.prepare(
    'DELETE FROM ledger WHERE instance_id = ? AND helper_generation = ? AND session_id = ? AND request_id = ?',
  );
  const addQuarantine = db.prepare(
    'INSERT INTO quarantines VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const add = (quarantines: readonly WindowsTargetQuarantine[]) => {
    for (const q of quarantines)
      addQuarantine.run(q.identity.pid, q.identity.creationTime, JSON.stringify(q));
  };
  const readRecords = (
    records: { rowid: number; payload: unknown }[],
    problem: (value: unknown) => string | null,
    removeInvalid: Database.Statement,
  ) =>
    records.map((record) => {
      const value = decode(record.payload);
      // Return the discarded shape once so the restore kernel emits only kind/reason diagnostics.
      if (problem(value) !== null) removeInvalid.run(record.rowid);
      return value;
    });
  const readQuarantines = db.transaction(() =>
    readRecords(
      db
        .prepare<[], { rowid: number; payload: unknown }>(
          'SELECT rowid, payload FROM quarantines ORDER BY rowid',
        )
        .all(),
      storedQuarantineProblem,
      db.prepare('DELETE FROM quarantines WHERE rowid = ?'),
    ),
  );
  const store = {
    instanceId,
    write(row: WindowsLedgerRow) {
      if (storedRowProblem(row) !== null) throw new Error('Invalid ledger row');
      put.run(...key(row), JSON.stringify(row));
      return true;
    },
    update(row: WindowsLedgerRow): boolean {
      return store.write(row);
    },
    delete(row: WindowsLedgerRow) {
      remove.run(...key(row));
      return true;
    },
    restoreQuarantines: db.transaction((quarantines: readonly WindowsTargetQuarantine[]) => {
      add(quarantines);
      return true;
    }),
    transferReceipt: db.transaction(
      (rows: readonly WindowsLedgerRow[], quarantines: readonly WindowsTargetQuarantine[]) => {
        add(quarantines);
        for (const row of rows) remove.run(...key(row));
        return true;
      },
    ),
    read: db.transaction(() => ({
      rows: readRecords(
        db
          .prepare<[string], { rowid: number; payload: unknown }>(
            'SELECT rowid, payload FROM ledger WHERE instance_id = ? ORDER BY rowid',
          )
          .all(instanceId),
        storedRowProblem,
        db.prepare('DELETE FROM ledger WHERE rowid = ?'),
      ),
      quarantines: readQuarantines(),
    })),
    readQuarantines,
    close() {
      if (db.open) db.close();
    },
  } satisfies WindowsDispatchLedgerStorage & {
    instanceId: string;
    read: unknown;
    readQuarantines: unknown;
    close(): void;
  };
  return store;
}
