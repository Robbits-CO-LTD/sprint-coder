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
//     closed (the core's "approval not enabled")  -> blocked, native_execution_trigger_blocked
//     Once the rule set trusts the approval, the core says "approval" and the approval decides.
// Everything else the core says (secure and credential fields, confirmations, supervised actions,
// sensitive origins, observe-only, unclassified) is not an interlock and is left to v1.

#include "computer_use_effect_classifier.h"

#include <cstdint>
#include <string_view>

namespace sprint_coder::computer_use {

enum class InterlockOutcome : std::uint8_t { kNone, kBlocked, kTakeover };
enum class InterlockReason : std::uint8_t { kNone, kShellSurface, kExecutionTrigger, kApprovalClosed };

struct InterlockVerdict {
  InterlockOutcome outcome = InterlockOutcome::kNone;
  InterlockReason reason = InterlockReason::kNone;
  EffectClass effect_class = EffectClass::kOrdinary;

  [[nodiscard]] bool Refuses() const { return outcome != InterlockOutcome::kNone; }
  // The native reason code of the refusal; empty when there is no verdict.
  [[nodiscard]] std::string_view ReasonCode() const {
    switch (reason) {
    case InterlockReason::kShellSurface:
      return "native_shell_surface_blocked";
    case InterlockReason::kExecutionTrigger:
    case InterlockReason::kApprovalClosed:
      return "native_execution_trigger_blocked";
    case InterlockReason::kNone:
      break;
    }
    return {};
  }
  // The result the receipt carries: a block is rejected, a takeover is paused for a person.
  [[nodiscard]] std::string_view DeniedResult() const {
    switch (outcome) {
    case InterlockOutcome::kBlocked:
      return "rejected";
    case InterlockOutcome::kTakeover:
      return "paused";
    case InterlockOutcome::kNone:
      break;
    }
    return {};
  }
};

namespace interlock_detail {

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

// Whether the control the action lands on is a control (a button, a link, a menu item, a check box:
// something that is pressed) rather than an item of a list or a text (a row, a cell, an outline item,
// a list item, static text: something that is named). The control is the target up to the nearest
// actionable ancestor, the same range the core reads its words from, so the label inside a button
// is inside the control. This is decided by the ROLE, not by whether a file is attached: a button can
// carry an AXURL or a file name and is still a button, and a file's row is still a row. The macOS
// roles (AXButton, AXMenuItem, ...) and the Windows control types (Button, MenuItem, ...) both
// contain these words once lowercased.
[[nodiscard]] inline bool ControlInSpan(const EffectFacts &facts) {
  using namespace effect_detail;
  static constexpr std::string_view kControls[] = {
      "button",   "link",       "menuitem", "checkbox",  "radiobutton", "switch",
      "popupbutton", "menubutton", "hyperlink", "tabitem", "splitbutton", "toggle"};
  const std::size_t span = ActionableSpan(facts);
  for (std::size_t index = 0; index < span && index < facts.chain.size(); ++index) {
    const std::string role = NormalizeForMatch(facts.chain[index].role) + " " +
                             NormalizeForMatch(facts.chain[index].subrole);
    for (const std::string_view name : kControls)
      if (role.find(name) != std::string::npos) return true;
  }
  return false;
}

// An installer control activated: the core's label rule (E4), independent of any extension that
// happens to be known for the item the control carries.
[[nodiscard]] inline bool InstallerControlActivated(const EffectFacts &facts) {
  using namespace effect_detail;
  return ControlInSpan(facts) && IsActivating(facts) && TextIsClassifiable(facts) &&
         ActionableContains(facts, kInstallerTerms);
}

} // namespace interlock_detail

// Maps the core's decision for `facts` to an interlock verdict. `kNone` means "no verdict: v1
// decides".
[[nodiscard]] inline InterlockVerdict MapEffectToInterlock(const EffectFacts &facts,
                                                           const EffectDecision &decision) {
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
      // in the sense that matters. A row or a text named like an installer ("install.sh" in a file
      // tree) is a file, judged by its extension.
      if (!RefusedByExtension(facts) && !ControlInSpan(facts)) return {};
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
  return MapEffectToInterlock(facts, ClassifyEffect(facts, ruleset));
}

} // namespace sprint_coder::computer_use
