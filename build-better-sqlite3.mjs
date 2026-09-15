import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  nativeBuildNetworkDiagnostics,
  sanitizedNativeBuildEnvironment,
} from './native-build-environment.mjs';
const require = createRequire(import.meta.url);
const electronVersion = JSON.parse(
  readFileSync(require.resolve('electron/package.json'), 'utf8'),
).version;
const sqliteRoot = dirname(require.resolve('better-sqlite3/package.json'));
const childEnvironment = sanitizedNativeBuildEnvironment(process.env);
// v13 includes prebuilds and makes node-gyp a no-op unless force_build is set. Distributables
// keep using a freshly compiled addon at the existing, explicitly packaged build path.
const result = spawnSync(
  process.execPath,
  [
    require.resolve('@electron/node-gyp/bin/node-gyp.js'),
    'rebuild',
    '--directory',
    sqliteRoot,
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
    '--dist-url=https://electronjs.org/headers',
    '--force_build=1',
    '--loglevel=error',
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnvironment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
  },
);
if (result.error || result.status !== 0) {
  // Compiler output can contain its environment. Never relay raw child diagnostics. The summary
  // below names only fixed, non-secret network variables, so the most common non-compiler failure
  // (a header download with no reachable proxy) is diagnosable without echoing a single value.
  const status = result.error ? 1 : (result.status ?? 1);
  process.stderr.write(`SQLite source build failed (exit ${status})\n`);
  process.stderr.write(`${nativeBuildNetworkDiagnostics(process.env)}\n`);
  process.exit(status);
}
const binding = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(binding)) throw new Error('SQLite source build produced no native addon');
const probe = spawnSync(
  require('electron'),
  [
    '-e',
    `const Database=require(${JSON.stringify(sqliteRoot)}); const db=new Database(':memory:',{nativeBinding:${JSON.stringify(binding)}}); if(db.prepare('SELECT 1 AS value').get().value!==1) throw new Error('SQLite native probe failed'); db.close();`,
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...childEnvironment, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  },
);
const probeStatus = probe.error ? 1 : (probe.status ?? 1);
if (probeStatus !== 0)
  process.stderr.write(`SQLite Electron ABI probe failed (exit ${probeStatus})\n`);
process.exitCode = probeStatus;
