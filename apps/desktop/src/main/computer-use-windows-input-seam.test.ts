import { readWindowsHostSource } from '../../../../computer-use-windows-host-source.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readWindowsHostSource();
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
  // This count seam uses a native target; browser page transitions have their own chunk seam.
  struct { bool web = false; } observed_page;
  int active_window = 1;
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
std::uint64_t WindowsValidationFrameStopSerial() { return stopSerial; }
int GetForegroundWindow() { return 1; }
bool WindowsValidationStillCurrent(std::uint64_t epoch, std::uint64_t serial) {
  return epoch == stopEpoch && serial == stopSerial;
}
bool WindowsSemanticInputInFlightLocked() { return false; }
// N9 P3c: the approval round trip may close input; the seam keeps it open.
bool WindowsRoundTripMayInput(const WindowsSession&) { return true; }
// N11 D: the browser page recheck before each chunk; this seam's target is not a browser page.
bool RecheckWindowsPageBeforeInput(const WindowsSession&) { return true; }
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
struct WindowsExplorerSendContext {};
bool RecheckWindowsExplorerBeforeSend(const WindowsSession &, const WindowsExplorerSendContext *,
    UINT, LPINPUT, std::uint64_t *) { return true; } // non-Explorer seam
bool WindowsExplorerSendStillCurrent(const WindowsSession &, const WindowsExplorerSendContext &,
    std::uint64_t) { return false; } // this seam must never supply Explorer evidence
UINT SendInput(UINT count, LPINPUT events, unsigned size) {
  ++calls;
  eventCount = count;
  if (count > 4 || size != sizeof(INPUT)) return 0;
  for (UINT i = 0; i < count; ++i) captured[i] = events[i];
  if (stopInsideApi) ++stopEpoch;
  return apiResult;
}
${source.slice(from, to)}
${sourceBetween('bool SendUnicodeScalar(', 'bool DecodeUtf8Scalars(')}
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
${sourceBetween('bool CloseWindowsSession(', 'bool StopPendingWindowsStart(')}
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
          `-I${join(__dirname, '../../computer-use-native')}`,
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
// The extracted session block also holds the ordinary ticket state (S5-a), which Close forgets.
#include "computer_use_native_ticket.h"
// The same block also holds the private approval owners (N8-2), which Close forgets as well.
#include "computer_use_windows_approval_handlers.h"
struct FrameId { std::string key; };
struct FrameHeader { FrameId session_id; };
struct Frame { FrameHeader header; };
struct WindowsSession {
  std::shared_ptr<std::atomic<std::uint64_t>> input_api_attempts =
      std::make_shared<std::atomic<std::uint64_t>>(0);
  std::string session_id;
  std::uint64_t cancel_epoch = 0;
  mutable bool page_observation_invalidated = false;
};
bool semanticInputInFlight = false;
bool StopWindowsSemanticInput(const WindowsSession& session, std::uint64_t* attempts) {
  if (semanticInputInFlight) return false;
  *attempts = session.input_api_attempts->load(std::memory_order_acquire);
  return true;
}
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
// Admission bookkeeping is covered by the dedicated ownership/live pipe seams.
template <typename Receipt> void MarkWindowsStartClosed(const std::string&, const Receipt&) {}
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

  const auto epochBefore = cancellation_epoch.load();
  const auto releasedBefore = releasedSessions;
  semanticInputInFlight = true;
  const bool refused = !OpenAndClose("in-flight", 5, epochBefore + 1, &response);
  std::string reason;
  const bool refusedAgain = !CloseWindowsSession(FrameFor("in-flight"), "", &response, &reason);
  if (!refused || !refusedAgain || reason != "semantic_input_in_flight" ||
      sessions.at("in-flight").cancel_epoch != 0 || cancellation_epoch.load() != epochBefore ||
      releasedSessions != releasedBefore || closed_sessions.find("in-flight") != closed_sessions.end()) return 1;
  semanticInputInFlight = false;
  if (!Reclose("in-flight", epochBefore + 1, &response) ||
      closed_sessions.at("in-flight").input_api_attempts != 5 ||
      releasedSessions != releasedBefore + 1 || !sessions.empty()) return 2;

  std::cout << std::boolalpha << "{\\"liveCloseDrained\\":" << liveCloseDrained
    << ",\\"sessionReleased\\":" << sessionReleased
    << ",\\"repeatCloseConfirms\\":" << repeatCloseConfirms
    << ",\\"staleRepeatRefused\\":" << staleRepeatRefused
    << ",\\"unclosedSessionRefused\\":" << unclosedSessionRefused
    << ",\\"missingEpochRefused\\":" << missingEpochRefused
    << ",\\"closedRecordsBounded\\":" << closedRecordsBounded << "}";
}
`;
