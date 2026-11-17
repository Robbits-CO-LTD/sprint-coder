import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Builds the desktop-control executable from the source kept in apps/desktop/desktop-control
// (see VENDORED.md there). Build Windows x64 and macOS arm64. The app enables
// desktop control separately from building this executable. On macOS the CLI writes the
// clipboard through a helper executable of its own, built here too with the same profile and
// target, and placed beside the CLI under Sprint Coder's name (the CLI looks for it there by that
// name when it runs under Sprint Coder's name).
const macOS = process.platform === 'darwin' && process.arch === 'arm64';
if (!macOS && (process.platform !== 'win32' || process.arch !== 'x64')) {
  console.log(`desktop-control: nothing to build on ${process.platform}-${process.arch}`);
  process.exit(0);
}

// Cargo's names for the two binaries, and the names Sprint Coder ships them under.
const CLI_BIN = 'agent-desktop';
const MAC_HELPER_BIN = 'agent-desktop-macos-helper';
const SHIPPED_NAMES = macOS
  ? {
      [CLI_BIN]: 'sprint-coder-desktop-control',
      [MAC_HELPER_BIN]: 'sprint-coder-desktop-control-helper',
    }
  : { [CLI_BIN]: 'sprint-coder-desktop-control.exe' };

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
    ...(macOS
      ? [
          '-p',
          'agent-desktop',
          '-p',
          'agent-desktop-macos',
          '--bin',
          CLI_BIN,
          '--bin',
          MAC_HELPER_BIN,
        ]
      : []),
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

// Take each binary's path from Cargo's own report, by the binary's name: exactly one each of the
// expected binaries, and nothing else.
const executables = result.stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line))
  .filter((message) => message.reason === 'compiler-artifact' && message.executable);
const expected = Object.keys(SHIPPED_NAMES);
const unexpected = executables.filter((message) => !expected.includes(message.target?.name));
if (unexpected.length > 0)
  throw new Error(
    `desktop-control: unexpected built executable ${unexpected.map((message) => message.target?.name).join(', ')}`,
  );
const built = Object.fromEntries(
  expected.map((name) => {
    const found = executables.filter((message) => message.target?.name === name);
    if (found.length !== 1)
      throw new Error(
        `desktop-control: expected one built executable ${name}, found ${found.length}`,
      );
    return [name, found[0].executable];
  }),
);

const output = join(crate, 'build', 'Release');
mkdirSync(output, { recursive: true });
for (const name of expected) {
  const destination = join(output, SHIPPED_NAMES[name]);
  copyFileSync(built[name], destination);
  if (macOS) chmodSync(destination, 0o755);
  const bytes = readFileSync(destination);
  // On macOS the app starts the CLI from its own path only when its bytes hold no relative loader
  // path (prepared-execution-image.ts looks for these strings anywhere in the file, embedded
  // documentation included), so one here would make every run refused: fail the build instead.
  // The CLI starts the helper by its path beside it, so the helper is held to the same rule.
  if (macOS)
    for (const token of ['@loader_path/', '@executable_path/', '@rpath/'])
      if (bytes.includes(token))
        throw new Error(`desktop-control: the macOS executable ${name} contains "${token}"`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${destination}.sha256`, `${digest}\n`, { mode: 0o600 });
  console.log(`desktop-control: ${destination} ${digest}`);
}
