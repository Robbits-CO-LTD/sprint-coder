#pragma once

// Windows V1 vocabulary, split for the approved confirmation path. Its union and matching modes
// remain V1's; Windows-only and ambiguous words stay on the side that approval never relaxes.
#include "computer_use_native_approved_risk.h"

#include <array>
#include <string_view>

namespace sprint_coder::computer_use {
namespace windows_risk_terms {
inline constexpr std::array<std::u8string_view, 20> kConfirmationSubstring = {
    u8"payment", u8"checkout", u8"purchase", u8"billing", u8"credit card", u8"card number",
    u8"wire transfer", u8"contract", u8"agreement", u8"sign agreement", u8"決済", u8"支払い", u8"支払う",
    u8"購入", u8"注文を確定", u8"注文する", u8"請求", u8"送金", u8"契約", u8"署名"};
inline constexpr std::array<std::u8string_view, 16> kOtherSubstring = {
    u8"installer", u8"install application", u8"administrator", u8"admin privileges", u8"sudo",
    u8"root access", u8"security settings", u8"privacy settings", u8"firewall",
    u8"accessibility permission", u8"screen recording permission", u8"インストール", u8"管理者", u8"セキュリティ",
    u8"プライバシー", u8"ファイアウォール"};
inline constexpr std::array<std::u8string_view, 15> kConfirmationBounded = {
    u8"pay", u8"pay now", u8"place order", u8"submit order", u8"complete order", u8"buy now",
    u8"pagar", u8"comprar", u8"acheter", u8"bestellen", u8"bezahlen", u8"pagare", u8"acquistare",
    u8"betalen", u8"kopen"};
inline constexpr std::array<std::u8string_view, 9> kOtherBounded = {
    u8"integrated terminal", u8"terminal", u8"console", u8"shell", u8"powershell",
    u8"command prompt", u8"cmd.exe", u8"pwsh", u8"wsl"};

static_assert(high_impact_terms::NoEmptyWord(kConfirmationSubstring) &&
              high_impact_terms::NoEmptyWord(kOtherSubstring) &&
              high_impact_terms::NoEmptyWord(kConfirmationBounded) &&
              high_impact_terms::NoEmptyWord(kOtherBounded));
} // namespace windows_risk_terms

[[nodiscard]] inline HighImpactTextBits ClassifyWindowsRiskText(std::string_view lowercase_text) {
  using namespace windows_risk_terms;
  using high_impact_terms::AnySubstring;
  using high_impact_terms::AnyBounded;
  return {AnySubstring(lowercase_text, kConfirmationSubstring) ||
              AnyBounded(lowercase_text, kConfirmationBounded),
          AnySubstring(lowercase_text, kOtherSubstring) ||
              AnyBounded(lowercase_text, kOtherBounded)};
}
} // namespace sprint_coder::computer_use
