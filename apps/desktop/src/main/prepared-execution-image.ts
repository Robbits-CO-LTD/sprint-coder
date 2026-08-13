import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { nativeSafeFsAddonPath } from './native-safe-fs';

export type SealedExecutableIdentity = Readonly<{
  canonicalPath: string;
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
  digest: string;
  allowSourceHardlinks?: boolean;
}>;

export type PreparedExecutionImage = Readonly<{
  launchPath: string;
  argvPrefix: readonly string[];
  descriptors: readonly number[];
  digest: string;
  identity: string;
  close(): Promise<void>;
}>;

type WindowsExecutionAddon = Readonly<{
  readNoReparseImageFile(path: string, allowHardlinks?: boolean): Buffer;
  holdPreparedExecutionImage(path: string): Readonly<{ id: string; bytes: Buffer }>;
  closePreparedExecutionImage(id: string): void;
}>;
type PosixExecutionAddon = Readonly<{
  prepareSealedExecutionImage(bytes: Buffer, mode: number): Readonly<{ id: string; fd: number }>;
  closeSealedExecutionImage(id: string): void;
}>;

const MAX_EXECUTION_IMAGE_BYTES = 512 * 1024 * 1024;

export async function prepareExecutionImage(
  expected: SealedExecutableIdentity,
  allowScript = true,
): Promise<PreparedExecutionImage> {
  const directory = await mkdtemp(join(tmpdir(), 'sprint-coder-execution-'));
  await chmod(directory, 0o700);
  const imageDirectory = join(directory, 'bin');
  await mkdir(imageDirectory, { mode: 0o700 });
  const destination = join(
    imageDirectory,
    `image-${randomUUID()}${extname(expected.canonicalPath)}`,
  );
  let held: FileHandle | undefined;
  let windowsId: string | undefined;
  const windowsDependencyIds: string[] = [];
  let sealedId: string | undefined;
  let sealedDescriptor: number | undefined;
  try {
    const sourceBytes =
      process.platform === 'win32'
        ? windowsAddon().readNoReparseImageFile(
            expected.canonicalPath,
            expected.allowSourceHardlinks === true,
          )
        : await readStablePosixImage(expected);
    assertDigestAndSize(sourceBytes, expected);
    await writeFile(destination, sourceBytes, { flag: 'wx', mode: expected.mode & 0o777 });
    await chmod(destination, expected.mode & 0o777);
    let heldBytes: Buffer;
    if (process.platform === 'win32') {
      const prepared = windowsAddon().holdPreparedExecutionImage(destination);
      windowsId = prepared.id;
      heldBytes = prepared.bytes;
    } else if (process.platform === 'linux') {
      const sealed = posixAddon().prepareSealedExecutionImage(sourceBytes, expected.mode & 0o777);
      sealedId = sealed.id;
      sealedDescriptor = sealed.fd;
      heldBytes = sourceBytes;
    } else {
      const noFollow = constants.O_NOFOLLOW;
      if (noFollow === undefined) throw new Error('O_NOFOLLOW is unavailable');
      held = await open(destination, constants.O_RDONLY | noFollow);
      const before = await held.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) throw new Error('Prepared image is not unique');
      const verifier = await open(destination, constants.O_RDONLY | noFollow);
      try {
        const verifiedBefore = await verifier.stat({ bigint: true });
        heldBytes = await verifier.readFile();
        const verifiedAfter = await verifier.stat({ bigint: true });
        if (!sameStats(before, verifiedBefore) || !sameStats(verifiedBefore, verifiedAfter))
          throw new Error('Prepared image changed while pinned');
      } finally {
        await verifier.close();
      }
    }
    assertDigestAndSize(heldBytes, expected);
    if (process.platform === 'win32')
      windowsDependencyIds.push(
        ...(await prepareWindowsSideBySideImages(
          expected.canonicalPath,
          imageDirectory,
          heldBytes,
        )),
      );
    const digest = sha256(heldBytes);
    const trustedMacPath =
      process.platform === 'darwin' && (await isRootOwnedSystemExecutable(expected.canonicalPath));
    // Linux exposes the sealed memfd through the Main process so descendants that reuse
    // process.execPath still resolve an immutable image. macOS has no equivalent and only permits
    // root-owned, non-writable system images (or descriptor-fed scripts) below.
    const descriptor = process.platform === 'linux' ? undefined : held?.fd;
    const baseLaunchPath =
      process.platform === 'linux'
        ? `/proc/${process.pid}/fd/${sealedDescriptor}`
        : trustedMacPath
          ? expected.canonicalPath
          : destination;
    const baseDescriptors = descriptor === undefined ? [] : [descriptor];
    const shebang =
      process.platform === 'win32' || (expected.mode & 0o111) === 0
        ? undefined
        : parseShebang(heldBytes);
    const hasRelativeMachOLoaderPath = containsRelativeMachOLoaderPath(heldBytes);
    const hasRelativeElfLoaderPath = containsRelativeElfLoaderPath(heldBytes);
    if (
      process.platform === 'darwin' &&
      shebang === undefined &&
      (!trustedMacPath || hasRelativeMachOLoaderPath)
    )
      throw new Error('macOS cannot safely launch this mutable native execution image');
    if (process.platform === 'linux' && shebang === undefined && hasRelativeElfLoaderPath)
      throw new Error('Linux cannot safely launch an image with a relative loader path');
    if (shebang !== undefined && !allowScript)
      throw new Error('Nested shebang interpreters are unsupported');
    const interpreter =
      shebang === undefined
        ? undefined
        : await prepareExecutionImage(await sealExecutablePath(shebang.path), false);
    const scriptArgument =
      shebang === undefined
        ? undefined
        : process.platform === 'linux'
          ? baseLaunchPath
          : `/dev/fd/${6 + interpreter!.descriptors.length}`;
    const descriptors =
      interpreter === undefined
        ? baseDescriptors
        : [...interpreter.descriptors, ...(descriptor === undefined ? [] : [descriptor])];
    const canonicalInterpreter = shebang === undefined ? undefined : await realpath(shebang.path);
    const shellScript =
      canonicalInterpreter !== undefined &&
      ['sh', 'bash', 'zsh'].includes(basename(canonicalInterpreter));
    return Object.freeze({
      launchPath: interpreter?.launchPath ?? baseLaunchPath,
      argvPrefix:
        interpreter === undefined
          ? Object.freeze([])
          : shellScript
            ? Object.freeze([
                ...shebang!.arguments,
                '-c',
                'sprint_coder_script=$1; shift; . "$sprint_coder_script"',
                expected.canonicalPath,
                scriptArgument!,
              ])
            : Object.freeze([...shebang!.arguments, scriptArgument!]),
      descriptors: Object.freeze(descriptors),
      digest,
      identity: sha256(
        Buffer.from(
          JSON.stringify([
            'prepared-execution-image-v2',
            digest,
            heldBytes.byteLength,
            interpreter?.identity ?? null,
          ]),
          'utf8',
        ),
      ),
      async close(): Promise<void> {
        try {
          await interpreter?.close();
        } finally {
          try {
            if (windowsId !== undefined) {
              windowsAddon().closePreparedExecutionImage(windowsId);
              windowsId = undefined;
            }
            for (const id of windowsDependencyIds.splice(0))
              windowsAddon().closePreparedExecutionImage(id);
            if (sealedId !== undefined) {
              posixAddon().closeSealedExecutionImage(sealedId);
              sealedId = undefined;
            }
            if (held !== undefined) {
              await held.close();
              held = undefined;
            }
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    });
  } catch (error) {
    if (windowsId !== undefined) windowsAddon().closePreparedExecutionImage(windowsId);
    for (const id of windowsDependencyIds.splice(0)) windowsAddon().closePreparedExecutionImage(id);
    if (sealedId !== undefined) posixAddon().closeSealedExecutionImage(sealedId);
    await held?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function containsRelativeMachOLoaderPath(bytes: Buffer): boolean {
  return ['@loader_path/', '@executable_path/', '@rpath/'].some((token) =>
    bytes.includes(Buffer.from(token, 'utf8')),
  );
}

export function containsRelativeElfLoaderPath(bytes: Buffer): boolean {
  return ['$ORIGIN', '${ORIGIN}'].some((token) => bytes.includes(Buffer.from(token, 'utf8')));
}

const WINDOWS_SYSTEM_DLL =
  /^(?:api-ms-win-|ext-ms-win-)|^(?:advapi32|bcrypt|comctl32|comdlg32|crypt32|dbghelp|dnsapi|gdi32|imm32|iphlpapi|kernel32|msvcp140|normaliz|ntdll|ole32|oleaut32|powrprof|psapi|rpcrt4|secur32|setupapi|shell32|shlwapi|ucrtbase|user32|userenv|vcruntime140(?:_1)?|version|winhttp|winmm|ws2_32)\.dll$/iu;

export function hasUnsafeWindowsDllImport(bytes: Buffer): boolean {
  const imports = parsePeImports(bytes);
  return imports === null || imports.some((name) => !WINDOWS_SYSTEM_DLL.test(name));
}

async function prepareWindowsSideBySideImages(
  executablePath: string,
  imageDirectory: string,
  executableBytes: Buffer,
): Promise<readonly string[]> {
  const sourceDirectory = dirname(executablePath);
  const queue: Buffer[] = [executableBytes];
  const copied = new Set<string>();
  const heldIds: string[] = [];
  let totalBytes = executableBytes.byteLength;
  try {
    while (queue.length > 0) {
      const imports = parsePeImports(queue.shift()!);
      if (imports === null)
        throw new Error('Windows execution image has an invalid PE import table');
      for (const name of imports) {
        if (WINDOWS_SYSTEM_DLL.test(name) || copied.has(name)) continue;
        if (basename(name).toLowerCase() !== name || !/^[a-z0-9_.-]+\.dll$/u.test(name))
          throw new Error('Windows execution image has an unsafe DLL import name');
        if (copied.size >= 128)
          throw new Error('Windows execution image exceeds the side-by-side DLL limit');
        const sourcePath = join(sourceDirectory, name);
        const bytes = windowsAddon().readNoReparseImageFile(sourcePath, false);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_EXECUTION_IMAGE_BYTES)
          throw new Error('Windows execution image dependencies exceed the size limit');
        const destination = join(imageDirectory, name);
        await writeFile(destination, bytes, { flag: 'wx' });
        const prepared = windowsAddon().holdPreparedExecutionImage(destination);
        if (!prepared.bytes.equals(bytes)) {
          windowsAddon().closePreparedExecutionImage(prepared.id);
          throw new Error('Windows side-by-side execution image changed while pinned');
        }
        copied.add(name);
        heldIds.push(prepared.id);
        queue.push(bytes);
      }
    }
    return Object.freeze(heldIds);
  } catch (error) {
    for (const id of heldIds) windowsAddon().closePreparedExecutionImage(id);
    throw error;
  }
}

function parsePeImports(bytes: Buffer): readonly string[] | null {
  if (bytes.length < 0x100 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x0000_4550) return null;
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  if (optionalSize < 112 || optional > bytes.length - optionalSize) return null;
  const magic = bytes.readUInt16LE(optional);
  const directory = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (directory < optional || directory > bytes.length - 16) return null;
  const importRva = bytes.readUInt32LE(directory + 8);
  const importSize = bytes.readUInt32LE(directory + 12);
  if (importRva === 0 && importSize === 0) return Object.freeze([]);
  const sections = optional + optionalSize;
  const rvaToOffset = (rva: number): number | null => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sections + index * 40;
      if (section > bytes.length - 40) return null;
      const virtualSize = bytes.readUInt32LE(section + 8);
      const virtualAddress = bytes.readUInt32LE(section + 12);
      const rawSize = bytes.readUInt32LE(section + 16);
      const rawAddress = bytes.readUInt32LE(section + 20);
      const span = Math.max(virtualSize, rawSize);
      if (rva >= virtualAddress && rva - virtualAddress < span) {
        const offset = rawAddress + (rva - virtualAddress);
        return offset < bytes.length ? offset : null;
      }
    }
    return null;
  };
  const table = rvaToOffset(importRva);
  if (table === null) return null;
  const imports: string[] = [];
  for (let offset = table; offset <= bytes.length - 20; offset += 20) {
    const nameRva = bytes.readUInt32LE(offset + 12);
    if (
      bytes.readUInt32LE(offset) === 0 &&
      bytes.readUInt32LE(offset + 4) === 0 &&
      bytes.readUInt32LE(offset + 8) === 0 &&
      nameRva === 0 &&
      bytes.readUInt32LE(offset + 16) === 0
    )
      return Object.freeze(imports);
    const nameOffset = rvaToOffset(nameRva);
    if (nameOffset === null) return null;
    const end = bytes.indexOf(0, nameOffset);
    if (end < 0 || end - nameOffset > 260) return null;
    imports.push(bytes.subarray(nameOffset, end).toString('ascii').toLowerCase());
    if (imports.length > 1024) return null;
  }
  return null;
}

function parseShebang(
  bytes: Buffer,
): Readonly<{ path: string; arguments: readonly string[] }> | undefined {
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return undefined;
  const newline = bytes.indexOf(0x0a, 2);
  if (newline < 0 || newline > 4096) throw new Error('Invalid shebang');
  const line = bytes.subarray(2, newline).toString('utf8').trim();
  const fields = line.split(/\s+/u);
  const path = fields.shift();
  if (
    path === undefined ||
    !path.startsWith('/') ||
    path.split('/').at(-1) === 'env' ||
    fields.length > 1
  )
    throw new Error('Unsupported shebang interpreter');
  return Object.freeze({ path, arguments: Object.freeze(fields) });
}

async function sealExecutablePath(path: string): Promise<SealedExecutableIdentity> {
  const canonicalPath = await realpath(path);
  if (canonicalPath.split('/').at(-1) === 'env')
    throw new Error('Dynamic shebang interpreters are unsupported');
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) throw new Error('O_NOFOLLOW is unavailable');
  const source = await open(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n)
      throw new Error('Shebang interpreter is not a unique regular file');
    const bytes = await source.readFile();
    const after = await source.stat({ bigint: true });
    if (!sameStats(before, after)) throw new Error('Shebang interpreter changed');
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_EXECUTION_IMAGE_BYTES)
      throw new Error('Shebang interpreter exceeds the size limit');
    return Object.freeze({
      canonicalPath,
      dev: String(before.dev),
      ino: String(before.ino),
      size: Number(before.size),
      mtimeMs: Number(before.mtimeNs) / 1_000_000,
      ctimeMs: Number(before.ctimeNs) / 1_000_000,
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
      mode: Number(before.mode),
      digest: sha256(bytes),
    });
  } finally {
    await source.close();
  }
}

