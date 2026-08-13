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
  interpreter?: SealedExecutableIdentity;
}>;

export type PreparedExecutionImage = Readonly<{
  launchPath: string;
  argvPrefix: readonly string[];
  descriptors: readonly number[];
  digest: string;
  identity: string;
  close(): Promise<void>;
}>;

export function sealedExecutableIdentityDigest(identity: SealedExecutableIdentity): string {
  return sha256(
    Buffer.from(
      JSON.stringify([
        'sealed-executable-identity-v1',
        identity.canonicalPath,
        identity.dev,
        identity.ino,
        identity.size,
        identity.mtimeNs,
        identity.ctimeNs,
        identity.mode,
        identity.digest,
        identity.interpreter === undefined
          ? null
          : sealedExecutableIdentityDigest(identity.interpreter),
      ]),
      'utf8',
    ),
  );
}

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
  let interpreter: PreparedExecutionImage | undefined;
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
    const hasRelativeElfLoaderPath = containsUnsafeElfLoaderPath(heldBytes);
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
    if ((shebang === undefined) !== (expected.interpreter === undefined))
      throw new Error('Shebang interpreter identity changed');
    interpreter =
      shebang === undefined ? undefined : await prepareExecutionImage(expected.interpreter!, false);
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
    const canonicalInterpreter = expected.interpreter?.canonicalPath;
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
    await interpreter?.close().catch(() => undefined);
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

export function containsUnsafeElfLoaderPath(bytes: Buffer): boolean {
  const paths = parseElfDynamicSearchPaths(bytes);
  return paths === null || paths.length > 0;
}

/** Parse DT_RPATH/DT_RUNPATH through PT_DYNAMIC. Any malformed ELF fails closed. */
function parseElfDynamicSearchPaths(bytes: Buffer): readonly string[] | null {
  if (
    bytes.length < 64 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[5] !== 1
  )
    return null;
  const elfClass = bytes[4];
  if (elfClass !== 1 && elfClass !== 2) return null;
  const is64 = elfClass === 2;
  const readWord = (offset: number): number | null => {
    if (offset < 0 || offset > bytes.length - (is64 ? 8 : 4)) return null;
    const value = is64 ? bytes.readBigUInt64LE(offset) : BigInt(bytes.readUInt32LE(offset));
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  };
  const phoff = readWord(is64 ? 32 : 28);
  if (phoff === null) return null;
  const phentsize = bytes.readUInt16LE(is64 ? 54 : 42);
  const phnum = bytes.readUInt16LE(is64 ? 56 : 44);
  if (phentsize < (is64 ? 56 : 32) || phnum > 4096) return null;
  const loads: Array<{ offset: number; vaddr: number; filesz: number }> = [];
  let dynamic: { offset: number; size: number } | undefined;
  for (let index = 0; index < phnum; index += 1) {
    const header = phoff + index * phentsize;
    if (header < 0 || header > bytes.length - phentsize) return null;
    const type = bytes.readUInt32LE(header);
    const offset = readWord(header + (is64 ? 8 : 4));
    const vaddr = readWord(header + (is64 ? 16 : 8));
    const filesz = readWord(header + (is64 ? 32 : 16));
    if (offset === null || vaddr === null || filesz === null || offset + filesz > bytes.length)
      return null;
    if (type === 1) loads.push({ offset, vaddr, filesz });
    if (type === 2) dynamic = { offset, size: filesz };
  }
  if (dynamic === undefined) return Object.freeze([]);
  const entrySize = is64 ? 16 : 8;
  let stringTableAddress: number | undefined;
  let stringTableSize: number | undefined;
  const searchOffsets: number[] = [];
  let terminated = false;
  for (
    let offset = dynamic.offset;
    offset + entrySize <= dynamic.offset + dynamic.size;
    offset += entrySize
  ) {
    const tag = readWord(offset);
    const value = readWord(offset + (is64 ? 8 : 4));
    if (tag === null || value === null) return null;
    if (tag === 0) {
      terminated = true;
      break;
    }
    if (tag === 5) stringTableAddress = value;
    else if (tag === 10) stringTableSize = value;
    else if (tag === 15 || tag === 29) searchOffsets.push(value);
  }
  if (!terminated) return null;
  if (searchOffsets.length === 0) return Object.freeze([]);
  if (stringTableAddress === undefined || stringTableSize === undefined) return null;
  const mapping = loads.find(
    (load) =>
      stringTableAddress! >= load.vaddr &&
      stringTableAddress! - load.vaddr <= load.filesz &&
      stringTableSize! <= load.filesz - (stringTableAddress! - load.vaddr),
  );
  if (mapping === undefined) return null;
  const stringTable = mapping.offset + (stringTableAddress - mapping.vaddr);
  const paths: string[] = [];
  for (const relativeOffset of searchOffsets) {
    if (relativeOffset >= stringTableSize) return null;
    const start = stringTable + relativeOffset;
    const endLimit = stringTable + stringTableSize;
    const end = bytes.indexOf(0, start);
    if (end < start || end >= endLimit) return null;
    const value = bytes.subarray(start, end).toString('utf8');
    if (value.length > 0) paths.push(value);
  }
  return Object.freeze(paths);
}

