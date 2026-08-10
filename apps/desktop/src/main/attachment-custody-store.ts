import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ImageAttachmentMimeType } from '@sprint-coder/contracts';
import { digestCanonical } from './context-compiler';
import { secureWindowsPath, verifyWindowsPathAcl } from './windows-acl';

const ROOT_MARKER = '.sprint-coder-attachment-custody.json';
const TURN_MARKER = '.turn.json';
const ROOT_MARKER_MAX_BYTES = 512;
const TURN_MARKER_MAX_BYTES = 2_048;
const TURN_DIRECTORY_PATTERN = /^turn-[a-f0-9-]{36}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type CustodyAttachmentInput = Readonly<{
  id: string;
  mimeType: ImageAttachmentMimeType;
  byteLength: number;
  sha256: string;
  bytes: Buffer;
}>;

export type CustodyManifestEntry = Readonly<{
  id: string;
  mimeType: ImageAttachmentMimeType;
  byteLength: number;
  sha256: string;
}>;

export type AttachmentCustodyLease = Readonly<{
  turnId: string;
  operationId: string;
  manifest: readonly CustodyManifestEntry[];
  manifestDigest: string;
  paths: readonly string[];
}>;

type OwnedLease = {
  publicLease: AttachmentCustodyLease;
  directoryPath: string;
  directoryIdentity: DirectoryIdentity;
  handles: FileHandle[];
  releasePromise?: Promise<void>;
};
type DirectoryIdentity = Readonly<{ dev: number; ino: number }>;
type AttachmentCustodyStoreOptions = Readonly<{
  afterMarkerStat?: (() => void | Promise<void>) | undefined;
  beforePrepareCommit?: (() => void | Promise<void>) | undefined;
  beforeRelease?: (() => void | Promise<void>) | undefined;
  beforeScavengeRemove?: (() => void | Promise<void>) | undefined;
}>;

type RootMarker = Readonly<{ version: 1; installationNonce: string }>;
type TurnMarker = Readonly<{
  version: 1;
  installationNonce: string;
  turnId: string;
  operationId: string;
  manifestDigest: string;
}>;

export class AttachmentCustodyStore {
  private installationNonce: string | null = null;
  private rootIdentity: DirectoryIdentity | null = null;
  private readonly leases = new Map<string, OwnedLease>();
  private readonly preparingTurnIds = new Set<string>();
  private readonly preparingOperationIds = new Set<string>();
  private readonly releasedLeases = new WeakSet<object>();
  private initializationPromise: Promise<void> | null = null;
  private initialized = false;

