#pragma once

// Classifier v2, S4-1-0: the interlock map. A pure function from what the portable effect
// classifier decided (and the facts behind it) to whether the native refuses the action outright,
// and with which reason code (ADR v2 section 3.6 execution-trigger interlock, section 3.7 surface
// deny). It has no platform header, N-API, clock or I/O, and is used the same way on macOS and on
// Windows (the facts differ, the table does not). NOTHING calls it yet: the receipts and the
// preflight are wired in S4-1a / S4-1b, and the classifier version, the preflight receipt and the
// attested versions are untouched.
//
// Two-stage policy (recorded in the ADR):
//   * S4-1 refuses on a POSITIVE match only: the core named an interlock class AND the facts that
//     class stands on are complete. When the facts are incomplete, or the core could not classify
//     the round, the answer is "no verdict" and the v1 preflight decides, exactly as before. This
//     keeps the applications that are eligible today (TextEdit, VS Code) working.
//   * S4-3 widens eligibility and must then refuse on incomplete facts (D13, fail closed) for every
//     newly eligible candidate. This map is not that rule; it must not be reused as if it were.
//
// What it maps:
//   * a command surface (shell, script input, command palette, DevTools console, or a surface word
//     in the chain)            -> blocked, native_shell_surface_blocked      (E5 and section 3.7)
//   * an executable or installer extension (E1, E4) opened from a file manager or a download list,
//     or an installer control activated      -> takeover, native_execution_trigger_blocked
//     The same file opened INSIDE an application (a script in an editor's file tree) is not an
//     execution trigger and is not refused here.
//   * opening a file from a file manager or a download list (E2, E3) while the approval path is
//     closed (the core's "approval not enabled")  -> blocked, native_approval_not_enabled
//     Once the rule set trusts the approval, the core says "approval" and the approval decides.
// Everything else the core says (secure and credential fields, confirmations, supervised actions,
// sensitive origins, observe-only, unclassified) is not an interlock and is left to v1.
//
// S5-c-3 PR-3 (#500, ADR v2 section 3.2.5): the STRICT map (MapEffectToStrictInterlock) is the rule
// of the second stage, for a session bound to the v2 eligibility basis only. It is a separate
// function: the map above is unchanged and stays the rule of every v1 session. NOTHING creates a v2
// session yet (a v1 build refuses the basis, and no v2 Windows native can be built).

#include "computer_use_effect_classifier.h"

#include <cstdint>
#include <optional>
#include <string_view>

