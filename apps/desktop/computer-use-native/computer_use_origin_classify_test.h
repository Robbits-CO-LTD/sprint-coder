#pragma once
#include "computer_use_origin_classify.h"
#include <iostream>

inline bool CheckOriginClassification() {
  using namespace sprint_coder::computer_use;
  struct Case {
    const char *name;
    std::string_view url;
    std::string_view origin;
    OriginState state;
  };
  const Case cases[] = {
      {"empty", "", "", OriginState::kUnknown},
      {"missing-scheme", "docs.example/a", "", OriginState::kUnknown},
      {"missing-authority", "https:///a", "", OriginState::kUnknown},
      {"control", "https://docs.example/\n", "", OriginState::kUnknown},
      {"space", " https://docs.example", "", OriginState::kUnknown},
      {"userinfo", "https://bank.example@docs.example", "", OriginState::kUnknown},
      {"trailing-dot", "https://docs.example.", "", OriginState::kUnknown},
      {"empty-label", "https://a..example", "", OriginState::kUnknown},
      {"hyphen", "https://-a.example", "", OriginState::kUnknown},
      {"idn", "https://\xc3\xa9.example", "", OriginState::kUnknown},
      {"punycode", "https://xn--test.example", "", OriginState::kUnknown},
      {"mixed-punycode", "https://docs.XN--test.example", "", OriginState::kUnknown},
      {"ipv4", "http://127.0.0.1", "", OriginState::kUnknown},
      {"short-ip", "http://127.1", "", OriginState::kUnknown},
      {"integer-ip", "http://2130706433", "", OriginState::kUnknown},
      {"octal-ip", "http://0177.0.0.1", "", OriginState::kUnknown},
      {"hex-ip", "http://0x7f000001", "", OriginState::kUnknown},
      {"hex-tail", "http://a.0x7f", "", OriginState::kUnknown},
      {"ipv6", "http://[::1]", "", OriginState::kUnknown},
      {"single-label", "http://localhost", "", OriginState::kUnknown},
      {"escaped-host", "https://%62ank.example", "", OriginState::kUnknown},
      {"backslash", "https://docs.example\\a", "", OriginState::kUnknown},
      {"bad-escape", "https://docs.example/%zz", "", OriginState::kUnknown},
      {"escaped-control", "https://docs.example/%0a", "", OriginState::kUnknown},
      {"empty-port", "https://docs.example:", "", OriginState::kUnknown},
      {"bad-port", "https://docs.example:abc", "", OriginState::kUnknown},
      {"zero-port", "https://docs.example:0", "", OriginState::kUnknown},
      {"overflow-port", "https://docs.example:65536", "", OriginState::kUnknown},
      {"file", "file:///synthetic/a.html", "", OriginState::kUnknown},
      {"remote-file", "file://docs.example/a", "", OriginState::kUnknown},
      {"unclassified", "https://docs.example/path?q=synthetic#part", "https://docs.example", OriginState::kUnknown},
      {"case-default-port", "HTTPS://DoCs.Example:00443/a", "https://docs.example", OriginState::kUnknown},
      {"http-default-port", "http://docs.example:80", "http://docs.example", OriginState::kUnknown},
      {"nondefault-port", "https://docs.example:08443/a", "https://docs.example:8443", OriginState::kUnknown},
      {"port-upper-bound", "https://docs.example:65535", "https://docs.example:65535", OriginState::kUnknown},
      {"sensitive-case", "HTTPS://BaNk.Example:443/a", "https://bank.example", OriginState::kSensitive},
      {"sensitive-subdomain", "https://a.payment.example", "https://a.payment.example", OriginState::kSensitive},
      {"label-not-substring", "https://notbank.example", "https://notbank.example", OriginState::kUnknown},
      {"path-not-origin", "https://docs.example/bank", "https://docs.example", OriginState::kUnknown},
  };
  for (const auto &entry : cases) {
    const auto result = ClassifyPageOrigin(entry.url);
    if (result.state != entry.state || result.normalized_origin != entry.origin) {
      std::cerr << "origin-classification: " << entry.name << '\n';
      return false;
    }
  }
  for (const auto scheme : {"chrome", "edge", "about", "view-source", "data", "javascript", "blob",
                            "devtools", "chrome-devtools", "app", "vscode-file", "ftp"}) {
    if (ClassifyPageOrigin(std::string(scheme) + "://docs.example/a").state != OriginState::kUnknown)
      return false;
  }
  for (const auto label : {"bank", "banking", "payment", "payments", "checkout", "pay", "billing",
                           "oauth", "sso", "login", "auth", "admin", "console", "account", "accounts"}) {
    if (ClassifyPageOrigin("https://" + std::string(label) + ".example").state != OriginState::kSensitive)
      return false;
  }
  for (int byte = 0; byte <= 127; ++byte) {
    if (byte > 32 && byte != 127) continue;
    std::string url = "https://docs.example/";
    url.push_back(static_cast<char>(byte));
    if (!ClassifyPageOrigin(url).normalized_origin.empty()) return false;
  }
  if (!ClassifyPageOrigin(std::string(8193, 'a')).normalized_origin.empty()) return false;
  if (!ClassifyPageOrigin("https://" + std::string(64, 'a') + ".example").normalized_origin.empty()) return false;
  return true;
}
