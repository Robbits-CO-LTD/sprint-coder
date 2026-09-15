import Database from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import { crc32, gunzipSync } from 'node:zlib';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_TABLES = 128;
const MAX_COLUMNS = 128;

type Result = {
  kind: 'raw' | 'sqlite' | 'gzip' | 'zip';
  complete: boolean;
  valuesScanned: number;
  decodedBytes: number;
};
type Visit = (bytes: Buffer) => void;

/** Only decoded bytes reach the transient matcher. Errors, SQL, names and values never escape. */
export async function inspectComputerUseStoredValues(
  filePath: string,
  bytes: Buffer,
  visit: Visit,
): Promise<Result> {
  if (bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')))
    return inspectSqlite(filePath, visit);
  const result: Result = { kind: 'raw', complete: false, valuesScanned: 0, decodedBytes: 0 };
  const account = (decoded: Buffer) => {
    if (
      decoded.length > MAX_VALUE_BYTES ||
      result.decodedBytes + decoded.length > MAX_DECODED_BYTES
    )
      throw new Error('decode_limit');
    result.decodedBytes += decoded.length;
    result.valuesScanned += 1;
    visit(decoded);
  };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    result.kind = 'gzip';
    let decoded: Buffer | undefined;
    try {
      decoded = gunzipSync(bytes, { maxOutputLength: MAX_VALUE_BYTES });
      account(decoded);
      result.complete = true;
    } catch {
      result.complete = false;
    } finally {
      decoded?.fill(0);
    }
  } else if (bytes.length >= 2 && bytes.readUInt16LE(0) === 0x4b50) {
    result.kind = 'zip';
    try {
      await inspectZip(bytes, account);
      result.complete = true;
    } catch {
      result.complete = false;
    }
  }
  return result;
}

