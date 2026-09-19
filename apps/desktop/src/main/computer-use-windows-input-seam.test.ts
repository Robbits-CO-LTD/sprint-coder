import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(__dirname, '../../computer-use-native/computer_use_windows_host.cc'),
  'utf8',
);
function sourceBetween(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Native seam source markers changed');
  return source.slice(from, to);
}
describe.skipIf(process.platform === 'win32')(
  'Windows SendInput count portable native seam',
  () => {
    // This spec spawns a compiler and then an ASan/UBSan-instrumented binary, so its cost is
    // dominated by process spawn inside the Vitest worker rather than by the tiny translation
    // unit: ~0.4s when the same steps run straight from Node, ~4s inside a worker on an idle
    // machine, and 9.4s on a healthy two-core Linux CI shard sharing the host with the rest of the
    // suite (run 34957326437). Vitest's 20s project default left no room for that spread and turned
    // an ordinary slow runner into a red build with only "Test timed out" to go on. Like the other
    // spawn-heavy specs in this repo it therefore declares its own budget, which keeps the bounded
    // clang++ (30s) and binary (5s) guards below the per-test deadline so a genuinely stuck
    // compiler still fails first and names the command instead of being masked by the runner.
    it('counts the actual API attempt even when SendInput fails, but not a guard refusal', () => {
      const root = mkdtempSync(join(tmpdir(), 'computer-use-win-input-seam-'));
      try {
        const from = source.indexOf('UINT SendInputForBoundTarget(');
        const to = source.indexOf('WORD VirtualKeyForName(', from);
        expect(from).toBeGreaterThan(0);
        expect(to).toBeGreaterThan(from);
        const path = join(root, 'seam.cc');
        const binary = join(root, 'seam');
        writeFileSync(
          path,
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
${source.slice(from, to)}
int main() {
  WindowsSession session;
  RECT bounds;
  INPUT input;
  if (SendInputForBoundTarget(session, bounds, 0, 1, &input) != 0) return 1;
  if (session.input_api_attempts->load() != 1 || calls != 1) return 2;
  valid = false;
  SendInputForBoundTarget(session, bounds, 1, 1, &input);
  return session.input_api_attempts->load() == 1 && calls == 1 ? 0 : 3;
}`,
        );
        execFileSync(
          'clang++',
          [
            '-std=c++20',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-fsanitize=address,undefined',
            path,
            '-o',
            binary,
          ],
          { stdio: 'pipe', timeout: 30_000 },
        );
        execFileSync(binary, [], { stdio: 'pipe', timeout: 5_000 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);

// Compile the actual production close path with inert Win32, protocol, and JSON seams. No window,
// process, pipe, or real session is used. The spawn budget matches the seam above.
describe.skipIf(process.platform === 'win32')('Windows close session recovery native seam', () => {
  it('answers a repeat close for a session whose confirmed close response was lost', () => {
    const root = mkdtempSync(join(tmpdir(), 'computer-use-win-close-seam-'));
    try {
      const path = join(root, 'seam.cc');
      const binary = join(root, 'seam');
      writeFileSync(
        path,
        `${windowsCloseSeamPreamble}
${sourceBetween('std::unordered_map<std::string, WindowsSession> sessions;', 'void ReleaseWindowsSessionResources(')}
${sourceBetween('bool CloseWindowsSession(', 'bool ValidateWindowsSession(')}
${windowsCloseSeamDriver}`,
      );
      execFileSync(
        'clang++',
        [
          '-std=c++20',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-fsanitize=address,undefined',
          path,
          '-o',
          binary,
        ],
        { stdio: 'pipe', timeout: 30_000 },
      );
      const result = JSON.parse(execFileSync(binary, [], { encoding: 'utf8', timeout: 5_000 })) as {
        liveCloseDrained: boolean;
        sessionReleased: boolean;
        repeatCloseConfirms: boolean;
        staleRepeatRefused: boolean;
        unclosedSessionRefused: boolean;
        missingEpochRefused: boolean;
        closedRecordsBounded: boolean;
      };
      expect(result).toEqual({
        liveCloseDrained: true,
        sessionReleased: true,
        repeatCloseConfirms: true,
        staleRepeatRefused: true,
        unclosedSessionRefused: true,
        missingEpochRefused: true,
        closedRecordsBounded: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

const windowsCloseSeamPreamble = `
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <deque>
#include <iostream>
#include <memory>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>
struct FrameId { std::string key; };
struct FrameHeader { FrameId session_id; };
struct Frame { FrameHeader header; };
struct WindowsSession {
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::string session_id;
  std::uint64_t cancel_epoch = 0;
};
std::string FrameIdKey(const FrameId &id) { return id.key; }
std::string JsonEscape(std::string_view value) { return std::string(value); }
std::uint64_t requestedEpoch = 0;
bool epochAvailable = true;
bool ReadJsonUint64(std::string_view, std::string_view, std::uint64_t *output) {
  if (!epochAvailable) return false;
  *output = requestedEpoch;
  return true;
}
std::atomic<std::uint64_t> cancellation_epoch{0};
unsigned releasedSessions = 0;
void ReleaseWindowsSessionResources(WindowsSession *) { ++releasedSessions; }
`;
const windowsCloseSeamDriver = `
Frame FrameFor(const std::string &id) {
  Frame frame;
  frame.header.session_id.key = id;
  return frame;
}
bool OpenAndClose(const std::string &id, std::uint64_t attempts, std::uint64_t epoch, std::string *response) {
  WindowsSession session;
  session.session_id = id;
  session.input_api_attempts->store(attempts, std::memory_order_release);
  sessions.emplace(id, std::move(session));
  requestedEpoch = epoch;
  return CloseWindowsSession(FrameFor(id), "", response);
}
bool Reclose(const std::string &id, std::uint64_t epoch, std::string *response) {
  response->clear();
  requestedEpoch = epoch;
  return CloseWindowsSession(FrameFor(id), "", response);
}
bool Contains(const std::string &response, const std::string &fragment) {
  return response.find(fragment) != std::string::npos;
}
int main() {
  std::string response;
  const bool liveClosed = OpenAndClose("session-1", 4, 1, &response);
  const bool liveCloseDrained = liveClosed && Contains(response, "\\"result\\":\\"closed\\"") &&
    Contains(response, "\\"drained\\":true") && Contains(response, "\\"cancelEpoch\\":1") &&
    Contains(response, "\\"inputAttemptCount\\":4");
  const bool sessionReleased = sessions.empty() && releasedSessions == 1;

  // Main keeps the host quarantined until it sees a confirmed close receipt, so it re-sends the
  // close for the same session id with a higher epoch when the first answer never arrived.
  const bool repeated = Reclose("session-1", 2, &response);
  const bool repeatCloseConfirms = repeated && Contains(response, "\\"result\\":\\"closed\\"") &&
    Contains(response, "\\"drained\\":true") && Contains(response, "\\"sessionId\\":\\"session-1\\"") &&
    Contains(response, "\\"cancelEpoch\\":2") && Contains(response, "\\"inputAttemptCount\\":4") &&
    releasedSessions == 1;
  const bool staleRepeatRefused = !Reclose("session-1", 2, &response);
  const bool unclosedSessionRefused = !Reclose("never-opened", 1, &response);
  epochAvailable = false;
  const bool missingEpochRefused = !Reclose("session-1", 3, &response);
  epochAvailable = true;

  // Keeping a close answerable is bounded, so a long lived helper cannot accumulate records.
  bool boundedClosesDrained = true;
  for (int index = 0; index < 40; ++index) {
    const std::string id = "bounded-" + std::to_string(index);
    if (!OpenAndClose(id, 0, 1, &response)) boundedClosesDrained = false;
  }
  const bool closedRecordsBounded = boundedClosesDrained && !Reclose("bounded-0", 2, &response) &&
    Reclose("bounded-39", 2, &response);

  std::cout << std::boolalpha << "{\\"liveCloseDrained\\":" << liveCloseDrained
    << ",\\"sessionReleased\\":" << sessionReleased
    << ",\\"repeatCloseConfirms\\":" << repeatCloseConfirms
    << ",\\"staleRepeatRefused\\":" << staleRepeatRefused
    << ",\\"unclosedSessionRefused\\":" << unclosedSessionRefused
    << ",\\"missingEpochRefused\\":" << missingEpochRefused
    << ",\\"closedRecordsBounded\\":" << closedRecordsBounded << "}";
}
`;
