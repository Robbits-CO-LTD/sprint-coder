#pragma once

// Pure, portable (C++20) target eligibility core shared by both natives (S5-c-3, #500 PR-1). The
// native measures the facts of a target (computer_use_deny_ruleset_generated.h defines them) and
// this decides, from the deny ruleset generated out of deny-ruleset.json. Nothing calls it yet. It
// has no platform header, so MSVC (/W4 /sdl) and clang both compile it.
//
// Rules (the TS core, computer-use-target-eligibility.ts, implements the same and the golden
// vectors and the seam hold the two together):
//   * a platform with no ruleset, or any fact of that platform that was not measured (or is not a
//     value the ruleset knows), is unresolvable: the default is not eligible;
//   * a denied rule that matches refuses (the first one in order names the class);
//   * otherwise a route must admit the target, or it is refused as W-NR;
//   * an upper rule that matches caps the mode; anything else is eligible;
//   * a refusal carries neither a label nor a class outward: ClassifyTarget returns only the kind,
//     and only ClassifyTargetExplained (harness and tests) says which class refused.

#include "computer_use_deny_ruleset_generated.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

// A measured string longer than this is treated as not measured.
inline constexpr std::size_t kTargetFactMaxBytes = 1024;

enum class TargetVerdictKind : std::uint8_t { kEligible, kUpper, kDenied, kUnresolvable };

// What leaves the core. A refusal says nothing but that it is one.
struct TargetVerdict {
  TargetVerdictKind kind = TargetVerdictKind::kUnresolvable;
  // The highest mode the target may be bound with: set for eligible and upper only.
  std::string_view maximum_mode;
};

// For the harness and tests only: which class refused, or which route admitted.
struct TargetClassification {
  TargetVerdict verdict;
  std::string_view deny_class;
  std::string_view route;
};

[[nodiscard]] constexpr std::string_view TargetVerdictKindName(TargetVerdictKind kind) {
  switch (kind) {
  case TargetVerdictKind::kEligible: return "eligible";
  case TargetVerdictKind::kUpper: return "upper";
  case TargetVerdictKind::kDenied: return "denied";
  case TargetVerdictKind::kUnresolvable: return "unresolvable";
  }
  return "unresolvable";
}

namespace target_eligibility_detail {

[[nodiscard]] inline std::string AsciiLower(std::string_view value) {
  std::string output(value);
  for (char &letter : output)
    if (letter >= 'A' && letter <= 'Z') letter = static_cast<char>(letter - 'A' + 'a');
  return output;
}

// `*` matches any run of bytes (including none); every other byte matches itself.
[[nodiscard]] inline bool GlobMatches(std::string_view pattern, std::string_view text) {
  std::size_t p = 0;
  std::size_t t = 0;
  std::size_t star = std::string_view::npos;
  std::size_t resume = 0;
  while (t < text.size()) {
    if (p < pattern.size() && pattern[p] == '*') {
      star = p++;
      resume = t;
    } else if (p < pattern.size() && pattern[p] == text[t]) {
      ++p;
      ++t;
    } else if (star != std::string_view::npos) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.size() && pattern[p] == '*') ++p;
  return p == pattern.size();
}

[[nodiscard]] inline const TargetPlatformRuleset *RulesetFor(TargetPlatform platform) {
  for (const TargetPlatformRuleset &ruleset : kTargetPlatformRulesets)
    if (ruleset.platform == platform) return &ruleset;
  return nullptr;
}

[[nodiscard]] inline bool FactIsMeasured(const TargetFacts &facts, const TargetSignalSpec &spec) {
  if (spec.type == TargetSignalType::kBoolean) {
    const std::optional<bool> *value = TargetBooleanFact(facts, spec.signal);
    return value != nullptr && value->has_value();
  }
  const std::optional<std::string> *value = TargetStringFact(facts, spec.signal);
  if (value == nullptr || !value->has_value() || (*value)->size() > kTargetFactMaxBytes)
    return false;
  if (spec.type != TargetSignalType::kEnum) return true;
  for (const std::string_view allowed : spec.values)
    if (**value == allowed) return true;
  return false;
}

[[nodiscard]] inline bool ConditionHolds(const TargetFacts &facts, const TargetCondition &condition) {
  bool holds = false;
  switch (condition.match) {
  case TargetMatch::kTrue:
  case TargetMatch::kFalse: {
    const std::optional<bool> *value = TargetBooleanFact(facts, condition.signal);
    holds = value != nullptr && value->has_value() &&
            **value == (condition.match == TargetMatch::kTrue);
    break;
  }
  case TargetMatch::kEquals:
  case TargetMatch::kPrefix:
  case TargetMatch::kGlob: {
    const std::optional<std::string> *value = TargetStringFact(facts, condition.signal);
    if (value == nullptr || !value->has_value()) break;
    const std::string folded = AsciiLower(**value);
    for (const std::string_view candidate : condition.values) {
      if (condition.match == TargetMatch::kEquals ? folded == candidate
          : condition.match == TargetMatch::kPrefix
              ? std::string_view(folded).substr(0, candidate.size()) == candidate
              : GlobMatches(candidate, folded)) {
        holds = true;
        break;
      }
    }
    break;
  }
  }
  return condition.negate ? !holds : holds;
}

template <typename Conditions>
[[nodiscard]] bool AllHold(const TargetFacts &facts, const Conditions &when) {
  for (const TargetCondition &condition : when)
    if (!ConditionHolds(facts, condition)) return false;
  return true;
}

inline void AppendWhen(std::string *text, const TargetCondition &condition) {
  static constexpr std::string_view kMatchNames[] = {"true", "false", "equals", "prefix", "glob"};
  *text += "when\t";
  for (const TargetSignalSpec &spec : kTargetSignals)
    if (spec.signal == condition.signal) *text += spec.name;
  *text += '\t';
  *text += kMatchNames[static_cast<std::size_t>(condition.match)];
  *text += condition.negate ? "\t1" : "\t0";
  for (const std::string_view value : condition.values) {
    *text += '\t';
    *text += value;
  }
  *text += '\n';
}

[[nodiscard]] constexpr std::string_view VerdictName(TargetRuleVerdict verdict) {
  return verdict == TargetRuleVerdict::kDenied ? "denied" : "upper";
}

} // namespace target_eligibility_detail

