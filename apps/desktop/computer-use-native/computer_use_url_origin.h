#pragma once

#include "computer_use_effect_classifier.h"
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

// N11-A candidate only. No capture/input path includes this header. Keep the existing
// ClassifyPageOrigin and macOS ApplyShadowOrigin unchanged until the integration review.
// This is a deliberately restricted parser, not a browser URL repair algorithm or IDNA library.
// ordinary describes the scheme, never trust in a site. No DNS or hostname permission table.
struct UrlOrigin {
  OriginState state = OriginState::kUnknown;
  bool dev_tools = false;
  // Private binding material only: never log, serialize or send to a provider.
  // Empty for unknown and file (opaque); file must not share an approval origin digest.
  std::string normalized_origin;
};

namespace url_origin_detail {
inline std::string Lower(std::string_view value) {
  std::string result(value);
  for (char &c : result)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return result;
}

inline int Hex(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

inline bool PlainUrl(std::string_view url) {
  if (url.empty() || url.size() > 8192) return false;
  for (std::size_t i = 0; i < url.size(); ++i) {
    const auto c = static_cast<unsigned char>(url[i]);
    if (c <= 32 || c >= 127 || c == '\\') return false;
    if (c != '%') continue;
    if (i + 2 >= url.size()) return false;
    const int high = Hex(url[i + 1]), low = Hex(url[i + 2]);
    if (high < 0 || low < 0) return false;
    const int decoded = high * 16 + low;
    if (decoded <= 32 || decoded == 127 || decoded == '\\') return false;
    i += 2;
  }
  return true;
}

inline bool PlainHost(std::string_view host) {
  if (host.empty() || host.size() > 253) return false;
  std::size_t begin = 0;
  while (begin < host.size()) {
    const auto dot = host.find('.', begin);
    const auto label = host.substr(begin, dot == std::string_view::npos ? dot : dot - begin);
    if (label.empty() || label.size() > 63 || label.front() == '-' || label.back() == '-')
      return false;
    // Unicode and A-labels require validated IDNA processing, including confusable policy.
    // Do not lowercase/fold Unicode or treat an unvalidated punycode label as ordinary.
    if (label.starts_with("xn--")) return false;
    bool numeric = true;
    for (char c : label) {
      if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
      numeric = numeric && c >= '0' && c <= '9';
    }
    // Includes numeric-address aliases under arbitrary domains. Never infer loopback or
    // local trust from a host prefix (and never resolve DNS to decide classification).
    if (numeric || label.starts_with("0x")) return false;
    if (dot == std::string_view::npos) return true;
    begin = dot + 1;
  }
  return false;
}
} // namespace url_origin_detail

[[nodiscard]] inline UrlOrigin NormalizeUrlOrigin(std::string_view url, bool url_read = true) {
  using namespace url_origin_detail;
  if (!url_read || !PlainUrl(url)) return {};
  const auto colon = url.find(':');
  if (colon == std::string_view::npos) return {};
  const auto scheme = Lower(url.substr(0, colon));
  const bool dev_tools = scheme == "devtools" || scheme == "chrome-devtools";
  if (scheme != "http" && scheme != "https" && scheme != "file" && !dev_tools) return {};
  const auto rest = url.substr(colon + 1);
  if (!rest.starts_with("//")) return {};
  const auto location = rest.substr(2);
  const auto end = location.find_first_of("/?#");
  const auto authority = location.substr(0, end);
  // Userinfo is discarded by rejecting the whole authority, never by trusting the text
  // before '@'. Percent-encoded delimiters, IPv6 and browser-repaired hosts stay unknown.
  if (authority.find_first_of("@%[]") != std::string_view::npos) return {};
  if (scheme == "file") {
    // Only an absolute local file URL. Remote/ambiguous file authorities stay unknown.
    if ((!authority.empty() && Lower(authority) != "localhost") ||
        end == std::string_view::npos || location[end] != '/') return {};
    return {OriginState::kOrdinary, false, {}};
  }
  const auto port_at = authority.find(':');
  std::string host = Lower(authority.substr(0, port_at));
  if (!host.empty() && host.back() == '.') host.pop_back();
  if (!PlainHost(host)) return {};
  std::string port;
  if (port_at != std::string_view::npos) {
    const auto digits = authority.substr(port_at + 1);
    if (digits.empty() || digits.size() > 5 || dev_tools) return {};
    unsigned number = 0;
    for (char c : digits) {
      if (c < '0' || c > '9') return {};
      number = number * 10 + static_cast<unsigned>(c - '0');
    }
    if (number == 0 || number > 65535) return {};
    if (!((scheme == "http" && number == 80) || (scheme == "https" && number == 443)))
      port = ":" + std::to_string(number);
  }
  return {OriginState::kOrdinary, dev_tools, scheme + "://" + host + port};
}

// Optional pre-existing sensitive evidence may only strengthen the result. There is no
// hostname-based sensitive detector here. Do not replace another measured dangerous surface.
inline void ApplyUrlOrigin(const UrlOrigin &origin, EffectFacts *facts) {
  if (facts->origin != OriginState::kSensitive) facts->origin = origin.state;
  if (origin.dev_tools &&
      (facts->surface == SurfaceKind::kOrdinary || facts->surface == SurfaceKind::kUnknown))
    facts->surface = SurfaceKind::kDevToolsConsole;
}

} // namespace sprint_coder::computer_use
