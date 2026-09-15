import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  nativeBuildFailureDetail,
  nativeBuildNetworkDiagnostics,
  nativeBuildTimeoutMs,
  sanitizedNativeBuildEnvironment,
} from './native-build-environment.mjs';
const require = createRequire(import.meta.url);
const electronVersion = JSON.parse(
  readFileSync(require.resolve('electron/package.json'), 'utf8'),
).version;
const sqliteRoot = dirname(require.resolve('better-sqlite3/package.json'));
const childEnvironment = sanitizedNativeBuildEnvironment(process.env);
const buildTimeoutMs = nativeBuildTimeoutMs(process.env);
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
    // Nothing reads this output and it must never be relayed, so discard it at the file descriptor
    // instead of capturing it only to throw it away. That is the stronger boundary, and capturing
    // nothing also removes the maxBuffer ceiling that would otherwise abort a noisy but healthy
    // build with ENOBUFS.
    stdio: ['ignore', 'ignore', 'ignore'],
    env: childEnvironment,
    timeout: buildTimeoutMs,
  },
);
if (result.error || result.status !== 0) {
  // Compiler output can contain its environment. Never relay raw child diagnostics. The summary
  // below names only fixed, non-secret network variables, so the most common non-compiler failure
  // (a header download with no reachable proxy) is diagnosable without echoing a single value.
  const status = result.error ? 1 : (result.status ?? 1);
  process.stderr.write(
    `SQLite source build failed (exit ${status}, ${nativeBuildFailureDetail(result, buildTimeoutMs)})\n`,
  );
  process.stderr.write(`${nativeBuildNetworkDiagnostics(process.env)}\n`);
  // Leave through the normal exit path. On POSIX a pipe-backed stderr is asynchronous, so
  // process.exit() can abandon the two lines above — and they are now the only diagnostics a
  // failed build produces. Setting exitCode lets Node flush them first, as the probe already does.
  process.exitCode = status;
} else {
  const binding = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(binding)) throw new Error('SQLite source build produced no native addon');
  // Loading one in-memory database is a fixed, tiny amount of work, so this budget stays at the
  // value it has always had. It is named here only so a timeout can be reported as one.
  const probeTimeoutMs = 30_000;
  const probe = spawnSync(
    require('electron'),
    [
      '-e',
      `const Database=require(${JSON.stringify(sqliteRoot)}); const db=new Database(':memory:',{nativeBinding:${JSON.stringify(binding)}}); if(db.prepare('SELECT 1 AS value').get().value!==1) throw new Error('SQLite native probe failed'); db.close();`,
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...childEnvironment, ELECTRON_RUN_AS_NODE: '1' },
      timeout: probeTimeoutMs,
    },
  );
  const probeStatus = probe.error ? 1 : (probe.status ?? 1);
  if (probeStatus !== 0)
    process.stderr.write(
      `SQLite Electron ABI probe failed (exit ${probeStatus}, ${nativeBuildFailureDetail(probe, probeTimeoutMs)})\n`,
    );
  process.exitCode = probeStatus;
}
