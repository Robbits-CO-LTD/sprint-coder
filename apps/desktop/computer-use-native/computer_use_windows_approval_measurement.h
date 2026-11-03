#pragma once

// Portable Windows approval entry. No producer is wired until the approval path is enabled.
// The same validated, possibly settled facts reach classification and authority construction.
#include "computer_use_effect_measurement.h"
#include "computer_use_windows_interlock_capture.h"
#include "computer_use_windows_association.h"
#include "computer_use_windows_background_binding.h"

namespace sprint_coder::computer_use {

struct WindowsApprovalMeasurementInput {
  // The receiving slot for N8-2. MeasureWindowsApproval deliberately does not read it yet: N8-2
  // requires these native-only E2 / E3 measurements and binds them at all three boundaries.
  const WindowsOpenFacts *open_facts = nullptr;
  const ShadowUiaCapture *capture = nullptr;
  ShadowRequestInfo request;
  ApprovalAuthorityIdentity identity;
  ApprovalTargetFrame target_frame;
  EffectRuleset ruleset;
  WindowsStrictCaptureIdentity strict;
  ClassifierRoute route = ClassifierRoute::kV1;
  std::uint32_t attested_classifier_version = 0;
  bool approval_gate = false;
  bool stopped_by_cancel = false;
  bool background = false;
  std::string observed_background_binding, current_background_binding;
};

[[nodiscard]] inline NativeApprovalMeasurement
MeasureWindowsApproval(const WindowsApprovalMeasurementInput &input,
                       DecisionKind *decision_kind = nullptr) {
  // The classified kind is reported only for complete facts; every early answer stays a takeover.
  if (decision_kind != nullptr) *decision_kind = DecisionKind::kTakeover;
  NativeApprovalMeasurement measured;
  if (!WindowsBackgroundBindingMatches(input.background, input.observed_background_binding,
                                        input.current_background_binding)) {
    measured.takeover = true;
    return measured;
  }
  if (!input.approval_gate || input.route != ClassifierRoute::kV2) return measured;
  if (input.capture == nullptr || input.stopped_by_cancel || input.capture->budget_exhausted) {
    measured.takeover = true;
    return measured;
  }
  const auto &capture = *input.capture;
  ShadowFacts built = BuildWindowsShadowFacts(capture, input.request);
  built.facts.target_not_web = WindowsCaptureTargetNotWeb(capture, input.strict.target_not_web);
  if (!input.strict.asked || !WindowsCaptureChainOwnedBy(capture, input.strict.process_id) ||
      !interlock_detail::FactsAreComplete(built.facts) ||
      (capture.item_kind == ShadowItemKind::kFile &&
       !(capture.item_name_read && capture.item_name_is_real_path))) {
    measured.takeover = true;
    return measured;
  }
  auto decision = ClassifyEffect(built.facts, input.ruleset);
  if (interlock_detail::NativeDocumentExceptionFor(
          built.facts, decision, interlock_detail::StrictTextReadable(built.facts)) ==
      NativeDocumentException::kApplied) {
    built.facts.origin = OriginState::kOrdinary;
    decision = ClassifyEffect(built.facts, input.ruleset);
  }
  if (decision_kind != nullptr) *decision_kind = decision.kind;
  // Only the origin is used from this binding capture; no AX fact builder is called here.
  ShadowAxCapture binding_capture;
  binding_capture.web_area_url_read = capture.document_url_read;
  binding_capture.web_area_url = capture.document_url;
  ApprovalMeasurementInput shared;
  shared.capture = &binding_capture;
  shared.identity = input.identity;
  shared.target_frame = input.target_frame;
  shared.ruleset = input.ruleset;
  shared.route = input.route;
  shared.attested_classifier_version = input.attested_classifier_version;
  shared.source = decision.approval_effect == NativeApprovalEffect::kHighImpactConfirmation
                      ? HighImpactSource::kNativeFacts : HighImpactSource::kNone;
  auto result = MeasureApprovalFromFacts(shared, built.facts);
  if (input.background && result.eligible)
    result.authority_digest = Sha256Hex(result.authority_digest + input.current_background_binding);
  return result;
}

} // namespace sprint_coder::computer_use
