#pragma once

// Private session owner. The lane serializes calls; claim runs a bounded transition under the
// same lock as Stop. Measurement and input never run under that lock. No secret crosses the wire.
#include "computer_use_windows_approval_measurement.h"
#include "computer_use_windows_approval_wire.h"
#include "computer_use_native_approved_risk.h"

#include <functional>

namespace sprint_coder::computer_use {

struct WindowsApprovalReference {
  std::uint64_t helper_generation = 0;
  std::uint64_t stop_serial = 0;
  NativeApprovalFacts facts;
};

struct WindowsApprovalClickBasis {
  bool tracked = false;
  bool opens = false;
  bool input_read = false;
  std::uint32_t input_tick = 0;
};

struct WindowsApprovalSample {
  NativeApprovalMeasurement measured;
  WindowsApprovalDisplay display;
  NativeRiskBits risk;
  bool metadata_complete = false;
  WindowsApprovalClickBasis click_basis;
};

// The same Windows-only entry at all three boundaries; never the ordinary interlock evaluator.
[[nodiscard]] inline WindowsApprovalSample MeasureWindowsApprovalSample(
    const WindowsApprovalMeasurementInput &input, WindowsApprovalDisplay display,
    NativeRiskBits risk, bool metadata_complete) {
  WindowsApprovalSample sample{MeasureWindowsApproval(input), std::move(display), risk,
                               metadata_complete};
  if (!sample.measured.eligible) return sample;
  const auto effect = sample.measured.effect;
  if (effect == NativeApprovalEffect::kDownloadOpen ||
      effect == NativeApprovalEffect::kFileManagerOpen) {
    const auto expected = effect == NativeApprovalEffect::kDownloadOpen
                              ? EffectClass::kE2DownloadOpen : EffectClass::kE3FileManagerOpen;
    if (input.open_facts == nullptr || input.open_facts->effect != expected ||
        JudgeWindowsOpenFacts(*input.open_facts) != WindowsOpenVerdict::kVerified) {
      sample.measured.eligible = false;
      sample.measured.takeover = true;
      return sample;
    }
    sample.measured.authority_digest = Sha256Hex(
        sample.measured.authority_digest + WindowsOpenFactsDigest(*input.open_facts));
  }
  // Bind exactly the display fields that will be serialized, including absence and warning.
  std::string framed = "windows-approval-display-v1";
  const auto append = [&framed](const std::optional<std::string> &value) {
    framed += value ? "P" + std::to_string(value->size()) + ":" + *value : "A";
  };
  append(sample.display.operation);
  append(sample.display.target_label);
  append(sample.display.extension);
  framed += sample.display.unsigned_main_image ? "1" : "0";
  framed += std::to_string(static_cast<unsigned>(sample.display.effect));
  sample.measured.authority_digest = Sha256Hex(sample.measured.authority_digest + framed);
  if (sample.display.effect != effect ||
      !NativePreflightAllowsDispatch(ClassifyWindowsNativeRisk(risk, metadata_complete, effect)))
    sample.measured.eligible = false;
  return sample;
}

struct WindowsApprovalEnvironment {
  std::function<std::uint64_t()> now;
  std::function<bool(std::string *)> random;
  // The callback receives the original frame reference, not a serial refreshed after a wait.
  std::function<bool(const WindowsApprovalReference &, const std::function<void()> &)> claim;
  std::function<WindowsApprovalSample(std::uint64_t)> measure;
};

class WindowsApprovalHandlers {
public:
  [[nodiscard]] bool Offer(const WindowsApprovalReference &reference,
                           const WindowsApprovalReceiptContext &receipt_context,
                           const WindowsApprovalEnvironment &environment, std::string *receipt) {
    Invalidate();
    if (receipt == nullptr || !Valid(reference) || !EnvironmentValid(environment)) return false;
    receipt->clear();
    const auto start = environment.now();
    if (start > (std::numeric_limits<std::uint64_t>::max)() - kNativeApprovalWaitMaxNs)
      return false;
    const auto deadline = WindowsOpenMeasurementDeadline(start, start + kNativeApprovalWaitMaxNs);
    const auto sample = environment.measure(deadline);
    const auto after = environment.now();
    if (!InBudget(start, after, deadline) || !SampleEligible(sample))
      return false;
    std::uint64_t generation = 0;
    if (!NextNativeApprovalGeneration(last_generation_, &generation)) return false;
    NativeApprovalOfferContext context{reference.facts.session_id, reference.facts.task_id,
        reference.facts.turn_id, reference.facts.request_id, reference.facts.action_digest,
        reference.facts.payload_digest, reference.facts.cancel_epoch, generation,
        reference.facts.observation_revision, reference.facts.ticket_generation};
    NativeApprovalIntentBinding binding;
    if (!BuildApprovalIntentBinding(sample.measured, context, &binding)) return false;
    std::string token;
    if (!environment.random(&token)) { ScrubNativeTicketString(&token); return false; }
    bool offered = false;
    const bool claimed = environment.claim(reference, [&] {
      const auto now = environment.now();
      if (!InBudget(start, now, deadline)) return;
      const auto expires = start + kNativeApprovalWaitMaxNs;
      const NativeApprovalOffer offer{generation, NativeApprovalRemainingMs(now, expires),
                                      sample.measured.effect};
      auto serialized = WindowsApprovalOfferReceipt(receipt_context, offer, sample.display);
      if (serialized.empty()) return;
      offered = flow_.Offer(token, std::move(binding), now, expires - now);
      if (!offered) return;
      helper_generation_ = reference.helper_generation;
      stop_serial_ = reference.stop_serial;
      last_generation_ = generation;
      last_time_ = now;
      deadline_ = expires;
      *receipt = std::move(serialized);
    });
    ScrubNativeTicketString(&token);
    if (!claimed || !offered) { Invalidate(); receipt->clear(); return false; }
    return true;
  }

