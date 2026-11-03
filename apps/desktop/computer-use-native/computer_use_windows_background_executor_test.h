#pragma once
#include "computer_use_windows_background_monitor.h"
#include "computer_use_windows_background_executor.h"
#include <array>
#include <iostream>
#include <string>

namespace windows_background_executor_test {
using namespace windows_background_executor_detail;
struct FakeOperations {
  enum class Pattern { kInvoke, kToggle, kSelect, kValue, kExpand };
  Pattern pattern = Pattern::kInvoke;
  sprint_coder::computer_use::WindowsBackgroundMonitorState monitor;
  Preparation preparation = Preparation::kReady;
  bool guard = true, call_ok = true, read_ok = true, window_ok = true;
  bool changed_content = false, throw_call = false, takeover = false, applies = true;
  bool own_event = false; // The provider raises the WinEvent our own pattern call causes.
  bool state = false, desired = true;
  std::string text = "Synthetic before", desired_text = "Synthetic after";
  std::uint64_t expected_epoch = 1;
  int calls = 0, reads = 0, windows = 0, claims = 0, finishes = 0;
  // These are deliberately available on the same fake as the UIA operations.
  std::array<int, 6> forbidden{};
  void SetForegroundWindow() { ++forbidden[0]; }
  void ShowWindow() { ++forbidden[1]; }
  void SetFocus() { ++forbidden[2]; }
  void SetCursorPos() { ++forbidden[3]; }
  void SendInput() { ++forbidden[4]; }
  void Paste() { ++forbidden[5]; }
  FakeOperations() { monitor.Registered(true); }
  bool Guard() { return guard && !monitor.Snapshot().paused; }
  Preparation Prepare() {
    if (preparation != Preparation::kReady) return preparation;
    if (pattern == Pattern::kInvoke) return Preparation::kReady;
    const bool same = pattern == Pattern::kValue ? text == desired_text : state == desired;
    return same ? Preparation::kNoop : Preparation::kReady;
  }
  std::uint64_t Claim() { ++claims; return monitor.Claim(expected_epoch); }
  bool Call() {
    ++calls;
    changed_content = true;
    if (takeover) monitor.Pause();
    if (throw_call) throw 1;
    if (applies) {
      if (pattern == Pattern::kValue) text = desired_text;
      else state = desired;
    }
    if (own_event) monitor.TargetEvent(sprint_coder::computer_use::BackgroundInputOwner::kTarget);
    return call_ok;
  }
  bool Readback() {
    if (pattern == Pattern::kInvoke) return true;
    ++reads;
    return read_ok && (pattern == Pattern::kValue ? text == desired_text : state == desired);
  }
  bool Window() { ++windows; return window_ok; }
  bool Finish(std::uint64_t claim, bool confirmed) {
    ++finishes;
    if (!confirmed) monitor.Pause();
    return monitor.Finish(claim);
  }
};
// Fake provider patterns: each branch must reach exactly one provider call through the timed contact,
// and the text argument must arrive as the mutable provider string (a BSTR in the UIA adapter).
struct FakePattern {
  int *calls;
  int Invoke() { ++*calls; return 1; }
  int Toggle() { ++*calls; return 2; }
  int Select() { ++*calls; return 3; }
  int Expand() { ++*calls; return 5; }
  int Collapse() { ++*calls; return 6; }
  wchar_t *seen = nullptr;
  int SetValue(wchar_t *text) { seen = text; ++*calls; return 4; }
};
inline bool CheckCallPattern() {
  wchar_t buffer[] = L"Synthetic";
  for (int branch = 0; branch < 7; ++branch) {
    int calls = 0, timed = 0;
    FakePattern pattern{&calls};
    FakePattern *none = nullptr;
    const auto wrap = [&](auto &&call) { ++timed; return call(); };
    const int result = CallPattern(branch == 0 ? &pattern : none, branch == 1 ? &pattern : none,
        branch == 2 ? &pattern : none, branch == 3 ? &pattern : none,
        branch >= 4 && branch < 6 ? &pattern : none, static_cast<wchar_t *>(buffer), branch == 4, wrap, -1);
    const int expected[] = {1, 2, 3, 4, 5, 6, -1};
    if (result != expected[branch] || calls != (branch < 6 ? 1 : 0) || timed != calls ||
        (branch == 3) != (pattern.seen == buffer)) return false;
  }
  return true;
}
inline bool CheckBackgroundExecutor() {
  const auto check = [](bool ok, const char *name) {
    if (!ok) std::cerr << name << '\n';
    return ok;
  };
  if (!check(CheckCallPattern(), "BG01_call_pattern_one_timed_provider_call")) return false;
  for (int pattern = 0; pattern < 5; ++pattern) {
    FakeOperations ops;
    ops.pattern = static_cast<FakeOperations::Pattern>(pattern);
    if (!check(RunBackgroundExecutor(ops) == Outcome::kCompleted && ops.calls == 1 &&
                   ops.claims == 1 && ops.finishes == 1 &&
                   ops.forbidden == std::array<int, 6>{},
               "BG01_background_forbidden_api_attempts_zero")) return false;
    if (!check(ops.windows == 1 && ops.changed_content && (pattern != 0 || ops.reads == 0),
               "BG01_invoke_checks_window_not_old_content")) return false;
    if (pattern == 0) continue;
    if (!check(ops.reads == 1, "BG01_pattern_readback_and_noop")) return false;
    FakeOperations noop;
    noop.pattern = ops.pattern;
    noop.state = noop.desired;
    noop.text = noop.desired_text;
    if (!check(RunBackgroundExecutor(noop) == Outcome::kCompleted && noop.calls == 0 &&
                   noop.claims == 0, "BG01_pattern_readback_and_noop")) return false;
    FakeOperations mismatch;
    mismatch.pattern = ops.pattern;
    mismatch.applies = false;
    if (!check(RunBackgroundExecutor(mismatch) == Outcome::kUnknownEffect && mismatch.calls == 1,
               "BG01_pattern_readback_and_noop")) return false;
  }
  for (int failure = 0; failure < 5; ++failure) {
    FakeOperations ops;
    ops.pattern = FakeOperations::Pattern::kToggle;
    if (failure == 0) ops.call_ok = false; // Provider error or timeout.
    if (failure == 1) ops.throw_call = true; // Lost response.
    if (failure == 2) ops.read_ok = false;
    if (failure == 3) ops.window_ok = false;
    if (failure == 4) ops.takeover = true; // Finish fails after a successful call.
    if (!check(RunBackgroundExecutor(ops) == Outcome::kUnknownEffect && ops.calls == 1 &&
                   ops.finishes == 1 && ops.monitor.Snapshot().unknown_effect &&
                   ops.monitor.Claim(ops.monitor.Snapshot().epoch) == 0 &&
                   ops.forbidden == std::array<int, 6>{},
               "BG06_claimed_uia_never_retries_or_falls_back")) return false;
  }
  for (int pattern = 0; pattern < 5; ++pattern) {
    // BG01 completed above is FAKE-ONLY. On a real device the target raises STATECHANGE /
    // VALUECHANGE / SELECTION / EXPANDCOLLAPSE (or INVOKED) for our own call while the claim is
    // active, the Target WinEvent hook pauses without own-call attribution, and the claim closes as
    // unknown_effect. Real-device BG01 completed stays BLOCKED until
    // "N9 P4a-attr claim-scoped own-call WinEvent attribution" lands; this case pins fail-closed.
    FakeOperations ops;
    ops.pattern = static_cast<FakeOperations::Pattern>(pattern);
    ops.own_event = true;
    if (!check(RunBackgroundExecutor(ops) == Outcome::kUnknownEffect && ops.calls == 1 &&
                   ops.finishes == 1 && ops.monitor.Snapshot().paused &&
                   ops.monitor.Snapshot().unknown_effect &&
                   ops.forbidden == std::array<int, 6>{},
               "BG01_real_device_completed_blocked_until_own_call_attribution")) return false;
  }
  {
    FakeOperations ops;
    ops.preparation = Preparation::kHandoff;
    if (!check(RunBackgroundExecutor(ops) == Outcome::kAwaitingForegroundHandoff &&
                   ops.calls == 0 && ops.claims == 0 && ops.forbidden == std::array<int, 6>{},
               "BG05_unissued_action_requires_handoff")) return false;
  }
  for (int failure = 0; failure < 5; ++failure) {
    FakeOperations ops;
    if (failure == 0) ops.guard = false;
    if (failure == 1) ops.preparation = Preparation::kRejected;
    if (failure == 2) ops.monitor.Registered(false);
    if (failure == 3) { ops.monitor.Registered(false); ops.preparation = Preparation::kHandoff; }
    if (failure == 4) ops.expected_epoch = 2; // Guard passes, but Claim returns zero.
    if (!check(RunBackgroundExecutor(ops) == Outcome::kRejected && ops.calls == 0 &&
                   ops.forbidden == std::array<int, 6>{},
               "BG05_guard_failure_never_falls_back")) return false;
  }
  return true;
}
} // namespace windows_background_executor_test