// True when every fact the platform's ruleset reads was measured and is a value it knows.
[[nodiscard]] inline bool TargetFactsAreComplete(const TargetFacts &facts) {
  const std::uint32_t bit = TargetPlatformBit(facts.platform);
  if (bit == 0 || target_eligibility_detail::RulesetFor(facts.platform) == nullptr) return false;
  for (const TargetSignalSpec &spec : kTargetSignals)
    if ((spec.platforms & bit) != 0 && !target_eligibility_detail::FactIsMeasured(facts, spec))
      return false;
  return true;
}

[[nodiscard]] inline TargetClassification ClassifyTargetExplained(const TargetFacts &facts) {
  using namespace target_eligibility_detail;
  TargetClassification result;
  const TargetPlatformRuleset *ruleset = RulesetFor(facts.platform);
  if (ruleset == nullptr || !TargetFactsAreComplete(facts)) return result;
  const std::uint32_t bit = TargetPlatformBit(facts.platform);
  for (const TargetRule &rule : kTargetRules)
    if (rule.verdict == TargetRuleVerdict::kDenied && (rule.platforms & bit) != 0 &&
        AllHold(facts, rule.when)) {
      result.verdict.kind = TargetVerdictKind::kDenied;
      result.deny_class = rule.class_id;
      return result;
    }
  for (const TargetRoute &route : kTargetRoutes)
    if ((route.platforms & bit) != 0 && AllHold(facts, route.when)) {
      result.route = route.id;
      break;
    }
  if (result.route.empty()) {
    result.verdict.kind = TargetVerdictKind::kDenied;
    result.deny_class = "W-NR";
    return result;
  }
  for (const TargetRule &rule : kTargetRules)
    if (rule.verdict == TargetRuleVerdict::kUpper && (rule.platforms & bit) != 0 &&
        AllHold(facts, rule.when)) {
      result.verdict = {TargetVerdictKind::kUpper, ruleset->upper_maximum_mode};
      return result;
    }
  result.verdict = {TargetVerdictKind::kEligible, ruleset->eligible_maximum_mode};
  return result;
}

[[nodiscard]] inline TargetVerdict ClassifyTarget(const TargetFacts &facts) {
  return ClassifyTargetExplained(facts).verdict;
}

// The ruleset version a platform's targets are judged under, or 0 when it has no ruleset.
[[nodiscard]] inline std::uint32_t DenyRulesetVersion(TargetPlatform platform) {
  const TargetPlatformRuleset *ruleset = target_eligibility_detail::RulesetFor(platform);
  return ruleset == nullptr ? 0 : ruleset->ruleset_version;
}

// The text the content hash is taken over, rebuilt from the compiled tables (the generator and the
// TS core build the same text from theirs). Empty when the platform has no ruleset.
[[nodiscard]] inline std::string DenyRulesetCanonicalText(TargetPlatform platform) {
  using namespace target_eligibility_detail;
  const TargetPlatformRuleset *ruleset = RulesetFor(platform);
  if (ruleset == nullptr) return {};
  const std::uint32_t bit = TargetPlatformBit(platform);
  std::string text = "deny-ruleset canonical " + std::to_string(kDenyRulesetSchemaVersion) + "\n";
  text += "platform\t";
  text += TargetPlatformName(platform);
  text += "\nmode\teligible\t";
  text += ruleset->eligible_maximum_mode;
  text += "\nmode\tupper\t";
  text += ruleset->upper_maximum_mode;
  text += '\n';
  static constexpr std::string_view kTypeNames[] = {"boolean", "enum", "string"};
  for (const TargetSignalSpec &spec : kTargetSignals) {
    if ((spec.platforms & bit) == 0) continue;
    text += "signal\t";
    text += spec.name;
    text += '\t';
    text += kTypeNames[static_cast<std::size_t>(spec.type)];
    text += spec.deny_only ? "\t1" : "\t0";
    for (const std::string_view value : spec.values) {
      text += '\t';
      text += value;
    }
    text += '\n';
  }
  for (const TargetClassSpec &entry : kTargetClasses) {
    text += "class\t";
    text += entry.id;
    text += '\t';
    text += VerdictName(entry.verdict);
    text += '\n';
  }
  for (const TargetRoute &route : kTargetRoutes) {
    if ((route.platforms & bit) == 0) continue;
    text += "route\t";
    text += route.id;
    text += '\n';
    for (const TargetCondition &condition : route.when) AppendWhen(&text, condition);
  }
  for (const TargetRule &rule : kTargetRules) {
    if ((rule.platforms & bit) == 0) continue;
    text += "rule\t";
    text += rule.class_id;
    text += '\t';
    text += VerdictName(rule.verdict);
    text += '\n';
    for (const TargetCondition &condition : rule.when) AppendWhen(&text, condition);
  }
  return text;
}

} // namespace sprint_coder::computer_use
