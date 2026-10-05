#pragma once

// Private, portable policy only; no production caller or Main-facing export.
// The native owner supplies CSPRNG tokens, real monotonic times and freshly
// measured bindings under its state mutex. Approve may be called only after
// Main's separately bound trusted activation and native revalidation succeed.
// This slot does not attest a human click, AX facts, signing or a build mode.
// Classifier v2 here is a reserved policy contract, not a runtime capability.

#include "computer_use_native_binding.h"
#include "computer_use_native_ticket.h"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <string>
#include <string_view>
#include <utility>

namespace sprint_coder::computer_use {

constexpr std::uint64_t kNativeApprovalWaitMaxNs = 60'000'000'000ULL;
constexpr std::uint64_t kNativeApprovalExecutionTtlNs = 5'000'000'000ULL;

// Only positively classified approval-eligible effects. Hard boundaries and
// unclassified effects deliberately have no value that can authorize a ticket.
enum class NativeApprovalEffect : std::uint8_t {
  kInvalid,
  kDownloadOpen,
  kFileManagerOpen,
  kHighImpactConfirmation,
  kSupervisedAction,
};

struct NativeApprovalIntentBinding {
  std::string session_id;
  std::string task_id;
  std::string turn_id;
  std::string approval_request_id;
  std::string action_digest;
  std::string payload_digest;
  std::string authority_digest;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t approval_generation = 0;
  std::uint64_t observation_revision = 0;
  std::uint64_t ticket_generation = 0;
  std::uint32_t classifier_version = 0;
  std::uint32_t ruleset_version = 0;
  std::uint32_t lexicon_version = 0;
  NativeApprovalEffect effect = NativeApprovalEffect::kInvalid;
};

struct NativeApprovalExecutionBinding {
  NativeApprovalIntentBinding intent;
  std::string request_id;
  std::string context_digest;
  std::uint64_t observation_revision = 0;
  std::uint64_t ticket_generation = 0;
};

[[nodiscard]] inline bool
NativeApprovalIntentBindingsEqual(const NativeApprovalIntentBinding &a,
                                 const NativeApprovalIntentBinding &b) {
  return a.session_id == b.session_id && a.task_id == b.task_id &&
         a.turn_id == b.turn_id &&
         a.approval_request_id == b.approval_request_id &&
         a.action_digest == b.action_digest &&
         a.payload_digest == b.payload_digest &&
         a.authority_digest == b.authority_digest &&
         a.cancel_epoch == b.cancel_epoch &&
         a.approval_generation == b.approval_generation &&
         a.observation_revision == b.observation_revision &&
         a.ticket_generation == b.ticket_generation &&
         a.classifier_version == b.classifier_version &&
         a.ruleset_version == b.ruleset_version &&
         a.lexicon_version == b.lexicon_version && a.effect == b.effect;
}

[[nodiscard]] inline bool
IsValidNativeApprovalIntent(const NativeApprovalIntentBinding &binding) {
  const bool effect =
      binding.effect == NativeApprovalEffect::kDownloadOpen ||
      binding.effect == NativeApprovalEffect::kFileManagerOpen ||
      binding.effect == NativeApprovalEffect::kHighImpactConfirmation ||
      binding.effect == NativeApprovalEffect::kSupervisedAction;
  return effect && binding.classifier_version == 2 &&
         binding.ruleset_version > 0 && binding.lexicon_version > 0 &&
         binding.approval_generation > 0 && binding.observation_revision > 0 &&
         binding.ticket_generation > 0 &&
         IsValidNativeBindingId(binding.session_id) &&
         IsValidNativeBindingId(binding.task_id) &&
         IsValidNativeBindingId(binding.turn_id) &&
         IsValidNativeBindingId(binding.approval_request_id) &&
         IsValidNativeOrdinaryTicketToken(binding.action_digest) &&
         IsValidNativeOrdinaryTicketToken(binding.payload_digest) &&
         IsValidNativeOrdinaryTicketToken(binding.authority_digest);
}

[[nodiscard]] inline bool
IsValidNativeApprovalExecution(const NativeApprovalExecutionBinding &binding) {
  return IsValidNativeApprovalIntent(binding.intent) &&
         IsValidNativeBindingId(binding.request_id) &&
         binding.request_id != binding.intent.approval_request_id &&
         IsValidNativeOrdinaryTicketToken(binding.context_digest) &&
         binding.observation_revision > binding.intent.observation_revision &&
         binding.ticket_generation > binding.intent.ticket_generation;
}

// One slot, two stages. No copy/move of the stored secrets; the owner serializes
// access. A matching stage/generation burns on every attempt. Stale completions
// do not own a replacement and must leave it intact.
class NativeApprovalTicketSlot {
public:
  NativeApprovalTicketSlot() = default;
  NativeApprovalTicketSlot(const NativeApprovalTicketSlot &) = delete;
  NativeApprovalTicketSlot &operator=(const NativeApprovalTicketSlot &) = delete;
  NativeApprovalTicketSlot(NativeApprovalTicketSlot &&) = delete;
  NativeApprovalTicketSlot &operator=(NativeApprovalTicketSlot &&) = delete;
  ~NativeApprovalTicketSlot() { Invalidate(); }

