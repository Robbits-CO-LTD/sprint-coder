import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { redactSecrets } from './secret-redactor';

const MAX_ARTIFACT_BYTES = 1024 * 1024;
const artifactIdPattern = /^[a-f0-9]{64}$/;
const rootQueues = new Map<string, Promise<void>>();

export type EditArtifactRole = 'preimage' | 'postimage' | 'recovery';
export type EditArtifactOwner = Readonly<{
  sagaId: string;
  ordinal: number;
  role: EditArtifactRole;
}>;
export type EditArtifactRef = Readonly<{
  version: 1;
  artifactId: string;
  owner: EditArtifactOwner;
  contentHash: string;
  size: number;
  containsSecrets: boolean;
}>;

export type EditArtifactErrorCode =
  | 'INVALID_REQUEST'
  | 'QUOTA_EXCEEDED'
  | 'ARTIFACT_NOT_FOUND'
  | 'INTEGRITY_MISMATCH'
  | 'UNSAFE_ARTIFACT';

export class EditArtifactError extends Error {
  constructor(
    readonly code: EditArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EditArtifactError';
  }
}

export class EditArtifactStore {
  private constructor(
    private readonly rootPath: string,
    private readonly quotaBytes: number,
  ) {}

  static async open(input: { rootPath: string; quotaBytes: number }): Promise<EditArtifactStore> {
    if (!Number.isSafeInteger(input.quotaBytes) || input.quotaBytes < 1)
      throw new EditArtifactError('INVALID_REQUEST', 'Artifact quota must be a positive integer');
    await mkdir(input.rootPath, { recursive: true, mode: 0o700 });
    const lexical = await lstat(input.rootPath);
    if (!lexical.isDirectory() || lexical.isSymbolicLink())
      throw new EditArtifactError('UNSAFE_ARTIFACT', 'Artifact root must be a real directory');
    await chmod(input.rootPath, 0o700);
    const rootPath = await realpath(input.rootPath);
    const store = new EditArtifactStore(rootPath, input.quotaBytes);
    await store.removeOwnedTemps();
    return store;
  }

