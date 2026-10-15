#pragma once

// Classifier v2, C4-1: what native measures *now* for an approval, as pure functions. Nothing here
// reads the process, the accessibility tree or a clock, and nothing is wired: the macOS addon does
// not include this header yet (the change that makes MeasureNativeApproval real does), so no
// production path offers, approves or consumes anything because of it.
//
//   * ApprovalAuthorityFrame / ApprovalAuthorityDigest: the authority an approval is bound to, as a
//     canonically framed string under the domain "approval-authority-v1" and its SHA-256. Every
//     field is a length-prefixed string ("<bytes>:<text>"), so neighbouring fields cannot run into
//     each other, and a field that is absent is told from one that is empty. The digest covers the
//     application, process generation, window and geometry, the target and its ancestors, the
//     surface and origin, the item and its extension, the effect, and the three versions. It does
//     not cover the observation revision, the ticket generation, the neighbouring captions or the
//     action: those change between the approval and the input without the authority changing.
//   * JudgeIntentOffer: whether an approval intent may be offered at all. All of: the session's
//     route is v2; the core's decision is an approval whose effect the rule set enables; the
//     high-impact judgement comes from native's own facts (never Main's projection, which can only
//     strengthen, ADR decision 3-A); the decision was made by the current versions of the core.
//   * MeasureApproval: the measurement the approval flow compares, built from an accessibility
//     capture and the core's decision on it.

#include "computer_use_effect_classifier.h"
#include "computer_use_effect_shadow.h"
#include "computer_use_native_approval_flow.h"
#include "computer_use_sha256.h"

#include <cstdint>
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

inline constexpr std::string_view kApprovalAuthorityDomain = "approval-authority-v1";

// The classifier a session is bound to (C3 / C4-0).
enum class ClassifierRoute : std::uint8_t { kV1, kV2 };

// Where the high-impact judgement came from. Only native's own facts can ground an approval; the
// projection Main adds may refuse more and never grants.
enum class HighImpactSource : std::uint8_t { kNone, kNativeFacts, kMainProjection };

// A string that may be missing. Missing is not empty.
struct AuthorityString {
  bool present = false;
  std::string value;
};

// What identifies the target's place, measured by native. The geometry is the window's bounds in
// whole units the caller rounds the same way every time.
struct ApprovalAuthorityIdentity {
  AuthorityString app_identity;
  AuthorityString process_generation;
  AuthorityString window_identity;
  bool geometry_present = false;
  std::int64_t x = 0;
  std::int64_t y = 0;
  std::int64_t width = 0;
  std::int64_t height = 0;
};

namespace measurement_detail {

inline void AppendLengthPrefixed(std::string *output, std::string_view value) {
  output->append(std::to_string(value.size()));
  output->push_back(':');
  output->append(value);
}

inline void AppendString(std::string *output, std::string_view name, const AuthorityString &field) {
  AppendLengthPrefixed(output, name);
  output->push_back(field.present ? 'P' : 'A');
  AppendLengthPrefixed(output, field.present ? std::string_view(field.value) : std::string_view());
}

inline void AppendNumber(std::string *output, std::string_view name, std::int64_t value) {
  AppendLengthPrefixed(output, name);
  output->push_back('P');
  AppendLengthPrefixed(output, std::to_string(value));
}

} // namespace measurement_detail

[[nodiscard]] inline std::string ApprovalAuthorityFrame(const ApprovalAuthorityIdentity &identity,
                                                        const EffectFacts &facts,
                                                        const EffectDecision &decision) {
  using namespace measurement_detail;
  std::string frame;
  AppendLengthPrefixed(&frame, kApprovalAuthorityDomain);
  AppendString(&frame, "app", identity.app_identity);
  AppendString(&frame, "process", identity.process_generation);
  AppendString(&frame, "window", identity.window_identity);
  AppendLengthPrefixed(&frame, "geometry");
  frame.push_back(identity.geometry_present ? 'P' : 'A');
  if (identity.geometry_present) {
    AppendNumber(&frame, "x", identity.x);
    AppendNumber(&frame, "y", identity.y);
    AppendNumber(&frame, "width", identity.width);
    AppendNumber(&frame, "height", identity.height);
  }
  AppendNumber(&frame, "surface", static_cast<std::int64_t>(facts.surface));
  AppendNumber(&frame, "origin", static_cast<std::int64_t>(facts.origin));
  AppendNumber(&frame, "file-item", facts.target_is_file_item ? 1 : 0);
  AppendString(&frame, "extension", AuthorityString{facts.extension_known, facts.extension});
  AppendNumber(&frame, "nodes", static_cast<std::int64_t>(facts.chain.size()));
  for (const NodeFacts &node : facts.chain) {
    AppendLengthPrefixed(&frame, node.role);
    AppendLengthPrefixed(&frame, node.subrole);
    AppendLengthPrefixed(&frame, node.label);
  }
  AppendNumber(&frame, "class", static_cast<std::int64_t>(decision.effect_class));
  AppendNumber(&frame, "effect", static_cast<std::int64_t>(decision.approval_effect));
  AppendNumber(&frame, "classifier", decision.classifier_version);
  AppendNumber(&frame, "ruleset", decision.ruleset_version);
  AppendNumber(&frame, "lexicon", decision.lexicon_version);
  return frame;
}

