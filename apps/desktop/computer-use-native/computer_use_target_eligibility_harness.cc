// Harness for the shared target eligibility core (S5-c-3, #500 PR-1). It runs the golden vectors
// the TS core also runs, rebuilds the canonical text from the compiled tables and checks its hash
// against the one the generator recorded, and checks monotonicity: a refusal signal added to, or a
// fact taken away from, any golden target never makes it more eligible. No platform header, no
// window, no process. CI compiles it with MSVC (the Windows v2 harness row) and clang (macOS).

#include "computer_use_native_eligibility.h"
#include "computer_use_sha256.h"
#include "computer_use_target_eligibility.h"
#include "computer_use_target_eligibility_golden_generated.h"

#include <cstddef>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace {

using namespace sprint_coder::computer_use;

bool Check(bool condition, std::string_view code) {
  if (!condition) std::cerr << "target eligibility harness: FAIL " << code << '\n';
  return condition;
}

// More is more permissive. A refusal and an unresolvable target are equally not eligible.
int Rank(TargetVerdictKind kind) {
  switch (kind) {
  case TargetVerdictKind::kEligible: return 2;
  case TargetVerdictKind::kUpper: return 1;
  case TargetVerdictKind::kDenied:
  case TargetVerdictKind::kUnresolvable: return 0;
  }
  return 0;
}

// What leaves the core is the kind and the mode only (the TS source contract pins the fields).
static_assert(std::is_same_v<decltype(TargetVerdict{}.kind), TargetVerdictKind>);
static_assert(std::is_same_v<decltype(TargetVerdict{}.maximum_mode), std::string_view>);

bool CheckGlob() {
  return Check(target_eligibility_detail::GlobMatches("setup*", "setup.exe"), "glob-prefix") &&
         Check(target_eligibility_detail::GlobMatches("*install*", "uninstall.exe"),
               "glob-infix") &&
         Check(target_eligibility_detail::GlobMatches("*update*.exe", "contosoupdater.exe"),
               "glob-two-stars") &&
         Check(!target_eligibility_detail::GlobMatches("*update*.exe", "update.dll"),
               "glob-suffix") &&
         Check(target_eligibility_detail::GlobMatches("a*b*c", "aXbYbZc"), "glob-backtrack") &&
         Check(!target_eligibility_detail::GlobMatches("cmd.exe", "cmd.exe2"), "glob-exact") &&
         Check(target_eligibility_detail::GlobMatches("*", ""), "glob-empty");
}

bool CheckTables() {
  // A deny-only signal never admits a route and is never negated (the generator refuses it too).
  for (const TargetRoute &route : kTargetRoutes)
    for (const TargetCondition &condition : route.when)
      for (const TargetSignalSpec &spec : kTargetSignals)
        if (spec.signal == condition.signal && !Check(!spec.deny_only, "deny-only-in-route"))
          return false;
  for (const TargetRule &rule : kTargetRules)
    for (const TargetCondition &condition : rule.when)
      for (const TargetSignalSpec &spec : kTargetSignals)
        if (spec.signal == condition.signal &&
            !Check(!(spec.deny_only && condition.negate), "deny-only-negated"))
          return false;
  if (!Check(std::size(kTargetSignals) == kTargetSignalCount, "signal-count")) return false;
  for (std::size_t index = 0; index < std::size(kTargetSignals); ++index)
    if (!Check(static_cast<std::size_t>(kTargetSignals[index].signal) == index, "signal-order"))
      return false;
  return true;
}

bool CheckContentHash() {
  for (const TargetPlatformRuleset &ruleset : kTargetPlatformRulesets) {
    const std::string text = DenyRulesetCanonicalText(ruleset.platform);
    if (!Check(!text.empty() && Sha256Hex(text) == ruleset.content_sha256, "content-hash"))
      return false;
    if (!Check(DenyRulesetVersion(ruleset.platform) == ruleset.ruleset_version &&
                   ruleset.ruleset_version > 0 && ruleset.ruleset_version <= 0xffff,
               "ruleset-version"))
      return false;
  }
  return Check(DenyRulesetCanonicalText(TargetPlatform::kUnknown).empty() &&
                   DenyRulesetVersion(TargetPlatform::kUnknown) == 0,
               "no-ruleset-unknown-platform");
}

bool CheckGolden(const std::vector<TargetGoldenCase> &cases) {
  for (const TargetGoldenCase &entry : cases) {
    const TargetClassification explained = ClassifyTargetExplained(entry.facts);
    const TargetVerdict verdict = ClassifyTarget(entry.facts);
    if (explained.verdict.kind != entry.kind || explained.deny_class != entry.deny_class ||
        verdict.kind != entry.kind) {
      std::cerr << "golden case \"" << entry.name << "\": got "
                << TargetVerdictKindName(explained.verdict.kind) << ' ' << explained.deny_class
                << ", want " << TargetVerdictKindName(entry.kind) << ' ' << entry.deny_class
                << '\n';
      return Check(false, "golden");
    }
    const bool admitted =
        entry.kind == TargetVerdictKind::kEligible || entry.kind == TargetVerdictKind::kUpper;
    if (!Check(admitted == !verdict.maximum_mode.empty(), "golden-mode-only-when-admitted") ||
        !Check(admitted == !explained.route.empty(), "golden-route-only-when-admitted"))
      return false;
  }
  return Check(cases.size() >= 40, "golden-count");
}