  put(input: { owner: EditArtifactOwner; bytes: Buffer }): Promise<EditArtifactRef> {
    const queue = rootQueues.get(this.rootPath) ?? Promise.resolve();
    const run = queue.then(() => this.putExclusive(input));
    rootQueues.set(
      this.rootPath,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async release(reference: EditArtifactRef): Promise<void> {
    validateEditArtifactReference(reference);
    const queue = rootQueues.get(this.rootPath) ?? Promise.resolve();
    const run = queue.then(async () => {
      await Promise.all(
        [`${reference.artifactId}.bin`, `${reference.artifactId}.json`].map((name) =>
          unlinkIfExists(join(this.rootPath, name)),
        ),
      );
      await this.syncDirectory();
    });
    rootQueues.set(
      this.rootPath,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    await run;
  }

  async read(reference: EditArtifactRef): Promise<Buffer> {
    validateEditArtifactReference(reference);
    const manifest = await this.readManifest(reference.artifactId);
    if (!sameReference(manifest, reference))
      throw new EditArtifactError(
        'INTEGRITY_MISMATCH',
        'Artifact manifest does not match reference',
      );
    const handle = await this.openSafeFile(`${reference.artifactId}.bin`);
    try {
      const before = await handle.stat();
      assertSafeArtifactStats(before.mode, before.nlink, before.isFile());
      const bytes = await handle.readFile();
      const after = await handle.stat();
      assertSafeArtifactStats(after.mode, after.nlink, after.isFile());
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        bytes.byteLength !== reference.size ||
        digest(bytes) !== reference.contentHash
      )
        throw new EditArtifactError('INTEGRITY_MISMATCH', 'Artifact content integrity failed');
      return bytes;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async putExclusive(input: {
    owner: EditArtifactOwner;
    bytes: Buffer;
  }): Promise<EditArtifactRef> {
    validateOwner(input.owner);
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES)
      throw new EditArtifactError('INVALID_REQUEST', 'Artifact exceeds the per-file limit');
    const reference = createEditArtifactReference(input.owner, input.bytes);
    const artifactId = reference.artifactId;
    try {
      const existing = await this.read(reference);
      if (existing.equals(input.bytes)) return reference;
    } catch (error) {
      if (!(error instanceof EditArtifactError) || error.code !== 'ARTIFACT_NOT_FOUND') throw error;
    }
    const manifestBytes = Buffer.from(JSON.stringify(reference), 'utf8');
    const used = await this.usedBytes();
    if (used + Math.max(1, input.bytes.byteLength) + manifestBytes.byteLength > this.quotaBytes)
      throw new EditArtifactError('QUOTA_EXCEEDED', 'Edit artifact quota exceeded');
    const contentTemp = `.tmp-${artifactId}.bin`;
    const manifestTemp = `.tmp-${artifactId}.json`;
    const contentFinal = `${artifactId}.bin`;
    const manifestFinal = `${artifactId}.json`;
    try {
      await this.writeExclusive(contentTemp, input.bytes);
      await this.writeExclusive(manifestTemp, manifestBytes);
      await rename(join(this.rootPath, contentTemp), join(this.rootPath, contentFinal));
      await rename(join(this.rootPath, manifestTemp), join(this.rootPath, manifestFinal));
      await this.syncDirectory();
      return reference;
    } catch (error) {
      await Promise.all(
        [contentTemp, manifestTemp, contentFinal, manifestFinal].map((name) =>
          unlink(join(this.rootPath, name)).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  private async readManifest(artifactId: string): Promise<EditArtifactRef> {
    const handle = await this.openSafeFile(`${artifactId}.json`);
    try {
      const stats = await handle.stat();
      assertSafeArtifactStats(stats.mode, stats.nlink, stats.isFile());
      if (stats.size > 4_096)
        throw new EditArtifactError('INTEGRITY_MISMATCH', 'Artifact manifest is oversized');
      let parsed: unknown;
      try {
        parsed = JSON.parse((await handle.readFile()).toString('utf8'));
      } catch {
        throw new EditArtifactError('INTEGRITY_MISMATCH', 'Artifact manifest is invalid');
      }
      validateEditArtifactReference(parsed);
      return parsed;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async openSafeFile(name: string): Promise<FileHandle> {
    try {
      return await open(join(this.rootPath, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new EditArtifactError('ARTIFACT_NOT_FOUND', 'Edit artifact is unavailable');
    }
  }

  private async writeExclusive(name: string, bytes: Buffer): Promise<void> {
    const handle = await open(
      join(this.rootPath, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async usedBytes(): Promise<number> {
    let total = 0;
    for (const name of await readdir(this.rootPath)) {
      if (!/^[a-f0-9]{64}\.(bin|json)$/.test(name)) continue;
      const item = await stat(join(this.rootPath, name));
      if (item.isFile()) total += Math.max(1, item.size);
    }
    return total;
  }

  private async removeOwnedTemps(): Promise<void> {
    for (const name of await readdir(this.rootPath)) {
      if (!/^\.tmp-[a-f0-9]{64}\.(bin|json)$/.test(name)) continue;
      await unlink(join(this.rootPath, name)).catch(() => undefined);
    }
    const names = new Set(await readdir(this.rootPath));
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.(bin|json)$/.exec(name);
      if (match === null) continue;
      const id = match[1]!;
      if (!names.has(`${id}.bin`) || !names.has(`${id}.json`))
        await Promise.all(
          [`${id}.bin`, `${id}.json`].map((item) =>
            unlink(join(this.rootPath, item)).catch(() => undefined),
          ),
        );
    }
    await this.syncDirectory();
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.rootPath, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export function createEditArtifactReference(
  owner: EditArtifactOwner,
  bytes: Buffer,
): EditArtifactRef {
  validateOwner(owner);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES)
    throw new EditArtifactError('INVALID_REQUEST', 'Artifact exceeds the per-file limit');
  const contentHash = digest(bytes);
  const artifactId = digest(Buffer.from(JSON.stringify({ owner, contentHash }), 'utf8'));
  const text = bytes.toString('utf8');
  return Object.freeze({
    version: 1,
    artifactId,
    owner: Object.freeze({ ...owner }),
    contentHash,
    size: bytes.byteLength,
    containsSecrets: redactSecrets(text) !== text,
  });
}

export function validateEditArtifactReference(value: unknown): asserts value is EditArtifactRef {
  if (typeof value !== 'object' || value === null) throw invalidReference();
  const record = value as Record<string, unknown>;
  const owner = record['owner'];
  if (
    record['version'] !== 1 ||
    typeof record['artifactId'] !== 'string' ||
    !artifactIdPattern.test(record['artifactId']) ||
    typeof record['contentHash'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record['contentHash']) ||
    !Number.isSafeInteger(record['size']) ||
    (record['size'] as number) < 0 ||
    (record['size'] as number) > MAX_ARTIFACT_BYTES ||
    typeof record['containsSecrets'] !== 'boolean' ||
    typeof owner !== 'object' ||
    owner === null
  )
    throw invalidReference();
  if (
    Object.keys(record).sort().join(',') !==
      'artifactId,containsSecrets,contentHash,owner,size,version' ||
    Object.keys(owner as Record<string, unknown>)
      .sort()
      .join(',') !== 'ordinal,role,sagaId'
  )
    throw invalidReference();
  validateOwner(owner as EditArtifactOwner);
}

function validateOwner(owner: EditArtifactOwner): void {
  if (
    typeof owner.sagaId !== 'string' ||
    owner.sagaId.length < 1 ||
    owner.sagaId.length > 200 ||
    !Number.isSafeInteger(owner.ordinal) ||
    owner.ordinal < 1 ||
    owner.ordinal > 100 ||
    !['preimage', 'postimage', 'recovery'].includes(owner.role)
  )
    throw invalidReference();
}

function sameReference(left: EditArtifactRef, right: EditArtifactRef): boolean {
  return (
    left.version === right.version &&
    left.artifactId === right.artifactId &&
    left.owner.sagaId === right.owner.sagaId &&
    left.owner.ordinal === right.owner.ordinal &&
    left.owner.role === right.owner.role &&
    left.contentHash === right.contentHash &&
    left.size === right.size &&
    left.containsSecrets === right.containsSecrets
  );
}

function assertSafeArtifactStats(mode: number, nlink: number, isFile: boolean): void {
  if (!isFile || nlink !== 1 || (mode & 0o022) !== 0)
    throw new EditArtifactError('UNSAFE_ARTIFACT', 'Artifact permissions or identity are unsafe');
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function invalidReference(): EditArtifactError {
  return new EditArtifactError('INVALID_REQUEST', 'Invalid Edit artifact reference');
}
