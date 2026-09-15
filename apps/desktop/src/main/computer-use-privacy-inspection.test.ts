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
import { gzipSync, deflateRawSync, crc32 } from 'node:zlib';
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