async function isRootOwnedSystemExecutable(path: string): Promise<boolean> {
  const systemPrefixes = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/System/'];
  if (!systemPrefixes.some((prefix) => path.startsWith(prefix))) return false;
  let current = path;
  for (;;) {
    try {
      const stats = await stat(current, { bigint: true });
      if (stats.uid !== 0n || (stats.mode & 0o22n) !== 0n) return false;
    } catch {
      return false;
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

async function readStablePosixImage(expected: SealedExecutableIdentity): Promise<Buffer> {
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) throw new Error('O_NOFOLLOW is unavailable');
  const source = await open(expected.canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const before = await source.stat({ bigint: true });
    assertExpectedStats(before, expected);
    const bytes = await source.readFile();
    const after = await source.stat({ bigint: true });
    if (!sameStats(before, after)) throw new Error('Executable changed while pinned');
    return bytes;
  } finally {
    await source.close();
  }
}

function assertExpectedStats(stats: BigIntStats, expected: SealedExecutableIdentity): void {
  if (
    !stats.isFile() ||
    stats.nlink !== 1n ||
    String(stats.dev) !== expected.dev ||
    String(stats.ino) !== expected.ino ||
    Number(stats.size) !== expected.size ||
    String(stats.mtimeNs) !== expected.mtimeNs ||
    String(stats.ctimeNs) !== expected.ctimeNs ||
    Number(stats.mode) !== expected.mode
  )
    throw new Error('Executable identity changed');
}

function sameStats(first: BigIntStats, second: BigIntStats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs &&
    first.mode === second.mode &&
    first.nlink === second.nlink &&
    second.nlink === 1n
  );
}

function assertDigestAndSize(bytes: Buffer, expected: SealedExecutableIdentity): void {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_EXECUTION_IMAGE_BYTES ||
    bytes.byteLength !== expected.size ||
    sha256(bytes) !== expected.digest
  )
    throw new Error('Executable bytes changed');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let loadedWindowsAddon: WindowsExecutionAddon | undefined;
function windowsAddon(): WindowsExecutionAddon {
  if (loadedWindowsAddon !== undefined) return loadedWindowsAddon;
  const require = createRequire(join(__dirname, 'prepared-execution-image-loader.cjs'));
  const candidate = require(nativeSafeFsAddonPath()) as Partial<WindowsExecutionAddon>;
  if (
    typeof candidate.readNoReparseImageFile !== 'function' ||
    typeof candidate.holdPreparedExecutionImage !== 'function' ||
    typeof candidate.closePreparedExecutionImage !== 'function'
  )
    throw new Error('Prepared execution native boundary is unavailable');
  loadedWindowsAddon = candidate as WindowsExecutionAddon;
  return loadedWindowsAddon;
}

let loadedPosixAddon: PosixExecutionAddon | undefined;
function posixAddon(): PosixExecutionAddon {
  if (loadedPosixAddon !== undefined) return loadedPosixAddon;
  const require = createRequire(join(__dirname, 'prepared-execution-image-loader.cjs'));
  const candidate = require(nativeSafeFsAddonPath()) as Partial<PosixExecutionAddon>;
  if (
    typeof candidate.prepareSealedExecutionImage !== 'function' ||
    typeof candidate.closeSealedExecutionImage !== 'function'
  )
    throw new Error('Sealed execution image native boundary is unavailable');
  loadedPosixAddon = candidate as PosixExecutionAddon;
  return loadedPosixAddon;
}
