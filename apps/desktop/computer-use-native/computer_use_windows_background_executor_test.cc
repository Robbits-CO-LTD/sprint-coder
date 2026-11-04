#include "computer_use_windows_background_executor_test.h"

bool CheckScrollAttribution() {
  using namespace windows_background_executor_test;
  struct Operations : FakeScrollOperations {
    bool other = false;
    std::uint64_t Claim() {
      ++claims;
      return monitor.Claim(expected_epoch, ClaimPermission("semantic_scroll", 5));
    }
    bool Call() {
      const bool result = FakeScrollOperations::Call();
      monitor.TargetEvent(sprint_coder::computer_use::BackgroundInputOwner::kTarget,
          0x800e, other ? 6 : 5, 0, 0, 1001);
      return result;
    }
  };
  for (bool other : {false, true}) {
    Operations ops;
    ops.other = other;
    if (RunBackgroundExecutor(ops) != (other ? Outcome::kUnknownEffect : Outcome::kCompleted) ||
        ops.calls != 1 || ops.reads != (other ? 0 : 1) || ops.finishes != 1 ||
        ops.monitor.Snapshot().unknown_effect != other) {
      std::cerr << "BG01_scroll_attributed_event_or_other_hwnd_takeover\n";
      return false;
    }
  }
  return true;
}

bool CheckCallWindow() {
  using namespace windows_background_executor_test;
  struct Operations : FakeOperations {
    int phase = 0;
    bool ordering = true;
    void Event(std::uint64_t now) {
      monitor.TargetEvent(sprint_coder::computer_use::BackgroundInputOwner::kTarget,
          0x8013, 5, 0, 0, 1001, now);
    }
    std::uint64_t Claim() {
      const auto claim = monitor.Claim(1, ClaimPermission("invoke", 5), 1000);
      if (phase == 0) Event(1001);
      return claim;
    }
    bool BeginCall(std::uint64_t claim) { ++begins; return monitor.BeginCall(claim, 1010); }
    bool Call() {
      ordering &= begins == 1 && ends == 0;
      ++calls;
      if (phase == 1) Event(1011);
      if (throw_call) throw 1;
      return call_ok;
    }
    bool EndCall(std::uint64_t claim) { ++ends; return monitor.EndCall(claim, 1020); }
    bool Readback() {
      ordering &= ends == 1;
      if (phase == 2 || phase == 3) Event(phase == 2 ? 1169 : 1170);
      return true;
    }
    bool Window() { ordering &= ends == 1; if (phase == 4) Event(1170); return true; }
    bool Finish(std::uint64_t claim, bool confirmed) {
      ++finishes;
      if (!confirmed) monitor.Pause();
      return monitor.Finish(claim, 1200);
    }
  };
  for (int phase = 0; phase < 7; ++phase) {
    Operations ops;
    ops.phase = phase;
    ops.throw_call = phase == 5;
    ops.call_ok = phase != 6;
    const auto result = RunBackgroundExecutor(ops);
    if (result != (phase == 1 || phase == 2 ? Outcome::kCompleted : Outcome::kUnknownEffect) ||
        !ops.ordering || ops.calls != (phase == 0 ? 0 : 1) ||
        ops.ends != (phase == 0 ? 0 : 1) || ops.finishes != 1) {
      std::cerr << "ATTR_executor_call_window_readback_window_and_exception\n";
      return false;
    }
  }
  return true;
}
int main() {
  return windows_background_executor_test::CheckBackgroundExecutor() &&
      windows_background_executor_test::CheckBackgroundScroll() && CheckScrollAttribution() &&
      CheckCallWindow() ? 0 : 1;
}
