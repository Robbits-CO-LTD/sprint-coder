import { createHash } from 'node:crypto';
import type { ForgeMakeResult } from '@electron-forge/shared-types';
import { open, type Entry, type ZipFile } from 'yauzl';

const RUNNER = 'sprint-coder-sandbox-runner.exe';

/** Inspect sealed bytes without extracting executable artifacts or trusting archive paths. */
export function verifyWindowsSandboxArchive(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let archive: ZipFile | undefined;
    let actual: string | undefined;
    let expected: string | undefined;
    let runnerPath: string | undefined;
    let manifestPath: string | undefined;
    const fail = (): void => {
      archive?.close();
      reject(new Error('Windows artifact sandbox runner digest verification failed'));
    };
    open(path, { lazyEntries: true }, (error, opened) => {
      if (error !== null || opened === undefined) {
        fail();
        return;
      }
      archive = opened;
      opened.on('error', fail);
      opened.on('end', () => {
        if (actual === undefined || actual !== expected || manifestPath !== `${runnerPath}.sha256`)
          fail();
        else resolve(actual);
      });
      opened.on('entry', (entry: Entry) => {
        // Windows treats casing variants as the same extracted helper or sibling seal.
        const name = entry.fileName.replaceAll('\\', '/').toLowerCase();
        const isRunner = name.endsWith(`/resources/${RUNNER}`) || name === `resources/${RUNNER}`;
        const isManifest =
          name.endsWith(`/resources/${RUNNER}.sha256`) || name === `resources/${RUNNER}.sha256`;
        if (!isRunner && !isManifest) {
          opened.readEntry();
          return;
        }
        if (
          (isRunner && runnerPath !== undefined) ||
          (isManifest && manifestPath !== undefined) ||
          entry.uncompressedSize > (isManifest ? 128 : 64 * 1024 * 1024)
        ) {
          fail();
          return;
        }
        if (isRunner) runnerPath = name;
        else manifestPath = name;
        opened.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            fail();
            return;
          }
          const hash = createHash('sha256');
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > (isManifest ? 128 : 64 * 1024 * 1024)) {
              stream.destroy();
              fail();
              return;
            }
            if (isRunner) hash.update(chunk);
            else chunks.push(chunk);
          });
          stream.on('end', () => {
            if (isRunner) actual = hash.digest('hex');
            else {
              expected = Buffer.concat(chunks).toString('utf8').trim();
              if (!/^[a-f0-9]{64}$/u.test(expected)) {
                fail();
                return;
              }
            }
            opened.readEntry();
          });
        });
      });
      opened.readEntry();
    });
  });
}

export async function verifyWindowsSandboxArtifacts(
  results: readonly ForgeMakeResult[],
): Promise<void> {
  const digests = new Map<string, string>();
  for (const result of results) {
    if (result.platform !== 'win32') continue;
    for (const path of result.artifacts) {
      if (!path.toLowerCase().endsWith('.zip') && !path.toLowerCase().endsWith('-full.nupkg'))
        continue;
      const digest = await verifyWindowsSandboxArchive(path);
      const previous = digests.get(result.arch);
      if (previous !== undefined && previous !== digest)
        throw new Error('Windows ZIP and Squirrel sandbox runner bytes differ');
      digests.set(result.arch, digest);
    }
  }
}
