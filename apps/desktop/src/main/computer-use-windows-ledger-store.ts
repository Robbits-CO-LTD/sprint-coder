import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import Database from 'better-sqlite3';
import { secureLogger } from './secure-logger';
import type { WindowsDispatchLedgerStorage } from './computer-use-native-host';
import {
  isStoredWindowsQuarantine,
  storedRowProblem,
  type WindowsLedgerRow,
  type WindowsTargetQuarantine,
} from './computer-use-windows-stop-outcome';

export function windowsLedgerInstanceId(userData: string): string {
  // No legacy rows exist before product wiring; future instanceId changes require migration before activation.
  if (!win32.isAbsolute(userData)) throw new Error('Absolute userData path required');
  let canonical = userData;
  try {
    canonical = realpathSync.native(userData);
  } catch {
    // Profiles that do not exist yet retain the normalized-path fallback.
    secureLogger.warn(
      'Windows ledger profile realpath unavailable; using normalized path',
      undefined,
      { event: 'computer_use.windows_ledger.realpath_fallback' },
    );
  }
  const normalized = win32
    .normalize(canonical)
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

type StoredRecord = { rowid: number; payload: string };
/** 2 adds the shared quarantine revision (approval releases are conditional on it). */
const STORE_VERSION = 2;

/** The caller owns lifetime. This is deliberately not opened from the product index.ts yet. */
export function openWindowsLedgerStore(options: { userData: string; path?: string }) {
  const instanceId = windowsLedgerInstanceId(options.userData);
  const path = options.path ?? windowsLedgerStorePath();
  mkdirSync(dirname(path), { recursive: true });
  // Synchronous transactions serialize writes and their completions on each connection.
  // SQLite serializes other connections at commit; 250ms leaves room in Host's 2s deadline.
  const db = new Database(path, { timeout: 250 });
  const assertVersion = () => {
    if (db.pragma('user_version', { simple: true }) !== STORE_VERSION)
      throw new Error('Unsupported Windows ledger version');
  };
  try {
    db.transaction(() => {
      const version = db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== 1 && version !== STORE_VERSION)
        throw new Error('Unsupported Windows ledger version');
      db.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          instance_id TEXT NOT NULL, helper_generation INTEGER NOT NULL,
          session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY (instance_id, helper_generation, session_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS quarantines (
          pid INTEGER NOT NULL, creation_time TEXT NOT NULL, payload TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (pid, creation_time)
        );
        CREATE TABLE IF NOT EXISTS quarantine_revision (
          id INTEGER PRIMARY KEY CHECK (id = 0), value INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO quarantine_revision VALUES (0, 0);
      `);
      // Version 1 rows keep revision 0; every later add takes a store-wide revision above it.
      if (version === 1)
        db.exec('ALTER TABLE quarantines ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
      if (version !== STORE_VERSION) db.pragma(`user_version = ${STORE_VERSION}`);
    }).immediate();
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
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
  // A conflict keeps the first committed payload but still records that newer evidence landed.
  const addQuarantine = db.prepare(
    'INSERT INTO quarantines (pid, creation_time, payload, revision) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT DO UPDATE SET revision = excluded.revision',
  );
  const nextRevision = db
    .prepare<[], number>(
      'UPDATE quarantine_revision SET value = value + 1 WHERE id = 0 RETURNING value',
    )
    .pluck();
  const findQuarantine = db.prepare<[number, string], { payload: string; revision: number }>(
    'SELECT payload, revision FROM quarantines WHERE pid = ? AND creation_time = ?',
  );
  const deleteQuarantine = db.prepare(
    'DELETE FROM quarantines WHERE pid = ? AND creation_time = ?',
  );
  const deleteQuarantineAt = db.prepare(
    'DELETE FROM quarantines WHERE pid = ? AND creation_time = ? AND revision = ?',
  );
  /** Both transferReceipt and restoreQuarantines preserve the first committed reason.
   * Concurrent receipt/exit commits can differ from core event order; reasons are diagnostic.
   * Every add that touches an identity, including a kept-reason conflict, takes a new store-wide
   * revision, so a revision is never reused even after its row was released and added again.
   */
  const add = (quarantines: readonly WindowsTargetQuarantine[]) => {
    // Check every conflict under the write lock before changing either table.
    for (const q of quarantines) {
      const record = findQuarantine.get(q.identity.pid, q.identity.creationTime);
      if (record === undefined) continue;
      const existing = decode(record.payload);
      if (
        !isStoredWindowsQuarantine(existing) ||
        existing.identity.pid !== q.identity.pid ||
        existing.identity.creationTime !== q.identity.creationTime
      )
        return false;
    }
    for (const q of quarantines) {
      const revision = nextRevision.get();
      if (typeof revision !== 'number') throw new Error('Windows ledger revision unavailable');
      addQuarantine.run(q.identity.pid, q.identity.creationTime, JSON.stringify(q), revision);
    }
    return true;
  };
  const readQuarantines = db.transaction(() => {
    assertVersion();
    // Unknown payloads reach the kernel's kind/reason diagnostics but remain for newer readers.
    return db
      .prepare<[], StoredRecord>('SELECT rowid, payload FROM quarantines ORDER BY rowid')
      .all()
      .map((record) => decode(record.payload));
  });
  const snapshot = db.transaction(() => {
    assertVersion();
    return {
      records: db
        .prepare<[string], StoredRecord>(
          'SELECT rowid, payload FROM ledger WHERE instance_id = ? ORDER BY rowid',
        )
        .all(instanceId),
      quarantines: readQuarantines(),
    };
  });
  const removeInvalid = db.prepare(
    'DELETE FROM ledger WHERE rowid = ? AND instance_id = ? AND payload = ?',
  );
  const discardInvalid = db.transaction((records: readonly StoredRecord[]) => {
    assertVersion();
    // Recheck payloads under a write lock: another connection may have repaired a snapshot row.
    for (const record of records) removeInvalid.run(record.rowid, instanceId, record.payload);
  });
  const store = {
    instanceId,
    write: db.transaction((row: WindowsLedgerRow) => {
      assertVersion();
      if (storedRowProblem(row) !== null) throw new Error('Invalid ledger row');
      put.run(...key(row), JSON.stringify(row));
      return true;
    }).immediate,
    update(row: WindowsLedgerRow): boolean {
      return store.write(row);
    },
    updateWithQuarantines: db.transaction(
      (row: WindowsLedgerRow, quarantines: readonly WindowsTargetQuarantine[]): boolean => {
        assertVersion();
        if (storedRowProblem(row) !== null) throw new Error('Invalid ledger row');
        // add() checks every conflict before inserting; a refusal leaves the row unchanged too.
        if (!add(quarantines)) return false;
        put.run(...key(row), JSON.stringify(row));
        return true;
      },
    ).immediate,
    delete: db.transaction((row: WindowsLedgerRow) => {
      assertVersion();
      remove.run(...key(row));
      return true;
    }).immediate,
    restoreQuarantines: db.transaction((quarantines: readonly WindowsTargetQuarantine[]) => {
      assertVersion();
      return add(quarantines);
    }).immediate,
    quarantineRevision: db.transaction(
      (identity: WindowsTargetQuarantine['identity']): number | null => {
        assertVersion();
        return findQuarantine.get(identity.pid, identity.creationTime)?.revision ?? null;
      },
    ),
    releaseQuarantine: db.transaction(
      (identity: WindowsTargetQuarantine['identity'], revision?: number): boolean => {
        assertVersion();
        if (revision === undefined) {
          deleteQuarantine.run(identity.pid, identity.creationTime);
          return true;
        }
        if (deleteQuarantineAt.run(identity.pid, identity.creationTime, revision).changes > 0)
          return true;
        // An absent row is an idempotent retry (or another release); a present one is newer.
        return findQuarantine.get(identity.pid, identity.creationTime) === undefined;
      },
    ).immediate,
    transferReceipt: db.transaction(
      (rows: readonly WindowsLedgerRow[], quarantines: readonly WindowsTargetQuarantine[]) => {
        assertVersion();
        if (!add(quarantines)) return false;
        for (const row of rows) remove.run(...key(row));
        return true;
      },
    ).immediate,
    read() {
      const { records, quarantines } = snapshot();
      const rows = records.map((record) => decode(record.payload));
      const invalid = records.filter((_, index) => storedRowProblem(rows[index]) !== null);
      if (invalid.length > 0) discardInvalid.immediate(invalid);
      return { rows, quarantines };
    },
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
