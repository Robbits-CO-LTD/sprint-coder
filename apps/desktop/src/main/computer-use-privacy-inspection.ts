import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectComputerUseStoredValues } from './computer-use-privacy-decoders';

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
type InspectionState =
  | 'raw_bytes_scanned'
  | 'logical_values_scanned'
  | 'decoded_bytes_scanned'
  | 'contaminated'
  | 'unavailable';

const MAX_ENUMERATED_FILES = 4096;
const MAX_ENUMERATED_DEPTH = 32;

/**
 * `O_NOFOLLOW` and `O_NONBLOCK` are absent from Windows' fs.constants, where `undefined` would
 * silently collapse to a plain `O_RDONLY` open. Resolving them explicitly keeps the POSIX
 * guarantee visible and makes the Windows gap a stated one rather than a silent regression.
 */
function openFlag(name: 'O_NOFOLLOW' | 'O_NONBLOCK'): number {
  const value = (constants as Partial<Record<string, number>>)[name];
  return typeof value === 'number' ? value : 0;
}

/**
 * Walks the roots the caller claims are the run's complete persistence surface and returns the
 * real path of every regular file found. A symlink, a non-regular entry, an unreadable directory,
 * a claim outside `root`, or a tree beyond the bounds returns `undefined`: an incomplete walk is
 * never reported as a verified inventory. Paths are compared here and never leave this module.
 *
 * `root` itself must be claimed. Otherwise a caller could name one tidy subdirectory, match it
 * exactly, and leave every sibling sink under `root` unenumerated but apparently accounted for.
 */
