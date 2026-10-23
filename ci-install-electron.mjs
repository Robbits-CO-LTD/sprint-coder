import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function electronCacheMetadata(root, environment = process.env) {
  const require = createRequire(resolve(root, 'package.json'));
  const { version } = require('electron/package.json');
  const platform =
    environment.ELECTRON_INSTALL_PLATFORM || environment.npm_config_platform || process.platform;
  let arch = environment.ELECTRON_INSTALL_ARCH || environment.npm_config_arch || process.arch;
  // Match Electron's Rosetta fallback so the cache key describes the downloaded ZIP.
  if (
    platform === 'darwin' &&
    process.platform === 'darwin' &&
    arch === 'x64' &&
    environment.npm_config_arch === undefined
  ) {
    try {
      if (
        execFileSync('sysctl', ['-in', 'sysctl.proc_translated'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === '1'
      )
        arch = 'arm64';
    } catch {
      // Native Intel macOS does not expose this sysctl.
    }
  }
  if (![version, platform, arch].every((value) => /^[a-zA-Z0-9._-]+$/u.test(value)))
    throw new Error('Invalid Electron cache identity');
  const checksums = createHash('sha256')
    .update(readFileSync(require.resolve('electron/checksums.json')))
    .digest('hex');
  const getRequire = createRequire(require.resolve('@electron/get/package.json'));
  // The install script and Forge/Packager must share @electron/get's default ZIP cache.
  const path = getRequire('env-paths')('electron', { suffix: '' }).cache;
  return { path, key: `electron-download-v1-${version}-${platform}-${arch}-${checksums}` };
}

export function electronInstallFailure(result) {
  if (result.signal) return { reason: 'signal', retry: false };
  if (result.error) return { reason: 'process-error', retry: false };
  const firstLine = (result.stderr ?? '').trim().split(/\r?\n/u)[0];
  const http = /^HTTPError: Response code (\d{3}) \(/u.exec(firstLine);
  if (http) {
    const status = Number(http[1]);
    return { reason: `HTTP-${status}`, retry: status === 429 || (status >= 500 && status <= 599) };
  }
  const network = /^RequestError: .*\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH)\b/u.exec(
    firstLine,
  );
  if (network) return { reason: network[1], retry: true };
  if (/^TimeoutError: Timeout awaiting /u.test(firstLine))
    return { reason: 'network-timeout', retry: true };
  return { reason: 'non-transient', retry: false };
}

export async function installElectron({
  root = process.cwd(),
  environment = process.env,
  run = spawnSync,
  wait = sleep,
  report = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const require = createRequire(resolve(root, 'package.json'));
  const installer = require.resolve('electron/install.js');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = run(process.execPath, [installer], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (!result.error && !result.signal && result.status === 0) return 0;
    const failure = electronInstallFailure(result);
    const retry = failure.retry && attempt < 3;
    // Installer errors can contain mirror/proxy credentials. Emit only classified metadata.
    report(
      `Electron install attempt ${attempt}/3 failed (${failure.reason}); ${retry ? 'retrying' : 'stopping'}.`,
    );
    if (!retry) return result.status || 1;
    await wait(2_000 * 2 ** (attempt - 1));
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'cache') {
    const metadata = electronCacheMetadata(process.cwd());
    process.stdout.write(`path=${metadata.path}\nkey=${metadata.key}\n`);
  } else if (process.argv.length === 2) {
    process.exitCode = await installElectron();
  } else {
    throw new Error('Unknown Electron install command');
  }
}
