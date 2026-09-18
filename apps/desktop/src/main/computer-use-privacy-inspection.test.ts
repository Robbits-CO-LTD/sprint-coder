import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as NodeFs from 'node:fs';
import { gzipSync, deflateRawSync, deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMPUTER_USE_PRIVATE_PAYLOADS,
  COMPUTER_USE_PRIVACY_SURFACES,
  inspectComputerUsePrivacySurfaces,
} from './computer-use-privacy-inspection';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'computer-use-privacy-')));
  roots.push(root);
  const payloads = COMPUTER_USE_PRIVATE_PAYLOADS.map((kind) => ({
    kind,
    bytes: Buffer.from(`PRIVATE_FIXTURE_${kind}_日本語`),
  }));
  const files = COMPUTER_USE_PRIVACY_SURFACES.map((surface) => {
    const path = join(root, `${surface}.bin`);
    writeFileSync(path, 'bounded metadata only');
    return { surface, path };
  });
  return { root, payloads, files };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local Computer Use privacy inspection (fixed unit artifacts)', () => {
  it('bounds copying for an 8MiB image and 64MiB file corpus', async () => {
    const input = fixture();
    const image = input.payloads.find(({ kind }) => kind === 'screenshot')!;
    image.bytes = Buffer.alloc(8 * 1024 * 1024, 0x81);
    const fileBytes = Buffer.alloc(16 * 1024 * 1024, 0x20);
    input.files.forEach(({ path }, index) =>
      writeFileSync(path, index < 4 ? fileBytes : Buffer.alloc(0)),
    );
    fileBytes.fill(0);
    const concat = Buffer.concat;
    let copiedBytes = 0;
    const spy = vi.spyOn(Buffer, 'concat').mockImplementation((list, size) => {
      copiedBytes += size ?? list.reduce((sum, buffer) => sum + buffer.length, 0);
      return concat(list, size);
    });
    const started = performance.now();
    try {
      const report = await inspectComputerUsePrivacySurfaces(input);
      const elapsedMs = Math.round(performance.now() - started);
      console.info(JSON.stringify({ privacyInspectionFixture: true, elapsedMs, copiedBytes }));
      expect(report.surfaces.every(({ state }) => state === 'raw_bytes_scanned')).toBe(true);
      expect(report.surfaces.reduce((sum, surface) => sum + surface.bytesInspected, 0)).toBe(
        64 * 1024 * 1024,
      );
      expect(copiedBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally {
      spy.mockRestore();
    }
  });

  it('inspects all specified surfaces without claiming complete inventory or final acceptance', async () => {
    const input = fixture();
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces.every(({ state }) => state === 'raw_bytes_scanned')).toBe(true);
    expect(result.finalGateEligible).toBe(false);
    expect(result.completeSurfaceInventoryVerified).toBe(false);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(input.root);
    expect(encoded).not.toContain('PRIVATE_FIXTURE');
    expect(input.payloads[0]!.bytes.toString()).toContain('PRIVATE_FIXTURE');
  });

  it('derives eligibility from a measured inventory rather than a caller claim', async () => {
    const input = fixture();
    const unclaimed = await inspectComputerUsePrivacySurfaces(input);
    expect(unclaimed.completeSurfaceInventoryVerified).toBe(false);
    expect(unclaimed.finalGateEligible).toBe(false);

    const verified = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
    });
    expect(verified.surfaces.every(({ state }) => state === 'raw_bytes_scanned')).toBe(true);
    expect(verified.completeSurfaceInventoryVerified).toBe(true);
    expect(verified.uninspectedSurfaces).toEqual([]);
    expect(verified.contaminatedSurfaces).toEqual([]);
    expect(verified.finalGateEligible).toBe(true);
    const encoded = JSON.stringify(verified);
    expect(encoded).not.toContain(input.root);
    expect(encoded).not.toContain('PRIVATE_FIXTURE');
  });

  it('refuses an inventory claim that misses a file actually present under the root', async () => {
    const input = fixture();
    writeFileSync(join(input.root, 'unenumerated-sink.log'), 'bounded metadata only');
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
    });
    expect(result.surfaces.every(({ state }) => state === 'raw_bytes_scanned')).toBe(true);
    expect(result.completeSurfaceInventoryVerified).toBe(false);
    expect(result.finalGateEligible).toBe(false);
  });

  it('refuses an inventory claim with an untraversable tree or an out-of-root claim', async () => {
    const input = fixture();
    const other = fixture();
    symlinkSync(other.files[0]!.path, join(input.root, 'aliased.log'));
    expect(
      (await inspectComputerUsePrivacySurfaces({ ...input, enumeratedRoots: [input.root] }))
        .completeSurfaceInventoryVerified,
    ).toBe(false);
    expect(
      (await inspectComputerUsePrivacySurfaces({ ...other, enumeratedRoots: [input.root] }))
        .completeSurfaceInventoryVerified,
    ).toBe(false);
    expect(
      (await inspectComputerUsePrivacySurfaces({ ...other, enumeratedRoots: [] }))
        .completeSurfaceInventoryVerified,
    ).toBe(false);
  });

  it('refuses a tidy subdirectory claim that leaves sibling sinks under the root unenumerated', async () => {
    const input = fixture();
    const nested = join(input.root, 'inspected');
    mkdirSync(nested);
    const files = input.files.map(({ surface, path }) => {
      const moved = join(nested, `${surface}.bin`);
      renameSync(path, moved);
      return { surface, path: moved };
    });
    writeFileSync(join(input.root, 'sibling-sink.log'), 'bounded metadata only');
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      files,
      enumeratedRoots: [nested],
    });
    expect(result.surfaces.every(({ state }) => state === 'raw_bytes_scanned')).toBe(true);
    expect(result.completeSurfaceInventoryVerified).toBe(false);
    expect(result.finalGateEligible).toBe(false);
    // Claiming the real root surfaces the sibling and still refuses the inventory.
    expect(
      (
        await inspectComputerUsePrivacySurfaces({
          ...input,
          files,
          enumeratedRoots: [input.root],
        })
      ).completeSurfaceInventoryVerified,
    ).toBe(false);
  });

  it('never reads a payload class the run did not generate as a clean surface', async () => {
    const input = fixture();
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
      payloads: input.payloads.slice(1),
    });
    expect(result.missingPayloadKinds).toEqual(['screenshot']);
    // The inventory is genuinely verified here; it still cannot open the gate on its own.
    expect(result.completeSurfaceInventoryVerified).toBe(true);
    expect(result.surfaces.every(({ state }) => state === 'unavailable')).toBe(true);
    expect(result.uninspectedSurfaces).toEqual([...COMPUTER_USE_PRIVACY_SURFACES]);
    expect(result.contaminatedSurfaces).toEqual([]);
    expect(result.finalGateEligible).toBe(false);
  });

  it('keeps one contaminated surface out of the gate despite a verified inventory', async () => {
    const input = fixture();
    writeFileSync(input.files[2]!.path, input.payloads[2]!.bytes);
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
    });
    expect(result.completeSurfaceInventoryVerified).toBe(true);
    expect(result.contaminatedSurfaces).toEqual(['telemetry']);
    expect(result.uninspectedSurfaces).toEqual([]);
    expect(result.finalGateEligible).toBe(false);
  });

  it('keeps one unreadable surface out of the gate despite a verified inventory', async () => {
    const input = fixture();
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
      files: input.files.slice(1),
    });
    expect(result.completeSurfaceInventoryVerified).toBe(false);
    expect(result.uninspectedSurfaces).toEqual(['database']);
    expect(result.finalGateEligible).toBe(false);
  });

  it('detects a logical SQLite BLOB split across physical pages', async () => {
    const input = fixture();
    const path = input.files[0]!.path;
    rmSync(path);
    const payload = input.payloads.find(({ kind }) => kind === 'screenshot')!;
    payload.bytes = Buffer.alloc(32 * 1024, 0x81);
    const database = new Database(path);
    try {
      database.exec('PRAGMA page_size=512; VACUUM; CREATE TABLE capture (body BLOB);');
      database.prepare('INSERT INTO capture VALUES (?)').run(payload.bytes);
      const stored = database.prepare<[], { body: unknown }>('SELECT body FROM capture').get()!
        .body;
      expect(stored).toBeInstanceOf(Uint8Array);
      if (!(stored instanceof Uint8Array)) throw new Error('SQLite fixture BLOB missing');
      expect(Buffer.from(stored).equals(payload.bytes)).toBe(true);
    } finally {
      database.close();
    }
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]).toMatchObject({
      state: 'contaminated',
      logicalValuesInspected: true,
      matchedKinds: ['screenshot'],
    });
    expect(result.finalGateEligible).toBe(false);
  });

  it('decodes a compressed value stored inside SQLite', async () => {
    const input = fixture();
    const path = input.files[0]!.path;
    rmSync(path);
    const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
    const database = new Database(path);
    try {
      database.exec('PRAGMA page_size=512; VACUUM; CREATE TABLE capture (body BLOB);');
      database.prepare('INSERT INTO capture VALUES (?)').run(gzipSync(payload.bytes));
    } finally {
      database.close();
    }
    // Present neither in the physical pages nor in the logical value as stored.
    expect(readFileSync(path).includes(payload.bytes)).toBe(false);
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]).toMatchObject({
      state: 'contaminated',
      matchedKinds: ['typed_text'],
    });
    expect(result.finalGateEligible).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
  });

  it.each(['uninspectable-container', 'nested-database'])(
    'refuses a SQLite value it cannot open: %s',
    async (kind) => {
      const input = fixture();
      const path = input.files[0]!.path;
      rmSync(path);
      const nested =
        kind === 'uninspectable-container'
          ? Buffer.concat([Buffer.from('BZh9'), Buffer.alloc(64, 7)])
          : Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64, 7)]);
      const database = new Database(path);
      try {
        database.exec('CREATE TABLE capture (body BLOB);');
        database.prepare('INSERT INTO capture VALUES (?)').run(nested);
      } finally {
        database.close();
      }
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'unavailable',
        logicalValuesInspected: false,
      });
      expect(result.finalGateEligible).toBe(false);
    },
  );

  it('reads committed WAL values without changing main/WAL bytes or executing a view', async () => {
    const input = fixture();
    const path = input.files[0]!.path;
    rmSync(path);
    const database = new Database(path);
    try {
      database.exec(
        'PRAGMA page_size=512; VACUUM; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE "quoted table" ("quoted column" TEXT); CREATE VIEW unsafe AS SELECT load_extension(\'never-load\');',
      );
      const text = input.payloads.find(({ kind }) => kind === 'typed_text')!.bytes.toString();
      database.prepare('INSERT INTO "quoted table" VALUES (?)').run(text.repeat(100));
      const before = [readFileSync(path), readFileSync(path + '-wal')];
      const files = readdirSync(input.root).sort();
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'contaminated',
        logicalValuesInspected: true,
        matchedKinds: ['typed_text'],
      });
      expect(readFileSync(path).equals(before[0]!)).toBe(true);
      expect(readFileSync(path + '-wal').equals(before[1]!)).toBe(true);
      expect(readdirSync(input.root).sort()).toEqual(files);
    } finally {
      database.close();
    }
  });

  it('leaves a locked SQLite database uninspected rather than waiting indefinitely', async () => {
    const input = fixture();
    const path = input.files[0]!.path;
    rmSync(path);
    const database = new Database(path);
    try {
      database.exec('CREATE TABLE capture (body TEXT); BEGIN EXCLUSIVE;');
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'unavailable',
        logicalValuesInspected: false,
      });
    } finally {
      database.exec('ROLLBACK');
      database.close();
    }
  });

  it.each(['gzip', 'zip'] as const)(
    'detects a known payload inside %s without exposing its body',
    async (format) => {
      const input = fixture();
      const payload = input.payloads.find(({ kind }) => kind === 'provider_response')!.bytes;
      writeFileSync(
        input.files[4]!.path,
        format === 'gzip' ? gzipSync(payload) : zipFixture(payload),
      );
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[4]).toMatchObject({
        state: 'contaminated',
        matchedKinds: ['provider_response'],
      });
      expect(JSON.stringify(result)).not.toContain(payload.toString());
    },
  );

  it.each(['double-gzip', 'zip-of-gzip', 'gzip-of-zip'])(
    'finds a known payload nested inside %s',
    async (kind) => {
      const input = fixture();
      const payload = input.payloads.find(({ kind: name }) => name === 'provider_response')!.bytes;
      writeFileSync(
        input.files[4]!.path,
        kind === 'double-gzip'
          ? gzipSync(gzipSync(payload))
          : kind === 'zip-of-gzip'
            ? zipFixture(gzipSync(payload))
            : gzipSync(zipFixture(payload)),
      );
      const result = await inspectComputerUsePrivacySurfaces({
        ...input,
        enumeratedRoots: [input.root],
      });
      expect(result.surfaces[4]).toMatchObject({
        state: 'contaminated',
        matchedKinds: ['provider_response'],
      });
      expect(result.contaminatedSurfaces).toEqual(['crash_artifact']);
      // The reviewer's scenario: everything else is clean and the inventory is verified.
      expect(result.completeSurfaceInventoryVerified).toBe(true);
      expect(result.finalGateEligible).toBe(false);
      expect(JSON.stringify(result)).not.toContain(payload.toString());
    },
  );

  it('refuses to call a surface complete when nesting exceeds the bounded depth', async () => {
    const input = fixture();
    const payload = input.payloads.find(({ kind }) => kind === 'provider_response')!.bytes;
    let nested = gzipSync(payload);
    for (let depth = 0; depth < 6; depth += 1) nested = gzipSync(nested);
    writeFileSync(input.files[4]!.path, nested);
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
    });
    // Unreached payload must never read as a scanned, clean surface.
    expect(result.surfaces[4]!.state).toBe('unavailable');
    expect(result.uninspectedSurfaces).toEqual(['crash_artifact']);
    expect(result.finalGateEligible).toBe(false);
  });

  it('never calls a decompressed SQLite scanned while its page-split values are unread', async () => {
    const input = fixture();
    const payload = input.payloads.find(({ kind }) => kind === 'screenshot')!;
    payload.bytes = Buffer.alloc(32 * 1024, 0x81);
    const databasePath = join(input.root, 'nested.db');
    const database = new Database(databasePath);
    try {
      database.exec('PRAGMA page_size=512; VACUUM; CREATE TABLE capture (body BLOB);');
      database.prepare('INSERT INTO capture VALUES (?)').run(payload.bytes);
    } finally {
      database.close();
    }
    const raw = readFileSync(databasePath);
    rmSync(databasePath);
    // The BLOB is split across 512-byte pages, so a byte search of the file cannot find it: only
    // a logical read can. Compressing it must not turn that gap into a clean result.
    expect(raw.includes(payload.bytes)).toBe(false);
    writeFileSync(input.files[4]!.path, gzipSync(raw));
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
    });
    expect(result.surfaces[4]!.state).toBe('unavailable');
    expect(result.uninspectedSurfaces).toEqual(['crash_artifact']);
    expect(result.finalGateEligible).toBe(false);
  });

  it.each([
    { kind: 'swapped descriptor', lstat: { dev: 7n, ino: 11n }, fstat: { dev: 7n, ino: 12n } },
    { kind: 'identity unavailable', lstat: { dev: 0n, ino: 0n }, fstat: { dev: 0n, ino: 0n } },
  ])('refuses a file whose opened descriptor cannot be pinned: $kind', async (scenario) => {
    const input = fixture();
    vi.resetModules();
    // Identity is compared with bigint stats, so the fakes are platform-independent.
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      const override = (stat: object, options: unknown, values: { dev: bigint; ino: bigint }) =>
        (options as { bigint?: boolean } | undefined)?.bigint === true
          ? Object.assign(Object.create(Object.getPrototypeOf(stat) as object), stat, values)
          : stat;
      return {
        ...actual,
        lstatSync: ((path: string, options?: unknown) =>
          override(
            actual.lstatSync(path, options as never),
            options,
            scenario.lstat,
          )) as typeof actual.lstatSync,
        fstatSync: ((fd: number, options?: unknown) =>
          override(
            actual.fstatSync(fd, options as never),
            options,
            scenario.fstat,
          )) as typeof actual.fstatSync,
      };
    });
    try {
      const module = await import('./computer-use-privacy-inspection');
      const result = await module.inspectComputerUsePrivacySurfaces({
        ...input,
        enumeratedRoots: [input.root],
      });
      expect(result.surfaces.every(({ state }) => state === 'unavailable')).toBe(true);
      expect(result.finalGateEligible).toBe(false);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

  function writeDatabaseValue(path: string, ...values: (Buffer | string)[]): void {
    rmSync(path);
    const database = new Database(path);
    try {
      database.exec('CREATE TABLE capture (body BLOB);');
      const insert = database.prepare('INSERT INTO capture VALUES (?)');
      for (const value of values) insert.run(value);
    } finally {
      database.close();
    }
  }

  /** Every two-byte prefix of printable text that passes the zlib header rules with FDICT set. */
  function fdictLookAlikePrefixes(): string[] {
    const prefixes: string[] = [];
    for (let cmf = 0x20; cmf <= 0x7e; cmf += 1) {
      if ((cmf & 0x0f) !== 8 || cmf >>> 4 > 7) continue;
      for (let flg = 0x20; flg <= 0x7e; flg += 1)
        if ((cmf * 256 + flg) % 31 === 0 && (flg & 0x20) !== 0)
          prefixes.push(String.fromCharCode(cmf, flg));
    }
    return prefixes;
  }

  it.each([
    { place: 'file', windowBits: 9 },
    { place: 'file', windowBits: 15 },
    { place: 'sqlite-blob', windowBits: 9 },
    { place: 'sqlite-blob', windowBits: 15 },
  ])('decodes a real zlib stream ($place, windowBits $windowBits)', async (scenario) => {
    const input = fixture();
    const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
    const compressed = deflateSync(payload.bytes, { windowBits: scenario.windowBits });
    expect(compressed[0]).toBe(scenario.windowBits === 9 ? 0x18 : 0x78);
    const path = input.files[0]!.path;
    if (scenario.place === 'file') writeFileSync(path, compressed);
    else writeDatabaseValue(path, compressed);
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]).toMatchObject({
      state: 'contaminated',
      matchedKinds: ['typed_text'],
    });
    expect(result.finalGateEligible).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
  });

  it.each(['file', 'sqlite-text', 'sqlite-blob'])(
    'scans a zlib look-alike value as raw bytes rather than refusing the surface: %s',
    async (placement) => {
      const input = fixture();
      // "(r" satisfies CM/CINFO/FCHECK yet is ordinary text; refusing it would make almost every
      // real database incomplete, so it must fall back to a raw scan instead.
      const lookAlike = Buffer.from('(rest of an ordinary logged line');
      expect((lookAlike[0]! & 0x0f) === 8).toBe(true);
      expect((lookAlike[0]! * 256 + lookAlike[1]!) % 31).toBe(0);
      const path = input.files[0]!.path;
      if (placement === 'file') writeFileSync(path, lookAlike);
      else writeDatabaseValue(path, placement === 'sqlite-text' ? lookAlike.toString() : lookAlike);
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]!.state).toBe(
        placement === 'file' ? 'raw_bytes_scanned' : 'logical_values_scanned',
      );
      expect(result.contaminatedSurfaces).toEqual([]);
      expect(result.uninspectedSurfaces).toEqual([]);
    },
  );

  it('still finds a payload stored behind a zlib look-alike prefix', async () => {
    const input = fixture();
    const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
    const prefix = Buffer.from('80 percent done ');
    expect((prefix[0]! * 256 + prefix[1]!) % 31).toBe(0);
    writeFileSync(input.files[0]!.path, Buffer.concat([prefix, payload.bytes]));
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]).toMatchObject({
      state: 'contaminated',
      matchedKinds: ['typed_text'],
    });
  });

  it.each(['file', 'sqlite-blob'])(
    'refuses a preset-dictionary zlib stream stored as a %s',
    async (placement) => {
      const input = fixture();
      const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
      // Compressed against a dictionary this process does not have: a strict inflate answers
      // Z_NEED_DICT and no part of the body can be read, so the payload is neither found nor
      // shown to be absent. Passing as a scanned surface would be a clean result we never got.
      const compressed = deflateSync(payload.bytes, {
        dictionary: Buffer.from('PRIVATE_FIXTURE_typed_text preset dictionary'),
      });
      expect(compressed[1]! & 0x20).toBe(0x20);
      const path = input.files[0]!.path;
      if (placement === 'file') writeFileSync(path, compressed);
      else writeDatabaseValue(path, compressed);
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]!.state).toBe('unavailable');
      expect(result.uninspectedSurfaces).toEqual(['database']);
      expect(result.finalGateEligible).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
    },
  );

  it.each(['file', 'sqlite-blob'])(
    'refuses a preset-dictionary zlib stream whose body runs past the old 64KiB cutoff: %s',
    async (placement) => {
      const input = fixture();
      // The same stream, only large: its body runs well past the 64KiB the parse once stopped at,
      // which used to leave it counted as a scanned surface holding nothing. Xorshift32 keeps the
      // payload incompressible, and so the body that size; the plain LCG used a few tests below
      // loses its low bits past 2^53 and compresses away to a few kilobytes.
      let state = 20260918;
      const payload = Buffer.alloc(512 * 1024);
      for (let index = 0; index < payload.length; index += 1) {
        state = (state ^ (state << 13)) >>> 0;
        state = state ^ (state >>> 17);
        state = (state ^ (state << 5)) >>> 0;
        payload[index] = 0x20 + (state % 95);
      }
      const compressed = deflateSync(payload, {
        dictionary: Buffer.from('PRIVATE_FIXTURE_typed_text preset dictionary'),
      });
      expect(compressed[1]! & 0x20).toBe(0x20);
      expect(compressed.length - 6).toBeGreaterThan(64 * 1024);
      const path = input.files[0]!.path;
      if (placement === 'file') writeFileSync(path, compressed);
      else writeDatabaseValue(path, compressed);
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]!.state).toBe('unavailable');
      expect(result.uninspectedSurfaces).toEqual(['database']);
      expect(result.finalGateEligible).toBe(false);
    },
  );

  it('refuses a preset-dictionary zlib stream a log file appended after', async () => {
    const input = fixture();
    const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
    // A compressed record followed by the next plain line, as an appended log holds it. The
    // record is still unreadable without its dictionary, so the surface is not a scanned one.
    let state = 20260918;
    const noise = Array.from({ length: 8192 }, () => {
      state = (state * 1103515245 + 12345) >>> 0;
      return String.fromCharCode(0x20 + ((state >>> 16) % 95));
    }).join('');
    const compressed = deflateSync(Buffer.concat([payload.bytes, Buffer.from(noise)]), {
      dictionary: Buffer.from('PRIVATE_FIXTURE_typed_text preset dictionary'),
    });
    // Only a body that ran at least a kilobyte vouches for the bytes stored after it.
    expect(compressed.length).toBeGreaterThan(1024);
    writeFileSync(
      input.files[1]!.path,
      Buffer.concat([compressed, Buffer.from('2026-09-18 session closed\n')]),
    );
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[1]!.state).toBe('unavailable');
    expect(result.uninspectedSurfaces).toEqual(['log']);
    expect(result.finalGateEligible).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
  });

  it('keeps a database of FDICT look-alike text a scanned surface', async () => {
    // FDICT is set by ordinary text as readily as the other header bits, and refusing the whole
    // database over it is what made every value unexamined before. Every prefix printable text
    // can start with is stored here, each with the continuations a logged line takes.
    const input = fixture();
    const prefixes = fdictLookAlikePrefixes();
    expect(prefixes.length).toBeGreaterThan(0);
    const values = prefixes.flatMap((prefix) =>
      [
        '',
        'est of an ordinary logged line',
        '{"level":"info","message":"session closed"}',
        'ラウンドが完了しました (round 12)',
      ].map((tail) => `${prefix}${tail}`),
    );
    writeDatabaseValue(
      input.files[0]!.path,
      ...values,
      ...values.map((value) => Buffer.from(value)),
    );
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]!.state).toBe('logical_values_scanned');
    expect(result.uninspectedSurfaces).toEqual([]);
    expect(result.contaminatedSurfaces).toEqual([]);
  });

  it.each(['file', 'sqlite-blob'])(
    'recovers a payload from a truncated zlib stream stored as a %s',
    async (placement) => {
      const input = fixture();
      const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
      // Only the trailing Adler-32 is missing, as a crash-cut compressed log would be: the whole
      // payload is still recoverable, so it must not pass as a scanned surface holding nothing.
      const truncated = deflateSync(payload.bytes).subarray(0, -4);
      const path = input.files[0]!.path;
      if (placement === 'file') writeFileSync(path, truncated);
      else writeDatabaseValue(path, truncated);
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'contaminated',
        matchedKinds: ['typed_text'],
      });
      expect(result.finalGateEligible).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
    },
  );

  it.each(['file', 'sqlite-blob'])(
    'recovers a payload from a checksum-damaged zlib stream stored as a %s',
    async (placement) => {
      const input = fixture();
      const payload = input.payloads.find(({ kind }) => kind === 'typed_text')!;
      // Only the trailing Adler-32 is wrong. The compressed body still yields the whole payload,
      // so a strict inflate failure must not be read as "this was never a stream".
      const damaged = Buffer.from(deflateSync(payload.bytes));
      const last = damaged.length - 1;
      damaged[last] = damaged[last]! ^ 0x01;
      const path = input.files[0]!.path;
      if (placement === 'file') writeFileSync(path, damaged);
      else writeDatabaseValue(path, damaged);
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'contaminated',
        matchedKinds: ['typed_text'],
      });
      expect(result.finalGateEligible).toBe(false);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
    },
  );

  it('keeps a body-damaged zlib surface incomplete even when nothing matched', async () => {
    const input = fixture();
    const damaged = Buffer.from(deflateSync(Buffer.from('ordinary log line\n'.repeat(64))));
    damaged[10] = damaged[10]! ^ 0x80;
    writeFileSync(input.files[0]!.path, damaged);
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]!.state).toBe('unavailable');
    expect(result.finalGateEligible).toBe(false);
  });

  it('keeps a truncated zlib surface incomplete even when nothing matched', async () => {
    const input = fixture();
    const truncated = deflateSync(Buffer.from('ordinary log line\n'.repeat(64))).subarray(0, -4);
    writeFileSync(input.files[0]!.path, truncated);
    const result = await inspectComputerUsePrivacySurfaces(input);
    // A stream whose tail is missing was not fully read, so it is unknown rather than clean.
    expect(result.surfaces[0]!.state).toBe('unavailable');
    expect(result.uninspectedSurfaces).toEqual(['database']);
    expect(result.finalGateEligible).toBe(false);
  });

  it('refuses a zlib stream whose expansion exceeds the bounded budget', async () => {
    const input = fixture();
    writeFileSync(input.files[0]!.path, deflateSync(Buffer.alloc(16 * 1024 * 1024 + 1)));
    const result = await inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]!.state).toBe('unavailable');
    expect(result.finalGateEligible).toBe(false);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    'scans an unopenable zlib look-alike with CINFO %i as raw bytes',
    async (cinfo) => {
      const input = fixture();
      const cmf = (cinfo << 4) | 8;
      const flg = (31 - ((cmf * 256) % 31)) % 31;
      writeFileSync(
        input.files[0]!.path,
        Buffer.concat([Buffer.from([cmf, flg]), Buffer.alloc(64, 7)]),
      );
      expect((await inspectComputerUsePrivacySurfaces(input)).surfaces[0]!.state).toBe(
        'raw_bytes_scanned',
      );
    },
  );

  it('does not mistake a failing zlib check byte pair for a container', async () => {
    const input = fixture();
    const cmf = 0x78;
    const flg = (((31 - ((cmf * 256) % 31)) % 31) + 1) % 31;
    expect((cmf * 256 + flg) % 31).not.toBe(0);
    writeFileSync(
      input.files[0]!.path,
      Buffer.concat([Buffer.from([cmf, flg]), Buffer.alloc(64, 7)]),
    );
    expect((await inspectComputerUsePrivacySurfaces(input)).surfaces[0]!.state).toBe(
      'raw_bytes_scanned',
    );
  });

  it('refuses a container format it cannot open rather than calling it scanned', async () => {
    const input = fixture();
    // A bzip2 stream: not decoded here, so its contents were never searched.
    writeFileSync(input.files[4]!.path, Buffer.concat([Buffer.from('BZh9'), Buffer.alloc(64, 7)]));
    const result = await inspectComputerUsePrivacySurfaces({
      ...input,
      enumeratedRoots: [input.root],
    });
    expect(result.surfaces[4]!.state).toBe('unavailable');
    expect(result.finalGateEligible).toBe(false);
  });

  it('rejects a decompression bomb, broken zip CRC and truncated gzip', async () => {
    const input = fixture();
    for (const bytes of [
      gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1)),
      zipFixture(Buffer.from('fixture'), true),
      gzipSync(Buffer.from('fixture')).subarray(0, 12),
    ]) {
      writeFileSync(input.files[4]!.path, bytes);
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[4]!.state).toBe('unavailable');
    }
  });

  it.each(['raw', 'base64', 'utf16', 'json', 'chunk-boundary'] as const)(
    'detects %s payload contamination',
    async (encoding) => {
      const input = fixture();
      const payload = input.payloads.find(
        ({ kind }) => kind === (encoding === 'base64' ? 'screenshot' : 'typed_text'),
      )!;
      const text = payload.bytes.toString();
      const bytes =
        encoding === 'base64'
          ? Buffer.from(payload.bytes.toString('base64'))
          : encoding === 'utf16'
            ? Buffer.from(text, 'utf16le')
            : encoding === 'json'
              ? Buffer.from(JSON.stringify(text))
              : payload.bytes;
      writeFileSync(
        input.files[0]!.path,
        encoding === 'chunk-boundary' ? Buffer.concat([Buffer.alloc(65530, 32), bytes]) : bytes,
      );
      const result = await inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'contaminated',
        matchedKinds: [payload.kind],
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
    },
  );

  it('leaves missing payloads/surfaces and unreadable files uninspected', async () => {
    const input = fixture();
    expect(
      (await inspectComputerUsePrivacySurfaces({ ...input, payloads: input.payloads.slice(1) }))
        .missingPayloadKinds,
    ).toEqual(['screenshot']);
    expect(
      (await inspectComputerUsePrivacySurfaces({ ...input, files: input.files.slice(1) }))
        .surfaces[0]!.state,
    ).toBe('unavailable');
    rmSync(input.files[0]!.path);
    expect((await inspectComputerUsePrivacySurfaces(input)).surfaces[0]!.state).toBe('unavailable');
  });

  it('refuses symlinks, out-of-root files, duplicate files and oversized inputs', async () => {
    const input = fixture();
    const other = fixture();
    rmSync(input.files[0]!.path);
    symlinkSync(other.files[0]!.path, input.files[0]!.path);
    expect((await inspectComputerUsePrivacySurfaces(input)).surfaces[0]!.state).toBe('unavailable');
    const outside = {
      ...input,
      files: [{ surface: 'database' as const, path: other.files[0]!.path }],
    };
    expect((await inspectComputerUsePrivacySurfaces(outside)).surfaces[0]!.state).toBe(
      'unavailable',
    );
    const duplicate = { ...other, files: [...other.files, other.files[0]!] };
    expect((await inspectComputerUsePrivacySurfaces(duplicate)).surfaces[0]!.state).toBe(
      'unavailable',
    );
    const huge = {
      ...other,
      payloads: [
        ...other.payloads,
        { kind: 'screenshot' as const, bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
      ],
    };
    expect(
      (await inspectComputerUsePrivacySurfaces(huge)).surfaces.every(
        ({ state }) => state === 'unavailable',
      ),
    ).toBe(true);
  });
});

function zipFixture(bytes: Buffer, badCrc = false): Buffer {
  const compressed = deflateRawSync(bytes);
  const name = Buffer.from('crash.txt');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(badCrc ? 0 : crc32(bytes), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(badCrc ? 0 : crc32(bytes), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(header.length + name.length + compressed.length, 16);
  return Buffer.concat([header, name, compressed, central, name, end]);
}
