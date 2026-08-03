import { applyWindowsAcl } from './native-file-publication';

export type WindowsAclPath = Readonly<{ path: string; kind: 'directory' | 'file' }>;
type AclOperation = 'secure' | 'verify';

const NATIVE_BATCH_SIZE = 32;
let aclQueue: Promise<void> = Promise.resolve();

export async function secureWindowsPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  await secureWindowsPaths([{ path, kind }]);
}

export async function secureWindowsPaths(paths: readonly WindowsAclPath[]): Promise<void> {
  await runAcl(paths, 'secure');
}

export async function verifyWindowsPathAcl(
  path: string,
  kind: 'directory' | 'file',
): Promise<void> {
  await verifyWindowsPaths([{ path, kind }]);
}

export async function verifyWindowsPaths(paths: readonly WindowsAclPath[]): Promise<void> {
  await runAcl(paths, 'verify');
}

async function runAcl(paths: readonly WindowsAclPath[], operation: AclOperation): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) return;
  const unique = [
    ...new Map(
      paths.map((item) => [`${item.kind}:${item.path.toLocaleLowerCase('en-US')}`, item]),
    ).values(),
  ];
  const work = aclQueue.then(async () => {
    for (let offset = 0; offset < unique.length; offset += NATIVE_BATCH_SIZE) {
      for (const item of unique.slice(offset, offset + NATIVE_BATCH_SIZE)) {
        applyWindowsAcl(item.path, item.kind, operation);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
  aclQueue = work.catch(() => undefined);
  await work;
}
