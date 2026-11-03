#pragma once
#include "computer_use_protocol.h"
#include <cstdint>
#include <limits>
#include <mutex>
#include <set>
#include <string>

namespace sprint_coder::computer_use {

struct ApprovalRoundTripBinding {
  std::string id, session, task, turn;
  std::uint64_t generation = 0, epoch = 0;
  bool operator==(const ApprovalRoundTripBinding &) const = default;
};
enum class ApprovalRoundTripFocus { kTarget, kSprintCoder, kOther, kShell, kExplorer, kDesktop };

// Times are durations on the helper's steady clock, never Main's absolute timestamps.
// The monitor and consumer share this owner; no failure depends on event delivery to Main.
class WindowsApprovalRoundTrip {
public:
  bool Begin(const ApprovalRoundTripBinding &binding, std::uint64_t now,
             std::uint64_t duration, std::uint64_t remaining,
             std::uint64_t observation, std::uint64_t ticket, bool monitor_ready) {
    std::lock_guard lock(mutex_);
    const auto identifier = [](const std::string &value) { return !value.empty() && value.size() <= 256; };
    if ((phase_ != Phase::kIdle && phase_ != Phase::kOffered) || !identifier(binding.id) || !identifier(binding.session) ||
        !identifier(binding.task) || !identifier(binding.turn) || binding.generation == 0 ||
        binding.generation > 9007199254740991ULL || binding.epoch > 9007199254740991ULL ||
        used_.contains(binding.id) || duration == 0 || duration > kApprovalRoundTripMaxDurationMs ||
        duration > remaining || now > (std::numeric_limits<std::uint64_t>::max)() - duration ||
        !monitor_ready || observation == 0) return false;
    binding_ = binding;
    used_.insert(binding.id);
    last_ = now;
    expires_ = now + duration;
    observation_ = observation;
    ticket_ = ticket;
    phase_ = Phase::kActive;
    return true;
  }
  void Observe(ApprovalRoundTripFocus focus, bool healthy, bool guards, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    if (phase_ == Phase::kIdle || phase_ == Phase::kFailed) return;
    if (!Tick(now)) return;
    if (!healthy) Fail("monitor_failed");
    else if (!guards) Fail("target_changed");
    else if (focus != ApprovalRoundTripFocus::kTarget && focus != ApprovalRoundTripFocus::kSprintCoder)
      Fail("third_window");
    else if ((phase_ == Phase::kReturned || phase_ == Phase::kExchanged || phase_ == Phase::kEnded) &&
             focus != ApprovalRoundTripFocus::kTarget) Fail("third_window");
  }
  bool Return(const ApprovalRoundTripBinding &binding, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    if (!Match(binding, now) || phase_ != Phase::kActive) return Fail("target_changed");
    phase_ = Phase::kReturning;
    return true;
  }
  bool Returned(const ApprovalRoundTripBinding &binding, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    if (!Match(binding, now) || phase_ != Phase::kReturning) return Fail("target_changed");
    phase_ = Phase::kReturned;
    return true;
  }
  // Called only after the existing native remeasurement/classifier successfully exchanged.
  bool Exchange(const ApprovalRoundTripBinding &binding, std::uint64_t observation,
                std::uint64_t ticket, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    if (!Match(binding, now) || phase_ != Phase::kReturned ||
        observation <= observation_ || ticket <= ticket_) return Fail("target_changed");
    phase_ = Phase::kExchanged;
    return true;
  }
  // Closing the V1 trip grants no input; its id remains spent.
  bool Offer(const ApprovalRoundTripBinding &binding, std::uint64_t observation, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    if (!Match(binding, now) || phase_ != Phase::kReturned || observation <= observation_)
      return Fail("target_changed");
    phase_ = Phase::kOffered;
    return true;
  }
  bool MayBegin() const {
    std::lock_guard lock(mutex_);
    return phase_ == Phase::kIdle || phase_ == Phase::kOffered;
  }
  bool End(const ApprovalRoundTripBinding &binding, bool approved, std::uint64_t now) {
    std::lock_guard lock(mutex_);
    if (!Match(binding, now) || !approved || phase_ != Phase::kExchanged)
      return Fail(approved ? "target_changed" : "rejected");
    phase_ = Phase::kEnded;
    return true;
  }
  bool MayInput(std::uint64_t now) {
    std::lock_guard lock(mutex_);
    return phase_ == Phase::kIdle || (Tick(now) && phase_ == Phase::kEnded);
  }
  bool MayObserve() const {
    std::lock_guard lock(mutex_);
    return phase_ == Phase::kIdle || phase_ == Phase::kReturned;
  }
  bool MayLegacyStart() const {
    std::lock_guard lock(mutex_);
    return phase_ == Phase::kIdle;
  }
  bool FocusException() const {
    std::lock_guard lock(mutex_);
    return phase_ == Phase::kActive || phase_ == Phase::kReturning;
  }
  bool Failed() const {
    std::lock_guard lock(mutex_);
    return phase_ == Phase::kFailed;
  }
  std::string Failure() const {
    std::lock_guard lock(mutex_);
    return failure_;
  }
  void TargetEvent() {
    std::lock_guard lock(mutex_);
    if (phase_ != Phase::kIdle) Fail("target_changed");
  }
  void Invalidate(const char *reason = "target_changed") {
    std::lock_guard lock(mutex_);
    Fail(reason);
  }
  void InputFinished() {
    std::lock_guard lock(mutex_);
    if (phase_ == Phase::kEnded) phase_ = Phase::kIdle;
  }

private:
  enum class Phase { kIdle, kActive, kReturning, kReturned, kOffered, kExchanged, kEnded, kFailed };
  bool Fail(const char *reason) {
    if (phase_ != Phase::kFailed) failure_ = reason;
    phase_ = Phase::kFailed;
    return false;
  }
  bool Tick(std::uint64_t now) {
    if (phase_ == Phase::kFailed) return false;
    if (now < last_ || now >= expires_) return Fail("expired");
    last_ = now;
    return true;
  }
  bool Match(const ApprovalRoundTripBinding &binding, std::uint64_t now) {
    return Tick(now) && (binding == binding_ || Fail("target_changed"));
  }
  mutable std::mutex mutex_;
  Phase phase_ = Phase::kIdle;
  ApprovalRoundTripBinding binding_;
  std::set<std::string> used_;
  std::uint64_t last_ = 0, expires_ = 0, observation_ = 0, ticket_ = 0;
  std::string failure_ = "none";
};
// Every preflight exit must either commit an exchange/offer or latch failure.
struct WindowsRoundTripPreflightGuard {
  WindowsApprovalRoundTrip *state;
  const bool &completed;
  ~WindowsRoundTripPreflightGuard() {
    if (!completed && state && !state->MayLegacyStart()) state->Invalidate();
  }
};
} // namespace sprint_coder::computer_use