  [[nodiscard]] NativeApprovalOutcome Approve(const WindowsApprovalReference &reference,
                                               const WindowsApprovalEnvironment &environment) {
    return Transition(reference, environment, false, nullptr);
  }

  // A successful return is a single claimed dispatch. The caller transfers the returned effect
  // to its input owner, which must recheck Stop/deadline immediately before each OS API attempt.
  [[nodiscard]] NativeApprovalOutcome Dispatch(const WindowsApprovalReference &reference,
                                                const WindowsApprovalEnvironment &environment,
                                                NativeApprovalEffect *effect) {
    if (effect == nullptr) return {false, NativeApprovalFailure::kUnavailable};
    *effect = NativeApprovalEffect::kInvalid;
    return Transition(reference, environment, true, effect);
  }

  bool Discard(const WindowsApprovalReference &reference) {
    if (!Matches(reference)) return false;
    Invalidate();
    return true;
  }
  void Invalidate() noexcept { flow_.Invalidate(); deadline_ = 0; }
  [[nodiscard]] std::uint64_t deadline() const noexcept { return deadline_; }
  [[nodiscard]] std::uint64_t claimed_at() const noexcept { return last_time_; }
  [[nodiscard]] bool occupied() const noexcept { return flow_.occupied(); }
  [[nodiscard]] const WindowsApprovalClickBasis &dispatch_click_basis() const noexcept {
    return dispatch_click_basis_;
  }

private:
  static bool Valid(const WindowsApprovalReference &reference) {
    return reference.helper_generation > 0 &&
           reference.helper_generation <= kNativeApprovalGenerationMax &&
           !reference.facts.session_closed &&
           reference.facts.cancel_epoch == reference.facts.current_cancel_epoch;
  }
  static bool EnvironmentValid(const WindowsApprovalEnvironment &environment) {
    return environment.now && environment.random && environment.claim && environment.measure;
  }
  static bool SampleEligible(const WindowsApprovalSample &sample) {
    return sample.measured.eligible && !sample.measured.takeover &&
        sample.display.effect == sample.measured.effect &&
        NativePreflightAllowsDispatch(ClassifyWindowsNativeRisk(
            sample.risk, sample.metadata_complete, sample.measured.effect));
  }
  static bool InBudget(std::uint64_t start, std::uint64_t now, std::uint64_t deadline) {
    return deadline > start && now >= start && now < deadline;
  }
  bool Matches(const WindowsApprovalReference &reference) const {
    return reference.helper_generation == helper_generation_ && flow_.occupied() &&
           reference.facts.approval_generation == flow_.approval_generation();
  }
  NativeApprovalOutcome Burn(NativeApprovalFailure failure) {
    Invalidate();
    return {false, failure};
  }
  NativeApprovalOutcome Transition(const WindowsApprovalReference &reference,
      const WindowsApprovalEnvironment &environment, bool dispatch, NativeApprovalEffect *effect) {
    if (!Matches(reference)) return {false, NativeApprovalFailure::kUnavailable};
    if (!Valid(reference) || reference.stop_serial != stop_serial_)
      return Burn(NativeApprovalFailure::kCanceled);
    if (!EnvironmentValid(environment)) return Burn(NativeApprovalFailure::kUnavailable);
    const auto start = environment.now();
    if (start < last_time_ || start >= deadline_) return Burn(NativeApprovalFailure::kExpired);
    const auto measurement_deadline = WindowsOpenMeasurementDeadline(start, deadline_);
    if (measurement_deadline <= start) return Burn(NativeApprovalFailure::kExpired);
    const auto sample = environment.measure(measurement_deadline);
    const auto after = environment.now();
    if (!InBudget(start, after, measurement_deadline)) return Burn(NativeApprovalFailure::kExpired);
    if (!SampleEligible(sample)) return Burn(sample.measured.takeover
        ? NativeApprovalFailure::kTakeover : NativeApprovalFailure::kRevalidationFailed);
    std::string token;
    if (!dispatch && !environment.random(&token)) {
      ScrubNativeTicketString(&token);
      return Burn(NativeApprovalFailure::kTicketUnavailable);
    }
    NativeApprovalOutcome outcome{false, NativeApprovalFailure::kCanceled};
    const bool claimed = environment.claim(reference, [&] {
      const auto now = environment.now();
      if (!InBudget(after, now, measurement_deadline)) {
        outcome = Burn(NativeApprovalFailure::kExpired);
        return;
      }
      outcome = dispatch ? flow_.ConsumeApproved(reference.facts, sample.measured, now)
                         : flow_.Approve(reference.facts, sample.measured, token, now);
      if (!outcome.ok) return;
      last_time_ = now;
      if (dispatch) {
        *effect = sample.measured.effect;
        deadline_ = measurement_deadline;
        dispatch_click_basis_ = sample.click_basis;
      }
      else deadline_ = (std::min)(deadline_, now + kNativeApprovalExecutionTtlNs);
    });
    ScrubNativeTicketString(&token);
    if (!claimed) return Burn(NativeApprovalFailure::kCanceled);
    return outcome;
  }
  NativeApprovalFlow flow_;
  WindowsApprovalClickBasis dispatch_click_basis_;
  std::uint64_t helper_generation_ = 0;
  std::uint64_t stop_serial_ = 0;
  std::uint64_t last_generation_ = 0;
  std::uint64_t last_time_ = 0;
  std::uint64_t deadline_ = 0;
};

} // namespace sprint_coder::computer_use
