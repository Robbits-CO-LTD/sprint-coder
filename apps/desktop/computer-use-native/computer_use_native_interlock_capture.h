#pragma once

// Classifier v2, S4-1b-1: the portable half of a SYNCHRONOUS interlock evaluation. What the C2
// shadow captures (a `ShadowAxCapture`, read under a call and time budget with a cancellation check
// before every platform call) is built into the core's facts, handed to the S4-1-0 interlock map,
// and answered as either a verdict or "no verdict, and why". It has no platform header, N-API,
// clock or I/O: the platform adapter (the .mm today, the Windows host later) reads the capture and
// passes in only what the read ended with.
//
// A round that ran out of budget, was canceled, or whose facts are incomplete is NO VERDICT: it is
// never a refusal and never an approval. The v1 preflight decides it exactly as it does today.
// NOTHING calls this from the preflight or a dispatch yet; that producer is S4-1b-2 (after the
// real-device check of #777). Until then no refusal can come out of it, the receipts, the versions
// and the attested versions are untouched.

#include "computer_use_effect_shadow.h"
#include "computer_use_native_interlock.h"

#include <cstdint>

namespace sprint_coder::computer_use {

// Why there is no verdict. kNone means the map answered (and its verdict may still be "nothing to
// refuse"); every other value means the map was not asked.
enum class InterlockNoVerdict : std::uint8_t {
  kNone,
  kCanceled,   // the action was canceled while the capture ran
  kBudget,     // the call or time budget ran out
  kIncomplete, // the facts the interlocks stand on are not complete
};

struct InterlockEvaluation {
  InterlockVerdict verdict;
  InterlockNoVerdict no_verdict = InterlockNoVerdict::kNone;

  // Only a complete, positive match refuses.
  [[nodiscard]] bool Refuses() const {
    return no_verdict == InterlockNoVerdict::kNone && verdict.Refuses();
  }
};

// `stopped_by_cancel`: the capture stopped because the action was no longer valid (the platform
// reader's cancellation flag). The capture's own `budget_exhausted` says the budget ran out. Both
// are checked before the facts are built, so a partly read target can never be mapped.
[[nodiscard]] inline InterlockEvaluation
EvaluateInterlockFromCapture(const ShadowAxCapture &capture, const ShadowRequestInfo &request,
                             bool stopped_by_cancel, const EffectRuleset &ruleset = EffectRuleset{}) {
  InterlockEvaluation result;
  if (stopped_by_cancel) {
    result.no_verdict = InterlockNoVerdict::kCanceled;
    return result;
  }
  if (capture.budget_exhausted) {
    result.no_verdict = InterlockNoVerdict::kBudget;
    return result;
  }
  const ShadowFacts built = BuildShadowFacts(capture, request);
  if (!interlock_detail::FactsAreComplete(built.facts)) {
    result.no_verdict = InterlockNoVerdict::kIncomplete;
    return result;
  }
  result.verdict = InterlockForFacts(built.facts, ruleset);
  return result;
}

} // namespace sprint_coder::computer_use
