import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  it('bounds copying for an 8MiB image and 64MiB file corpus', () => {
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
      const report = inspectComputerUsePrivacySurfaces(input);
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

  it('inspects all specified surfaces without claiming complete inventory or final acceptance', () => {
    const input = fixture();
    const result = inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces.every(({ state }) => state === 'raw_bytes_scanned')).toBe(true);
    expect(result.finalGateEligible).toBe(false);
    expect(result.completeSurfaceInventoryVerified).toBe(false);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(input.root);
    expect(encoded).not.toContain('PRIVATE_FIXTURE');
    expect(input.payloads[0]!.bytes.toString()).toContain('PRIVATE_FIXTURE');
  });

  it('does not confuse physical SQLite pages with logical BLOB/TEXT inspection', () => {
    const input = fixture();
    const path = input.files[0]!.path;
    rmSync(path);
    const payload = input.payloads.find(({ kind }) => kind === 'screenshot')!;
    payload.bytes = Buffer.alloc(32 * 1024, 0x81);
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA page_size=512; VACUUM; CREATE TABLE capture (body BLOB);');
      database.prepare('INSERT INTO capture VALUES (?)').run(payload.bytes);
      const stored = database.prepare('SELECT body FROM capture').get()!['body'];
      expect(stored).toBeInstanceOf(Uint8Array);
      if (!(stored instanceof Uint8Array)) throw new Error('SQLite fixture BLOB missing');
      expect(Buffer.from(stored).equals(payload.bytes)).toBe(true);
    } finally {
      database.close();
    }
    const result = inspectComputerUsePrivacySurfaces(input);
    expect(result.surfaces[0]).toMatchObject({
      state: 'raw_bytes_scanned',
      logicalValuesInspected: false,
      matchedKinds: [],
    });
    expect(result.finalGateEligible).toBe(false);
  });

  it.each(['raw', 'base64', 'utf16', 'json', 'chunk-boundary'] as const)(
    'detects %s payload contamination',
    (encoding) => {
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
      const result = inspectComputerUsePrivacySurfaces(input);
      expect(result.surfaces[0]).toMatchObject({
        state: 'contaminated',
        matchedKinds: [payload.kind],
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE');
    },
  );

  it('leaves missing payloads/surfaces and unreadable files uninspected', () => {
    const input = fixture();
    expect(
      inspectComputerUsePrivacySurfaces({ ...input, payloads: input.payloads.slice(1) })
        .missingPayloadKinds,
    ).toEqual(['screenshot']);
    expect(
      inspectComputerUsePrivacySurfaces({ ...input, files: input.files.slice(1) }).surfaces[0]!
        .state,
    ).toBe('unavailable');
    rmSync(input.files[0]!.path);
    expect(inspectComputerUsePrivacySurfaces(input).surfaces[0]!.state).toBe('unavailable');
  });

  it('refuses symlinks, out-of-root files, duplicate files and oversized inputs', () => {
    const input = fixture();
    const other = fixture();
    rmSync(input.files[0]!.path);
    symlinkSync(other.files[0]!.path, input.files[0]!.path);
    expect(inspectComputerUsePrivacySurfaces(input).surfaces[0]!.state).toBe('unavailable');
    const outside = {
      ...input,
      files: [{ surface: 'database' as const, path: other.files[0]!.path }],
    };
    expect(inspectComputerUsePrivacySurfaces(outside).surfaces[0]!.state).toBe('unavailable');
    const duplicate = { ...other, files: [...other.files, other.files[0]!] };
    expect(inspectComputerUsePrivacySurfaces(duplicate).surfaces[0]!.state).toBe('unavailable');
    const huge = {
      ...other,
      payloads: [
        ...other.payloads,
        { kind: 'screenshot' as const, bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
      ],
    };
    expect(
      inspectComputerUsePrivacySurfaces(huge).surfaces.every(
        ({ state }) => state === 'unavailable',
      ),
    ).toBe(true);
  });
});
