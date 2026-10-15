#pragma once

// Classifier v2, S5-c-1: the Windows twin of computer_use_native_interlock_capture.h (S4-1b-1). The
// portable half of a SYNCHRONOUS interlock evaluation on Windows: the UI Automation capture of the
// shadow (`WindowsShadowReader::Capture`, read under the shadow's gate: a call budget, a deadline and
// a cancellation check before every platform call) is built into the core's facts, handed to the
// S4-1-0 interlock map and answered as either a verdict or "no verdict, and why". It has no platform
// header, N-API, clock or I/O: the host passes in a `ShadowUiaSource` (its clock and its UI
// Automation), and the harness passes a fake one.
//
// A round that ran out of budget, was canceled, or whose facts are incomplete is NO VERDICT: never a
// refusal and never an approval. The V1 preflight decides it exactly as it does today. NOTHING calls
// this from the preflight or a dispatch yet; that producer is S5-c-2 (after the real-machine check
// and a decision on how long the serial lane may be held). The shadow's asynchronous path (the
// scheduler, the ring, the observer) does not use this header and is untouched.

#include "computer_use_native_interlock_capture.h"
#include "computer_use_windows_shadow_reader.h"

#include <string_view>

namespace sprint_coder::computer_use {

// The order is the macOS evaluation's: canceled, then budget, then incomplete facts, then the map.
// `stopped_by_cancel`: the capture stopped because the action was no longer valid.
[[nodiscard]] inline InterlockEvaluation
EvaluateWindowsInterlockFromCapture(const ShadowUiaCapture &capture, const ShadowRequestInfo &request,
                                    bool stopped_by_cancel,
                                    const EffectRuleset &ruleset = EffectRuleset{}) {
  InterlockEvaluation result;
  if (stopped_by_cancel) {
    result.no_verdict = InterlockNoVerdict::kCanceled;
    return result;
  }
  if (capture.budget_exhausted) {
    result.no_verdict = InterlockNoVerdict::kBudget;
    return result;
  }
  const ShadowFacts built = BuildWindowsShadowFacts(capture, request);
  if (!interlock_detail::FactsAreComplete(built.facts)) {
    result.no_verdict = InterlockNoVerdict::kIncomplete;
    return result;
  }
  // A file item of a file manager whose REAL path could not be read (the shell lookup was abandoned or
  // refused, or only the display name is known): its extension is unknown, and the map would then say
  // "nothing to refuse" for it, silently dropping the E1 / E4 refusal and the closed-approval refusal.
  // That is not a verdict: V1 decides. (Explorer hides known extensions, so a display name proves
  // nothing; see the contract of ShadowUiaCapture::item_name.)
  if (capture.item_kind == ShadowItemKind::kFile &&
      !(capture.item_name_read && capture.item_name_is_real_path)) {
    result.no_verdict = InterlockNoVerdict::kIncomplete;
    return result;
  }
  result.verdict = InterlockForFacts(built.facts, ruleset);
  return result;
}

// One capture through the shadow's reader and gate, then the evaluation. The cancel flag is what the
// shadow's own `Run` asks: the reader was stopped by a cancel, or the action is no longer valid right
// after the last call (a deadline that passed during the last call is the capture's `Finish`, which
// marks it budget-exhausted, and so is a budget answer here too).
[[nodiscard]] inline InterlockEvaluation
EvaluateWindowsInterlockOnSource(ShadowUiaSource &source, std::string_view kind,
                                 std::string_view target_id, const ShadowRequestInfo &request,
                                 const EffectRuleset &ruleset = EffectRuleset{}) {
  WindowsShadowReader reader(source);
  const ShadowUiaCapture capture = reader.Capture(kind, target_id);
  const bool canceled = reader.Canceled() || !source.ActionStillValid();
  return EvaluateWindowsInterlockFromCapture(capture, request, canceled, ruleset);
}

} // namespace sprint_coder::computer_use