namespace sprint_coder::computer_use {

// What a session's eligibility stands on, bound when the session is created (ADR v2 section 3.2.5).
// The names are the contract's computerUseEligibilityModeSchema values.
enum class EligibilityBasis : std::uint8_t { kV1Allowlist, kV2Denylist };
// What "no verdict" means for a session: V1 decides (S5-c-2 PR-5), or a person takes over (D13).
// Shared with the macOS S4-3, which widens eligibility the same way.
enum class IncompletePolicy : std::uint8_t { kDeferToV1, kTakeover };

[[nodiscard]] constexpr IncompletePolicy IncompletePolicyFor(EligibilityBasis basis) {
  switch (basis) {
  case EligibilityBasis::kV1Allowlist:
    return IncompletePolicy::kDeferToV1;
  case EligibilityBasis::kV2Denylist:
    return IncompletePolicy::kTakeover;
  }
  // A value outside the enumeration: the strict side.
  return IncompletePolicy::kTakeover;
}
static_assert(IncompletePolicyFor(EligibilityBasis::kV2Denylist) == IncompletePolicy::kTakeover,
              "a v2 session must take over what the interlocks cannot judge");
static_assert(IncompletePolicyFor(EligibilityBasis::kV1Allowlist) == IncompletePolicy::kDeferToV1,
              "a v1 session keeps the S5-c-2 PR-5 behaviour");

// The basis a session asks for, by its contract name. Anything else is not a basis.
[[nodiscard]] inline bool ParseEligibilityBasis(std::string_view name, EligibilityBasis *basis) {
  if (name == "v1-allowlist") {
    *basis = EligibilityBasis::kV1Allowlist;
    return true;
  }
  if (name == "v2-denylist") {
    *basis = EligibilityBasis::kV2Denylist;
    return true;
  }
  return false;
}

// Whether a native compiled as `build_is_v2` may hold a session of `basis`: a v1 build refuses the
// v2 basis (it has no deny-list); a v2 build keeps the v1 sessions it admits through the V1 allow-list.
[[nodiscard]] constexpr bool EligibilityBasisAdmitted(EligibilityBasis basis, bool build_is_v2) {
  switch (basis) {
  case EligibilityBasis::kV1Allowlist:
    return true;
  case EligibilityBasis::kV2Denylist:
    return build_is_v2;
  }
  return false;
}

// The policy a session's interlocks run under. A basis the build does not admit gets the strict one
// (such a session is refused when it is created, so this never relaxes anything).
[[nodiscard]] constexpr IncompletePolicy SessionInterlockPolicy(EligibilityBasis basis,
                                                                bool build_is_v2) {
  return EligibilityBasisAdmitted(basis, build_is_v2) ? IncompletePolicyFor(basis)
                                                      : IncompletePolicy::kTakeover;
}

enum class InterlockOutcome : std::uint8_t { kNone, kBlocked, kTakeover };
// kSecureField and kUnclassified come from the strict map only (S5-c-3 PR-3).
enum class InterlockReason : std::uint8_t {
  kNone,
  kShellSurface,
  kExecutionTrigger,
  kApprovalClosed,
  kSecureField,
  kUnclassified,
};

// What the strict map did with its one exception (a native Document whose only takeover is the unknown
// origin, ADR v2 section 3.2.5). Applied and each "not applied" are different values, so the verdict
// itself says why a Document was or was not let through.
enum class NativeDocumentException : std::uint8_t {
  kNotAsked,               // not a takeover of the core, or not the strict map
  kApplied,                // let through: the only takeover reason was the unknown origin
  kNotOriginUnknown,       // the core's takeover had another reason
  kReadabilityUnconfirmed, // the text was not confirmed readable (false, or not measured)
  kWebNotRuledOut,         // the target was not confirmed to show no web content
  kNotNativeDocument,      // the facts are not those of a Document with an unknown origin
};

struct InterlockVerdict {
  InterlockOutcome outcome = InterlockOutcome::kNone;
  InterlockReason reason = InterlockReason::kNone;
  EffectClass effect_class = EffectClass::kOrdinary;
  NativeDocumentException document_exception = NativeDocumentException::kNotAsked;

