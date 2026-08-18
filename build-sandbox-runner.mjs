import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const crate = join(root, 'apps', 'desktop', 'sandbox-runner');
const result = spawnSync(
  'cargo',
  ['build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml')],
  {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const name =
  process.platform === 'win32' ? 'sprint-coder-sandbox-runner.exe' : 'sprint-coder-sandbox-runner';
const source = join(crate, 'target', 'release', name);
const output = join(crate, 'build', 'Release');
mkdirSync(output, { recursive: true });
const destination = join(output, name);
copyFileSync(source, destination);
const digest = createHash('sha256').update(readFileSync(destination)).digest('hex');
writeFileSync(`${destination}.sha256`, `${digest}\n`, { mode: 0o600 });
