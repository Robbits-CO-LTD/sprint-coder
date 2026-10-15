#pragma once

// The closed set of blocked and takeover preflight receipts, as (decision, reason, result). Portable
// (no platform header), so that the macOS native, the portable interlock harness and the Main
// adapter's table (NATIVE_PREFLIGHT_REFUSALS) are checked against ONE list instead of each repeating
// it. A reason is only valid together with the decision and result of its own row.
//
// The shell-surface, approval-not-enabled and execution-trigger rows (ADR v2 sections 3.6, 3.7,
// classifier v2 S4-1) are here before anything returns them: a producer is wired in a later change.

#include <cstddef>
#include <iterator>
#include <string_view>

namespace sprint_coder::computer_use {

struct NativePreflightRefusalEntry {
  const char *decision;
  const char *reason_code;
  const char *result;
};

inline constexpr NativePreflightRefusalEntry kNativePreflightRefusalTable[] = {
    {"blocked", "native_secure_field_blocked", "rejected"},
    {"blocked", "native_shell_surface_blocked", "rejected"},
    {"blocked", "native_approval_not_enabled", "rejected"},
    {"takeover", "native_high_impact_user_takeover", "paused"},
    {"takeover", "native_target_unclassified", "rejected"},
    {"takeover", "native_execution_trigger_blocked", "paused"},
};

inline constexpr std::size_t kNativePreflightRefusalCount = std::size(kNativePreflightRefusalTable);

[[nodiscard]] inline bool NativePreflightRefusalAllowed(std::string_view decision,
                                                        std::string_view reason_code,
                                                        std::string_view result) {
  for (const NativePreflightRefusalEntry &entry : kNativePreflightRefusalTable)
    if (decision == entry.decision && reason_code == entry.reason_code && result == entry.result)
      return true;
  return false;
}

} // namespace sprint_coder::computer_use
