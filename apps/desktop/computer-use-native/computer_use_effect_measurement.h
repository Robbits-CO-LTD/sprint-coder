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
//     route is v2; the build attests the classifier version the core has; the core's decision is an
//     approval whose effect the rule set enables, and the rule set is the one that version names;
//     the high-impact judgement comes from native's own facts (a confirmation needs them; Main's
//     projection can only strengthen and never grants, ADR decision 3-A); the decision was made by
//     the current versions of the core.
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

// Where the high-impact judgement behind this action came from. A confirmation (the high-impact
// approval) needs native's own facts. An approval that is not about high impact (a supervised
// action) claims none (kNone) or has native's (kNativeFacts). A judgement that only Main's
// projection makes (kMainProjection) never grants anything: the projection can only strengthen.
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

// The target element's frame in screen units, measured by native and rounded the same way every
// time (the caller's job). Not part of the capture the shared shadow reads.
struct ApprovalTargetFrame {
  bool present = false;
  std::int64_t x = 0;
  std::int64_t y = 0;
  std::int64_t width = 0;
  std::int64_t height = 0;
};

// Units a window-relative frame is rounded down to before it is bound (see ADR, item 10).
inline constexpr std::int64_t kAuthorityFrameGrid = 4;

// What an approval is bound to beyond the identity and the facts: where the page is (the origin, not
// the whole URL), and, for a confirmation only, what the person saw (the captions near the control,
// as one digest) and where the control was in its window.
struct ApprovalAuthorityBinding {
  AuthorityString origin;
  bool content_bound = false;
  std::string neighbors_digest;
  bool frame_present = false;
  std::int64_t relative_x = 0;
  std::int64_t relative_y = 0;
  std::int64_t relative_width = 0;
  std::int64_t relative_height = 0;
};