  constructor(
    private readonly rootPath: string,
    private readonly options: AttachmentCustodyStoreOptions = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializationPromise === null) {
      const initialize = (async () => {
        await this.initializeRoot();
        await this.scavengeValidatedChildren();
        this.initialized = true;
      })();
      this.initializationPromise = initialize.catch((error: unknown) => {
        this.initializationPromise = null;
        throw error;
      });
    }
    await this.initializationPromise;
  }

  async prepare(input: {
    turnId: string;
    operationId?: string;
    attachments: readonly CustodyAttachmentInput[];
  }): Promise<AttachmentCustodyLease> {
    await this.initialize();
    if (input.attachments.length < 1 || input.attachments.length > 4)
      throw new AttachmentCustodyError('invalid_manifest');
    if (!INTERNAL_ID_PATTERN.test(input.turnId))
      throw new AttachmentCustodyError('invalid_manifest');
    if (
      this.preparingTurnIds.has(input.turnId) ||
      [...this.leases.values()].some(({ publicLease }) => publicLease.turnId === input.turnId)
    )
      throw new AttachmentCustodyError('already_prepared');
    const operationId = input.operationId ?? randomUUID();
    if (!INTERNAL_ID_PATTERN.test(operationId))
      throw new AttachmentCustodyError('invalid_manifest');
    if (this.preparingOperationIds.has(operationId) || this.leases.has(operationId))
      throw new AttachmentCustodyError('already_prepared');
    const manifest = input.attachments.map(validateCustodyAttachment);
    if (manifest.reduce((sum, entry) => sum + entry.byteLength, 0) > 16 * 1024 * 1024)
      throw new AttachmentCustodyError('invalid_manifest');
    const manifestDigest = digestCanonical(manifest);
    const directoryPath = join(this.rootPath, `turn-${randomUUID()}`);
    const handles: FileHandle[] = [];
    let directoryIdentity: DirectoryIdentity | null = null;
    this.preparingTurnIds.add(input.turnId);
    this.preparingOperationIds.add(operationId);
    try {
      await this.assertRootIdentity();
      await mkdir(directoryPath, { mode: 0o700 });
      await secureWindowsPath(directoryPath, 'directory');
      directoryIdentity = await readPrivateDirectoryIdentity(directoryPath);
      const marker: TurnMarker = {
        version: 1,
        installationNonce: this.requiredInstallationNonce(),
        turnId: input.turnId,
        operationId,
        manifestDigest,
      };
      await writeExclusiveFile(join(directoryPath, TURN_MARKER), encodeJson(marker), 0o600);
      const paths: string[] = [];
      for (const [index, attachment] of input.attachments.entries()) {
        const path = join(
          directoryPath,
          `${String(index + 1).padStart(3, '0')}${extensionFor(attachment.mimeType)}`,
        );
        await writeExclusiveFile(path, attachment.bytes, 0o600);
        await chmod(path, 0o400);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!(await verifyMaterializedAttachment(handle, attachment))) {
          await handle.close();
          throw new AttachmentCustodyError('materialization_mismatch');
        }
        handles.push(handle);
        paths.push(path);
      }
      await chmod(join(directoryPath, TURN_MARKER), 0o400);
      await syncDirectory(directoryPath);
      await chmod(directoryPath, 0o500);
      await this.options.beforePrepareCommit?.();
      await this.assertRootIdentity();
      await assertDirectoryIdentity(directoryPath, directoryIdentity);
      const publicLease = Object.freeze({
        turnId: input.turnId,
        operationId,
        manifest: Object.freeze(manifest),
        manifestDigest,
        paths: Object.freeze(paths),
      });
      this.leases.set(operationId, {
        publicLease,
        directoryPath,
        directoryIdentity,
        handles,
      });
      return publicLease;
    } catch (error) {
      await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
      if (directoryIdentity !== null)
        await this.removeOwnedDirectory(directoryPath, directoryIdentity).catch(() => undefined);
      throw error;
    } finally {
      this.preparingTurnIds.delete(input.turnId);
      this.preparingOperationIds.delete(operationId);
    }
  }

  async release(lease: AttachmentCustodyLease): Promise<boolean> {
    const owned = this.leases.get(lease.operationId);
    if (owned === undefined)
      return typeof lease === 'object' && lease !== null && this.releasedLeases.has(lease);
    if (owned.publicLease !== lease) return false;
    if (owned.releasePromise === undefined) {
      owned.releasePromise = (async () => {
        await Promise.all(owned.handles.map((handle) => handle.close().catch(() => undefined)));
        await this.options.beforeRelease?.();
        await this.removeOwnedDirectory(owned.directoryPath, owned.directoryIdentity);
        this.releasedLeases.add(owned.publicLease);
        if (this.leases.get(lease.operationId) === owned) this.leases.delete(lease.operationId);
      })().catch((error: unknown) => {
        delete owned.releasePromise;
        throw error;
      });
    }
    await owned.releasePromise;
    return true;
  }

  async dispose(): Promise<void> {
    for (const lease of [...this.leases.values()].map(({ publicLease }) => publicLease))
      await this.release(lease).catch(() => undefined);
  }

  private async initializeRoot(): Promise<void> {
    const absoluteRoot = resolve(this.rootPath);
    if (absoluteRoot !== this.rootPath) throw new AttachmentCustodyError('unsafe_root');
    let created = false;
    try {
      await mkdir(this.rootPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created) await secureWindowsPath(this.rootPath, 'directory');
    const rootIdentity = await readPrivateDirectoryIdentity(this.rootPath);
    const markerPath = join(this.rootPath, ROOT_MARKER);
    if (created) {
      await this.createRootMarker(markerPath, rootIdentity);
      return;
    }
    let marker: RootMarker;
    try {
      marker = parseRootMarker(
        await readBoundedNoFollow(markerPath, ROOT_MARKER_MAX_BYTES, this.options.afterMarkerStat),
      );
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
        (await readdir(this.rootPath)).length !== 0
      )
        throw error;
      await this.createRootMarker(markerPath, rootIdentity);
      return;
    }
    await assertDirectoryIdentity(this.rootPath, rootIdentity);
    this.installationNonce = marker.installationNonce;
    this.rootIdentity = rootIdentity;
  }

  private async createRootMarker(
    markerPath: string,
    rootIdentity: DirectoryIdentity,
  ): Promise<void> {
    const marker: RootMarker = {
      version: 1,
      installationNonce: randomBytes(32).toString('hex'),
    };
    await writeExclusiveFile(markerPath, encodeJson(marker), 0o600);
    await syncDirectory(this.rootPath);
    await assertDirectoryIdentity(this.rootPath, rootIdentity);
    this.installationNonce = marker.installationNonce;
    this.rootIdentity = rootIdentity;
  }

  private async scavengeValidatedChildren(): Promise<void> {
    await this.assertRootIdentity();
    const entries = (await readdir(this.rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && TURN_DIRECTORY_PATTERN.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 128);
    for (const entry of entries) {
      const directoryPath = join(this.rootPath, entry.name);
      let directoryIdentity: DirectoryIdentity;
      try {
        directoryIdentity = await readPrivateDirectoryIdentity(directoryPath);
      } catch {
        continue;
      }
      let marker: TurnMarker;
      try {
        marker = parseTurnMarker(
          await readBoundedNoFollow(
            join(directoryPath, TURN_MARKER),
            TURN_MARKER_MAX_BYTES,
            this.options.afterMarkerStat,
          ),
        );
      } catch {
        continue;
      }
      if (marker.installationNonce !== this.requiredInstallationNonce()) continue;
      await this.options.beforeScavengeRemove?.();
      await this.removeOwnedDirectory(directoryPath, directoryIdentity);
    }
  }

  private requiredInstallationNonce(): string {
    if (this.installationNonce === null) throw new AttachmentCustodyError('unsafe_root');
    return this.installationNonce;
  }

  private async assertRootIdentity(): Promise<void> {
    if (this.rootIdentity === null) throw new AttachmentCustodyError('unsafe_root');
    await assertDirectoryIdentity(this.rootPath, this.rootIdentity);
  }

  private async removeOwnedDirectory(
    directoryPath: string,
    directoryIdentity: DirectoryIdentity,
  ): Promise<void> {
    await this.assertRootIdentity();
    const current = await tryReadPrivateDirectoryIdentity(directoryPath);
    if (current === null) return;
    if (!sameDirectoryIdentity(current, directoryIdentity))
      throw new AttachmentCustodyError('unsafe_root');
    await chmod(directoryPath, 0o700);
    await this.assertRootIdentity();
    await assertDirectoryIdentity(directoryPath, directoryIdentity);
    await rm(directoryPath, { recursive: true, force: true });
  }
}

