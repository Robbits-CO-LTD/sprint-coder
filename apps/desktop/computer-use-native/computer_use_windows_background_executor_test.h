#pragma once
#include "computer_use_windows_background_monitor.h"
#include "computer_use_windows_background_executor.h"
#include "computer_use_windows_page.h"
#include <array>
#include <iostream>
#include <string>

namespace windows_background_executor_test {
using namespace windows_background_executor_detail;
struct FakeOperations {
  enum class Pattern { kInvoke, kToggle, kSelect, kValue, kExpand };
  Pattern pattern = Pattern::kInvoke;
  sprint_coder::computer_use::WindowsBackgroundMonitorState monitor{1, [] { return 1000u; }};
  Preparation preparation = Preparation::kReady;
  bool guard = true, call_ok = true, read_ok = true, window_ok = true;
  bool changed_content = false, throw_call = false, takeover = false, applies = true;
  bool other_hwnd = false;
  bool own_event = false; // The provider raises the WinEvent our own pattern call causes.
  bool state = false, desired = true;
  std::string text = "Synthetic before", desired_text = "Synthetic after";
  std::uint64_t expected_epoch = 1;
  int calls = 0, reads = 0, windows = 0, claims = 0, finishes = 0;
  int begins = 0, ends = 0;
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
  bool CheckPage() { return true; }
  Preparation Prepare() {
    if (preparation != Preparation::kReady) return preparation;
    if (pattern == Pattern::kInvoke) return Preparation::kReady;
    const bool same = pattern == Pattern::kValue ? text == desired_text : state == desired;
    return same ? Preparation::kNoop : Preparation::kReady;
  }
  std::uint64_t Claim() {
    ++claims;
    const char *kinds[] = {"invoke", "toggle", "select", "set_text", "expand_collapse"};
    return monitor.Claim(expected_epoch, ClaimPermission(kinds[static_cast<int>(pattern)], 5));
  }
  bool BeginCall(std::uint64_t claim) { ++begins; return monitor.BeginCall(claim); }
  bool EndCall(std::uint64_t claim) { ++ends; return monitor.EndCall(claim); }
  bool Call() {
    ++calls;
    changed_content = true;
    if (takeover) monitor.Pause();
    if (throw_call) throw 1;
    if (applies) {
      if (pattern == Pattern::kValue) text = desired_text;
      else state = desired;
    }
    if (own_event) {
      const std::uint32_t events[] = {0x8013, 0x800a, 0x8006, 0x800e, 0x800a};
      monitor.TargetEvent(sprint_coder::computer_use::BackgroundInputOwner::kTarget,
          events[static_cast<int>(pattern)], other_hwnd ? 6 : 5, 0, 0, 1001);
    }
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
  // Synthetic ordinary evidence exercises the seam without opening the product's browser gate.
  struct PageOperations : FakeOperations {
    sprint_coder::computer_use::WindowsPageEvidence observed{
        true, true, sprint_coder::computer_use::OriginState::kOrdinary,
        "https://example.test", "document-1", "url-hash-1"};
    sprint_coder::computer_use::WindowsPageEvidence current = observed;
    bool change_at_claim = false, stop_at_claim = false, stop_after_read = false;
    bool ticket_valid = true;
    int page_reads = 0;
    bool CheckPage() {
      if (monitor.Snapshot().paused) return false;
      if (!observed.web) return true;
      ++page_reads;
      const bool matches = sprint_coder::computer_use::WindowsPageAllowsInput(observed, current);
      if (!matches) ticket_valid = false;
      if (stop_after_read) monitor.Pause();
      return matches;
    }
    std::uint64_t Claim() {
      const auto claim = FakeOperations::Claim();
      if (change_at_claim) current.document_identity = "document-2";
      if (stop_at_claim) monitor.Pause();
      return claim;
    }
  };
  for (bool changed : {false, true}) {
    PageOperations ops;
    if (changed) ops.current.location_digest = "url-hash-2";
    if (!check(RunBackgroundExecutor(ops) == (changed ? Outcome::kRejected : Outcome::kCompleted) &&
               ops.calls == (changed ? 0 : 1) && ops.ticket_valid == !changed,
               "background_action_checks_bound_page")) return false;
  }
  {
    PageOperations ops;
    ops.change_at_claim = true;
    if (!check(RunBackgroundExecutor(ops) == Outcome::kUnknownEffect && ops.calls == 0 &&
               !ops.ticket_valid && ops.finishes == 1 && ops.begins == 0,
               "background_page_change_blocks_commit")) return false;
  }
  for (bool during_read : {false, true}) {
    PageOperations ops;
    ops.stop_at_claim = !during_read;
    ops.stop_after_read = during_read;
    if (!check(RunBackgroundExecutor(ops) != Outcome::kCompleted && ops.calls == 0 &&
               ops.page_reads == 1, "stop_before_or_during_page_check_blocks_input")) return false;
  }
  {
    PageOperations ops;
    ops.observed = {};
    ops.change_at_claim = true;
    if (!check(RunBackgroundExecutor(ops) == Outcome::kCompleted && ops.calls == 1 &&
               ops.page_reads == 0, "electron_background_page_check_is_neutral")) return false;
  }
  for (int pattern = 0; pattern < 5; ++pattern) {
    FakeOperations ops;
    ops.pattern = static_cast<FakeOperations::Pattern>(pattern);
    if (!check(RunBackgroundExecutor(ops) == Outcome::kCompleted && ops.calls == 1 &&
                   ops.claims == 1 && ops.finishes == 1 && ops.begins == 1 && ops.ends == 1 &&
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
                   ops.finishes == 1 && ops.ends == 1 && ops.monitor.Snapshot().unknown_effect &&
                   ops.monitor.Claim(ops.monitor.Snapshot().epoch) == 0 &&
                   ops.forbidden == std::array<int, 6>{},
               "BG06_claimed_uia_never_retries_or_falls_back")) return false;
  }
  for (int pattern = 0; pattern < 5; ++pattern) {
    for (bool other : {false, true}) {
      FakeOperations ops;
      ops.pattern = static_cast<FakeOperations::Pattern>(pattern);
      ops.own_event = true;
      ops.other_hwnd = other;
      if (!check(RunBackgroundExecutor(ops) == (other ? Outcome::kUnknownEffect : Outcome::kCompleted) &&
                     ops.calls == 1 && ops.finishes == 1 && ops.monitor.Snapshot().paused == other &&
                     ops.monitor.Snapshot().unknown_effect == other &&
                     ops.forbidden == std::array<int, 6>{},
                 "BG01_attributed_event_or_other_hwnd_takeover")) return false;
    }
  }
  {
    FakeOperations ops;
    ops.pattern = FakeOperations::Pattern::kToggle;
    ops.own_event = true;
    ops.applies = false;
    if (!check(RunBackgroundExecutor(ops) == Outcome::kUnknownEffect && ops.reads == 1,
               "BG01_attribution_does_not_replace_readback")) return false;
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
struct FakeScrollOperations : FakeOperations {
  enum Amount { kNone, kSmallDown, kLargeDown, kSmallUp, kLargeUp };
  ScrollRequest request;
  ScrollSnapshot before{true, true, 40, 40, 20, 20}, current = before;
  bool initial_read = true;
  int timed_calls = 0;
  Amount horizontal = kNone, vertical = kNone;
  double horizontal_percent = -1, vertical_percent = -1;
  FakeScrollOperations() {
    ParseScroll("scroll", "vertical", "small_increment",
                std::numeric_limits<double>::quiet_NaN(), &request);
  }
  Preparation Prepare() {
    return initial_read ? PrepareScroll(request, before) : Preparation::kRejected;
  }
  bool Apply() {
    ++calls;
    if (takeover) monitor.Pause();
    if (throw_call) throw 1;
    if (applies) {
      double &position = request.horizontal ? current.horizontal_percent : current.vertical_percent;
      position = request.absolute ? request.percent : position + (request.increment ? 10 : -10);
    }
    return call_ok;
  }
  bool Scroll(Amount h, Amount v) { horizontal = h; vertical = v; return Apply(); }
  bool SetScrollPercent(double h, double v) {
    horizontal_percent = h; vertical_percent = v; return Apply();
  }
  bool Call() {
    return CallScroll(this, request, kNone, kSmallDown, kLargeDown, kSmallUp, kLargeUp,
                      [&](auto &&call) { ++timed_calls; return call(); });
  }
  bool Readback() { ++reads; return read_ok && ScrollMatches(request, before, current); }
};
inline bool CheckBackgroundScroll() {
  const auto check = [](bool ok, const char *name) {
    if (!ok) std::cerr << name << '\n';
    return ok;
  };
  const double absent = std::numeric_limits<double>::quiet_NaN();
  double parsed_percent = 0;
  if (!check(ParseScrollPercent("1e2", &parsed_percent) && parsed_percent == 100 &&
                 ParseScrollPercent("1.25e1", &parsed_percent) && parsed_percent == 12.5 &&
                 !ParseScrollPercent("10px", &parsed_percent) &&
                 !ParseScrollPercent("1000e-0", &parsed_percent) &&
                 !ParseScrollPercent("NaN", &parsed_percent) &&
                 !ParseScrollPercent("Infinity", &parsed_percent),
             "BG01_scroll_units_and_readback")) return false;
  for (bool horizontal : {false, true}) {
    for (const auto amount : {"small_decrement", "large_decrement", "small_increment", "large_increment"}) {
      FakeScrollOperations ops;
      if (!ParseScroll("scroll", horizontal ? "horizontal" : "vertical", amount, absent, &ops.request))
        return false;
      const auto expected = std::string_view(amount) == "small_decrement" ? FakeScrollOperations::kSmallDown :
          std::string_view(amount) == "large_decrement" ? FakeScrollOperations::kLargeDown :
          std::string_view(amount) == "small_increment" ? FakeScrollOperations::kSmallUp : FakeScrollOperations::kLargeUp;
      if (!check(RunBackgroundExecutor(ops) == Outcome::kCompleted && ops.calls == 1 &&
                     ops.reads == 1 && ops.claims == 1 && ops.finishes == 1 && ops.timed_calls == 1 &&
                     ops.horizontal == (horizontal ? expected : FakeScrollOperations::kNone) &&
                     ops.vertical == (horizontal ? FakeScrollOperations::kNone : expected) &&
                     ops.forbidden == std::array<int, 6>{}, "BG01_scroll_units_and_readback")) return false;
    }
    for (double percent : {0.0, 12.5, 40.0, 100.0}) {
      FakeScrollOperations ops;
      if (!ParseScroll("set_scroll_percent", horizontal ? "horizontal" : "vertical", "", percent, &ops.request))
        return false;
      const int calls = percent == 40 ? 0 : 1;
      if (!check(RunBackgroundExecutor(ops) == Outcome::kCompleted && ops.calls == calls &&
                     ops.claims == calls && ops.finishes == calls && ops.timed_calls == calls &&
                     (calls == 0 || (ops.horizontal_percent == (horizontal ? percent : -1) &&
                                     ops.vertical_percent == (horizontal ? -1 : percent))),
                 "BG01_scroll_same_percent_noop")) return false;
    }
  }
  ScrollRequest request;
  if (!check(!ParseScroll("scroll", "vertical", "120", absent, &request) &&
                 !ParseScroll("scroll", "both", "small_increment", absent, &request) &&
                 !ParseScroll("scroll", "vertical", "small_increment", 5, &request) &&
                 !ParseScroll("set_scroll_percent", "vertical", "small_increment", 5, &request) &&
                 !ParseScroll("set_scroll_percent", "vertical", "", -1, &request) &&
                 !ParseScroll("set_scroll_percent", "vertical", "", 101, &request) &&
                 !ParseScroll("set_scroll_percent", "vertical", "", absent, &request) &&
                 !ParseScroll("set_scroll_percent", "vertical", "", INFINITY, &request) &&
                 !ParseScroll("scroll_into_view", "vertical", "", absent, &request),
             "BG01_scroll_units_and_readback")) return false;
  for (int failure = 0; failure < 13; ++failure) {
    FakeScrollOperations ops;
    if (failure == 0) ops.call_ok = false;
    if (failure == 1) ops.throw_call = true;
    if (failure == 2) ops.read_ok = false;
    if (failure == 3) ops.applies = false;
    if (failure == 4) ops.window_ok = false;
    if (failure == 5) ops.takeover = true;
    if (failure == 6) ops.current.horizontal_percent = 50;
    if (failure == 7) ops.current.vertical_view = absent;
    if (failure == 8) ops.current.vertical_scrollable = false;
    if (failure == 9) { ops.applies = false; ops.current.vertical_percent = 30; }
    if (failure == 10) {
      ParseScroll("set_scroll_percent", "vertical", "", 80, &ops.request);
      ops.applies = false; ops.current.vertical_percent = 60;
    }
    if (failure == 11) ops.current.vertical_view = 30;
    if (failure == 12) { ops.before.vertical_percent = ops.current.vertical_percent = 100; ops.applies = false; }
    if (!check(RunBackgroundExecutor(ops) == Outcome::kUnknownEffect && ops.calls == 1 &&
                   ops.timed_calls == 1 && ops.finishes == 1 && ops.monitor.Snapshot().unknown_effect &&
                   ops.forbidden == std::array<int, 6>{},
               "BG06_scroll_unknown_never_retries_or_falls_back")) return false;
  }
  {
    FakeScrollOperations ops;
    ops.before.horizontal_scrollable = ops.current.horizontal_scrollable = false;
    ops.before.horizontal_percent = ops.current.horizontal_percent = -1;
    ops.before.horizontal_view = ops.current.horizontal_view = 100;
    if (!check(RunBackgroundExecutor(ops) == Outcome::kCompleted && ops.calls == 1 &&
                   ops.horizontal == FakeScrollOperations::kNone,
               "BG01_scroll_units_and_readback")) return false;
  }
  for (int failure = 0; failure < 5; ++failure) {
    FakeScrollOperations ops;
    if (failure == 0) ops.initial_read = false;
    if (failure == 1) ops.before.vertical_percent = absent;
    if (failure == 2) ops.before.vertical_view = 101;
    if (failure == 3) { ops.before.vertical_scrollable = false; ops.before.vertical_percent = -1; }
    if (failure == 4) ops.expected_epoch = 2;
    const auto outcome = RunBackgroundExecutor(ops);
    if (!check((outcome == Outcome::kRejected || outcome == Outcome::kAwaitingForegroundHandoff) &&
                   ops.calls == 0 && ops.timed_calls == 0, "BG01_scroll_units_and_readback")) return false;
  }
  return true;
}
} // namespace windows_background_executor_test
