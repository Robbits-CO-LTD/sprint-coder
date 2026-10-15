#pragma once

// Classifier v2, C4-2c-1: how the v1 high-impact judgement is split, and how an APPROVED effect may
// relax part of it. Portable (no platform header, N-API or I/O): the macOS addon reads its words from
// here and the harness checks the table against a frozen copy of the v1 vocabulary.
//
// v1 has ONE high-impact bit. It mixes two things the approval path must tell apart:
//   * CONFIRMATION words: a purchase, a payment, a contract, a transfer ("Pay now", "checkout",
//     "購入"). A person may approve exactly this effect once (the high_impact_confirmation effect).
//   * everything else v1 calls high impact: a command surface (terminal, shell, console, run
//     script), an installer, an administrator / permission / security / privacy / firewall words.
//     These are NEVER relaxed. The ambiguous ones (security settings, administrator, installer, ...)
//     are on this side on purpose: an unclassifiable word is not a confirmation.
// The union of the two sides is exactly the v1 vocabulary (the harness proves it), so v1 behaves as
// before whenever no effect was approved.
//
// The only relaxation: an approved high_impact_confirmation lets a target whose high-impact evidence
// is CONFIRMATION words alone through. A secure field, an unclassified target, any other word and
// every effect other than high_impact_confirmation (a supervised action, a download or file-manager
// open) are judged exactly as v1 judges them. Nothing sets the approved effect yet (the producer is
// C4-2c-2); the default is no effect, which is v1.
//
// The words are lowercase ASCII or UTF-8 (u8 literals; the file also carries a BOM), matched against one lowercase text (role, subrole, title,
// description, help, identifier and placeholder joined by newlines), like v1 does. Words that are
// "bounded" must not touch an ASCII letter or digit on either side.

#include "computer_use_native_approval_ticket.h"
#include "computer_use_preflight_classifier.h"

#include <array>
#include <cstddef>
#include <string_view>

