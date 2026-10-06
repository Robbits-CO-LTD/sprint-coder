import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** @param {string} root */
export function dependencyCacheValid(root) {
  try {
    const modules = join(root, 'node_modules');
    if (!lstatSync(modules).isDirectory() || lstatSync(modules).isSymbolicLink()) return false;
    for (const [name, directory] of [
      ['contracts', 'packages/contracts'],
      ['domain', 'packages/domain'],
      ['desktop', 'apps/desktop'],
    ]) {
      const link = join(modules, '@sprint-coder', name);
      if (
        !lstatSync(link).isSymbolicLink() ||
        realpathSync(link) !== realpathSync(join(root, directory))
      )
        return false;
    }
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    return ['vitest', 'tsc'].every((name) => existsSync(join(modules, '.bin', `${name}${suffix}`)));
  } catch {
    return false;
  }
}

/** @param {string} root */
export function clearDependencyToolCaches(root) {
  for (const workspace of ['', 'apps/desktop', 'packages/contracts', 'packages/domain']) {
    const modules = join(root, workspace, 'node_modules');
    if (!existsSync(modules)) continue;
    if (!lstatSync(modules).isDirectory() || lstatSync(modules).isSymbolicLink())
      throw new Error('Unexpected CI dependency directory');
    for (const name of ['.vite', '.cache'])
      rmSync(join(modules, name), { recursive: true, force: true });
  }
}

/** @param {Record<string, string | undefined>} environment */
export function compilerCacheable(environment) {
  return !Object.keys(environment).some(
    (name) =>
      environment[name] &&
      (/^(RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER)$/u.test(name) ||
        /^CARGO_(ENCODED_RUSTFLAGS|BUILD_(TARGET|RUSTC.*|RUSTFLAGS)|PROFILE_RELEASE_|TARGET_)/u.test(
          name,
        )),
  );
}

/** @param {string} root @param {string} platform */
function sandboxPath(root, platform) {
  return join(
    root,
    'apps/desktop/sandbox-runner/build/Release',
    platform === 'win32' ? 'sprint-coder-sandbox-runner.exe' : 'sprint-coder-sandbox-runner',
  );
}

/** @param {string} root @param {string} [platform] */
export function sandboxCacheValid(root, platform = process.platform) {
  try {
    const executable = sandboxPath(root, platform);
    const binary = lstatSync(executable);
    if (!binary.isFile() || binary.isSymbolicLink()) return false;
    if (platform !== 'win32' && (binary.mode & 0o111) === 0) return false;
    const manifest = lstatSync(`${executable}.sha256`);
    if (!manifest.isFile() || manifest.isSymbolicLink()) return false;
    const expected = readFileSync(`${executable}.sha256`, 'utf8').trim();
    const actual = createHash('sha256').update(readFileSync(executable)).digest('hex');
    if (!/^[a-f0-9]{64}$/u.test(expected) || expected !== actual) return false;
    if (platform === 'win32') {
      const guard = join(
        root,
        'apps/desktop/sandbox-runner/build/Release/sandbox-node-pipe-guard.cjs',
      );
      if (!lstatSync(guard).isFile() || lstatSync(guard).isSymbolicLink()) return false;
      if (
        !readFileSync(guard).equals(
          readFileSync(join(root, 'apps/desktop/resources/sandbox-node-pipe-guard.cjs')),
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** @param {string} root @param {string} [platform] */
export function sandboxProbeValid(root, platform = process.platform) {
  try {
    const probe = spawnSync(sandboxPath(root, platform), ['--probe-json'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (probe.error || probe.status !== 0) return false;
    const response = JSON.parse(probe.stdout);
    return (
      response.protocolVersion === 1 &&
      typeof response.available === 'boolean' &&
      typeof response.backend === 'string' &&
      (response.reason === null || typeof response.reason === 'string')
    );
  } catch {
    return false;
  }
}

/** @param {string} root */
export function resetSandboxOutput(root) {
  for (const directory of ['apps/desktop/sandbox-runner', 'apps/desktop/sandbox-runner/build']) {
    const path = join(root, directory);
    if (existsSync(path) && lstatSync(path).isSymbolicLink())
      throw new Error('Unexpected CI sandbox build directory');
  }
  rmSync(join(root, 'apps/desktop/sandbox-runner/build/Release'), { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  switch (process.argv[2]) {
    case 'dependencies': {
      if (process.versions.node !== process.env.CI_NODE_VERSION)
        throw new Error('CI Node version does not match setup-node');
      const valid = dependencyCacheValid(root);
      if (valid) clearDependencyToolCaches(root);
      process.stdout.write(`valid=${valid}\n`);
      break;
    }
    case 'compiler': {
      const version = spawnSync('rustc', ['-vV'], { encoding: 'utf8', timeout: 10_000 });
      if (version.error || version.status !== 0) {
        // Compiler identity only authorizes cache reuse. The original Cargo build
        // remains authoritative when the optional probe is unavailable or slow.
        process.stdout.write('cacheable=false\n');
        break;
      }
      const digest = createHash('sha256').update(version.stdout).digest('hex');
      process.stdout.write(`digest=${digest}\ncacheable=${compilerCacheable(process.env)}\n`);
      break;
    }
    case 'check-sandbox':
      process.stdout.write(`valid=${sandboxCacheValid(root) && sandboxProbeValid(root)}\n`);
      break;
    case 'reset-sandbox':
      resetSandboxOutput(root);
      break;
    case 'assert-sandbox': {
      if (!sandboxCacheValid(root)) throw new Error('CI sandbox output validation failed');
      const executable = sandboxPath(root, process.platform);
      const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
      writeFileSync(`${executable}.sha256`, `${digest}\n`, { mode: 0o600 });
      if (!sandboxProbeValid(root)) throw new Error('CI sandbox executable probe failed');
      process.stdout.write('Sandbox digest and executable protocol validated.\n');
      break;
    }
    default:
      throw new Error('Unknown CI cache validation command');
  }
}