  [[nodiscard]] bool Refuses() const { return outcome != InterlockOutcome::kNone; }
  // The native reason code of the refusal; empty when there is no verdict.
  [[nodiscard]] std::string_view ReasonCode() const {
    switch (reason) {
    case InterlockReason::kShellSurface:
      return "native_shell_surface_blocked";
    case InterlockReason::kExecutionTrigger:
      return "native_execution_trigger_blocked";
    case InterlockReason::kApprovalClosed:
      // Its own code, so that one code means one (decision, result) pair in the receipt table.
      return "native_approval_not_enabled";
    case InterlockReason::kSecureField:
      return "native_secure_field_blocked";
    case InterlockReason::kUnclassified:
      return "native_target_unclassified";
    case InterlockReason::kNone:
      break;
    }
    return {};
  }
  // The error code a dispatch gives when it refuses (the preflight code without its "native_"
  // prefix: Main adds the prefix back). One reason, one code; empty when there is no verdict.
  [[nodiscard]] std::string_view DispatchCode() const {
    switch (reason) {
    case InterlockReason::kShellSurface:
      return "shell_surface_blocked";
    case InterlockReason::kExecutionTrigger:
      return "execution_trigger_blocked";
    case InterlockReason::kApprovalClosed:
      return "approval_not_enabled";
    case InterlockReason::kSecureField:
      return "secure_field_blocked";
    case InterlockReason::kUnclassified:
      return "target_unclassified";
    case InterlockReason::kNone:
      break;
    }
    return {};
  }
  // The receipt's decision for this refusal (the first column of the receipt table).
  [[nodiscard]] std::string_view DecisionName() const {
    switch (outcome) {
    case InterlockOutcome::kBlocked:
      return "blocked";
    case InterlockOutcome::kTakeover:
      return "takeover";
    case InterlockOutcome::kNone:
      break;
    }
    return {};
  }
  // The result the receipt carries: a block is rejected, a takeover is paused for a person. The
  // unclassified takeover is the receipt table's own row (takeover, rejected), as V1 sends it.
  [[nodiscard]] std::string_view DeniedResult() const {
    switch (outcome) {
    case InterlockOutcome::kBlocked:
      return "rejected";
    case InterlockOutcome::kTakeover:
      return reason == InterlockReason::kUnclassified ? "rejected" : "paused";
    case InterlockOutcome::kNone:
      break;
    }
    return {};
  }
};

namespace interlock_detail {

// The role walk lives in the core (it decides what counts as opening); the map uses the same one.
using effect_detail::ItemInSpan;
using effect_detail::RoleIsKnownContainer;
using effect_detail::RoleIsPassiveItem;

[[nodiscard]] inline InterlockVerdict Refusal(InterlockOutcome outcome, InterlockReason reason,
                                              EffectClass effect_class) {
  InterlockVerdict verdict;
  verdict.outcome = outcome;
  verdict.reason = reason;
  verdict.effect_class = effect_class;
  return verdict;
}

// The facts every interlock stands on: complete metadata, a complete non-empty chain and a known
// surface. This is a part of the gate the core applies before it classifies (the core also checks
// the bounds, which a decision that came from it has already passed; they are not repeated here).
[[nodiscard]] inline bool FactsAreComplete(const EffectFacts &facts) {
  return facts.metadata_complete && facts.chain_complete && !facts.chain.empty() &&
         facts.surface != SurfaceKind::kUnknown;
}

[[nodiscard]] inline bool IsListedSurface(SurfaceKind surface) {
  return surface == SurfaceKind::kFileBrowser || surface == SurfaceKind::kDownloadPanel;
}

// The core's extension rule applies to these facts: exactly the condition the core uses to refuse
// because of the extension of an item.
[[nodiscard]] inline bool RefusedByExtension(const EffectFacts &facts) {
  using namespace effect_detail;
  const std::string extension = NormalizeExtension(facts.extension);
  return (MayOpen(facts) || facts.action == ActionKind::kToggle) && facts.extension_known &&
         IsPlainExtension(extension) && InSet(extension, kExecutableExtensions);
}

// An installer control activated: the core's label rule (E4), independent of any extension that
// happens to be known for the item the control carries.
[[nodiscard]] inline bool InstallerControlActivated(const EffectFacts &facts) {
  using namespace effect_detail;
  return !ItemInSpan(facts) && IsActivating(facts) && TextIsClassifiable(facts) &&
         ActionableContains(facts, kInstallerTerms);
}

} // namespace interlock_detail

// Maps the core's decision for `facts` to an interlock verdict. `kNone` means "no verdict: v1
// decides".
[[nodiscard]] inline InterlockVerdict
MapEffectToInterlock(const EffectFacts &facts, const EffectDecision &decision,
                     const EffectRuleset &ruleset = EffectRuleset{}) {
  using namespace interlock_detail;
  if (facts.action == ActionKind::kObserve || !FactsAreComplete(facts)) return {};

  if (decision.kind == DecisionKind::kBlocked) {
    switch (decision.effect_class) {
    case EffectClass::kSurface:
      if (decision.reason == DecisionReason::kSurface)
        return Refusal(InterlockOutcome::kBlocked, InterlockReason::kShellSurface,
                       decision.effect_class);
      return {};
    case EffectClass::kE1ExecutableOpen:
    case EffectClass::kE4InstallerLaunch:
      if (decision.reason != DecisionReason::kExecutionTrigger) return {};
      // An extension is a trigger where opening the item runs or installs it. Inside an
      // application the same file merely opens (a script in an editor's tree): not refused here.
      // (An installer control is a trigger wherever it is, with or without an extension.)
      if (RefusedByExtension(facts) && !IsListedSurface(facts.surface) &&
          !InstallerControlActivated(facts))
        return {};
      // Refused for the words of the control, not for an extension: only a control has those words
      // in the sense that matters. A row or a text that is KNOWN to be one ("install.sh" in a file
      // tree) is a file, judged by its extension; a role nobody listed is a control.
      if (!RefusedByExtension(facts) && ItemInSpan(facts)) {
        // A passive item opened from a file manager or a download list is an opening that needs an
        // approval (E2 / E3), whatever word its name carries: the core may call it E4 for "install" in
        // the name, and the answer must not be weaker than the approval's. It needs the extension the
        // E2 / E3 rule needs; without it the round stays with v1. Inside an application (any other
        // surface) the file is a file in an editor and is not refused here.
        // The refusal says "the approval is closed", so it is only said while that is true for this
        // surface: once the rule set trusts the approval, the approval decides and there is no verdict.
        const bool approval_open = facts.surface == SurfaceKind::kDownloadPanel ? ruleset.download_open
                                                                                 : ruleset.file_manager_open;
        if (IsListedSurface(facts.surface) && effect_detail::MayOpen(facts) && facts.extension_known &&
            !approval_open)
          return Refusal(InterlockOutcome::kBlocked, InterlockReason::kApprovalClosed,
                         facts.surface == SurfaceKind::kDownloadPanel ? EffectClass::kE2DownloadOpen
                                                                      : EffectClass::kE3FileManagerOpen);
        return {};
      }
      return Refusal(InterlockOutcome::kTakeover, InterlockReason::kExecutionTrigger,
                     decision.effect_class);
    case EffectClass::kE2DownloadOpen:
    case EffectClass::kE3FileManagerOpen:
      if (decision.reason == DecisionReason::kApprovalNotEnabled)
        return Refusal(InterlockOutcome::kBlocked, InterlockReason::kApprovalClosed,
                       decision.effect_class);
      return {};
    default:
      return {};
    }
  }
  return {};
}

// The core's decision for `facts`, then the map.
[[nodiscard]] inline InterlockVerdict InterlockForFacts(const EffectFacts &facts,
                                                        const EffectRuleset &ruleset = EffectRuleset{}) {
  return MapEffectToInterlock(facts, ClassifyEffect(facts, ruleset), ruleset);
}

// ---- S5-c-3 PR-3: the strict map (v2 sessions only, ADR v2 section 3.2.5) --------------------------

namespace interlock_detail {

// Whether the text the core judges this action on is readable, measured again here and not taken from
// the core's order of checks: the label rule for an action, the readable scope (and, for a wheel that
// can change a value, its label) for a scroll. No value when it cannot be measured (facts outside the
// core's bounds, or no chain); only a value that is there and true lets the exception apply.
[[nodiscard]] inline std::optional<bool> StrictTextReadable(const EffectFacts &facts) {
  using namespace effect_detail;
  if (facts.chain.empty() || !WithinBounds(facts)) return std::nullopt;
  if (facts.action != ActionKind::kScroll) return TextIsClassifiable(facts);
  const std::size_t scope = ScrollScope(facts);
  if (!ScopeIsReadable(facts, scope)) return false;
  if (ScrollChangesValue(facts, scope)) return ScrollValueTextIsClassifiable(facts, scope);
  return true;
}

[[nodiscard]] inline bool ChainHasDocument(const EffectFacts &facts) {
  for (const NodeFacts &node : facts.chain)
    if (effect_detail::IsPageRoot(node)) return true;
  return false;
}

// The one exception to "a takeover of the core is a takeover": a Document that is confirmed to show no
// web content, whose only takeover reason is its unknown origin (Notepad's text area). Every condition is
// "there and true"; anything not measured keeps the takeover.
[[nodiscard]] inline NativeDocumentException
NativeDocumentExceptionFor(const EffectFacts &facts, const EffectDecision &decision,
                           const std::optional<bool> &text_readable) {
  if (decision.kind != DecisionKind::kTakeover || decision.reason != DecisionReason::kOriginUnknown)
    return NativeDocumentException::kNotOriginUnknown;
  if (!(text_readable.has_value() && *text_readable))
    return NativeDocumentException::kReadabilityUnconfirmed;
  if (!(facts.target_not_web.has_value() && *facts.target_not_web))
    return NativeDocumentException::kWebNotRuledOut;
  if (facts.origin != OriginState::kUnknown || !ChainHasDocument(facts))
    return NativeDocumentException::kNotNativeDocument;
  return NativeDocumentException::kApplied;
}

[[nodiscard]] inline InterlockVerdict StrictUnclassified(EffectClass effect_class) {
  return Refusal(InterlockOutcome::kTakeover, InterlockReason::kUnclassified, effect_class);
}

// Every refusal of the core is a refusal here, whatever its reason. The switch names every reason and
// has no default, so a reason added to the core fails the build (-Werror=switch, /we4062) until it is
// placed; a value outside the enumeration falls out of the switch and is refused.
[[nodiscard]] inline InterlockVerdict StrictBlocked(const EffectDecision &decision) {
  switch (decision.reason) {
  case DecisionReason::kSecure:
  case DecisionReason::kCredential:
    return Refusal(InterlockOutcome::kBlocked, InterlockReason::kSecureField, decision.effect_class);
  case DecisionReason::kSurface:
    return Refusal(InterlockOutcome::kBlocked, InterlockReason::kShellSurface, decision.effect_class);
  case DecisionReason::kExecutionTrigger:
    return Refusal(InterlockOutcome::kTakeover, InterlockReason::kExecutionTrigger,
                   decision.effect_class);
  case DecisionReason::kApprovalNotEnabled:
    return Refusal(InterlockOutcome::kBlocked, InterlockReason::kApprovalClosed, decision.effect_class);
  case DecisionReason::kNone:
  case DecisionReason::kUnclassified:
  case DecisionReason::kSensitiveOrigin:
  case DecisionReason::kObserveOnly:
  case DecisionReason::kOriginUnknown:
    break;
  }
  return StrictUnclassified(decision.effect_class);
}

} // namespace interlock_detail

// The strict map: what a v2 session refuses for the core's decision. Reading is never refused. Incomplete
// facts are a takeover. A refusal of the map above stays that refusal (same codes). Then every kind of
// decision is placed: ordinary and an approval are no verdict (the approval path, as before), a refusal
// is a refusal whatever its reason, a takeover is a takeover except the native Document above. The
// switch names every kind and has no default; a kind outside the enumeration is a takeover.
// `text_readable` is StrictTextReadable(facts) on the production path.
[[nodiscard]] inline InterlockVerdict
MapEffectToStrictInterlock(const EffectFacts &facts, const EffectDecision &decision,
                           const std::optional<bool> &text_readable,
                           const EffectRuleset &ruleset = EffectRuleset{}) {
  using namespace interlock_detail;
  if (facts.action == ActionKind::kObserve) return {};
  if (!FactsAreComplete(facts)) return StrictUnclassified(EffectClass::kUnclassified);
  const InterlockVerdict mapped = MapEffectToInterlock(facts, decision, ruleset);
  if (mapped.Refuses()) return mapped;
  switch (decision.kind) {
  case DecisionKind::kOrdinary:
  case DecisionKind::kApproval:
    return {};
  case DecisionKind::kBlocked:
    return StrictBlocked(decision);
  case DecisionKind::kTakeover: {
    const NativeDocumentException exception =
        NativeDocumentExceptionFor(facts, decision, text_readable);
    InterlockVerdict verdict = exception == NativeDocumentException::kApplied
                                   ? InterlockVerdict{}
                                   : StrictUnclassified(decision.effect_class);
    verdict.document_exception = exception;
    return verdict;
  }
  }
  return StrictUnclassified(decision.effect_class);
}

// The core's decision for `facts`, then the strict map, with the readability measured from the facts.
[[nodiscard]] inline InterlockVerdict
StrictInterlockForFacts(const EffectFacts &facts, const EffectRuleset &ruleset = EffectRuleset{}) {
  return MapEffectToStrictInterlock(facts, ClassifyEffect(facts, ruleset),
                                    interlock_detail::StrictTextReadable(facts), ruleset);
}

} // namespace sprint_coder::computer_use
