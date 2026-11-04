#pragma once

#include "computer_use_url_origin.h"

namespace sprint_coder::computer_use {

// Version 1 establishes no ordinary page. Sensitive labels remain refusal-only
// evidence, including on address aliases whose binding material is rejected.
inline constexpr unsigned kOriginClassificationVersion = 1;
struct ClassifiedPageOrigin {
  OriginState state = OriginState::kUnknown;
  std::string normalized_origin;
};

[[nodiscard]] inline ClassifiedPageOrigin ClassifyPageOrigin(std::string_view url) {
  const auto parsed = NormalizeUrlOrigin(url);
  if (parsed.sensitive_label) return {OriginState::kSensitive, parsed.normalized_origin};
  const auto &origin = parsed.normalized_origin;
  // Preserve the existing policy: only dotted HTTP(S) authorities supply binding material.
  if ((!origin.starts_with("http://") && !origin.starts_with("https://")) ||
      origin.find('.') == std::string::npos) return {};
  return {OriginState::kUnknown, origin};
}

} // namespace sprint_coder::computer_use