function enumerateClaimedFiles(
  root: string,
  claimedRoots: readonly string[],
): Set<string> | undefined {
  const pending: { path: string; depth: number }[] = [];
  let rootClaimed = false;
  for (const claimed of claimedRoots) {
    let resolved: string;
    try {
      if (typeof claimed !== 'string' || !isAbsolute(claimed)) return undefined;
      resolved = realpathSync(claimed);
    } catch {
      return undefined;
    }
    const child = relative(root, resolved);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined;
    if (child === '') rootClaimed = true;
    pending.push({ path: resolved, depth: 0 });
  }
  if (!rootClaimed) return undefined;
  const found = new Set<string>();
  while (pending.length > 0) {
    const directory = pending.pop()!;
    if (directory.depth > MAX_ENUMERATED_DEPTH) return undefined;
    let entries;
    try {
      entries = readdirSync(directory.path, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const path = join(directory.path, entry.name);
      if (entry.isDirectory()) {
        pending.push({ path, depth: directory.depth + 1 });
        continue;
      }
      // A symlink, socket, FIFO or device could alias or hide a sink this scan cannot read.
      if (!entry.isFile() || found.size >= MAX_ENUMERATED_FILES) return undefined;
      found.add(path);
    }
  }
  return found;
}

/**
 * True only when the files the caller submitted for inspection are exactly the files that exist
 * under the claimed roots. The claim itself proves nothing: an empty, wrong or partial claim
 * simply fails to match the measured tree.
 */
function verifyCompleteSurfaceInventory(
  root: string,
  files: readonly Readonly<{ surface: Surface; path: string }>[],
  claimedRoots: readonly string[] | undefined,
): boolean {
  if (claimedRoots === undefined) return false;
  const enumerated = enumerateClaimedFiles(root, claimedRoots);
  if (enumerated === undefined) return false;
  const submitted = new Set<string>();
  for (const file of files) {
    if (typeof file.path !== 'string' || !isAbsolute(file.path)) return false;
    submitted.add(resolve(file.path));
  }
  if (submitted.size !== enumerated.size) return false;
  for (const path of submitted) if (!enumerated.has(path)) return false;
  return true;
}

/**
 * A protected, local acceptance runner supplies exact files after flushing/closing the tested
 * process, plus transient payloads from that run. No paths, bodies, exceptions, or secret hashes
 * escape. This scans explicit files only.
 *
 * Absence is never cleanliness. A surface nobody submitted, a file that could not be read, and a
 * payload class the run never generated all report as uninspected, and none of them is a pass:
 * `finalGateEligible` is derived solely from measurement — every payload class present, every
 * surface actually scanned, nothing contaminated, and the submitted files proven to be the whole
 * tree under `enumeratedRoots`. No caller flag or boolean can set it.
 */
export async function inspectComputerUsePrivacySurfaces(
  input: Readonly<{
    root: string;
    files: readonly Readonly<{ surface: Surface; path: string }>[];
    payloads: readonly Readonly<{ kind: Payload; bytes: Uint8Array }>[];
    /** Roots the caller claims hold every persistence sink of the run; each is walked and compared. */
    enumeratedRoots?: readonly string[];
  }>,
) {
  const surfaces = COMPUTER_USE_PRIVACY_SURFACES.map((surface) => ({
    surface,
    state: 'unavailable' as InspectionState,
    logicalValuesInspected: false,
    decodedBytes: 0,
    valuesScanned: 0,
    filesInspected: 0,
    bytesInspected: 0,
    contentDigests: [] as string[],
    matchedKinds: [] as Payload[],
  }));
  const missingPayloadKinds = COMPUTER_USE_PRIVATE_PAYLOADS.filter(
    (kind) => !input.payloads.some((payload) => payload.kind === kind && payload.bytes.length > 0),
  );
  let root: string | undefined;
  try {
    root = realpathSync(input.root);
  } catch {
    root = undefined;
  }
  // Measured independently of the scan: it constrains eligibility but can never grant it.
  const completeSurfaceInventoryVerified =
    root !== undefined && verifyCompleteSurfaceInventory(root, input.files, input.enumeratedRoots);
  const report = () => {
    const uninspectedSurfaces = surfaces
      .filter(({ state }) => state === 'unavailable')
      .map(({ surface }) => surface);
    const contaminatedSurfaces = surfaces
      .filter(({ state }) => state === 'contaminated')
      .map(({ surface }) => surface);
    return {
      schemaVersion: 2 as const,
      evidenceKind: 'privacy-surface-inspection-only' as const,
      // Every conjunct is a measurement. Losing any one of them keeps this false.
      finalGateEligible:
        missingPayloadKinds.length === 0 &&
        completeSurfaceInventoryVerified &&
        uninspectedSurfaces.length === 0 &&
        contaminatedSurfaces.length === 0,
      completeSurfaceInventoryVerified,
      /** Payload classes the run never produced. Their absence proves nothing about any surface. */
      missingPayloadKinds,
      /** Surfaces whose bytes were never searched. Not a clean result — an unknown one. */
      uninspectedSurfaces,
      contaminatedSurfaces,
      surfaces,
    };
  };
  // Nothing below the scan may inherit a state by default: say "unavailable" explicitly so an
  // un-run inspection can never be read as a surface that was searched and found clean.
  const unscanned = () => {
    for (const result of surfaces) {
      result.state = 'unavailable';
      result.logicalValuesInspected = false;
    }
    return report();
  };
  if (missingPayloadKinds.length > 0 || input.files.length > 128 || input.payloads.length > 32)
    return unscanned();
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
    return unscanned();
  if (input.payloads.reduce((sum, { bytes }) => sum + bytes.length, 0) > 16 * 1024 * 1024)
    return unscanned();
  if (root === undefined) return unscanned();
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
    let totalDecodedBytes = 0;
    const seen = new Set<string>();
    for (const result of surfaces) {
      const files = input.files.filter(({ surface }) => surface === result.surface);
      if (files.length === 0) continue;
      let unavailable = false;
      let logicalFiles = 0;
      let decodedFiles = 0;
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
          // Reject a link by its own metadata, not only by the realpath comparison above: on
          // Windows the O_NOFOLLOW below is not available to enforce it at open time.
          // Identity is read as bigint stats throughout: plain stats report dev/ino as 0 on
          // Windows, which would silently disable the pinning below.
          const entry = lstatSync(path, { bigint: true });
          if (entry.isSymbolicLink() || !entry.isFile()) throw new Error();
          fd = openSync(path, constants.O_RDONLY | openFlag('O_NOFOLLOW') | openFlag('O_NONBLOCK'));
          const opened = fstatSync(fd, { bigint: true });
          // Pin the descriptor to the entry that was just stat-ed, closing the window between
          // realpath/lstat and open. POSIX identifies an entry by dev+ino, and Windows reports
          // the volume serial and file index here. If a platform still yields no identity at
          // all, refuse the file rather than inspecting one we cannot prove we opened.
          if (
            (entry.dev === 0n && entry.ino === 0n) ||
            entry.dev !== opened.dev ||
            entry.ino !== opened.ino
          )
            throw new Error();
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
          const decoded = await inspectComputerUseStoredValues(path, fileBytes, (value) => {
            totalDecodedBytes += value.byteLength;
            if (totalDecodedBytes > 64 * 1024 * 1024) throw new Error('decoded_total_limit');
            for (const needle of needles) {
              if (value.includes(needle.bytes) && !result.matchedKinds.includes(needle.kind))
                result.matchedKinds.push(needle.kind);
            }
          });
          result.decodedBytes += decoded.decodedBytes;
          result.valuesScanned += decoded.valuesScanned;
          // Incomplete now includes a raw-looking container the decoder could not open.
          if (!decoded.complete) unavailable = true;
          if (decoded.complete && decoded.kind === 'sqlite') logicalFiles += 1;
          if (decoded.complete && (decoded.kind === 'gzip' || decoded.kind === 'zip'))
            decodedFiles += 1;
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
            : logicalFiles === files.length
              ? 'logical_values_scanned'
              : decodedFiles === files.length
                ? 'decoded_bytes_scanned'
                : 'raw_bytes_scanned';
      result.logicalValuesInspected = !unavailable && logicalFiles === files.length;
    }
    return report();
  } finally {
    for (const needle of needles) needle.bytes.fill(0);
  }
}
