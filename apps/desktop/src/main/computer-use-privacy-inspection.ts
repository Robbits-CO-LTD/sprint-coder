import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const COMPUTER_USE_PRIVACY_SURFACES = [
  'database',
  'log',
  'telemetry',
  'provider_trace',
  'crash_artifact',
  'stdout',
  'stderr',
] as const;
export const COMPUTER_USE_PRIVATE_PAYLOADS = [
  'screenshot',
  'accessibility',
  'typed_text',
  'provider_response',
  'provider_reasoning',
  'secret',
] as const;
type Surface = (typeof COMPUTER_USE_PRIVACY_SURFACES)[number];
type Payload = (typeof COMPUTER_USE_PRIVATE_PAYLOADS)[number];
type InspectionState = 'raw_bytes_scanned' | 'contaminated' | 'unavailable';

/**
 * A protected, local acceptance runner supplies exact files after flushing/closing the tested
 * process, plus transient payloads from that run. No paths, bodies, exceptions, or secret hashes
 * escape. Missing surfaces/payload classes remain uninspected. This scans explicit files only:
 * it does not establish that the caller enumerated every sink or that a live file stayed quiet.
 */
export function inspectComputerUsePrivacySurfaces(
  input: Readonly<{
    root: string;
    files: readonly Readonly<{ surface: Surface; path: string }>[];
    payloads: readonly Readonly<{ kind: Payload; bytes: Uint8Array }>[];
  }>,
) {
  const surfaces = COMPUTER_USE_PRIVACY_SURFACES.map((surface) => ({
    surface,
    state: 'unavailable' as InspectionState,
    logicalValuesInspected: false as const,
    filesInspected: 0,
    bytesInspected: 0,
    contentDigests: [] as string[],
    matchedKinds: [] as Payload[],
  }));
  const missingPayloadKinds = COMPUTER_USE_PRIVATE_PAYLOADS.filter(
    (kind) => !input.payloads.some((payload) => payload.kind === kind && payload.bytes.length > 0),
  );
  const report = () => ({
    schemaVersion: 1 as const,
    evidenceKind: 'privacy-surface-inspection-only' as const,
    finalGateEligible: false as const,
    completeSurfaceInventoryVerified: false as const,
    missingPayloadKinds,
    surfaces,
  });
  if (missingPayloadKinds.length > 0 || input.files.length > 128 || input.payloads.length > 32)
    return report();
  // Limit the ephemeral search corpus. In particular a screen must not become an unbounded
  // buffer through caller-controlled size or repeated base64/JSON transformations.
  if (
    input.payloads.some(
      ({ bytes, kind }) =>
        bytes.length === 0 ||
        bytes.length > 8 * 1024 * 1024 ||
        !COMPUTER_USE_PRIVATE_PAYLOADS.includes(kind),
    )
  )
    return report();
  if (input.payloads.reduce((sum, { bytes }) => sum + bytes.length, 0) > 16 * 1024 * 1024)
    return report();
  let root: string;
  try {
    root = realpathSync(input.root);
  } catch {
    return report();
  }
  const needles: Array<{ kind: Payload; bytes: Buffer }> = [];
  try {
    for (const { kind, bytes } of input.payloads) {
      const raw = Buffer.from(bytes);
      needles.push({ kind, bytes: raw });
      // Screens may be binary, base64, or embedded in a JSON string. Text sinks can use
      // UTF-8/UTF-16LE or escaped JSON. Owned Buffers are cleared in finally; temporary JS
      // strings are only released for GC, so this does not guarantee complete memory erasure.
      const text = kind === 'screenshot' ? raw.toString('base64') : raw.toString('utf8');
      needles.push({ kind, bytes: Buffer.from(text) });
      needles.push({ kind, bytes: Buffer.from(text, 'utf16le') });
      needles.push({ kind, bytes: Buffer.from(JSON.stringify(text).slice(1, -1)) });
    }
    let totalBytes = 0;
    const seen = new Set<string>();
    for (const result of surfaces) {
      const files = input.files.filter(({ surface }) => surface === result.surface);
      if (files.length === 0) continue;
      let unavailable = false;
      for (const file of files) {
        let fd: number | undefined;
        let fileBytes: Buffer | undefined;
        try {
          const path = resolve(file.path);
          const child = relative(root, path);
          if (
            !isAbsolute(file.path) ||
            child === '' ||
            child === '..' ||
            child.startsWith(`..${sep}`) ||
            isAbsolute(child) ||
            realpathSync(path) !== path ||
            seen.has(path)
          )
            throw new Error();
          seen.add(path);
          fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const before = fstatSync(fd);
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size > 16 * 1024 * 1024 ||
            totalBytes + before.size > 64 * 1024 * 1024
          )
            throw new Error();
          // One bounded file buffer avoids copying a multi-MiB image overlap on every 64KiB read.
          fileBytes = Buffer.alloc(before.size);
          let bytesRead = 0;
          while (bytesRead < before.size) {
            const count = readSync(fd, fileBytes, bytesRead, before.size - bytesRead, null);
            if (count === 0) break;
            bytesRead += count;
            totalBytes += count;
            if (bytesRead > before.size || totalBytes > 64 * 1024 * 1024) throw new Error();
          }
          for (const needle of needles) {
            if (fileBytes.includes(needle.bytes) && !result.matchedKinds.includes(needle.kind))
              result.matchedKinds.push(needle.kind);
          }
          const after = fstatSync(fd);
          if (
            bytesRead !== before.size ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            throw new Error();
          result.filesInspected += 1;
          result.bytesInspected += bytesRead;
          result.contentDigests.push(createHash('sha256').update(fileBytes).digest('hex'));
        } catch {
          unavailable = true;
        } finally {
          fileBytes?.fill(0);
          if (fd !== undefined) {
            try {
              closeSync(fd);
            } catch {
              unavailable = true;
            }
          }
        }
      }
      result.state =
        result.matchedKinds.length > 0
          ? 'contaminated'
          : unavailable
            ? 'unavailable'
            : 'raw_bytes_scanned';
    }
    return report();
  } finally {
    for (const needle of needles) needle.bytes.fill(0);
  }
}
