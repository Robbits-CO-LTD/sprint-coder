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

// Whether a role names a passive item of a list or a text (a row, a cell, an outline row, a list
// item, a tree item, a data item, static text). An ALLOW LIST, matched whole after lowercasing and
// dropping the macOS "ax" prefix, so the Windows control types (ListItem, DataItem, TreeItem, Text)
// and the macOS roles (AXRow, AXOutlineRow, AXStaticText, ...) name the same things.
[[nodiscard]] inline bool RoleIsPassiveItem(std::string_view role) {
  using namespace effect_detail;
  std::string name = NormalizeForMatch(role);
  if (name.rfind("ax", 0) == 0) name.erase(0, 2);
  static constexpr std::string_view kItems[] = {"row",      "cell",     "outlinerow", "listitem",
                                                "treeitem", "dataitem", "statictext", "text"};
  for (const std::string_view item : kItems)
    if (name == item) return true;
  return false;
}

// A known container: something items live in, which is never pressed itself (a list, an outline, a
// table, a browser, a scroll area, a window, the application, a web area; UI Automation's List, Tree,
// DataGrid, Table, Pane, Window and Document). Matched whole, like the items.
[[nodiscard]] inline bool RoleIsKnownContainer(std::string_view role) {
  using namespace effect_detail;
  std::string name = NormalizeForMatch(role);
  if (name.rfind("ax", 0) == 0) name.erase(0, 2);
  static constexpr std::string_view kContainers[] = {
      "list", "outline", "table",  "browser", "scrollarea", "window", "application",
      "webarea", "tree", "datagrid", "pane", "document"};
  for (const std::string_view container : kContainers)
    if (name == container) return true;
  return false;
}

// Whether what the action lands on is KNOWN to be a passive item: walking up from the target, every
// node has an allow-listed role (and no subrole other than an allow-listed one) until the nearest
// KNOWN container is reached. Anything else is treated as a control: a role nobody listed anywhere on
// the way up (an AXGroup a page made clickable, a Custom, a combo box, a disclosure triangle, a menu
// bar item, a split button), a chain that never reaches a known container, and a target that is
// itself a container. This fails closed on purpose. It does not stop at the core's nearest
// actionable ancestor: the core does not recognize a group or a custom control as actionable, so a
// label under one would look like an item on its own. The decision is by ROLE, never by whether a
// file is attached: a button can carry an AXURL or a file name and is still a button, and a file's
// row is still a row.
[[nodiscard]] inline bool ItemInSpan(const EffectFacts &facts) {
  for (std::size_t index = 0; index < facts.chain.size(); ++index) {
    const NodeFacts &node = facts.chain[index];
    if (RoleIsKnownContainer(node.role)) return index > 0;
    if (!RoleIsPassiveItem(node.role)) return false;
    if (!effect_detail::NormalizeForMatch(node.subrole).empty() && !RoleIsPassiveItem(node.subrole))
      return false;
  }
  return false;
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
      // in the sense that matters. A row or a text that is KNOWN to be one ("install.sh" in a file
      // tree) is a file, judged by its extension; a role nobody listed is a control.
      if (!RefusedByExtension(facts) && ItemInSpan(facts)) {
        // A passive item opened from a file manager or a download list is an opening that needs an
        // approval (E2 / E3), whatever word its name carries: the core may call it E4 for "install" in
        // the name, and the answer must not be weaker than the approval's. It needs the extension the
        // E2 / E3 rule needs; without it the round stays with v1. Inside an application (any other
        // surface) the file is a file in an editor and is not refused here.
        if (IsListedSurface(facts.surface) && effect_detail::MayOpen(facts) && facts.extension_known)
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
  return MapEffectToInterlock(facts, ClassifyEffect(facts, ruleset));
}

} // namespace sprint_coder::computer_use
