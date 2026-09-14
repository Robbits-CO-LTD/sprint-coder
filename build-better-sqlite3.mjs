import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const electronVersion = JSON.parse(
  readFileSync(require.resolve('electron/package.json'), 'utf8'),
).version;
const sqliteRoot = dirname(require.resolve('better-sqlite3/package.json'));
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
  ],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const binding = join(sqliteRoot, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(binding)) throw new Error('SQLite source build produced no native addon');
const probe = spawnSync(
  require('electron'),
  [
    '-e',
    `const Database=require(${JSON.stringify(sqliteRoot)}); const db=new Database(':memory:',{nativeBinding:${JSON.stringify(binding)}}); if(db.prepare('SELECT 1 AS value').get().value!==1) throw new Error('SQLite native probe failed'); db.close();`,
  ],
  { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 },
);
if (probe.error) throw probe.error;
process.exitCode = probe.status ?? 1;
