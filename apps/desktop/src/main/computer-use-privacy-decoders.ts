import Database from 'better-sqlite3';
import { lstatSync } from 'node:fs';
import {
  constants as zlibConstants,
  crc32,
  gunzipSync,
  inflateRawSync,
  inflateSync,
} from 'node:zlib';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import { createDeflateBodyWalk } from './computer-use-privacy-deflate';

const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_TABLES = 128;
const MAX_COLUMNS = 128;
/** Same bounded budget as the ZIP entry cap: nesting must not widen the corpus. */
const MAX_NESTED_DEPTH = 4;
const MAX_NESTED_ARCHIVES = 128;

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const isGzip = (bytes: Buffer) => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
const isZip = (bytes: Buffer) => bytes.length >= 2 && bytes.readUInt16LE(0) === 0x4b50;
const isSqlite = (bytes: Buffer) => bytes.subarray(0, 16).equals(SQLITE_MAGIC);
/**
 * A zlib stream has no magic number: CMF holds CM in its low nibble and CINFO in its high one,
 * and CMF/FLG together must be a multiple of 31. Two weak bytes are not proof, and ordinary text
 * satisfies them — "(r" and "80" both do — so this only decides whether inflating is worth
 * attempting. Whether the bytes really were a stream is settled by the inflate itself.
 */
function isZlib(bytes: Buffer): boolean {
  if (bytes.length < 2) return false;
  const cmf = bytes[0]!;
  return (cmf & 0x0f) === 8 && cmf >>> 4 <= 7 && (cmf * 256 + bytes[1]!) % 31 === 0;
}

/** RFC 1950 §2.2: FDICT adds a 4-byte DICTID, so the DEFLATE body starts at byte 6, not byte 2. */
const ZLIB_DICTIONARY_HEADER_BYTES = 6;

/**
 * Containers this decoder cannot open. Searching only their compressed bytes would leave a stored
 * payload unexamined, so seeing one makes the surface incomplete rather than clean. Each magic is
 * compared positionally, which already fails on a buffer too short to hold it. zlib is absent
 * here because it is inflated instead of refused.
 */
