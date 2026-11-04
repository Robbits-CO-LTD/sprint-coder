import { computerUseNativeManifestSchema } from '@sprint-coder/contracts';
import { createHash } from 'node:crypto';
import type { ForgeMakeResult } from '@electron-forge/shared-types';
import { open, type Entry, type ZipFile } from 'yauzl';

const ADDON = 'sprint_coder_computer_use_windows_main.node';
const NATIVE_MANIFEST = 'computer-use-native.manifest.json';
const RUNNER = 'sprint-coder-sandbox-runner.exe';

/** Inspect sealed bytes without extracting executable artifacts or trusting archive paths. */
export function verifyWindowsSandboxArchive(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let archive: ZipFile | undefined;
    let actual: string | undefined;
    let expected: string | undefined;
    let runnerPath: string | undefined;
    let manifestPath: string | undefined;
    let addonPath: string | undefined;
    let nativeManifestPath: string | undefined;
    let addonDigest: string | undefined;
    let expectedAddonDigest: string | undefined;
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
        else if (
          addonDigest === undefined ||
          addonDigest !== expectedAddonDigest ||
          addonPath !== runnerPath?.replace(RUNNER, ADDON) ||
          nativeManifestPath !== runnerPath?.replace(RUNNER, NATIVE_MANIFEST)
        )
          fail();
        else resolve(actual);
      });
      opened.on('entry', (entry: Entry) => {
        // Windows treats casing variants as the same extracted helper or sibling seal.
        const name = entry.fileName.replaceAll('\\', '/').toLowerCase();
        const isRunner = name.endsWith(`/resources/${RUNNER}`) || name === `resources/${RUNNER}`;
        const isManifest =
          name.endsWith(`/resources/${RUNNER}.sha256`) || name === `resources/${RUNNER}.sha256`;
        const isAddon = name.endsWith(`/resources/${ADDON}`) || name === `resources/${ADDON}`;
        const isNativeManifest =
          name.endsWith(`/resources/${NATIVE_MANIFEST}`) || name === `resources/${NATIVE_MANIFEST}`;
        const limit = isManifest ? 128 : isNativeManifest ? 64 * 1024 : 64 * 1024 * 1024;
        if (!isRunner && !isManifest && !isAddon && !isNativeManifest) {
          opened.readEntry();
          return;
        }
        if (
          (isRunner && runnerPath !== undefined) ||
          (isManifest && manifestPath !== undefined) ||
          (isAddon && addonPath !== undefined) ||
          (isNativeManifest && nativeManifestPath !== undefined) ||
          entry.uncompressedSize > limit
        ) {
          fail();
          return;
        }
        if (isRunner) runnerPath = name;
        else if (isManifest) manifestPath = name;
        else if (isAddon) addonPath = name;
        else nativeManifestPath = name;
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
            if (bytes > limit) {
              stream.destroy();
              fail();
              return;
            }
            if (isRunner || isAddon) hash.update(chunk);
            else chunks.push(chunk);
          });
          stream.on('end', () => {
            if (isRunner) actual = hash.digest('hex');
            else if (isAddon) addonDigest = hash.digest('hex');
            else if (isNativeManifest) {
              try {
                const manifest = computerUseNativeManifestSchema.parse(
                  JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
                );
                if (manifest.platform !== 'win32' || manifest.windowsMainAddon === undefined) {
                  fail();
                  return;
                }
                expectedAddonDigest = manifest.windowsMainAddon.sha256;
              } catch {
                fail();
                return;
              }
            } else {
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
