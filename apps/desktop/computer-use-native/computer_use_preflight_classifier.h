#pragma once

#include <cstdint>

namespace sprint_coder::computer_use {

// Internal native risk translation only. This is not a manifest/handshake
// attestation that S4's effect classifier or approval ticket is complete.
constexpr std::uint32_t kNativePreflightClassifierVersion = 1;

enum class NativePreflightKind : std::uint8_t {
  kOrdinary,
  kSingleUseApproval,
  kBlocked,
  kTakeover,
};

enum class NativePreflightReason : std::uint8_t {
  kNone,
  kUnclassified,
  kSecure,
  kHighImpact,
};

// Constructed from freshly measured AX/UIA facts in native code, never from
// Renderer, model, or IPC declarations. Mac's classified bit already includes
// its bounded AX metadata/classification success.
struct NativePreflightFacts {
  bool metadata_complete = false;
  bool classified = false;
  bool secure = false;
  bool high_impact = false;
};

struct NativePreflightDecision {
  NativePreflightKind kind = NativePreflightKind::kTakeover;
  NativePreflightReason reason = NativePreflightReason::kUnclassified;
  std::uint32_t classifier_version = kNativePreflightClassifierVersion;
};

[[nodiscard]] constexpr NativePreflightDecision
ClassifyNativePreflightFacts(NativePreflightFacts facts) noexcept {
  // Preserve legacy reason priority even for incomplete/contradictory facts;
  // none of those combinations may become an ordinary dispatch.
  if (!facts.metadata_complete || !facts.classified)
    return {NativePreflightKind::kTakeover,
            NativePreflightReason::kUnclassified};
  if (facts.secure)
    return {NativePreflightKind::kBlocked, NativePreflightReason::kSecure};
  if (facts.high_impact)
    return {NativePreflightKind::kTakeover,
            NativePreflightReason::kHighImpact};
  return {NativePreflightKind::kOrdinary, NativePreflightReason::kNone};
}

[[nodiscard]] constexpr bool
NativePreflightAllowsDispatch(NativePreflightDecision decision) noexcept {
  // Approval is reserved, not authority. Coarse high-impact facts cannot
  // distinguish approval-eligible effects from permanently blocked surfaces.
  // A future native one-shot ticket requires its own fresh effect classifier.
  return decision.classifier_version == kNativePreflightClassifierVersion &&
         decision.kind == NativePreflightKind::kOrdinary &&
         decision.reason == NativePreflightReason::kNone;
}

} // namespace sprint_coder::computer_use