const WINDOWS_SYSTEM_DLL =
  /^(?:api-ms-win-|ext-ms-win-)|^(?:advapi32|avrt|bcrypt|cfgmgr32|combase|comctl32|comdlg32|crypt32|cryptbase|cryptnet|cryptui|d3d11|d3d12|dbgcore|dbghelp|dcomp|dhcpcsvc|dhcpcsvc6|dnsapi|dsound|dwmapi|dwrite|dxgi|gdi32|hid|iertutil|imm32|iphlpapi|kernel32|mf|mfplat|mfreadwrite|msacm32|msvcp140|msvfw32|mswsock|ncrypt|netapi32|normaliz|ntasn1|ntdll|ole32|oleacc|oleaut32|powrprof|profapi|propsys|psapi|rpcrt4|secur32|setupapi|shcore|shell32|shlwapi|srvcli|ucrtbase|urlmon|user32|userenv|usp10|uxtheme|vcruntime140(?:_1)?|version|winhttp|wininet|winmm|wintrust|wlanapi|wldp|ws2_32|wtsapi32)\.dll$/iu;

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
        // A source DLL may be hardlinked by a package manager. That alias is harmless here: the
        // native read pins one handle, and only those exact bytes are materialized into the held
        // app-owned execution directory before CreateProcess.
        const bytes = windowsAddon().readNoReparseImageFile(sourcePath, true);
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
  if (directory < optional || directory + 14 * 8 > optional + optionalSize) return null;
  const importRva = bytes.readUInt32LE(directory + 8);
  const importSize = bytes.readUInt32LE(directory + 12);
  const delayRva = bytes.readUInt32LE(directory + 13 * 8);
  const delaySize = bytes.readUInt32LE(directory + 13 * 8 + 4);
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
  const imports: string[] = [];
  const parseTable = (
    rva: number,
    size: number,
    stride: number,
    nameField: number,
    delay: boolean,
  ): boolean => {
    if (rva === 0 && size === 0) return true;
    if (rva === 0 || size < stride || size > 1024 * stride) return false;
    const table = rvaToOffset(rva);
    if (table === null) return false;
    for (let offset = table; offset + stride <= bytes.length; offset += stride) {
      const nameRva = bytes.readUInt32LE(offset + nameField);
      if (bytes.subarray(offset, offset + stride).every((value) => value === 0)) return true;
      // Delay descriptors with grAttrs bit 0 clear contain process VAs, which cannot be mapped
      // safely without loading the image. Fail closed instead of guessing.
      if (delay && (bytes.readUInt32LE(offset) & 1) === 0) return false;
      const nameOffset = rvaToOffset(nameRva);
      if (nameOffset === null) return false;
      const end = bytes.indexOf(0, nameOffset);
      if (end < 0 || end - nameOffset > 260) return false;
      imports.push(bytes.subarray(nameOffset, end).toString('ascii').toLowerCase());
      if (imports.length > 1024) return false;
    }
    return false;
  };
  if (
    !parseTable(importRva, importSize, 20, 12, false) ||
    !parseTable(delayRva, delaySize, 32, 4, true)
  ) {
    return null;
  }
  return Object.freeze(imports);
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

export async function sealExecutablePath(
  path: string,
  allowHardlinks = false,
  allowScript = true,
): Promise<SealedExecutableIdentity> {
  const canonicalPath = await realpath(path);
  if (canonicalPath.split('/').at(-1) === 'env')
    throw new Error('Dynamic shebang interpreters are unsupported');
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) throw new Error('O_NOFOLLOW is unavailable');
  const source = await open(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || (before.nlink !== 1n && !allowHardlinks))
      throw new Error('Shebang interpreter is not a unique regular file');
    const bytes = await source.readFile();
    const after = await source.stat({ bigint: true });
    if (!sameStats(before, after)) throw new Error('Shebang interpreter changed');
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_EXECUTION_IMAGE_BYTES)
      throw new Error('Shebang interpreter exceeds the size limit');
    const shebang = process.platform === 'win32' || !allowScript ? undefined : parseShebang(bytes);
    const interpreter =
      shebang === undefined ? undefined : await sealExecutablePath(shebang.path, false, false);
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
      allowSourceHardlinks: allowHardlinks,
      ...(interpreter === undefined ? {} : { interpreter }),
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