namespace sprint_coder::computer_use {

namespace high_impact_terms {

// CONFIRMATION words, matched anywhere in the text.
inline constexpr std::array<std::u8string_view, 15> kConfirmationSubstring = {
    u8"payment", u8"checkout", u8"purchase", u8"billing", u8"credit card", u8"card number", u8"wire transfer",
    u8"contract", u8"agreement", u8"sign agreement", u8"決済", u8"支払い", u8"支払う", u8"購入",
    u8"注文を確定"};
inline constexpr std::array<std::u8string_view, 5> kConfirmationSubstringJa = {
    u8"注文する", u8"請求", u8"送金", u8"契約", u8"署名"};
// CONFIRMATION words that must stand alone (bounded).
inline constexpr std::array<std::u8string_view, 15> kConfirmationBounded = {
    u8"pay",      u8"pay now",    u8"place order", u8"submit order", u8"complete order",
    u8"buy now",  u8"pagar",      u8"comprar",     u8"acheter",      u8"bestellen",
    u8"bezahlen", u8"pagare",     u8"acquistare",  u8"betalen",      u8"kopen"};

// Everything else v1 calls high impact: never relaxed.
inline constexpr std::array<std::u8string_view, 12> kOtherSubstring = {
    u8"installer", u8"install application", u8"administrator", u8"admin privileges", u8"sudo",
    u8"root access", u8"security settings", u8"privacy settings", u8"firewall",
    u8"accessibility permission", u8"screen recording permission", u8"インストール"};
inline constexpr std::array<std::u8string_view, 4> kOtherSubstringJa = {
    u8"管理者", u8"セキュリティ", u8"プライバシー", u8"ファイアウォール"};
// Command surfaces, bounded.
inline constexpr std::array<std::u8string_view, 12> kOtherBounded = {
    u8"integrated terminal", u8"terminal", u8"terminal.app", u8"console", u8"shell", u8"powershell",
    u8"powershell.exe", u8"command prompt", u8"cmd.exe", u8"run script", u8"shell script",
    u8"script console"};
inline constexpr std::array<std::u8string_view, 5> kOtherSurfaceJa = {
    u8"ターミナル", u8"コンソール", u8"シェル", u8"コマンドプロンプト", u8"スクリプトを実行"};

// No word is empty (an empty word would match every text).
template <std::size_t N>
[[nodiscard]] constexpr bool NoEmptyWord(const std::array<std::u8string_view, N> &words) {
  for (const std::u8string_view word : words)
    if (word.empty()) return false;
  return true;
}
static_assert(NoEmptyWord(kConfirmationSubstring) && NoEmptyWord(kConfirmationSubstringJa) &&
                  NoEmptyWord(kConfirmationBounded) && NoEmptyWord(kOtherSubstring) &&
                  NoEmptyWord(kOtherSubstringJa) && NoEmptyWord(kOtherBounded) &&
                  NoEmptyWord(kOtherSurfaceJa),
              "an empty high-impact word would match every text");

// The words are u8 literals (like the classifier's lexicon), so no compiler character set can misread
// them; they are matched as bytes.
[[nodiscard]] inline std::string_view Bytes(std::u8string_view term) {
  return std::string_view(reinterpret_cast<const char *>(term.data()), term.size());
}

[[nodiscard]] inline bool IsTermContinuation(unsigned char character) {
  return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');
}

[[nodiscard]] inline bool ContainsSubstring(std::string_view haystack, std::string_view needle) {
  return haystack.find(needle) != std::string_view::npos;
}

// The v1 rule: an occurrence counts when neither neighbour is an ASCII lowercase letter or digit.
[[nodiscard]] inline bool ContainsBounded(std::string_view haystack, std::string_view needle) {
  for (std::size_t position = haystack.find(needle); position != std::string_view::npos;
       position = haystack.find(needle, position + 1)) {
    const bool before =
        position == 0 || !IsTermContinuation(static_cast<unsigned char>(haystack[position - 1]));
    const std::size_t end = position + needle.size();
    const bool after =
        end == haystack.size() || !IsTermContinuation(static_cast<unsigned char>(haystack[end]));
    if (before && after) return true;
  }
  return false;
}

template <std::size_t N>
[[nodiscard]] inline bool AnySubstring(std::string_view haystack,
                                       const std::array<std::u8string_view, N> &needles) {
  for (const std::u8string_view needle : needles)
    if (ContainsSubstring(haystack, Bytes(needle))) return true;
  return false;
}

template <std::size_t N>
[[nodiscard]] inline bool AnyBounded(std::string_view haystack,
                                     const std::array<std::u8string_view, N> &needles) {
  for (const std::u8string_view needle : needles)
    if (ContainsBounded(haystack, Bytes(needle))) return true;
  return false;
}

} // namespace high_impact_terms

// What one lowercase text says about high impact, split into the two sides.
struct HighImpactTextBits {
  bool confirmation = false;
  bool other = false;
};

[[nodiscard]] inline HighImpactTextBits ClassifyHighImpactText(std::string_view lowercase_text) {
  using namespace high_impact_terms;
  HighImpactTextBits bits;
  bits.confirmation = AnySubstring(lowercase_text, kConfirmationSubstring) ||
                      AnySubstring(lowercase_text, kConfirmationSubstringJa) ||
                      AnyBounded(lowercase_text, kConfirmationBounded);
  bits.other = AnySubstring(lowercase_text, kOtherSubstring) ||
               AnySubstring(lowercase_text, kOtherSubstringJa) ||
               AnyBounded(lowercase_text, kOtherBounded) ||
               AnySubstring(lowercase_text, kOtherSurfaceJa);
  return bits;
}

// The facts a risk judgement stands on, as native measured them (macOS: the accessibility element
// and its parents, each bit OR-ed along the way).
struct NativeRiskBits {
  bool classified = false;
  bool secure = false;
  // v1's single bit: confirmation || other.
  bool high_impact = false;
  bool confirmation = false;
  bool other = false;
};

// The v1 judgement, with one relaxation for an APPROVED high-impact confirmation (see the top of
// this file). `approved_effect` is `kInvalid` for every ordinary preflight and dispatch, and then the
// answer is exactly ClassifyNativePreflightFacts' of the v1 bits.
[[nodiscard]] constexpr NativePreflightDecision
ClassifyNativeRisk(NativeRiskBits bits,
                   NativeApprovalEffect approved_effect = NativeApprovalEffect::kInvalid) noexcept {
  bool high_impact = bits.high_impact;
  // Positive evidence only: the confirmation words are there, and nothing else makes it high impact.
  if (approved_effect == NativeApprovalEffect::kHighImpactConfirmation && bits.high_impact &&
      bits.confirmation && !bits.other)
    high_impact = false;
  return ClassifyNativePreflightFacts({true, bits.classified, bits.secure, high_impact});
}

} // namespace sprint_coder::computer_use