  [[nodiscard]] bool Begin(std::string_view token,
                           NativeApprovalIntentBinding binding,
                           std::uint64_t now_ns, std::uint64_t ttl_ns) {
    Invalidate();
    if (!IsValidNativeOrdinaryTicketToken(token) ||
        !IsValidNativeApprovalIntent(binding) || ttl_ns == 0 ||
        ttl_ns > kNativeApprovalWaitMaxNs ||
        now_ns > std::numeric_limits<std::uint64_t>::max() - ttl_ns)
      return false;
    token_.assign(token.data(), token.size());
    intent_ = std::move(binding);
    issued_ns_ = now_ns;
    expires_ns_ = now_ns + ttl_ns;
    state_ = State::kPending;
    return true;
  }

  // The fresh intent fields must come from native's new measurements; copying
  // old authority facts is not revalidation. Original observation/generation
  // remain audit bindings while the execution fields must have advanced.
  [[nodiscard]] bool Approve(
      std::string_view presented_intent_token,
      const NativeApprovalIntentBinding &expected_intent,
      NativeApprovalExecutionBinding fresh, std::string_view execution_token,
      std::uint64_t now_ns) {
    if (!pending() || expected_intent.approval_generation == 0 ||
        expected_intent.approval_generation != intent_.approval_generation)
      return false;
    const bool token_ok =
        IsValidNativeOrdinaryTicketToken(presented_intent_token) &&
        NativeOrdinaryTicketTokensEqual(token_, presented_intent_token);
    const bool fresh_token =
        IsValidNativeOrdinaryTicketToken(execution_token) &&
        !NativeOrdinaryTicketTokensEqual(token_, execution_token);
    const bool binding_ok =
        IsValidNativeApprovalIntent(expected_intent) &&
        IsValidNativeApprovalExecution(fresh) &&
        NativeApprovalIntentBindingsEqual(intent_, expected_intent) &&
        NativeApprovalIntentBindingsEqual(intent_, fresh.intent);
    const bool time_ok = now_ns >= issued_ns_ && now_ns < expires_ns_ &&
        now_ns <= std::numeric_limits<std::uint64_t>::max() -
                      kNativeApprovalExecutionTtlNs;
    const std::uint64_t waiting_deadline = expires_ns_;
    Invalidate();
    if (!token_ok || !fresh_token || !binding_ok || !time_ok)
      return false;
    token_.assign(execution_token.data(), execution_token.size());
    execution_ = std::move(fresh);
    issued_ns_ = now_ns;
    expires_ns_ = std::min(waiting_deadline,
                          now_ns + kNativeApprovalExecutionTtlNs);
    state_ = State::kReady;
    return true;
  }

  [[nodiscard]] bool Consume(
      std::string_view presented_execution_token,
      const NativeApprovalExecutionBinding &expected, std::uint64_t now_ns) {
    if (!ready() || expected.intent.approval_generation == 0 ||
        expected.intent.approval_generation !=
            execution_.intent.approval_generation ||
        expected.ticket_generation == 0 ||
        expected.ticket_generation != execution_.ticket_generation)
      return false;
    const bool token_ok =
        IsValidNativeOrdinaryTicketToken(presented_execution_token) &&
        NativeOrdinaryTicketTokensEqual(token_, presented_execution_token);
    const bool binding_ok =
        IsValidNativeApprovalExecution(expected) &&
        NativeApprovalIntentBindingsEqual(execution_.intent, expected.intent) &&
        execution_.request_id == expected.request_id &&
        execution_.context_digest == expected.context_digest &&
        execution_.observation_revision == expected.observation_revision &&
        execution_.ticket_generation == expected.ticket_generation;
    const bool time_ok = now_ns >= issued_ns_ && now_ns < expires_ns_;
    Invalidate();
    return token_ok && binding_ok && time_ok;
  }

  void Invalidate() noexcept {
    ScrubNativeTicketString(&token_);
    intent_ = NativeApprovalIntentBinding{};
    execution_ = NativeApprovalExecutionBinding{};
    issued_ns_ = 0;
    expires_ns_ = 0;
    state_ = State::kEmpty;
  }

  bool InvalidateIfApprovalGeneration(std::uint64_t generation) noexcept {
    if (generation == 0 || generation != approval_generation())
      return false;
    Invalidate();
    return true;
  }

  bool InvalidateIfTicketGeneration(std::uint64_t generation) noexcept {
    if (generation == 0 || generation != ticket_generation())
      return false;
    Invalidate();
    return true;
  }

  [[nodiscard]] bool occupied() const noexcept { return state_ != State::kEmpty; }
  [[nodiscard]] bool pending() const noexcept { return state_ == State::kPending; }
  [[nodiscard]] bool ready() const noexcept { return state_ == State::kReady; }
  [[nodiscard]] std::uint64_t approval_generation() const noexcept {
    return pending() ? intent_.approval_generation
                     : ready() ? execution_.intent.approval_generation : 0;
  }
  [[nodiscard]] std::uint64_t ticket_generation() const noexcept {
    return ready() ? execution_.ticket_generation : 0;
  }

private:
  enum class State { kEmpty, kPending, kReady };
  State state_ = State::kEmpty;
  std::string token_;
  NativeApprovalIntentBinding intent_;
  NativeApprovalExecutionBinding execution_;
  std::uint64_t issued_ns_ = 0;
  std::uint64_t expires_ns_ = 0;
};

} // namespace sprint_coder::computer_use
