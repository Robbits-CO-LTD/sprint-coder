export type BigIntFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

export class UnsafeFileSnapshotError extends Error {
  constructor(message = 'File snapshot is unsafe or changed') {
    super(message);
    this.name = 'UnsafeFileSnapshotError';
  }
}

export function assertStableSingleLinkFile(
  before: BigIntFileStat,
  opened: BigIntFileStat,
  after: BigIntFileStat,
  pathAfter: BigIntFileStat,
  bytes: Buffer,
): void {
  for (const observed of [before, opened, after, pathAfter])
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1n)
      throw new UnsafeFileSnapshotError();
  if (
    !sameIdentity(before, opened) ||
    !sameIdentity(opened, after) ||
    !sameIdentity(after, pathAfter) ||
    BigInt(bytes.byteLength) !== after.size
  )
    throw new UnsafeFileSnapshotError();
}

export function assertStableDirectoryIdentity(
  before: Pick<BigIntFileStat, 'dev' | 'ino'>,
  opened: Pick<BigIntFileStat, 'dev' | 'ino'>,
  after: Pick<BigIntFileStat, 'dev' | 'ino'>,
): void {
  if (
    before.dev !== opened.dev ||
    before.ino !== opened.ino ||
    opened.dev !== after.dev ||
    opened.ino !== after.ino
  )
    throw new UnsafeFileSnapshotError('Parent directory changed identity');
}

function sameIdentity(left: BigIntFileStat, right: BigIntFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink
  );
}