export class AttachmentCustodyError extends Error {
  constructor(
    readonly reason:
      'unsafe_root' | 'invalid_manifest' | 'already_prepared' | 'materialization_mismatch',
  ) {
    super(reason);
  }
}

function validateCustodyAttachment(input: CustodyAttachmentInput): CustodyManifestEntry {
  if (
    !INTERNAL_ID_PATTERN.test(input.id) ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    input.byteLength > 5 * 1024 * 1024 ||
    input.bytes.byteLength !== input.byteLength ||
    !SHA256_PATTERN.test(input.sha256) ||
    createHash('sha256').update(input.bytes).digest('hex') !== input.sha256
  )
    throw new AttachmentCustodyError('invalid_manifest');
  return Object.freeze({
    id: input.id,
    mimeType: input.mimeType,
    byteLength: input.byteLength,
    sha256: input.sha256,
  });
}

async function writeExclusiveFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await secureWindowsPath(path, 'file');
}

async function readBoundedNoFollow(
  path: string,
  maxBytes: number,
  afterStat?: (() => void | Promise<void>) | undefined,
): Promise<Buffer> {
  await verifyWindowsPathAcl(path, 'file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0) ||
      before.size < 1 ||
      before.size > maxBytes
    )
      throw new AttachmentCustodyError('unsafe_root');
    await afterStat?.();
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const result = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      total < 1 ||
      total > maxBytes ||
      total !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new AttachmentCustodyError('unsafe_root');
    return Buffer.from(bytes.subarray(0, total));
  } finally {
    await handle.close();
  }
}

