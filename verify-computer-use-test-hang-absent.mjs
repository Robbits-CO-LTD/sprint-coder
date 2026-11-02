import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDirectory = join(
  repositoryDirectory,
  'apps/desktop/computer-use-native/build/Release',
);
const marker = 'SPRINT_CODER_COMPUTER_USE_TEST_HANG_MARKER';
const helperName = 'sprint-coder-computer-use-host.exe';
const manifestName = 'computer-use-native.manifest.json';

function verifyDirectory(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), 'utf8'));
  if (manifest?.platform !== 'win32') throw new Error('manifest platform is not win32');
  const bytes = readFileSync(join(directory, helperName));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (manifest.binaryDigest !== digest) throw new Error('manifest digest does not match helper');
  if (bytes.includes(Buffer.from(marker)) || bytes.includes(Buffer.from(marker, 'utf16le')))
    throw new Error('test-hang marker found in helper');
}

function packagedResources(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name === 'resources') found.push(path);
    else found.push(...packagedResources(path));
  }
  return found;
}

/** Verify Release and, when --out is supplied, every packaged Windows resources directory. */
export function main(argv, platform = process.platform) {
  const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const required = argv.includes('--require');
  if (platform !== 'win32') {
    if (required) {
      console.error('[verify-test-hang] FAIL: platform outside Windows contract (--require)');
      return 1;
    }
    console.log('[verify-test-hang] SKIP: platform outside Windows contract');
    return 0;
  }
  const directory = resolve(option('dir') ?? defaultDirectory);
  const out = option('out');
  try {
    if (!existsSync(join(directory, manifestName))) {
      if (required || out !== undefined || existsSync(join(directory, helperName)))
        throw new Error('no built manifest');
      console.log('[verify-test-hang] SKIP: no built artifact');
      return 0;
    }
    verifyDirectory(directory);
    let packages = 0;
    if (out !== undefined) {
      const resources = packagedResources(resolve(out));
      if (resources.length === 0) throw new Error('no packaged resources directories');
      for (const resource of resources) verifyDirectory(resource);
      packages = resources.length;
    }
    console.log(
      `[verify-test-hang] OK: Release and ${packages} packages contain no test-hang marker`,
    );
    return 0;
  } catch (error) {
    console.error(`[verify-test-hang] FAIL: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
