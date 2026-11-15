import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Builds the desktop-control executable from the source kept in apps/desktop/desktop-control
// (see VENDORED.md there). Build Windows x64 and macOS arm64. The app enables
// desktop control separately from building this executable.
const macOS = process.platform === 'darwin' && process.arch === 'arm64';
if (!macOS && (process.platform !== 'win32' || process.arch !== 'x64')) {
  console.log(`desktop-control: nothing to build on ${process.platform}-${process.arch}`);
  process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const crate = join(root, 'apps', 'desktop', 'desktop-control');
// Run from the crate so its own rust-toolchain.toml selects the compiler.
const result = spawnSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    // The default members include the Windows crate, which does not compile on macOS.
    ...(macOS ? ['-p', 'agent-desktop'] : []),
    '--manifest-path',
    join(crate, 'Cargo.toml'),
    '--message-format=json-render-diagnostics',
  ],
  {
    cwd: crate,
    env: process.env,
    stdio: ['inherit', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

// The selected packages build one binary: take its path from Cargo's own report.
const executables = result.stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line))
  .filter((message) => message.reason === 'compiler-artifact' && message.executable)
  .map((message) => message.executable);
if (executables.length !== 1)
  throw new Error(`desktop-control: expected one built executable, found ${executables.length}`);

const output = join(crate, 'build', 'Release');
mkdirSync(output, { recursive: true });
const destination = join(
  output,
  macOS ? 'sprint-coder-desktop-control' : 'sprint-coder-desktop-control.exe',
);
copyFileSync(executables[0], destination);
if (macOS) chmodSync(destination, 0o755);
const digest = createHash('sha256').update(readFileSync(destination)).digest('hex');
writeFileSync(`${destination}.sha256`, `${digest}\n`, { mode: 0o600 });
console.log(`desktop-control: ${destination} ${digest}`);
