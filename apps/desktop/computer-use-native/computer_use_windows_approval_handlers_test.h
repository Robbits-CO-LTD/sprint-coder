#pragma once

#include "computer_use_windows_approval_handlers.h"

namespace windows_approval_handlers_test {
using namespace sprint_coder::computer_use;

struct Fixture {
  WindowsApprovalHandlers owner;
  WindowsApprovalReference reference;
  WindowsApprovalSample sample;
  std::uint64_t now = 1'000'000'000;
  std::uint64_t measurement_delay = 0;
  std::uint64_t claim_delay = 0;
  bool stopped = false;
  bool hung_owner = false;
  bool stop_during_measurement = false;
  bool random_ok = true;
  unsigned tokens = 0;
  unsigned approved_inputs = 0;
  // Counted by the preflight route below: an ordinary ticket is issued only where the gated
  // preflight hands the request to the ordinary interlock and that interlock finds it ordinary.
  unsigned ordinary_tickets = 0;
  unsigned interlock_refusals = 0;
  WindowsApprovalPreflightRoute route = WindowsApprovalPreflightRoute::kRefuse;
  Fixture() {
    reference.helper_generation = 7;
    reference.stop_serial = 11;
    auto &facts = reference.facts;
    facts.session_id = "session-1";
    facts.task_id = "task-1";
    facts.turn_id = "turn-1";
    facts.request_id = "request-1";
    facts.context_digest = std::string(64, 'a');
    facts.action_digest = std::string(64, 'b');
    facts.payload_digest = std::string(64, 'c');
    facts.observation_revision = facts.ticket_generation = 1;
    sample.measured = {true, false, NativeApprovalEffect::kSupervisedAction,
                       std::string(64, 'd'), 3, 2, 3};
    sample.display = {NativeApprovalEffect::kSupervisedAction, "invoke", std::nullopt,
                      std::nullopt, false};
    sample.risk.classified = sample.metadata_complete = true;
    sample.decision = DecisionKind::kApproval;
  }
  WindowsApprovalEnvironment Environment() {
    return {[this] { return now; }, [this](std::string *token) {
        *token = std::string(64, (++tokens % 2) ? 'e' : 'f');
        return random_ok;
      }, [this](const WindowsApprovalReference &r, const std::function<void()> &commit) {
        now += claim_delay;
        if (stopped || hung_owner || r.stop_serial != 11 || r.helper_generation != 7) return false;
        commit();
        return true;
      }, [this](std::uint64_t) {
        now += measurement_delay;
        if (stop_during_measurement) stopped = true;
        return sample;
      }};
  }
  // The gated preflight: one Offer, then RouteWindowsApprovalPreflight on its measurement. The
  // ordinary interlock is represented by its outcome for the measured decision: an ordinary ticket
  // for an ordinary decision, its own refusal for anything else.
  bool Offer() {
    std::string receipt;
    WindowsApprovalSample measured;
    const bool ok = owner.Offer(reference, {"request-1", "session-1", 0, 1, 0}, Environment(),
                                &receipt, &measured);
    route = RouteWindowsApprovalPreflight(ok, measured);
    if (route == WindowsApprovalPreflightRoute::kInterlock) {
      if (measured.decision == DecisionKind::kOrdinary || measured.outside_approval_scope)
        ++ordinary_tickets;
      else
        ++interlock_refusals;
    }
    if (ok != (route == WindowsApprovalPreflightRoute::kOffered)) return false;
    if (ok && (receipt.empty() || receipt.find(std::string(64, 'e')) != std::string::npos))
      return false;
    reference.facts.approval_generation = 1;
    reference.facts.request_id = "request-2";
    reference.facts.observation_revision = reference.facts.ticket_generation = 2;
    return ok;
  }
  bool Approve() { return owner.Approve(reference, Environment()).ok; }
  bool Dispatch() {
    NativeApprovalEffect effect;
    const bool ok = owner.Dispatch(reference, Environment(), &effect).ok;
    if (ok && effect != NativeApprovalEffect::kInvalid) ++approved_inputs;
    return ok;
  }
};

inline bool Check() {
  // Single use, private tokens, no ordinary ticket/input, and all four effect bindings.
  for (const auto effect : {NativeApprovalEffect::kSupervisedAction,
       NativeApprovalEffect::kHighImpactConfirmation, NativeApprovalEffect::kDownloadOpen,
       NativeApprovalEffect::kFileManagerOpen}) {
    Fixture f;
    f.sample.measured.effect = f.sample.display.effect = effect;
    if (effect == NativeApprovalEffect::kDownloadOpen || effect == NativeApprovalEffect::kFileManagerOpen) {
      f.sample.display.target_label = "Synthetic item";
      f.sample.display.extension = "txt";
    }
    if (!f.Offer() || !f.Approve() || !f.Dispatch() || f.Dispatch() || f.Approve() ||
        f.approved_inputs != 1 || f.ordinary_tickets != 0) return false;
  }
  // Pending 60 seconds and ready 5 seconds: equality expires; the last nanosecond is live.
  for (const auto offset : {59'999'999'999ULL, 60'000'000'000ULL, 60'000'000'001ULL}) {
    Fixture f;
    if (!f.Offer()) return false;
    f.now += offset;
    if (f.Approve() != (offset < kNativeApprovalWaitMaxNs)) return false;
  }
  for (const auto offset : {4'999'999'999ULL, 5'000'000'000ULL, 5'000'000'001ULL}) {
    Fixture f;
    if (!f.Offer() || !f.Approve()) return false;
    f.now += offset;
    if (f.Dispatch() != (offset < kNativeApprovalExecutionTtlNs)) return false;
  }
  {
    Fixture f;
    if (!f.Offer()) return false;
    f.now += 59'999'999'999ULL;
    if (!f.Approve()) return false;
    ++f.now;
    if (f.Dispatch()) return false; // execution cannot extend the intent deadline
  }
  for (const bool dispatch : {false, true}) {
    for (const auto delay : {149'999'999ULL, 150'000'000ULL, 150'000'001ULL}) {
      Fixture f;
      if (!f.Offer() || (dispatch && !f.Approve())) return false;
      f.measurement_delay = delay;
      const bool result = dispatch ? f.Dispatch() : f.Approve();
      if (result != (delay < 150'000'000ULL)) return false;
      if (!result && f.owner.occupied()) return false;
    }
    for (const bool during_claim : {false, true}) {
      Fixture f;
      if (!f.Offer() || (dispatch && !f.Approve())) return false;
      f.now = f.owner.deadline() - 1;
      if (during_claim) f.claim_delay = 1; else f.measurement_delay = 1;
      if ((dispatch ? f.Dispatch() : f.Approve()) || f.owner.occupied()) return false;
    }
    Fixture backwards;
    if (!backwards.Offer() || (dispatch && !backwards.Approve())) return false;
    --backwards.now;
    if ((dispatch ? backwards.Dispatch() : backwards.Approve()) || backwards.owner.occupied()) return false;
  }
  {
    Fixture f;
    f.now = (std::numeric_limits<std::uint64_t>::max)() - kNativeApprovalWaitMaxNs + 1;
    if (f.Offer()) return false;
  }
  for (unsigned mismatch = 0; mismatch < 14; ++mismatch) {
    Fixture f;
    if (!f.Offer() || !f.Approve()) return false;
    switch (mismatch) {
    case 0: ++f.reference.helper_generation; break;
    case 1: ++f.reference.facts.approval_generation; break;
    case 2: ++f.reference.stop_serial; break;
    case 3: ++f.reference.facts.current_cancel_epoch; break;
    case 4: f.sample.measured.authority_digest = std::string(64, 'a'); break;
    case 5: f.reference.facts.payload_digest = std::string(64, 'a'); break;
    case 6: ++f.reference.facts.ticket_generation; break;
    case 7: f.stopped = true; break;
    case 8: f.hung_owner = true; break;
    case 9: f.sample.measured.takeover = true; break;
    case 10: f.sample.metadata_complete = false; break;
    case 11: f.sample.risk.secure = true; break;
    case 12: f.sample.risk.high_impact = f.sample.risk.other = true; break;
    case 13: f.stop_during_measurement = true; break;
    }
    if (f.Dispatch() || f.approved_inputs || f.ordinary_tickets) return false;
    if (f.owner.occupied() != (mismatch < 2)) return false;
  }
  {
    Fixture f;
    f.reference.helper_generation = 0;
    if (f.Offer()) return false;
  }
  {
    Fixture f;
    if (!f.Offer()) return false;
    auto stale = f.reference;
    ++stale.helper_generation;
    if (f.owner.Discard(stale) || !f.owner.occupied() || !f.owner.Discard(f.reference) ||
        f.Approve() || f.Dispatch()) return false;
  }
  {
    Fixture f;
    if (!f.Offer()) return false;
    f.owner.Invalidate(); // cancel/close, independent of a late worker result
    if (f.Approve() || f.Dispatch()) return false;
  }
  // The gated preflight keeps ordinary work ordinary (a full_access_app click on a plain control):
  // a measured ordinary decision gets the ordinary interlock and its ticket, and no approval.
  {
    Fixture f;
    f.sample.measured = {};
    f.sample.decision = DecisionKind::kOrdinary;
    if (f.Offer() || f.route != WindowsApprovalPreflightRoute::kInterlock ||
        f.ordinary_tickets != 1 || f.owner.occupied() || f.Approve() || f.Dispatch() ||
        f.approved_inputs != 0) return false;
  }
  // A blocked decision reaches the same interlock, which refuses with its own reason code.
  {
    Fixture f;
    f.sample.measured = {};
    f.sample.decision = DecisionKind::kBlocked;
    if (f.Offer() || f.route != WindowsApprovalPreflightRoute::kInterlock ||
        f.interlock_refusals != 1 || f.ordinary_tickets != 0 || f.owner.occupied()) return false;
  }
  // Text longer than one scalar is outside any approval: the ordinary interlock decides.
  {
    Fixture f;
    f.sample = {};
    f.sample.outside_approval_scope = true;
    if (f.Offer() || f.route != WindowsApprovalPreflightRoute::kInterlock ||
        f.ordinary_tickets != 1 || f.owner.occupied()) return false;
  }
  // Fail closed, never an ordinary ticket: an approval that cannot be offered, a takeover, an
  // unmeasured sample, a measurement past its budget, an eligible measurement whose offer failed
  // (Stop at the claim, no token), and an eligible effect whose decision is not an approval.
  for (unsigned refusal = 0; refusal < 8; ++refusal) {
    Fixture f;
    switch (refusal) {
    case 0: f.sample.measured.eligible = false; break; // kApproval measured, not offerable
    case 1: f.sample.measured.eligible = false; f.sample.measured.takeover = true; break;
    case 2: f.sample = {}; break;
    case 3: f.measurement_delay = 150'000'000ULL; f.sample.decision = DecisionKind::kOrdinary;
            f.sample.measured = {}; break;
    case 4: f.stopped = true; break;
    case 5: f.random_ok = false; break;
    case 6: f.sample.decision = DecisionKind::kOrdinary; break;
    case 7: f.sample.outside_approval_scope = true; break;
    }
    if (f.Offer() || f.route != WindowsApprovalPreflightRoute::kRefuse ||
        f.ordinary_tickets != 0 || f.interlock_refusals != 0 || f.owner.occupied() ||
        f.Approve() || f.Dispatch() || f.approved_inputs != 0) return false;
  }
  return true;
}
} // namespace windows_approval_handlers_test