function isUninspectableContainer(bytes: Buffer): boolean {
  for (const magic of [
    [0x42, 0x5a, 0x68], // bzip2
    [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
    [0x28, 0xb5, 0x2f, 0xfd], // zstd
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
    [0x04, 0x22, 0x4d, 0x18], // lz4
  ])
    if (magic.every((byte, index) => bytes[index] === byte)) return true;
  return false;
}

type Result = {
  kind: 'raw' | 'sqlite' | 'gzip' | 'zip';
  complete: boolean;
  valuesScanned: number;
  decodedBytes: number;
};
type Visit = (bytes: Buffer) => void;
type Scanner = ReturnType<typeof createBoundedScanner>;

/**
 * The single bounded inspection every candidate byte string goes through, whether it came from a
 * file, an archive entry or a logical database value. Bytes that are themselves an archive are
 * queued rather than treated as final content: searching only the inner compressed bytes would
 * miss a stored payload. Exceeding any budget throws, which leaves the surface uninspected.
 */
function createBoundedScanner(result: Result, visit: Visit) {
  const queue: { bytes: Buffer; depth: number }[] = [];
  let queuedBytes = 0;
  // One walk per file, because this scanner is built once per file. Building one per value would
  // hand each of them a fresh budget and give back the amplification the budget exists to stop;
  // sharing one across files would spend a later file's budget on an earlier one's bytes.
  const walkDeflateBody = createDeflateBodyWalk();
  /**
   * FDICT in FLG says the stream was compressed against a preset dictionary. The bit is as weak as
   * the rest of the header, and ordinary text sets it as readily — "(rest of an ordinary line"
   * does — so the body behind it decides: bytes that parse as a written DEFLATE stream, inside the
   * window CINFO declares, were compressed, and no dictionary exists here to read them with. Text
   * that merely matched the header does not parse, and stays a look-alike scanned as raw bytes.
   *
   * A body that spends the walk budget settled neither, and an unsettled body counts as a
   * dictionary here: this decoder treats work it could not finish as unread, never as clean.
   */
  const usesPresetDictionary = (bytes: Buffer): boolean =>
    (bytes[1]! & 0x20) !== 0 &&
    bytes.length > ZLIB_DICTIONARY_HEADER_BYTES &&
    walkDeflateBody(
      bytes.subarray(ZLIB_DICTIONARY_HEADER_BYTES),
      // RFC 1950 §2.2: CINFO is the base-2 log of the window size, less eight.
      1 << ((bytes[0]! >>> 4) + 8),
    ) !== 'look-alike';
  // A stream that was cut short, damaged, or written against a dictionary this process does not
  // hold can be read at most up to that point. Whatever comes back is scanned, but the surface
  // must not claim to have been fully read afterwards.
  let unread = false;
  const account = (decoded: Buffer, depth: number) => {
    if (
      decoded.length > MAX_VALUE_BYTES ||
      result.decodedBytes + decoded.length > MAX_DECODED_BYTES
    )
      throw new Error('decode_limit');
    result.decodedBytes += decoded.length;
    result.valuesScanned += 1;
    visit(decoded);
    if (isUninspectableContainer(decoded)) throw new Error('uninspectable_nested_format');
    // A decompressed database can hold values split across pages, which the byte search above
    // cannot reassemble. Logical reading needs a file on disk, and this scanner must not write
    // the decompressed private bytes back out to get one, so the surface stays uninspected.
    if (isSqlite(decoded)) throw new Error('uninspectable_nested_sqlite');
    if (!isGzip(decoded) && !isZip(decoded) && !isZlib(decoded)) return;
    if (
      depth >= MAX_NESTED_DEPTH ||
      queue.length >= MAX_NESTED_ARCHIVES ||
      queuedBytes + decoded.length > MAX_DECODED_BYTES
    )
      throw new Error('nesting_limit');
    queuedBytes += decoded.length;
    queue.push({ bytes: Buffer.from(decoded), depth: depth + 1 });
  };
  const expand = async (archive: Buffer, depth: number) => {
    if (isGzip(archive) || isZlib(archive)) {
      let decoded: Buffer;
      try {
        decoded = isGzip(archive)
          ? gunzipSync(archive, { maxOutputLength: MAX_VALUE_BYTES })
          : inflateSync(archive, { maxOutputLength: MAX_VALUE_BYTES });
      } catch (error) {
        // Output that outgrows the budget is always a refusal, and gzip's magic is specific
        // enough that failing to open one stays a refusal too.
        if (isGzip(archive) || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
          throw error;
        // Why a strict inflate failed says little: a cut stream, a flipped checksum bit and a
        // line of text that happens to match the two header bytes can all report the same code.
        // What separates them is whether the DEFLATE body still yields anything, so decide on
        // recoverability instead. Reading it raw skips the zlib framing and its checksum, which
        // is exactly the part a damaged stream fails on while its content stays readable.
        //
        // A preset dictionary is the one failure the body itself answers for: either it parsed as
        // a written stream, or the walk ran out of budget before that could be ruled out. Both
        // count as a dictionary, because work that settled nothing must not read as clean, and
        // either way the content was compressed against a dictionary that is not in this process.
        // The surface therefore stays unread whatever the recovery below yields. Its body still
        // begins after the DICTID, and reading from there recovers whatever precedes the first
        // reference into the dictionary.
        const dictionary = usesPresetDictionary(archive);
        if (dictionary) unread = true;
        let recovered: Buffer;
        try {
          recovered = inflateRawSync(
            archive.subarray(dictionary ? ZLIB_DICTIONARY_HEADER_BYTES : 2),
            {
              finishFlush: zlibConstants.Z_SYNC_FLUSH,
              maxOutputLength: MAX_VALUE_BYTES,
            },
          );
        } catch (recoveryError) {
          if ((recoveryError as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
            throw recoveryError;
          return;
        }
        try {
          // Nothing came back, so those two bytes were never a stream. The raw bytes were already
          // searched by the visit that queued this, and the surface stays scanned.
          if (recovered.length === 0) return;
          // Something came back, so this was a real stream that strict reading could not finish.
          // Scan what was recovered and refuse to call the surface completely read.
          unread = true;
          account(recovered, depth);
        } finally {
          recovered.fill(0);
        }
        return;
      }
      try {
        account(decoded, depth);
      } finally {
        decoded.fill(0);
      }
      return;
    }
    await inspectZip(archive, (decoded) => account(decoded, depth));
  };
  return {
    account,
    expand,
    /** True once any stream could not be read whole: damage, an early cut, or a missing dictionary. */
    wasUnread: () => unread,
    async drain() {
      while (queue.length > 0) {
        const nested = queue.shift()!;
        try {
          await expand(nested.bytes, nested.depth);
        } finally {
          nested.bytes.fill(0);
        }
      }
    },
    dispose() {
      for (const nested of queue) nested.bytes.fill(0);
      queue.length = 0;
    },
  };
}

/** Only decoded bytes reach the transient matcher. Errors, SQL, names and values never escape. */
export async function inspectComputerUseStoredValues(
  filePath: string,
  bytes: Buffer,
  visit: Visit,
): Promise<Result> {
  const result: Result = { kind: 'raw', complete: false, valuesScanned: 0, decodedBytes: 0 };
  const scanner = createBoundedScanner(result, visit);
  try {
    return await inspectBytes(filePath, bytes, result, scanner);
  } finally {
    scanner.dispose();
  }
}

async function inspectBytes(
  filePath: string,
  bytes: Buffer,
  result: Result,
  scanner: Scanner,
): Promise<Result> {
  const { expand, drain } = scanner;
  if (isSqlite(bytes)) {
    result.kind = 'sqlite';
    await inspectSqlite(filePath, result, scanner);
    return result;
  }
  if (isGzip(bytes) || isZip(bytes) || isZlib(bytes)) {
    // A zlib-looking file keeps the raw kind: the header may not be a stream at all, and the
    // outer byte search covers it either way. Only gzip and ZIP claim to have been decoded.
    if (isGzip(bytes)) result.kind = 'gzip';
    else if (isZip(bytes)) result.kind = 'zip';
    try {
      await expand(bytes, 0);
      await drain();
      result.complete = !scanner.wasUnread();
    } catch {
      result.complete = false;
    }
  } else
    // Plain bytes are fully searched as they are. A container this decoder cannot open is not:
    // nothing inside it was examined, so it must not read as a scanned surface.
    result.complete = !isUninspectableContainer(bytes);
  return result;
}

async function inspectSqlite(filePath: string, result: Result, scanner: Scanner): Promise<void> {
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
            // A stored value gets the same bounded inspection as a file: a compressed BLOB is
            // decoded and searched rather than counted as scanned on its compressed bytes.
            scanner.account(decoded, 0);
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
    // Drained only after the database is closed, so no archive is expanded while a read
    // transaction is still open on it.
    await scanner.drain();
    result.complete = !scanner.wasUnread();
  } catch {
    result.complete = false;
  } finally {
    try {
      database?.close();
    } catch {
      result.complete = false;
    }
  }
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