async function verifyMaterializedAttachment(
  handle: FileHandle,
  attachment: CustodyAttachmentInput,
): Promise<boolean> {
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.size !== attachment.byteLength) return false;
  const bytes = Buffer.allocUnsafe(attachment.byteLength + 1);
  let total = 0;
  while (total < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, total, bytes.byteLength - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  const after = await handle.stat();
  return (
    total === attachment.byteLength &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs &&
    createHash('sha256').update(bytes.subarray(0, total)).digest('hex') === attachment.sha256
  );
}

async function readPrivateDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  )
    throw new AttachmentCustodyError('unsafe_root');
  await verifyWindowsPathAcl(path, 'directory');
  return { dev: stat.dev, ino: stat.ino };
}

async function tryReadPrivateDirectoryIdentity(path: string): Promise<DirectoryIdentity | null> {
  try {
    return await readPrivateDirectoryIdentity(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const actual = await readPrivateDirectoryIdentity(path);
  if (!sameDirectoryIdentity(actual, expected)) throw new AttachmentCustodyError('unsafe_root');
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function encodeJson(value: RootMarker | TurnMarker): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function parseRootMarker(bytes: Buffer): RootMarker {
  const value = parseRecord(bytes);
  if (
    value['version'] !== 1 ||
    typeof value['installationNonce'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['installationNonce']) ||
    Object.keys(value).some((key) => !['version', 'installationNonce'].includes(key))
  )
    throw new AttachmentCustodyError('unsafe_root');
  return { version: 1, installationNonce: value['installationNonce'] };
}

function parseTurnMarker(bytes: Buffer): TurnMarker {
  const value = parseRecord(bytes);
  if (
    value['version'] !== 1 ||
    typeof value['installationNonce'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value['installationNonce']) ||
    typeof value['turnId'] !== 'string' ||
    value['turnId'].length < 1 ||
    value['turnId'].length > 128 ||
    typeof value['operationId'] !== 'string' ||
    value['operationId'].length < 1 ||
    value['operationId'].length > 128 ||
    typeof value['manifestDigest'] !== 'string' ||
    !SHA256_PATTERN.test(value['manifestDigest']) ||
    Object.keys(value).some(
      (key) =>
        !['version', 'installationNonce', 'turnId', 'operationId', 'manifestDigest'].includes(key),
    )
  )
    throw new AttachmentCustodyError('unsafe_root');
  return {
    version: 1,
    installationNonce: value['installationNonce'],
    turnId: value['turnId'],
    operationId: value['operationId'],
    manifestDigest: value['manifestDigest'],
  };
}

function parseRecord(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AttachmentCustodyError('unsafe_root');
  return value as Record<string, unknown>;
}

function extensionFor(mimeType: ImageAttachmentMimeType): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  return '.webp';
}
