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
import { dirname, extname, join } from 'node:path';
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
    const digest = sha256(heldBytes);
    const trustedMacPath =
      process.platform === 'darwin' && (await isRootOwnedSystemExecutable(expected.canonicalPath));
    // macOS has no fexecve/execveat equivalent and rejects executing an O_RDONLY
    // descriptor through /dev/fd. Launch the private prepared path there while
    // retaining the verified handle for the lifetime of the child. Linux can
    // execute the inherited descriptor directly through procfs.
    const descriptor = process.platform === 'win32' ? undefined : held?.fd;
    const baseLaunchPath =
      process.platform === 'linux'
        ? '/proc/self/fd/6'
        : trustedMacPath
          ? expected.canonicalPath
          : destination;
    const baseDescriptors = descriptor === undefined ? [] : [descriptor];
    const shebang =
      process.platform === 'win32' || (expected.mode & 0o111) === 0
        ? undefined
        : parseShebang(heldBytes);
    if (
      process.platform === 'darwin' &&
      shebang === undefined &&
      heldBytes.includes(Buffer.from('@loader_path/../lib', 'utf8'))
    )
      throw new Error('macOS loader-relative native execution images are unsupported');
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
          ? `/proc/self/fd/${6 + interpreter!.descriptors.length}`
          : `/dev/fd/${6 + interpreter!.descriptors.length}`;
    const descriptors =
      interpreter === undefined
        ? baseDescriptors
        : [...interpreter.descriptors, ...(descriptor === undefined ? [] : [descriptor])];
    const canonicalInterpreter = shebang === undefined ? undefined : await realpath(shebang.path);
    const shellScript =
      canonicalInterpreter !== undefined &&
      ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/sh', '/usr/bin/bash', '/usr/bin/zsh'].includes(
        canonicalInterpreter,
      );
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
    await held?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
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
