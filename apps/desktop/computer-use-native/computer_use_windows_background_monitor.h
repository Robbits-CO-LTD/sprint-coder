#pragma once
#include <cstdint>
#include <limits>
#include <mutex>

namespace sprint_coder::computer_use {

enum class BackgroundInputOwner { kNone, kOther, kTarget, kUnknown };
struct BackgroundMonitorSnapshot {
  std::uint64_t epoch = 1;
  bool paused = false;
  bool unknown_effect = false;
};

// This mutex is the linearization boundary for monitor callbacks and the final claim.
// Callers may hold Stop before taking it, never the reverse. No OS/provider call runs locked.
// Notification delivery cannot reopen this state; human resume must create fresh authority.
class WindowsBackgroundMonitorState {
public:
  explicit WindowsBackgroundMonitorState(std::uint64_t epoch = 1) {
    state_.epoch = epoch;
    if (epoch == 0) state_.paused = true;
  }
  void Registered(bool success) {
    std::lock_guard lock(mutex_);
    if (!success) PauseLocked();
    registered_ = success;
  }
  void Foreground(BackgroundInputOwner owner) {
    if (owner != BackgroundInputOwner::kOther) Pause();
  }
  void Pointer(BackgroundInputOwner hit, BackgroundInputOwner capture) {
    if (hit != BackgroundInputOwner::kOther ||
        (capture != BackgroundInputOwner::kNone && capture != BackgroundInputOwner::kOther)) Pause();
  }
  void TargetEvent(BackgroundInputOwner owner) {
    // WinEvent carries no trustworthy per-call token. Being inside our call is not attribution.
    // P4 must supply stronger correlation before any event can be exempted.
    if (owner != BackgroundInputOwner::kOther) Pause();
  }
  void Pause() {
    std::lock_guard lock(mutex_);
    PauseLocked();
  }
  BackgroundMonitorSnapshot Snapshot() const {
    std::lock_guard lock(mutex_);
    return state_;
  }
  std::uint64_t Claim(std::uint64_t expected_epoch) {
    std::lock_guard lock(mutex_);
    if (!registered_ || state_.paused || expected_epoch != state_.epoch || active_claim_ != 0)
      return 0;
    if (next_claim_ == std::numeric_limits<std::uint64_t>::max()) {
      PauseLocked();
      return 0;
    }
    active_claim_ = ++next_claim_;
    return active_claim_;
  }
  bool Finish(std::uint64_t claim) {
    std::lock_guard lock(mutex_);
    if (claim == 0 || claim != active_claim_) return false;
    active_claim_ = 0;
    return !state_.paused && !state_.unknown_effect;
  }
private:
  void PauseLocked() {
    // Close first, then advance, then let a caller publish the snapshot. Saturation never wraps.
    if (!state_.paused) {
      state_.paused = true;
      if (state_.epoch != std::numeric_limits<std::uint64_t>::max()) ++state_.epoch;
    }
    if (active_claim_ != 0) state_.unknown_effect = true;
  }
  mutable std::mutex mutex_;
  BackgroundMonitorSnapshot state_;
  bool registered_ = false;
  std::uint64_t next_claim_ = 0;
  std::uint64_t active_claim_ = 0;
};

} // namespace sprint_coder::computer_use
