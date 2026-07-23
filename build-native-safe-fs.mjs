import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve('electron/package.json', {
  paths: [join(repositoryDirectory, 'apps/desktop')],
});
const electronVersion = JSON.parse(readFileSync(electronPackagePath, 'utf8')).version;
const nodeGypPath = require.resolve('@electron/node-gyp/bin/node-gyp.js');
const forwardedEnvironmentNames = [
  'APPDATA',
  'CC',
  'CXX',
  'ComSpec',
  'DEVELOPER_DIR',
  'HOME',
  'LANG',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SDKROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
];
const buildEnvironment = { npm_config_loglevel: 'error' };
for (const name of forwardedEnvironmentNames) {
  if (process.env[name] !== undefined) buildEnvironment[name] = process.env[name];
}
const buildTestAddon = process.argv.slice(2).includes('--test');

const result = spawnSync(
  process.execPath,
  [
    nodeGypPath,
    'rebuild',
    '--directory',
    join(repositoryDirectory, 'apps/desktop/native-safe-fs'),
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
    '--loglevel=error',
    ...(buildTestAddon ? ['--vibe_test_hooks=1'] : []),
  ],
  { env: buildEnvironment, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