// Sets the fact `condition` reads to a value that satisfies it. Only called for conditions that
// are not negated, in rules that refuse or cap.
void Satisfy(TargetFacts *facts, const TargetCondition &condition) {
  if (condition.match == TargetMatch::kTrue || condition.match == TargetMatch::kFalse) {
    *MutableTargetBooleanFact(*facts, condition.signal) = condition.match == TargetMatch::kTrue;
    return;
  }
  std::string value(condition.values.front());
  for (char &letter : value)
    if (letter == '*') letter = 'x';
  *MutableTargetStringFact(*facts, condition.signal) = value;
}

// True when the fact `signal` already holds a refusal or cap signal (or holds nothing). A fact
// holds one value, so setting it to another signal would take that one away rather than add one;
// such a fact is not mutated.
bool CarriesSignal(const TargetFacts &facts, TargetSignal signal) {
  // An unmeasured fact (or one the ruleset does not know) is not mutated either: measuring it is
  // not adding a signal.
  for (const TargetSignalSpec &spec : kTargetSignals)
    if (spec.signal == signal && !target_eligibility_detail::FactIsMeasured(facts, spec))
      return true;
  for (const TargetRule &rule : kTargetRules)
    for (const TargetCondition &condition : rule.when)
      if (condition.signal == signal && !condition.negate &&
          target_eligibility_detail::ConditionHolds(facts, condition))
        return true;
  return false;
}

bool CheckMonotonic(const std::vector<TargetGoldenCase> &cases) {
  std::size_t mutations = 0;
  for (const TargetGoldenCase &entry : cases) {
    const int before = Rank(ClassifyTarget(entry.facts).kind);
    for (const TargetRule &rule : kTargetRules) {
      bool negated = false;
      for (const TargetCondition &condition : rule.when) negated = negated || condition.negate;
      if (negated) continue;
      bool carried = false;
      for (const TargetCondition &condition : rule.when)
        carried = carried || CarriesSignal(entry.facts, condition.signal);
      TargetFacts whole = entry.facts;
      for (const TargetCondition &condition : rule.when) {
        if (CarriesSignal(entry.facts, condition.signal)) continue;
        TargetFacts single = entry.facts;
        Satisfy(&single, condition);
        Satisfy(&whole, condition);
        ++mutations;
        if (Rank(ClassifyTarget(single).kind) > before) {
          std::cerr << "golden case \"" << entry.name << "\" became more eligible\n";
          return Check(false, "monotonic-signal");
        }
      }
      if (carried) continue;
      if (!Check(Rank(ClassifyTarget(whole).kind) <= before, "monotonic-rule")) return false;
      // A whole refusing rule refuses a target whose facts are complete.
      if (rule.verdict == TargetRuleVerdict::kDenied && TargetFactsAreComplete(whole) &&
          (rule.platforms & TargetPlatformBit(whole.platform)) != 0 &&
          !Check(ClassifyTarget(whole).kind == TargetVerdictKind::kDenied, "rule-refuses"))
        return false;
    }
    for (const TargetSignalSpec &spec : kTargetSignals) {
      TargetFacts unknown = entry.facts;
      if (spec.type == TargetSignalType::kBoolean)
        MutableTargetBooleanFact(unknown, spec.signal)->reset();
      else
        MutableTargetStringFact(unknown, spec.signal)->reset();
      ++mutations;
      const TargetVerdictKind kind = ClassifyTarget(unknown).kind;
      if (!Check(Rank(kind) <= before, "monotonic-unknown")) return false;
      if ((spec.platforms & TargetPlatformBit(unknown.platform)) != 0 &&
          !Check(kind == TargetVerdictKind::kUnresolvable, "unknown-is-unresolvable"))
        return false;
    }
  }
  std::cout << "  monotonic mutations checked: " << mutations << '\n';
  return true;
}

bool CheckEligibilityMode() {
#if defined(SPRINT_CODER_EXPECT_ELIGIBILITY_V2)
  // The CI row names the mode it compiled the harness for.
  static_assert(SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 0 || SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 1,
                "The expected eligibility mode is v1 (0) or v2 (1).");
  if (!Check(kNativeEligibilityIsV2 == (SPRINT_CODER_EXPECT_ELIGIBILITY_V2 == 1),
             "eligibility-mode-matches-row"))
    return false;
#endif
  std::cout << "  compiled eligibility mode: " << kNativeEligibilityModeName << '\n';
  return true;
}

} // namespace

int main() {
  const std::vector<TargetGoldenCase> cases = TargetGoldenCases();
  if (!CheckEligibilityMode() || !CheckGlob() || !CheckTables() || !CheckContentHash() ||
      !CheckGolden(cases) || !CheckMonotonic(cases))
    return 1;
  std::cout << "Computer Use target eligibility core: PASS (" << cases.size()
            << " golden vectors)\n";
  return 0;
}
