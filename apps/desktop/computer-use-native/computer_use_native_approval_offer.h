#pragma once

// Classifier v2, C4-2c-1: the portable parts of an approval OFFER, the receipt a preflight returns
// when it asks a person to approve one effect, and the binding the waiting intent is made of.
// Nothing here calls the approval flow by itself, reads the system or touches a version: the
// macOS preflight wires it in C4-2c-2, and only for a session on route v2 with classifier 2
// attested (never in production while the build attests 1).
//
//   * the receipt: the version-2 format, the fixed key sets (Main's parser requires exactly these),
//     the effect words, the bounds of an offer;
//   * the waiting time left on an offer, in whole milliseconds;
//   * the intent binding, made from what native measured (eligible, with its authority digest and
//     versions) and what the request and the session say.
// A receipt that is not closed is never returned; a binding that is not valid is never offered.

#include "computer_use_native_approval_flow.h"
#include "computer_use_native_approval_ticket.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

namespace sprint_coder::computer_use {

// The version of the receipt format, independent of the classifier's own version. A receipt without
// it is version 1 and keeps its original shape.
inline constexpr std::uint32_t kNativePreflightReceiptVersion = 2;
// The classifier version an approval offer carries (the core's own).
inline constexpr std::uint32_t kNativeApprovalOfferClassifierVersion = 2;
// An offer waits at most this long (the slot's own bound), in milliseconds.
inline constexpr std::uint32_t kNativeApprovalOfferMaxMs =
    static_cast<std::uint32_t>(kNativeApprovalWaitMaxNs / 1'000'000ULL);

// The keys of a version-1 receipt, of any version-2 receipt, and of a version-2 approval offer.
// Main requires exactly these sets (a missing or an extra key is an invalid receipt).
inline constexpr std::array<std::string_view, 10> kNativePreflightReceiptKeysV1 = {
    "decision", "reasonCode", "deniedResult", "ticket", "classifierVersion",
    "inputAttemptCount", "requestId", "sessionId", "cancelEpoch", "observationRevision"};
inline constexpr std::array<std::string_view, 11> kNativePreflightReceiptKeysV2 = {
    "decision", "reasonCode", "deniedResult", "ticket", "classifierVersion",
    "inputAttemptCount", "requestId", "sessionId", "cancelEpoch", "observationRevision",
    "receiptVersion"};
inline constexpr std::array<std::string_view, 14> kNativeApprovalOfferReceiptKeys = {
    "decision", "reasonCode", "deniedResult", "ticket", "classifierVersion",
    "inputAttemptCount", "requestId", "sessionId", "cancelEpoch", "observationRevision",
    "receiptVersion", "approvalGeneration", "remainingMs", "effect"};

// The `effect` word of an offer: the native effect minus kInvalid, spelled the way Main spells it.
// Empty for an effect that cannot be offered.
[[nodiscard]] constexpr std::string_view
NativeApprovalEffectName(NativeApprovalEffect effect) noexcept {
  switch (effect) {
  case NativeApprovalEffect::kDownloadOpen:
    return "download_open";
  case NativeApprovalEffect::kFileManagerOpen:
    return "file_manager_open";
  case NativeApprovalEffect::kHighImpactConfirmation:
    return "high_impact_confirmation";
  case NativeApprovalEffect::kSupervisedAction:
    return "supervised_action";
  case NativeApprovalEffect::kInvalid:
    break;
  }
  return {};
}

// What an offer says: which approval (the generation), how long it still waits, which effect.
struct NativeApprovalOffer {
  std::uint64_t approval_generation = 0;
  std::uint32_t remaining_ms = 0;
  NativeApprovalEffect effect = NativeApprovalEffect::kInvalid;
};

// The offer is closed when it can be shown to a person: a real generation, a wait of at least one
// and at most the bound, an effect that has a word. (The receipt around it has no ticket, no reason
// and no denied result; the macOS receipt maker adds that.)
[[nodiscard]] constexpr bool NativeApprovalOfferIsClosed(const NativeApprovalOffer &offer) noexcept {
  return offer.approval_generation >= 1 && offer.remaining_ms >= 1 &&
         offer.remaining_ms <= kNativeApprovalOfferMaxMs &&
         !NativeApprovalEffectName(offer.effect).empty();
}

// Whole milliseconds an offer still waits, rounded UP so that a live offer never reads as zero, and
// capped at the bound. Zero when it has expired (or the clock went backwards past it): such an offer
// is not shown.
[[nodiscard]] constexpr std::uint32_t NativeApprovalRemainingMs(std::uint64_t now_ns,
                                                                std::uint64_t expires_ns) noexcept {
  if (now_ns >= expires_ns) return 0;
  const std::uint64_t left_ns = expires_ns - now_ns;
  const std::uint64_t ms = (left_ns + 999'999ULL) / 1'000'000ULL;
  return ms > kNativeApprovalOfferMaxMs ? kNativeApprovalOfferMaxMs
                                        : static_cast<std::uint32_t>(ms);
}

// What the request and the session say about the approval being offered. Plain values, read by the
// owner under its lock; nothing here is a measurement.
struct NativeApprovalOfferContext {
  std::string session_id;
  std::string task_id;
  std::string turn_id;
  // The preflight request that makes the offer (the execution request is a different one).
  std::string approval_request_id;
  std::string action_digest;
  std::string payload_digest;
  std::uint64_t cancel_epoch = 0;
  std::uint64_t approval_generation = 0;
  std::uint64_t observation_revision = 0;
  std::uint64_t ticket_generation = 0;
};

// The intent binding from a fresh measurement and the context. False (and nothing offered) unless
// the measurement is an eligible approval with no takeover and the binding is valid as a whole. The
// authority digest, the effect and the three versions are the measurement's; the identifiers and
// digests are the context's. Mirrors what the approval flow compares again at approve and consume.
[[nodiscard]] inline bool BuildApprovalIntentBinding(const NativeApprovalMeasurement &measured,
                                                     const NativeApprovalOfferContext &context,
                                                     NativeApprovalIntentBinding *binding) {
  if (binding == nullptr || !measured.eligible || measured.takeover) return false;
  NativeApprovalIntentBinding built;
  built.session_id = context.session_id;
  built.task_id = context.task_id;
  built.turn_id = context.turn_id;
  built.approval_request_id = context.approval_request_id;
  built.action_digest = context.action_digest;
  built.payload_digest = context.payload_digest;
  built.authority_digest = measured.authority_digest;
  built.cancel_epoch = context.cancel_epoch;
  built.approval_generation = context.approval_generation;
  built.observation_revision = context.observation_revision;
  built.ticket_generation = context.ticket_generation;
  built.classifier_version = measured.classifier_version;
  built.ruleset_version = measured.ruleset_version;
  built.lexicon_version = measured.lexicon_version;
  built.effect = measured.effect;
  if (!IsValidNativeApprovalIntent(built)) return false;
  *binding = std::move(built);
  return true;
}

} // namespace sprint_coder::computer_use
