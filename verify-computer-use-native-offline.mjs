import { readWindowsHostSource } from './computer-use-windows-host-source.mjs';
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
  manifest.apiVersion !== 3 ||
  manifest.protocolVersion !== 1 ||
  manifest.binaryDigest !== artifactSha256 ||
  manifest.moduleDigest !== artifactSha256
)
  throw new Error('Native manifest/source/artifact mismatch');
mkdirSync(output, { recursive: true });

const hostSource = readWindowsHostSource();
const from = hostSource.indexOf('UINT SendInputForBoundTarget(');
const to = hostSource.indexOf('WORD VirtualKeyForName(', from);
if (from < 0 || to <= from) throw new Error('Native input seam markers changed');
const seamPath = join(output, 'input-seam.cc');
writeFileSync(
  seamPath,
  `
#include <atomic>
#include <cstdint>
#include <initializer_list>
#include <memory>
#include <mutex>
using UINT = unsigned;
using BOOL = int;
constexpr BOOL FALSE = 0;
struct RECT {};
using WORD = std::uint16_t;
constexpr unsigned INPUT_KEYBOARD = 1;
constexpr unsigned KEYEVENTF_UNICODE = 4;
constexpr unsigned KEYEVENTF_KEYUP = 2;
struct INPUT {
  unsigned type = 0;
  struct { WORD wVk = 0; WORD wScan = 0; unsigned dwFlags = 0; } ki;
};
using LPINPUT = INPUT*;
struct WindowsSession {
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts = std::make_shared<std::atomic<std::uint64_t>>(0);
  // Approved-input fields (N8-2c); zero keeps the ordinary path this seam covers.
  std::uint64_t approved_started_ns = 0;
  std::uint64_t approved_deadline_ns = 0;
  std::uint64_t approved_helper_generation = 0;
  std::uint64_t approved_stop_serial = 0;
  std::uint64_t cancel_epoch = 0;
};
struct TargetListControl { std::mutex stop_mutex; };
TargetListControl &WindowsTargetListControl() { static TargetListControl control; return control; }
std::uint64_t windows_helper_generation = 0;
std::uint64_t MonotonicNowNs() { return 1; }
std::uint64_t stopEpoch = 0;
std::uint64_t stopSerial = 0;
bool WindowsValidationStillCurrent(std::uint64_t epoch, std::uint64_t serial) {
  return epoch == stopEpoch && serial == stopSerial;
}
bool WindowsSemanticInputInFlightLocked() { return false; }
// N9 P3c: the approval round trip may close input; the seam keeps it open.
bool WindowsRoundTripMayInput(const WindowsSession&) { return true; }
BOOL SetCursorPos(int, int) { return 1; }
bool valid = true;
bool semanticInputInFlight = false;
unsigned calls = 0;
bool WindowsSemanticInputInFlight() { return semanticInputInFlight; }
unsigned validations = 0;
unsigned stopAtValidation = 0;
UINT apiResult = 0;
UINT eventCount = 0;
INPUT captured[4]{};
bool stopInsideApi = false;
bool RevalidateWindowsTarget(const WindowsSession&, const RECT&, std::uint64_t epoch) {
  if (++validations == stopAtValidation) ++stopEpoch;
  return valid && epoch == stopEpoch;
}
UINT SendInput(UINT count, LPINPUT events, unsigned size) {
  ++calls;
  eventCount = count;
  if (count > 4 || size != sizeof(INPUT)) return 0;
  for (UINT i = 0; i < count; ++i) captured[i] = events[i];
  if (stopInsideApi) ++stopEpoch;
  return apiResult;
}
${hostSource.slice(from, to)}
${hostSource.slice(hostSource.indexOf('bool SendUnicodeScalar('), hostSource.indexOf('bool DecodeUtf8Scalars('))}
void Reset(WindowsSession& session) {
  session.input_api_attempts->store(0);
  session.approved_deadline_ns = 0;
  valid = true;
  semanticInputInFlight = false;
  calls = validations = stopAtValidation = 0;
  stopEpoch = stopSerial = 0;
  apiResult = eventCount = 0;
  stopInsideApi = false;
}
bool EventsMatch(WORD high, WORD low, UINT count) {
  if (eventCount != count) return false;
  for (UINT i = 0; i < count; ++i) {
    if (captured[i].type != INPUT_KEYBOARD || captured[i].ki.wVk != 0 ||
        captured[i].ki.wScan != (i < 2 ? high : low) ||
        captured[i].ki.dwFlags != (KEYEVENTF_UNICODE | (i % 2 ? KEYEVENTF_KEYUP : 0))) return false;
  }
  return true;
}
int main() {
  WindowsSession session;
  RECT bounds;
  INPUT input;
  if (SendInputForBoundTarget(session, bounds, 0, 1, &input) != 0) return 1;
  if (session.input_api_attempts->load() != 1 || calls != 1) return 2;
  stopEpoch = 1;
  valid = false;
  SendInputForBoundTarget(session, bounds, 1, 1, &input);
  if (session.input_api_attempts->load() != 1 || calls != 1) return 3;
  valid = true;
  semanticInputInFlight = true;
  SendInputForBoundTarget(session, bounds, 1, 1, &input);
  if (session.input_api_attempts->load() != 1 || calls != 1) return 4;

  // Supplementary boundaries and a middle scalar: all four events in one call.
  for (const std::uint32_t scalar : {0x10000u, 0x1f642u, 0x10ffffu}) {
    Reset(session);
    apiResult = 4;
    bool accepted = false;
    if (!SendUnicodeScalar(session, bounds, 0, scalar, &accepted) || !accepted ||
        calls != 1 || session.input_api_attempts->load() != 1 ||
        !EventsMatch(static_cast<WORD>(0xd800 + ((scalar - 0x10000) >> 10)),
                     static_cast<WORD>(0xdc00 + ((scalar - 0x10000) & 0x3ff)), 4)) return 10;
  }
  // Zero/partial results never retry; positive results record accepted input.
  // BMP keeps its two-event unit and the same acceptance semantics.
  for (const std::uint32_t scalar : {0x41u, 0x3042u, 0xffffu, 0x1f642u}) {
    const UINT count = scalar > 0xffff ? 4 : 2;
    for (UINT sent = 0; sent <= count; ++sent) {
      Reset(session);
      apiResult = sent;
      bool accepted = false;
      const bool complete = SendUnicodeScalar(session, bounds, 0, scalar, &accepted);
      if (complete != (sent == count) || accepted != (sent > 0) ||
          calls != 1 || session.input_api_attempts->load() != 1 || eventCount != count) return 11;
      if (count == 2 && !EventsMatch(static_cast<WORD>(scalar), 0, 2)) return 12;
    }
  }
  // Stop before the scalar or at the final bound-target revalidation prevents input.
  for (const unsigned stopPoint : {1u, 2u}) {
    Reset(session);
    stopAtValidation = stopPoint;
    apiResult = 4;
    bool accepted = false;
    if (SendUnicodeScalar(session, bounds, 0, 0x1f642, &accepted) || accepted ||
        calls != 0 || session.input_api_attempts->load() != 0) return 13;
  }
  // Approved-input Stop serial is checked under the existing stop mutex.
  Reset(session);
  session.approved_deadline_ns = 2;
  stopSerial = 1;
  bool accepted = false;
  if (SendUnicodeScalar(session, bounds, 0, 0x1f642, &accepted) || accepted ||
      calls != 0 || session.input_api_attempts->load() != 0) return 14;

  Reset(session);
  semanticInputInFlight = true;
  if (SendUnicodeScalar(session, bounds, 0, 0x1f642, &accepted) || accepted ||
      calls != 0 || session.input_api_attempts->load() != 0) return 15;

  // Stop after the API prevents confirmation, but does not erase an accepted attempt.
  Reset(session);
  apiResult = 4;
  stopInsideApi = true;
  if (SendUnicodeScalar(session, bounds, 0, 0x1f642, &accepted) || !accepted ||
      calls != 1 || session.input_api_attempts->load() != 1 || eventCount != 4) return 16;
  return 0;
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
          // The sources carry CJK lexicon terms; do not depend on the machine's code page.
          '/utf-8',
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