function inspectSqlite(filePath: string, visit: Visit): Result {
  const result: Result = { kind: 'sqlite', complete: false, valuesScanned: 0, decodedBytes: 0 };
  let database: Database.Database | undefined;
  try {
    // SQLite owns WAL replay. Never infer logical absence from only the main DB file's pages.
    // Refuse indirect/oversized sidecars before SQLite can open them.
    const tracked = ['', '-wal', '-shm', '-journal'].map((suffix) => {
      try {
        const stat = lstatSync(filePath + suffix);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > MAX_VALUE_BYTES
        )
          throw new Error('sqlite_sidecar');
        return { suffix, stat };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { suffix, stat: null };
        throw error;
      }
    });
    if (
      (tracked.find(({ suffix }) => suffix === '-wal')?.stat?.size ?? 0) > 0 &&
      tracked.find(({ suffix }) => suffix === '-shm')?.stat === null
    )
      throw new Error('sqlite_wal_index_missing');
    if ((tracked.find(({ suffix }) => suffix === '-journal')?.stat?.size ?? 0) > 0)
      throw new Error('sqlite_recovery_uninspected');
    database = new Database(filePath, { readonly: true, fileMustExist: true, timeout: 100 });
    database.pragma('query_only = ON');
    database.pragma('trusted_schema = OFF');
    database.exec('BEGIN');
    const tableRows = database
      .prepare("SELECT name, type FROM pragma_table_list WHERE schema='main' LIMIT 129")
      .all();
    const tables = tableRows.map((value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('name' in value) ||
        !('type' in value) ||
        typeof value.name !== 'string' ||
        typeof value.type !== 'string'
      )
        throw new Error('sqlite_table_shape');
      return { name: value.name, type: value.type };
    });
    if (tables.length > MAX_TABLES || tables.some((table) => table.type === 'virtual'))
      throw new Error('sqlite_table_limit');
    let rows = 0;
    for (const table of tables) {
      if (table.type === 'view') continue;
      const columns = database
        .prepare('SELECT name, hidden FROM pragma_table_xinfo(?) LIMIT 129')
        .all(table.name)
        .map((value) => {
          if (
            typeof value !== 'object' ||
            value === null ||
            !('name' in value) ||
            !('hidden' in value) ||
            typeof value.name !== 'string' ||
            typeof value.hidden !== 'number'
          )
            throw new Error('sqlite_column_shape');
          return { name: value.name, hidden: value.hidden };
        });
      if (
        columns.length === 0 ||
        columns.length > MAX_COLUMNS ||
        columns.some(({ hidden }) => hidden !== 0)
      )
        throw new Error('sqlite_column_limit');
      const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const statement = database.prepare(
        `SELECT ${columns.map(({ name }) => quoted(name)).join(',')} FROM ${quoted(table.name)} LIMIT ${MAX_ROWS + 1}`,
      );
      for (const row of statement.iterate()) {
        if (++rows > MAX_ROWS) throw new Error('sqlite_row_limit');
        if (typeof row !== 'object' || row === null) throw new Error('sqlite_row_shape');
        for (const value of Object.values(row)) {
          if (typeof value !== 'string' && !Buffer.isBuffer(value)) continue;
          const decoded = typeof value === 'string' ? Buffer.from(value) : value;
          try {
            if (
              decoded.length > MAX_VALUE_BYTES ||
              result.decodedBytes + decoded.length > MAX_DECODED_BYTES
            )
              throw new Error('sqlite_value_limit');
            result.decodedBytes += decoded.length;
            result.valuesScanned += 1;
            visit(decoded);
          } finally {
            decoded.fill(0);
          }
        }
      }
    }
    database.exec('ROLLBACK');
    database.close();
    database = undefined;
    for (const { suffix, stat } of tracked) {
      // SHM lock bookkeeping is not logical payload. Main/WAL/journal bytes must remain stable.
      if (suffix === '-shm') continue;
      let after;
      try {
        after = lstatSync(filePath + suffix);
      } catch {
        if (stat === null) continue;
        throw new Error('sqlite_changed');
      }
      if (
        stat === null ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      )
        throw new Error('sqlite_changed');
    }
    result.complete = true;
  } catch {
    result.complete = false;
  } finally {
    try {
      database?.close();
    } catch {
      result.complete = false;
    }
  }
  return result;
}

function inspectZip(bytes: Buffer, visit: (decoded: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let archive: ZipFile | undefined;
    let finished = false;
    let count = 0;
    const fail = () => {
      if (finished) return;
      finished = true;
      archive?.close();
      reject(new Error('zip_incomplete'));
    };
    fromBuffer(
      bytes,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          fail();
          return;
        }
        archive = zip;
        zip.on('error', fail);
        zip.on('end', () => {
          if (!finished) {
            finished = true;
            zip.close();
            resolve();
          }
        });
        zip.on('entry', (entry: Entry) => {
          const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            ++count > 128 ||
            entry.isEncrypted() ||
            ![0, 8].includes(entry.compressionMethod) ||
            ![0, 0o100000, 0o040000].includes(kind) ||
            entry.uncompressedSize > MAX_VALUE_BYTES
          ) {
            fail();
            return;
          }
          if (entry.fileName.endsWith('/')) {
            if (entry.uncompressedSize !== 0) {
              fail();
              return;
            }
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail();
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            const clear = () => {
              for (const chunk of chunks) chunk.fill(0);
              chunks.length = 0;
            };
            stream.on('error', () => {
              clear();
              fail();
            });
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_VALUE_BYTES) {
                chunk.fill(0);
                stream.destroy();
                clear();
                fail();
                return;
              }
              chunks.push(chunk);
            });
            stream.on('end', () => {
              const decoded = Buffer.concat(chunks, size);
              clear();
              try {
                if (size !== entry.uncompressedSize || crc32(decoded) !== entry.crc32)
                  throw new Error('zip_crc');
                visit(decoded);
                zip.readEntry();
              } catch {
                fail();
              } finally {
                decoded.fill(0);
              }
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
