import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Non-GUI compiler/contract evidence only. This never launches Sprint Coder or the native
// helper: the two executables below contain inert test seams, not OS input implementations.
const root = dirname(fileURLToPath(import.meta.url));
const native = join(root, 'apps', 'desktop', 'computer-use-native');
const output = join(native, 'build', 'offline');
const release = join(native, 'build', 'Release');
const windows = process.platform === 'win32';
if (!windows && process.platform !== 'darwin') throw new Error('Unsupported offline verifier host');
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Node 22 is required');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root });
const manifest = JSON.parse(
  readFileSync(join(release, 'computer-use-native.manifest.json'), 'utf8'),
);
const artifact = join(
  release,
  windows ? 'sprint-coder-computer-use-host.exe' : 'sprint_coder_computer_use_native.node',
);
const artifactSha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
if (
  manifest.sourceCommit !== sourceCommit ||
  manifest.platform !== process.platform ||
  manifest.apiVersion !== 2 ||
  manifest.protocolVersion !== 1 ||
  manifest.binaryDigest !== artifactSha256 ||
  manifest.moduleDigest !== artifactSha256
)
  throw new Error('Native manifest/source/artifact mismatch');
mkdirSync(output, { recursive: true });

const hostSource = readFileSync(join(native, 'computer_use_windows_host.cc'), 'utf8');
const from = hostSource.indexOf('UINT SendInputForBoundTarget(');
const to = hostSource.indexOf('WORD VirtualKeyForName(', from);
if (from < 0 || to <= from) throw new Error('Native input seam markers changed');
const seamPath = join(output, 'input-seam.cc');
writeFileSync(
  seamPath,
  `
#include <atomic>
#include <cstdint>
#include <memory>
using UINT = unsigned;
struct RECT {};
struct INPUT {};
using LPINPUT = INPUT*;
struct WindowsSession { std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts = std::make_shared<std::atomic<std::uint64_t>>(0); };
bool valid = true;
unsigned calls = 0;
bool RevalidateWindowsTarget(const WindowsSession&, const RECT&, std::uint64_t) { return valid; }
UINT SendInput(UINT, LPINPUT, unsigned) { ++calls; return 0; }
${hostSource.slice(from, to)}
int main() {
  WindowsSession session;
  RECT bounds;
  INPUT input;
  if (SendInputForBoundTarget(session, bounds, 0, 1, &input) != 0) return 1;
  if (session.input_api_attempts->load() != 1 || calls != 1) return 2;
  valid = false;
  SendInputForBoundTarget(session, bounds, 1, 1, &input);
  return session.input_api_attempts->load() == 1 && calls == 1 ? 0 : 3;
}
`,
);

function checked(command, args, stage) {
  const result = spawnSync(command, args, {
    cwd: output,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`${stage} failed`);
}
for (const [name, source] of [
  ['protocol', join(native, 'computer_use_protocol_fuzz.cc')],
  ['input-seam', seamPath],
]) {
  const executable = join(output, `${name}${windows ? '.exe' : ''}`);
  checked(
    windows ? 'cl.exe' : 'clang++',
    windows
      ? [
          '/nologo',
          '/std:c++20',
          '/EHsc',
          '/W4',
          `/Fo:${join(output, `${name}.obj`)}`,
          `/Fe:${executable}`,
          source,
        ]
      : [
          '-std=c++20',
          '-Wall',
          '-Wextra',
          '-fsanitize=address,undefined',
          '-fno-omit-frame-pointer',
          source,
          '-o',
          executable,
        ],
    `${name} compile`,
  );
  checked(executable, [], name);
}
console.log(
  JSON.stringify({
    sourceCommit,
    platform: process.platform,
    nodeVersion: process.versions.node,
    apiVersion: manifest.apiVersion,
    protocolVersion: manifest.protocolVersion,
    artifactSha256,
    signaturePending: manifest.signerDigest === null,
    protocolTest: 'PASS',
    inputAttemptSeam: 'PASS',
    realInputPerformed: false,
  }),
);
