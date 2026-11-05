#pragma once

#include "computer_use_url_origin.h"

namespace sprint_coder::computer_use {

// Version 2 admits ordinary dotted HTTP(S) hosts; rejected aliases remain closed.
inline constexpr unsigned kOriginClassificationVersion = 2;
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
  const std::string_view authority = std::string_view(origin).substr(origin.find("://") + 3);
  const auto host = authority.substr(0, authority.find(':'));
  for (const std::string_view suffix : {"localhost", "localhost.localdomain", "local", "internal",
                                       "lan", "home.arpa", "intranet", "corp"}) {
    if (host == suffix || (host.size() > suffix.size() && host.ends_with(suffix) &&
                          host[host.size() - suffix.size() - 1] == '.'))
      // Local hosts keep their binding origin, as before F2; only the state stays non-ordinary.
      return {OriginState::kUnknown, origin};
  }
  return {OriginState::kOrdinary, origin};
}

} // namespace sprint_coder::computer_use
