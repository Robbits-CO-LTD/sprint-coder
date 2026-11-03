#pragma once
#include <chrono>
#include <cstdint>
#include <limits>
#include <mutex>

namespace sprint_coder::computer_use {

enum class BackgroundInputOwner { kNone, kOther, kTarget, kUnknown };
enum class BackgroundMonitorPump { kHook, kRaw };
// Provisional fail-closed bounds; real-device measurements are required before publication.
inline constexpr std::uint64_t kBackgroundMouseCorrelationMs = 100;
inline constexpr std::uint64_t kBackgroundHeartbeatIntervalMs = 20;
inline constexpr std::uint64_t kBackgroundHeartbeatTimeoutMs = 250;
inline std::uint64_t BackgroundMonitorNow() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
struct BackgroundMonitorSnapshot {
  std::uint64_t epoch = 1;
  bool paused = false;
  bool unknown_effect = false;
};

// This mutex is the linearization boundary for monitor callbacks and the final claim.
// Callers may hold Stop before taking it, never the reverse. No OS/provider call runs locked;
// the claim boundaries read only the steady clock under it.
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
  void BeginMonitoring(std::uint64_t now = BackgroundMonitorNow()) {
    std::lock_guard lock(mutex_);
    now = ObserveLocked(now);
    if (monitoring_) { PauseLocked(); return; }
    monitoring_ = true;
    hook_heartbeat_ = raw_heartbeat_ = now;
  }
  void Heartbeat(BackgroundMonitorPump pump, std::uint64_t now = BackgroundMonitorNow()) {
    std::lock_guard lock(mutex_);
    now = ObserveLocked(now);
    CheckHealthLocked(now);
    (pump == BackgroundMonitorPump::kHook ? hook_heartbeat_ : raw_heartbeat_) = now;
  }
  void MouseHook(std::uint64_t now = BackgroundMonitorNow()) {
    std::lock_guard lock(mutex_);
    now = ObserveLocked(now);
    CheckHealthLocked(now);
    hook_seen_ = true;
    last_hook_ = now;
    raw_pending_ = false;
  }
  void RawMouse(std::uint64_t now = BackgroundMonitorNow()) {
    std::lock_guard lock(mutex_);
    now = ObserveLocked(now);
    CheckHealthLocked(now);
    // Coalescing and delivery order prohibit a one-to-one event-count assumption.
    if (hook_seen_ && now >= last_hook_ && now - last_hook_ <= kBackgroundMouseCorrelationMs)
      return;
    if (!raw_pending_) { raw_pending_ = true; first_raw_ = now; }
  }
  void CheckHealth(std::uint64_t now = BackgroundMonitorNow()) {
    std::lock_guard lock(mutex_);
    CheckHealthLocked(ObserveLocked(now));
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
  // The final input boundary reads the clock under the lock, so a stale sample cannot pass it.
  std::uint64_t Claim(std::uint64_t expected_epoch) {
    std::lock_guard lock(mutex_);
    return ClaimLocked(expected_epoch, BackgroundMonitorNow());
  }
  // Tests only: production passes no time, so a stale sample cannot cross a boundary.
  std::uint64_t Claim(std::uint64_t expected_epoch, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    return ClaimLocked(expected_epoch, now);
  }
  // The end boundary checks monitor health too: a stall seen only here still fails the claim.
  bool Finish(std::uint64_t claim) {
    std::lock_guard lock(mutex_);
    return FinishLocked(claim, BackgroundMonitorNow());
  }
  // Tests only, like Claim.
  bool Finish(std::uint64_t claim, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    return FinishLocked(claim, now);
  }
private:
  bool FinishLocked(std::uint64_t claim, std::uint64_t now) {
    if (claim == 0 || claim != active_claim_) return false;
    CheckHealthLocked(ObserveLocked(now));
    active_claim_ = 0;
    return !state_.paused && !state_.unknown_effect;
  }
  std::uint64_t ClaimLocked(std::uint64_t expected_epoch, std::uint64_t now) {
    CheckHealthLocked(ObserveLocked(now));
    if (!registered_ || state_.paused || expected_epoch != state_.epoch || active_claim_ != 0)
      return 0;
    if (next_claim_ == std::numeric_limits<std::uint64_t>::max()) {
      PauseLocked();
      return 0;
    }
    active_claim_ = ++next_claim_;
    return active_claim_;
  }
  // A default argument samples the clock before the lock, so a thread may arrive with a time
  // older than one another thread already recorded. Never let that order read as a stall.
  std::uint64_t ObserveLocked(std::uint64_t now) {
    if (now > latest_) latest_ = now;
    return latest_;
  }
  void CheckHealthLocked(std::uint64_t now) {
    if (!monitoring_) return;
    const auto expired = [now](std::uint64_t time, std::uint64_t limit) {
      return now < time || now - time > limit;
    };
    if (expired(hook_heartbeat_, kBackgroundHeartbeatTimeoutMs) ||
        expired(raw_heartbeat_, kBackgroundHeartbeatTimeoutMs) ||
        (raw_pending_ && expired(first_raw_, kBackgroundMouseCorrelationMs))) PauseLocked();
  }
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
  bool monitoring_ = false;
  bool hook_seen_ = false;
  bool raw_pending_ = false;
  std::uint64_t hook_heartbeat_ = 0, raw_heartbeat_ = 0;
  std::uint64_t last_hook_ = 0, first_raw_ = 0;
  std::uint64_t latest_ = 0;
  std::uint64_t next_claim_ = 0;
  std::uint64_t active_claim_ = 0;
};

} // namespace sprint_coder::computer_use
