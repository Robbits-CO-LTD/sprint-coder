#pragma once

// Pure, portable (C++20) approval flow for one native session: the policy that connects the
// private approval slot to the three addon calls `approvalApprove`, `approvalDiscard` and
// `dispatchApproved` (ADR v2 S4-4 addendum). No platform header, N-API, hash, random source or
// clock: the owner holds its state lock, injects a monotonic clock value, supplies an already
// generated execution token and passes freshly *measured* facts. It must stay compilable by MSVC
// (/W4 /sdl) and clang without platform headers.
//
// What this file decides, and what it does not:
//   * It never begins an intent by itself. `Offer` is the only way in and exists for the classifier
//     v2 change and for the harness; the macOS addon does not call it, so a production native has
//     no pending approval and every approve / dispatchApproved fails closed.
//   * Approve and ConsumeApproved never issue a new intent. A fresh classification that still is
//     `single_use_approval` is NOT a reason to refuse: the approved action is exactly that. It is
//     accepted, once, only when it matches the bound ticket (target, payload, authority, effect
//     class, versions, generations). A missing, spent or expired ticket, or any mismatch, is a
//     refusal, and still without a new intent.
//   * Approve and ConsumeApproved have no input capability. They return a decision only; whether
//     to post an event is the caller's business after ConsumeApproved says yes.
//   * A generation that does not match the stored one changes nothing, so a stale or foreign
//     request cannot burn somebody else's approval. A matching generation burns the stage on every
//     attempt, success or not.
//   * Slot lifetime: only Offer (a replacement), Discard, a cancel or close (Invalidate), and the
//     deadline end a slot. Observation and refocus do not touch it; they change the ticket
//     generation instead, which Approve and ConsumeApproved compare.

#include "computer_use_native_approval_ticket.h"

#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

namespace sprint_coder::computer_use {

// The classifier version an approval intent requires (IsValidNativeApprovalIntent).
constexpr std::uint32_t kNativeApprovalClassifierVersion = 2;

enum class NativeApprovalFailure : std::uint8_t {
  kNone,
  // No pending / ready slot for that generation, or a stage mismatch.
  kUnavailable,
  kExpired,
  // A fresh measurement differs from the approved one, or the binding no longer holds.
  kRevalidationFailed,
  // A measured fact now needs a person rather than a refusal.
  kTakeover,
  kCanceled,
  kTicketUnavailable,
};

struct NativeApprovalDenial {
  const char *reason_code;
  const char *result;
};

// The finite reason / result table. These strings are the contract with Main.
[[nodiscard]] inline NativeApprovalDenial
NativeApprovalDenialFor(NativeApprovalFailure failure) {
  switch (failure) {
  case NativeApprovalFailure::kExpired:
    return {"native_approval_expired", "rejected"};
  case NativeApprovalFailure::kRevalidationFailed:
    return {"native_approval_revalidation_failed", "rejected"};
  case NativeApprovalFailure::kTakeover:
    return {"native_approval_revalidation_failed", "paused"};
  case NativeApprovalFailure::kCanceled:
    return {"native_canceled_pre_dispatch", "canceled"};
  case NativeApprovalFailure::kTicketUnavailable:
    return {"native_ticket_unavailable", "rejected"};
  case NativeApprovalFailure::kUnavailable:
  case NativeApprovalFailure::kNone:
  default:
    return {"native_approval_unavailable", "rejected"};
  }
}

// What native measured *now*. A harness injects it; the macOS addon measures nothing approvable
// until classifier v2 exists, so its measurement is always `eligible == false`.
struct NativeApprovalMeasurement {
  bool eligible = false;
  // A fact that now needs a person (for example a dialog appeared).
  bool takeover = false;
  NativeApprovalEffect effect = NativeApprovalEffect::kInvalid;
  std::string authority_digest;
  std::uint32_t classifier_version = 0;
  std::uint32_t ruleset_version = 0;
  std::uint32_t lexicon_version = 0;
};

// The request and the session, read by the owner under the state lock.
struct NativeApprovalFacts {
  bool session_closed = false;
  std::string session_id;
  std::string task_id;
  std::string turn_id;
  // The new dispatch request, never the request that was approved.
  std::string request_id;
  std::string context_digest;
  std::string action_digest;
  std::string payload_digest;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t current_cancel_epoch = 0;
  std::uint64_t approval_generation = 0;
  std::uint64_t observation_revision = 0;
  // The session's current ticket generation.
  std::uint64_t ticket_generation = 0;
};

struct NativeApprovalOutcome {
  bool ok = false;
  NativeApprovalFailure failure = NativeApprovalFailure::kNone;
};

class NativeApprovalFlow {
public:
  // Begins the waiting intent. The addon calls it from one place, the preflight's approval offer
  // (route v2 only); a build that attests classifier 1 measures nothing eligible, so production never does.
  [[nodiscard]] bool Offer(std::string_view intent_token,
                           NativeApprovalIntentBinding binding,
                           std::uint64_t now_ns, std::uint64_t ttl_ns) {
    return slot_.Begin(intent_token, std::move(binding), now_ns, ttl_ns);
  }