[[nodiscard]] inline std::string ApprovalAuthorityDigest(const ApprovalAuthorityIdentity &identity,
                                                         const EffectFacts &facts,
                                                         const EffectDecision &decision) {
  return Sha256Hex(ApprovalAuthorityFrame(identity, facts, decision));
}

enum class IntentRefusal : std::uint8_t {
  kNone,
  kRouteNotV2,
  kNotNativeFacts,
  kNotAnApproval,
  kVersionMismatch,
  kNotEnabled,
};

struct IntentVerdict {
  bool offer = false;
  IntentRefusal refusal = IntentRefusal::kNotAnApproval;
  NativeApprovalEffect effect = NativeApprovalEffect::kInvalid;
};

[[nodiscard]] inline bool RulesetEnables(const EffectRuleset &ruleset, NativeApprovalEffect effect) {
  switch (effect) {
  case NativeApprovalEffect::kDownloadOpen:
    return ruleset.download_open;
  case NativeApprovalEffect::kFileManagerOpen:
    return ruleset.file_manager_open;
  case NativeApprovalEffect::kHighImpactConfirmation:
    return ruleset.high_impact_confirmation;
  case NativeApprovalEffect::kSupervisedAction:
    return ruleset.supervised_action;
  case NativeApprovalEffect::kInvalid:
  default:
    return false;
  }
}

[[nodiscard]] inline IntentVerdict JudgeIntentOffer(ClassifierRoute route, const EffectRuleset &ruleset,
                                                    const EffectDecision &decision,
                                                    HighImpactSource source) {
  const auto refuse = [](IntentRefusal reason) { return IntentVerdict{false, reason, NativeApprovalEffect::kInvalid}; };
  if (route != ClassifierRoute::kV2) return refuse(IntentRefusal::kRouteNotV2);
  if (source != HighImpactSource::kNativeFacts) return refuse(IntentRefusal::kNotNativeFacts);
  if (decision.kind != DecisionKind::kApproval ||
      decision.approval_effect == NativeApprovalEffect::kInvalid)
    return refuse(IntentRefusal::kNotAnApproval);
  if (decision.classifier_version != kEffectClassifierVersion ||
      decision.ruleset_version != kEffectRulesetVersion ||
      decision.lexicon_version != kEffectLexiconVersion)
    return refuse(IntentRefusal::kVersionMismatch);
  if (!RulesetEnables(ruleset, decision.approval_effect)) return refuse(IntentRefusal::kNotEnabled);
  return IntentVerdict{true, IntentRefusal::kNone, decision.approval_effect};
}

struct ApprovalMeasurementInput {
  // The capture the facts are built from; not owned, and not kept.
  const ShadowAxCapture *capture = nullptr;
  ShadowRequestInfo request;
  ApprovalAuthorityIdentity identity;
  EffectRuleset ruleset;
  ClassifierRoute route = ClassifierRoute::kV1;
  HighImpactSource source = HighImpactSource::kNone;
};

// Builds the facts, asks the core, and states the result the way the approval flow compares it:
//   * a decision that needs a person (a capture that is not whole, an unclassified text) is a
//     takeover;
//   * a decision that is an approval the offer rules allow is eligible, with its effect, the
//     authority digest and the core's three versions;
//   * everything else (an ordinary control, a refusal, a route or a source that cannot ground an
//     approval) is not eligible, and carries no effect and no digest.
[[nodiscard]] inline NativeApprovalMeasurement MeasureApproval(const ApprovalMeasurementInput &input) {
  NativeApprovalMeasurement measured;
  if (input.capture == nullptr) {
    measured.takeover = true;
    return measured;
  }
  const ShadowFacts built = BuildShadowFacts(*input.capture, input.request);
  const EffectDecision decision = ClassifyEffect(built.facts, input.ruleset);
  if (decision.kind == DecisionKind::kTakeover) {
    measured.takeover = true;
    return measured;
  }
  const IntentVerdict verdict = JudgeIntentOffer(input.route, input.ruleset, decision, input.source);
  if (!verdict.offer) return measured;
  measured.eligible = true;
  measured.effect = verdict.effect;
  measured.authority_digest = ApprovalAuthorityDigest(input.identity, built.facts, decision);
  measured.classifier_version = decision.classifier_version;
  measured.ruleset_version = decision.ruleset_version;
  measured.lexicon_version = decision.lexicon_version;
  return measured;
}

} // namespace sprint_coder::computer_use
