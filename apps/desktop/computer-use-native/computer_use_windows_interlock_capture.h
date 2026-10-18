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

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

// S5-c-3 PR-5: what a v2 session's interlock adds to the capture (ADR v2 section 3.2.5). `asked` is
// set only for a session bound to the v2 basis; every other capture is evaluated as before.
//   * process_id: the session's target process. An element of the chain that another process
//     provides, or whose process could not be read, makes the strict verdict a takeover.
//   * target_not_web: from the verified identity table (the host's System32 notepad entry), never
//     from anything the app reports. FrameworkId may only take it away (below).
struct WindowsStrictCaptureIdentity {
  bool asked = false;
  std::uint32_t process_id = 0;
  std::optional<bool> target_not_web;
};

namespace windows_interlock_capture_detail {

[[nodiscard]] inline std::string FoldedLower(std::string_view text) {
  return windows_shadow_detail::Lowercase(shadow_detail::CompatFold(text));
}

// A framework that renders web content. Only ever a reason to take over.
[[nodiscard]] inline bool IsWebFramework(std::string_view framework) {
  const std::string folded = FoldedLower(framework);
  return folded == "chrome" || folded == "internetexplorer" || folded == "microsoftedge" ||
         folded == "gecko" || folded == "webkit" || folded == "webview";
}

} // namespace windows_interlock_capture_detail

// Every element of the chain is provided by `process_id` (each one read, none 0).
[[nodiscard]] inline bool WindowsCaptureChainOwnedBy(const ShadowUiaCapture &capture,
                                                     std::uint32_t process_id) {
  if (process_id == 0 || capture.chain.empty()) return false;
  for (const ShadowUiaNode &node : capture.chain)
    if (node.process_id != process_id) return false;
  return true;
}

// The "not web" fact a v2 session's facts carry: the verified one, taken away when the capture's
// FrameworkId says web for any element of the chain (false), or a Document of the chain does not
// say which framework it is (not measured). FrameworkId never turns an unconfirmed target into a
// confirmed one: the verified value comes first, and only a value that is there and true is kept.
[[nodiscard]] inline std::optional<bool>
WindowsCaptureTargetNotWeb(const ShadowUiaCapture &capture, const std::optional<bool> &verified) {
  using namespace windows_interlock_capture_detail;
  if (!(verified.has_value() && *verified)) return verified;
  bool document_unsaid = false;
  for (const ShadowUiaNode &node : capture.chain) {
    if (node.framework_read && IsWebFramework(node.framework_id)) return false;
    if (FoldedLower(node.control_type) == "document" &&
        !(node.framework_read && !node.framework_id.empty()))
      document_unsaid = true;
  }
  if (document_unsaid) return std::nullopt;
  return true;
}

// The order is the macOS evaluation's: canceled, then budget, then incomplete facts, then the map.
// `stopped_by_cancel`: the capture stopped because the action was no longer valid.
[[nodiscard]] inline InterlockEvaluation
EvaluateWindowsInterlockFromCapture(const ShadowUiaCapture &capture, const ShadowRequestInfo &request,
                                    bool stopped_by_cancel,
                                    const EffectRuleset &ruleset = EffectRuleset{},
                                    const WindowsStrictCaptureIdentity &strict = {}) {
  InterlockEvaluation result;
  if (stopped_by_cancel) {
    result.no_verdict = InterlockNoVerdict::kCanceled;
    return result;
  }
  if (capture.budget_exhausted) {
    result.no_verdict = InterlockNoVerdict::kBudget;
    return result;
  }
  ShadowFacts built = BuildWindowsShadowFacts(capture, request);
  if (strict.asked) built.facts.target_not_web = WindowsCaptureTargetNotWeb(capture, strict.target_not_web);
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
  // A v2 session's chain must be the target process's own (ADR v2 section 3.2.5): an element another
  // process provides (or one whose process is unknown) makes a takeover of what the strict map would
  // let through. A refusal of the strict map stays that refusal, with its reason and effect class (a
  // refusal ranks above a takeover, as in MapEffectToStrictInterlock).
  result.strict_verdict = StrictInterlockForFacts(built.facts, ruleset);
  if (strict.asked && !WindowsCaptureChainOwnedBy(capture, strict.process_id) &&
      !result.strict_verdict.Refuses())
    result.strict_verdict = interlock_detail::StrictUnclassified(EffectClass::kUnclassified);
  return result;
}

// One capture through the shadow's reader and gate, then the evaluation. The cancel flag is what the
// shadow's own `Run` asks: the reader was stopped by a cancel, or the action is no longer valid right
// after the last call (a deadline that passed during the last call is the capture's `Finish`, which
// marks it budget-exhausted, and so is a budget answer here too).
[[nodiscard]] inline InterlockEvaluation
EvaluateWindowsInterlockOnSource(ShadowUiaSource &source, std::string_view kind,
                                 std::string_view target_id, const ShadowRequestInfo &request,
                                 const EffectRuleset &ruleset = EffectRuleset{},
                                 const WindowsStrictCaptureIdentity &strict = {}) {
  WindowsShadowReader reader(source);
  reader.ReadChainIdentity(strict.asked);
  const ShadowUiaCapture capture = reader.Capture(kind, target_id);
  const bool canceled = reader.Canceled() || !source.ActionStillValid();
  return EvaluateWindowsInterlockFromCapture(capture, request, canceled, ruleset, strict);
}

} // namespace sprint_coder::computer_use
