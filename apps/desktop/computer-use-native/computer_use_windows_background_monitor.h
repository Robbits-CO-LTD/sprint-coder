#pragma once
#include <chrono>
#include <cstdint>
#include <limits>
#include <mutex>
#include <array>
#if defined(_WIN32) && !defined(_WINDOWS_)
// The same declaration as <windows.h>, without its macros (min/max/near) in every includer.
extern "C" __declspec(dllimport) unsigned long __stdcall GetTickCount(void);
#endif

namespace sprint_coder::computer_use {

enum class BackgroundInputOwner { kNone, kOther, kTarget, kUnknown };
enum class BackgroundMonitorPump { kHook, kRaw };
enum class BackgroundPattern { kNone, kInvoke, kValue, kToggle, kSelectionItem, kExpandCollapse, kScroll };
// Provisional delivery allowance, not measured provider guarantees. Equality is expired.
inline constexpr std::uint64_t kBackgroundEventGraceMs = 150;
inline constexpr unsigned kBackgroundEventLimit = 16;
struct BackgroundEventPermission {
  std::uintptr_t hwnd = 0;
  std::array<std::uint32_t, 5> events{};
  std::array<unsigned, 5> limits{};
  bool child_known = false;
  std::int32_t object = 0, child = 0;
};
// WinUser.h event IDs, kept portable for the state-machine tests. Only direct pattern effects:
// no CREATE/DESTROY, focus, foreground, capture or MOVESIZE, even on the bound HWND.
inline BackgroundEventPermission BackgroundPatternPermission(BackgroundPattern pattern,
                                                              std::uintptr_t hwnd) {
  BackgroundEventPermission permission;
  permission.hwnd = hwnd;
  switch (pattern) {
    case BackgroundPattern::kInvoke: permission.events = {0x8013, 0x800a}; permission.limits = {1, 2}; break;
    case BackgroundPattern::kValue: permission.events = {0x800e, 0x800c}; permission.limits = {2, 2}; break;
    case BackgroundPattern::kToggle: permission.events = {0x800a}; permission.limits = {2}; break;
    case BackgroundPattern::kSelectionItem:
      permission.events = {0x800a, 0x8006, 0x8007, 0x8008, 0x8009}; permission.limits = {2, 1, 1, 1, 1}; break;
    case BackgroundPattern::kExpandCollapse:
      permission.events = {0x800a}; permission.limits = {2}; break;
    case BackgroundPattern::kScroll: permission.events = {0x800e}; permission.limits = {2}; break;
    case BackgroundPattern::kNone: break;
  }
  // One invocation/selection notification per kind; state/value/name allow a paired update.
  // These conservative caps are provisional, not measured provider guarantees (P7b).
  return permission;
}
// Provisional fail-closed bounds; real-device measurements are required before publication.
inline constexpr std::uint64_t kBackgroundMouseCorrelationMs = 100;
inline constexpr std::uint64_t kBackgroundHeartbeatIntervalMs = 20;
inline constexpr std::uint64_t kBackgroundHeartbeatTimeoutMs = 250;
inline std::uint64_t BackgroundMonitorNow() {
  return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
}
inline std::uint32_t BackgroundEventTick() {
#if defined(_WIN32)
  return ::GetTickCount(); // Same wrapping clock as WinEvent's dwmsEventTime.
#else
  return static_cast<std::uint32_t>(BackgroundMonitorNow());
#endif
}
struct BackgroundMonitorSnapshot {
  std::uint64_t epoch = 1;
  bool paused = false;
  bool unknown_effect = false;
};

// This mutex is the linearization boundary for monitor callbacks and the final claim.
// Callers may hold Stop before taking it, never the reverse. Only clock reads (including
// GetTickCount) run locked; no window queries or provider calls run under this mutex.
// Notification delivery cannot reopen this state; human resume must create fresh authority.
class WindowsBackgroundMonitorState {
public:
  using TickClock = std::uint32_t (*)();
  explicit WindowsBackgroundMonitorState(std::uint64_t epoch = 1,
      TickClock tick_clock = BackgroundEventTick) : tick_clock_(tick_clock) {
    state_.epoch = epoch;
    if (epoch == 0) state_.paused = true;
  }
  void Registered(bool success) {
    std::lock_guard lock(mutex_);
    if (!success || registered_) PauseLocked();
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
  void TargetEvent(BackgroundInputOwner owner, std::uint32_t event = 0,
                   std::uintptr_t hwnd = 0, std::int32_t object = 0, std::int32_t child = 0,
                   std::uint32_t event_tick = 0) {
    if (owner == BackgroundInputOwner::kOther) return;
    std::lock_guard lock(mutex_);
    TargetEventLocked(owner, event, hwnd, object, child, event_tick, BackgroundMonitorNow());
  }
  // Tests only: production samples time under the same lock as Claim and Finish.
  void TargetEvent(BackgroundInputOwner owner, std::uint32_t event, std::uintptr_t hwnd,
                   std::int32_t object, std::int32_t child, std::uint32_t event_tick, std::uint64_t now) {
    if (owner == BackgroundInputOwner::kOther) return;
    std::lock_guard lock(mutex_);
    TargetEventLocked(owner, event, hwnd, object, child, event_tick, now);
  }
private:
  void TargetEventLocked(BackgroundInputOwner owner, std::uint32_t event, std::uintptr_t hwnd,
                         std::int32_t object, std::int32_t child, std::uint32_t event_tick, std::uint64_t now) {
    const auto observed = ObserveLocked(now);
    CheckHealthLocked(observed);
    // This bounded correlation is not proof of origin: another UIA client can perform the same
    // operation on the same element concurrently. ADR 2.5 display/isolation still applies.
    // Reject pre-claim generation even if delivery was delayed. Same-tick ordering is
    // ambiguous, so equality fails closed too; signed subtraction tolerates DWORD wrap.
    std::size_t kind = permission_.events.size();
    for (std::size_t i = 0; i < permission_.events.size(); ++i)
      if (permission_.events[i] != 0 && permission_.events[i] == event) kind = i;
    const bool forbidden = event == 3 || (event >= 8 && event <= 11) ||
        event == 0x8000 || event == 0x8001;
    if (owner == BackgroundInputOwner::kTarget && registered_ && !state_.paused &&
        permission_.hwnd != 0 && hwnd == permission_.hwnd && now >= claim_started_ &&
        static_cast<std::int32_t>(event_tick - claim_tick_) > 0 &&
        (active_claim_ != 0 || (grace_ && observed < grace_deadline_)) &&
        (!permission_.child_known || (object == permission_.object && child == permission_.child)) &&
        kind < permission_.events.size() && !forbidden && exempted_ < kBackgroundEventLimit &&
        kind_counts_[kind] < permission_.limits[kind]) {
      ++exempted_;
      ++kind_counts_[kind];
      return;
    }
    PauseLocked();
  }
public:
  void Pause() {
    std::lock_guard lock(mutex_);
    PauseLocked();
  }
  // Atomically retire background authority before shutting down its monitor threads.
  bool RetireForForeground(std::uint64_t expected_epoch) {
    std::lock_guard lock(mutex_);
    CheckHealthLocked(ObserveLocked(BackgroundMonitorNow()));
    const bool admitted = registered_ && !state_.paused && !state_.unknown_effect &&
        active_claim_ == 0 && expected_epoch == state_.epoch;
    PauseLocked();
    return admitted;
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
  std::uint64_t Claim(std::uint64_t expected_epoch, const BackgroundEventPermission &permission) {
    std::lock_guard lock(mutex_);
    return ClaimLocked(expected_epoch, BackgroundMonitorNow(), permission);
  }
  std::uint64_t Claim(std::uint64_t expected_epoch, const BackgroundEventPermission &permission,
                      std::uint64_t now) {
    std::lock_guard lock(mutex_);
    return ClaimLocked(expected_epoch, now, permission);
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
    now = ObserveLocked(now);
    CheckHealthLocked(now);
    active_claim_ = 0;
    grace_ = !state_.paused && !state_.unknown_effect && permission_.hwnd != 0 &&
        now <= (std::numeric_limits<std::uint64_t>::max)() - kBackgroundEventGraceMs;
    if (grace_) grace_deadline_ = now + kBackgroundEventGraceMs;
    return !state_.paused && !state_.unknown_effect;
  }
  std::uint64_t ClaimLocked(std::uint64_t expected_epoch, std::uint64_t now,
                            const BackgroundEventPermission &permission = {}) {
    now = ObserveLocked(now);
    CheckHealthLocked(now);
    if (!registered_ || state_.paused || expected_epoch != state_.epoch || active_claim_ != 0 ||
        (grace_ && now < grace_deadline_))
      return 0;
    if (next_claim_ == (std::numeric_limits<std::uint64_t>::max)()) {
      PauseLocked();
      return 0;
    }
    active_claim_ = ++next_claim_;
    permission_ = permission;
    claim_tick_ = tick_clock_();
    claim_started_ = now;
    exempted_ = 0;
    kind_counts_ = {};
    grace_ = false;
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
    permission_ = {};
    grace_ = false;
    // Close first, then advance, then let a caller publish the snapshot. Saturation never wraps.
    if (!state_.paused) {
      state_.paused = true;
      if (state_.epoch != (std::numeric_limits<std::uint64_t>::max)()) ++state_.epoch;
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
  BackgroundEventPermission permission_;
  const TickClock tick_clock_;
  std::uint32_t claim_tick_ = 0;
  std::array<unsigned, 5> kind_counts_{};
  std::uint64_t claim_started_ = 0, grace_deadline_ = 0;
  unsigned exempted_ = 0;
  bool grace_ = false;
};

} // namespace sprint_coder::computer_use
