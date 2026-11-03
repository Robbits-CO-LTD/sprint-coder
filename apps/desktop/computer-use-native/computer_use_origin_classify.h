#pragma once

#include "computer_use_effect_classifier.h"
#include <string>
#include <string_view>

namespace sprint_coder::computer_use {

// Private classification data, never a diagnostic or provider payload. This parser is deliberately
// not connected to capture yet. Version 1 has no evidence that any host is ordinary (ADR S7/D13).
inline constexpr unsigned kOriginClassificationVersion = 1;
struct ClassifiedPageOrigin {
  OriginState state = OriginState::kUnknown;
  std::string normalized_origin;
};

namespace origin_detail {
inline int Hex(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

inline std::string Lower(std::string_view value) {
  std::string result(value);
  for (char &byte : result)
    if (byte >= 'A' && byte <= 'Z') byte = static_cast<char>(byte - 'A' + 'a');
  return result;
}

// These labels are refusal-only signals for the categories in ADR 3.5, not a complete site list.
// A missing signal cannot establish that a site is safe, including a lookalike or an internal site.
inline bool SensitiveLabel(std::string_view label) {
  constexpr std::string_view labels[] = {
      "bank", "banking", "payment", "payments", "checkout", "pay", "billing", "oauth",
      "sso", "login", "auth", "admin", "console", "account", "accounts"};
  for (auto candidate : labels)
    if (label == candidate) return true;
  return false;
}
} // namespace origin_detail

[[nodiscard]] inline ClassifiedPageOrigin ClassifyPageOrigin(std::string_view url) {
  using namespace origin_detail;
  // No trimming, scheme inference, IDNA conversion, IP interpretation or browser error repair.
  if (url.empty() || url.size() > 8192) return {};
  for (std::size_t i = 0; i < url.size(); ++i) {
    const auto byte = static_cast<unsigned char>(url[i]);
    if (byte <= 32 || byte >= 127 || byte == '\\') return {};
    if (byte == '%') {
      if (i + 2 >= url.size()) return {};
      const int high = Hex(url[i + 1]);
      const int low = Hex(url[i + 2]);
      if (high < 0 || low < 0) return {};
      const int decoded = high * 16 + low;
      if (decoded <= 32 || decoded == 127 || decoded == '\\') return {};
      i += 2;
    }
  }
  const auto separator = url.find("://");
  if (separator == std::string_view::npos) return {};
  const std::string scheme = Lower(url.substr(0, separator));
  // file has an opaque origin. Browser/internal/embedded schemes never inherit an inner origin.
  if (scheme != "http" && scheme != "https") return {};
  const auto rest = url.substr(separator + 3);
  const auto end = rest.find_first_of("/?#");
  const auto authority = rest.substr(0, end);
  if (authority.empty() || authority.find_first_of("@%[]") != std::string_view::npos) return {};
  const auto colon = authority.find(':');
  const auto raw_host = authority.substr(0, colon);
  if (raw_host.empty() || raw_host.size() > 253 || raw_host.back() == '.') return {};
  const std::string host = Lower(raw_host);
  if (host.find('.') == std::string::npos) return {};
  bool sensitive = false;
  std::size_t begin = 0;
  while (begin < host.size()) {
    const auto dot = host.find('.', begin);
    const auto label = std::string_view(host).substr(begin, dot == std::string::npos ? dot : dot - begin);
    if (label.empty() || label.size() > 63 || label.front() == '-' || label.back() == '-' ||
        label.substr(0, 4) == "xn--") return {};
    for (char byte : label)
      if (!((byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9') || byte == '-')) return {};
    sensitive = sensitive || SensitiveLabel(label);
    if (dot == std::string::npos) {
      // Numeric/hex final labels can trigger the special-scheme IPv4 parser. Reject all of them.
      bool numeric = true;
      for (char byte : label) numeric = numeric && byte >= '0' && byte <= '9';
      if (numeric || label.substr(0, 2) == "0x") return {};
      break;
    }
    begin = dot + 1;
  }
  unsigned port = scheme == "https" ? 443 : 80;
  if (colon != std::string_view::npos) {
    const auto text = authority.substr(colon + 1);
    if (text.empty() || text.size() > 5) return {};
    port = 0;
    for (char byte : text) {
      if (byte < '0' || byte > '9') return {};
      port = port * 10 + static_cast<unsigned>(byte - '0');
    }
    if (port == 0 || port > 65535) return {};
  }
  ClassifiedPageOrigin result;
  result.normalized_origin = scheme + "://" + host;
  if ((scheme == "https" && port != 443) || (scheme == "http" && port != 80))
    result.normalized_origin += ":" + std::to_string(port);
  result.state = sensitive ? OriginState::kSensitive : OriginState::kUnknown;
  return result;
}

} // namespace sprint_coder::computer_use
