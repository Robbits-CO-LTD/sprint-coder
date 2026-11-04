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
        ops.calls != 1 || ops.reads != 1 || ops.finishes != 1 ||
        ops.monitor.Snapshot().unknown_effect != other) {
      std::cerr << "BG01_scroll_attributed_event_or_other_hwnd_takeover\n";
      return false;
    }
  }
  return true;
}

int main() {
  return windows_background_executor_test::CheckBackgroundExecutor() &&
      windows_background_executor_test::CheckBackgroundScroll() && CheckScrollAttribution() ? 0 : 1;
}