namespace measurement_detail {

inline std::string LowerAscii(std::string_view text) {
  std::string output(text);
  for (char &character : output)
    if (character >= 'A' && character <= 'Z') character = static_cast<char>(character + 32);
  return output;
}

[[nodiscard]] inline std::int64_t FloorDivide(std::int64_t value, std::int64_t divisor) {
  const std::int64_t quotient = value / divisor;
  return (value % divisor != 0 && (value < 0) != (divisor < 0)) ? quotient - 1 : quotient;
}

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

// scheme://host[:port], lowercase, the default port left out, no user information, no path, query
// or fragment. Empty when the text is not a URL with an authority.
[[nodiscard]] inline std::string NormalizeOrigin(std::string_view url) {
  using measurement_detail::LowerAscii;
  const std::size_t marker = url.find("://");
  if (marker == std::string_view::npos || marker == 0) return std::string();
  const std::string scheme = LowerAscii(url.substr(0, marker));
  std::string_view rest = url.substr(marker + 3);
  const std::size_t end = rest.find_first_of("/?#");
  std::string_view authority = end == std::string_view::npos ? rest : rest.substr(0, end);
  const std::size_t at = authority.rfind('@');
  if (at != std::string_view::npos) authority = authority.substr(at + 1);
  std::string host;
  std::string port;
  if (!authority.empty() && authority.front() == '[') {
    const std::size_t close = authority.find(']');
    if (close == std::string_view::npos) return std::string();
    host = LowerAscii(authority.substr(0, close + 1));
    if (close + 1 < authority.size()) {
      if (authority[close + 1] != ':') return std::string();
      port = std::string(authority.substr(close + 2));
    }
  } else {
    const std::size_t colon = authority.rfind(':');
    host = LowerAscii(colon == std::string_view::npos ? authority : authority.substr(0, colon));
    if (colon != std::string_view::npos) port = std::string(authority.substr(colon + 1));
  }
  for (const char digit : port)
    if (digit < '0' || digit > '9') return std::string();
  if ((scheme == "http" && port == "80") || (scheme == "https" && port == "443")) port.clear();
  if (host.empty() && scheme != "file") return std::string();
  std::string origin = scheme + "://" + host;
  if (!port.empty()) origin += ":" + port;
  return origin;
}

[[nodiscard]] inline bool AuthorityIdentityIsWhole(const ApprovalAuthorityIdentity &identity) {
  return identity.app_identity.present && identity.process_generation.present &&
         identity.window_identity.present && identity.geometry_present;
}

// The binding for this capture and decision. The origin is read from the page's URL (absent when
// there is none, or it cannot be read: the facts then say the origin is unknown, which refuses).
// A confirmation also binds its content and place; for it, the neighbours must have been listed
// whole and the control's frame must be known, else `complete` is false and the caller refuses.
struct DerivedAuthorityBinding {
  ApprovalAuthorityBinding binding;
  bool complete = true;
};

[[nodiscard]] inline DerivedAuthorityBinding
DeriveAuthorityBinding(const ShadowAxCapture &capture, const ApprovalAuthorityIdentity &identity,
                       const ApprovalTargetFrame &target, const EffectFacts &facts,
                       const EffectDecision &decision) {
  using namespace measurement_detail;
  DerivedAuthorityBinding derived;
  if (facts.origin == OriginState::kOrdinary && capture.web_area_url_read) {
    const std::string origin = NormalizeOrigin(capture.web_area_url);
    if (!origin.empty()) derived.binding.origin = AuthorityString{true, origin};
  }
  if (decision.approval_effect != NativeApprovalEffect::kHighImpactConfirmation) return derived;
  derived.binding.content_bound = true;
  std::string joined;
  AppendLengthPrefixed(&joined, std::to_string(facts.neighbor_labels.size()));
  for (const std::string &label : facts.neighbor_labels) AppendLengthPrefixed(&joined, label);
  derived.binding.neighbors_digest = Sha256Hex(joined);
  if (!facts.neighbor_labels_complete) derived.complete = false;
  if (target.present && identity.geometry_present) {
    derived.binding.frame_present = true;
    derived.binding.relative_x = FloorDivide(target.x - identity.x, kAuthorityFrameGrid);
    derived.binding.relative_y = FloorDivide(target.y - identity.y, kAuthorityFrameGrid);
    derived.binding.relative_width = FloorDivide(target.width, kAuthorityFrameGrid);
    derived.binding.relative_height = FloorDivide(target.height, kAuthorityFrameGrid);
  } else {
    derived.complete = false;
  }
  return derived;
}

[[nodiscard]] inline std::string ApprovalAuthorityFrame(const ApprovalAuthorityIdentity &identity,
                                                        const ApprovalAuthorityBinding &binding,
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
  AppendString(&frame, "site", binding.origin);
  AppendNumber(&frame, "content", binding.content_bound ? 1 : 0);
  if (binding.content_bound) {
    AppendString(&frame, "captions", AuthorityString{true, binding.neighbors_digest});
    AppendLengthPrefixed(&frame, "place");
    frame.push_back(binding.frame_present ? 'P' : 'A');
    if (binding.frame_present) {
      AppendNumber(&frame, "rx", binding.relative_x);
      AppendNumber(&frame, "ry", binding.relative_y);
      AppendNumber(&frame, "rw", binding.relative_width);
      AppendNumber(&frame, "rh", binding.relative_height);
    }
  }
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
                                                         const ApprovalAuthorityBinding &binding,
                                                         const EffectFacts &facts,
                                                         const EffectDecision &decision) {
  return Sha256Hex(ApprovalAuthorityFrame(identity, binding, facts, decision));
}

enum class IntentRefusal : std::uint8_t {
  kNone,
  kRouteNotV2,
  kNotNativeFacts,
  kNotAnApproval,
  kVersionMismatch,
  kNotEnabled,
  kNotAttested,
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

// The rule set that classifier / ruleset version 2 names: the confirmation and the supervised
// action, and no file open (decision 2-A). Enabling more is a new ruleset version, not a flag.
[[nodiscard]] inline bool RulesetIsTheVersionsOwn(const EffectRuleset &ruleset) {
  const EffectRuleset canonical;
  return ruleset.download_open == canonical.download_open &&
         ruleset.file_manager_open == canonical.file_manager_open &&
         ruleset.high_impact_confirmation == canonical.high_impact_confirmation &&
         ruleset.supervised_action == canonical.supervised_action;
}

// The order is the contract: the route first (a session on v1 gets "no" whatever else is true), then
// what the build attests, then the decision itself.
[[nodiscard]] inline IntentVerdict JudgeIntentOffer(ClassifierRoute route, const EffectRuleset &ruleset,
                                                    const EffectDecision &decision,
                                                    HighImpactSource source,
                                                    std::uint32_t attested_classifier_version) {
  const auto refuse = [](IntentRefusal reason) { return IntentVerdict{false, reason, NativeApprovalEffect::kInvalid}; };
  if (route != ClassifierRoute::kV2) return refuse(IntentRefusal::kRouteNotV2);
  if (attested_classifier_version != kEffectClassifierVersion) return refuse(IntentRefusal::kNotAttested);
  if (decision.kind != DecisionKind::kApproval ||
      decision.approval_effect == NativeApprovalEffect::kInvalid)
    return refuse(IntentRefusal::kNotAnApproval);
  // Main's projection grants nothing; a confirmation needs native's own facts behind it.
  if (source == HighImpactSource::kMainProjection) return refuse(IntentRefusal::kNotNativeFacts);
  if (decision.approval_effect == NativeApprovalEffect::kHighImpactConfirmation &&
      source != HighImpactSource::kNativeFacts)
    return refuse(IntentRefusal::kNotNativeFacts);
  if (decision.classifier_version != kEffectClassifierVersion ||
      decision.ruleset_version != kEffectRulesetVersion ||
      decision.lexicon_version != kEffectLexiconVersion)
    return refuse(IntentRefusal::kVersionMismatch);
  if (!RulesetIsTheVersionsOwn(ruleset) || !RulesetEnables(ruleset, decision.approval_effect))
    return refuse(IntentRefusal::kNotEnabled);
  return IntentVerdict{true, IntentRefusal::kNone, decision.approval_effect};
}

struct ApprovalMeasurementInput {
  // The capture the facts are built from; not owned, and not kept.
  const ShadowAxCapture *capture = nullptr;
  ShadowRequestInfo request;
  ApprovalAuthorityIdentity identity;
  ApprovalTargetFrame target_frame;
  EffectRuleset ruleset;
  ClassifierRoute route = ClassifierRoute::kV1;
  HighImpactSource source = HighImpactSource::kNone;
  // The classifier version the build attests (0: none). An offer needs the core's own.
  std::uint32_t attested_classifier_version = 0;
};

// Builds the facts, asks the core, and states the result the way the approval flow compares it.
// The order is the contract:
//   1. no capture: a person's (takeover);
//   2. a session on route v1: not eligible, whatever the capture says (no takeover, no effect);
//   3. a decision that needs a person (a capture that is not whole, an unclassified text): takeover;
//   4. an approval whose identity could not be measured whole (application, process, window,
//      geometry): takeover;
//   5. an approval the offer rules do not allow (a source that cannot ground it, a version the
//      build does not attest, a rule set that is not the version's own): not eligible;
//   6. a confirmation whose captions or place could not be bound: takeover;
//   7. otherwise an approval the offer rules allow: eligible, with its effect, the authority digest
//      and the core's three versions. Everything that is not an approval (an ordinary control, a
//      refusal) is not eligible, with no effect and no digest.
[[nodiscard]] inline NativeApprovalMeasurement MeasureApproval(const ApprovalMeasurementInput &input) {
  NativeApprovalMeasurement measured;
  if (input.capture == nullptr) {
    measured.takeover = true;
    return measured;
  }
  if (input.route != ClassifierRoute::kV2) return measured;
  const ShadowFacts built = BuildShadowFacts(*input.capture, input.request);
  const EffectDecision decision = ClassifyEffect(built.facts, input.ruleset);
  if (decision.kind == DecisionKind::kTakeover) {
    measured.takeover = true;
    return measured;
  }
  if (decision.kind == DecisionKind::kApproval && !AuthorityIdentityIsWhole(input.identity)) {
    measured.takeover = true;
    return measured;
  }
  const IntentVerdict verdict = JudgeIntentOffer(input.route, input.ruleset, decision, input.source,
                                                 input.attested_classifier_version);
  if (!verdict.offer) return measured;
  const DerivedAuthorityBinding derived = DeriveAuthorityBinding(
      *input.capture, input.identity, input.target_frame, built.facts, decision);
  if (!derived.complete) {
    measured.takeover = true;
    return measured;
  }
  measured.eligible = true;
  measured.effect = verdict.effect;
  measured.authority_digest =
      ApprovalAuthorityDigest(input.identity, derived.binding, built.facts, decision);
  measured.classifier_version = decision.classifier_version;
  measured.ruleset_version = decision.ruleset_version;
  measured.lexicon_version = decision.lexicon_version;
  return measured;
}

} // namespace sprint_coder::computer_use