  // Revalidated exchange of the waiting intent for an execution ticket. `execution_token` is a
  // fresh secret from the owner's CSPRNG; it never leaves the owner.
  [[nodiscard]] NativeApprovalOutcome
  Approve(const NativeApprovalFacts &facts,
          const NativeApprovalMeasurement &measured,
          std::string_view execution_token, std::uint64_t now_ns) {
    if (!slot_.pending() || facts.approval_generation == 0 ||
        facts.approval_generation != slot_.approval_generation())
      return Refuse(NativeApprovalFailure::kUnavailable);
    if (facts.session_closed || facts.cancel_epoch != facts.current_cancel_epoch)
      return Burn(NativeApprovalFailure::kCanceled);
    if (now_ns >= slot_.expires_ns())
      return Burn(NativeApprovalFailure::kExpired);
    if (measured.takeover)
      return Burn(NativeApprovalFailure::kTakeover);
    const NativeApprovalIntentBinding *held = slot_.intent_view();
    if (held == nullptr || !measured.eligible)
      return Burn(NativeApprovalFailure::kRevalidationFailed);
    NativeApprovalIntentBinding intent = FreshIntent(*held, facts, measured);
    NativeApprovalExecutionBinding execution{
        intent, facts.request_id, facts.context_digest, facts.observation_revision,
        facts.ticket_generation};
    if (!slot_.ApproveHeld(intent, std::move(execution), execution_token, now_ns))
      return Burn(NativeApprovalFailure::kRevalidationFailed);
    return {true, NativeApprovalFailure::kNone};
  }

  // The last check before an approved input. It consumes the execution ticket held in the slot,
  // against a fresh measurement of the same effect and authority. It never begins an intent.
  [[nodiscard]] NativeApprovalOutcome
  ConsumeApproved(const NativeApprovalFacts &facts,
                  const NativeApprovalMeasurement &measured, std::uint64_t now_ns) {
    if (!slot_.ready() || facts.approval_generation == 0 ||
        facts.approval_generation != slot_.approval_generation())
      return Refuse(NativeApprovalFailure::kUnavailable);
    if (facts.session_closed || facts.cancel_epoch != facts.current_cancel_epoch)
      return Burn(NativeApprovalFailure::kCanceled);
    if (now_ns >= slot_.expires_ns())
      return Burn(NativeApprovalFailure::kExpired);
    if (measured.takeover)
      return Burn(NativeApprovalFailure::kTakeover);
    const NativeApprovalIntentBinding *held = slot_.intent_view();
    if (held == nullptr || !measured.eligible)
      return Burn(NativeApprovalFailure::kRevalidationFailed);
    NativeApprovalIntentBinding intent = FreshIntent(*held, facts, measured);
    NativeApprovalExecutionBinding expected{
        intent, facts.request_id, facts.context_digest, facts.observation_revision,
        facts.ticket_generation};
    if (!slot_.ConsumeHeld(expected, now_ns))
      return Burn(NativeApprovalFailure::kRevalidationFailed);
    return {true, NativeApprovalFailure::kNone};
  }

  // Ends the slot of exactly this generation; any other generation changes nothing.
  bool Discard(std::uint64_t approval_generation) noexcept {
    return slot_.InvalidateIfApprovalGeneration(approval_generation);
  }

  // Cancel and close.
  void Invalidate() noexcept { slot_.Invalidate(); }

  [[nodiscard]] bool occupied() const noexcept { return slot_.occupied(); }
  [[nodiscard]] bool pending() const noexcept { return slot_.pending(); }
  [[nodiscard]] bool ready() const noexcept { return slot_.ready(); }
  [[nodiscard]] std::uint64_t approval_generation() const noexcept {
    return slot_.approval_generation();
  }

private:
  // The stored fields that identify *which approval this is* are kept; everything native measures
  // again is replaced, so equality with the stored intent means "the same effect, still".
  static NativeApprovalIntentBinding
  FreshIntent(const NativeApprovalIntentBinding &held, const NativeApprovalFacts &facts,
              const NativeApprovalMeasurement &measured) {
    NativeApprovalIntentBinding intent = held;
    intent.session_id = facts.session_id;
    intent.task_id = facts.task_id;
    intent.turn_id = facts.turn_id;
    intent.action_digest = facts.action_digest;
    intent.payload_digest = facts.payload_digest;
    intent.authority_digest = measured.authority_digest;
    intent.cancel_epoch = facts.cancel_epoch;
    intent.classifier_version = measured.classifier_version;
    intent.ruleset_version = measured.ruleset_version;
    intent.lexicon_version = measured.lexicon_version;
    intent.effect = measured.effect;
    return intent;
  }

  // A failed attempt on the matching generation always ends the slot, including the early
  // refusals of the slot itself (a ticket generation that has moved on does not burn there).
  NativeApprovalOutcome Burn(NativeApprovalFailure failure) noexcept {
    slot_.Invalidate();
    return {false, failure};
  }

  // Nothing is burned: the request does not name the stored approval.
  static NativeApprovalOutcome Refuse(NativeApprovalFailure failure) noexcept {
    return {false, failure};
  }

  NativeApprovalTicketSlot slot_;
};

} // namespace sprint_coder::computer_use
